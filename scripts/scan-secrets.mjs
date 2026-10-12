// Scans tracked and unignored working files, and every blob reachable from a local ref, for high-confidence
// credential shapes. History reads each distinct blob once. A match prints the rule and the location only:
// exit 0 is clean, 1 is a match, and 2 is a scanner or git failure. Git's own error text is discarded because
// it can echo the bytes that matched.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const BINARY_PROBE = 8000, MAX_MATCH = 160, OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// The pieces are joined so this file does not contain a credential it would itself report.
const RULES = [
  { id: "github-token", source: String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b` },
  { id: "aws-access-key", source: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b` },
  { id: "google-api-key", source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b` },
  { id: "private-api-token", source: [String.raw`\bxox[baprs]-(?:\d{10,13}-){2,3}[A-Za-z0-9]{24,32}\b`, String.raw`\b(?:sk|rk)_live_[A-Za-z0-9]{24,99}\b`, String.raw`\bnpm_[A-Za-z0-9]{36}\b`, String.raw`\bglpat-[A-Za-z0-9_-]{20,99}\b`].join("|") },
  { id: "pem-private-key", source: ["-----", "BEGIN ", "(?:RSA |OPENSSH |EC |DSA |ENCRYPTED |PGP )?", "PRIVATE KEY", "(?: BLOCK)?", "-----"].join("") },
];

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"]) delete env[name];
const findings = [], seen = new Set();
const fail = () => { console.error("scan-secrets: the repository could not be read."); process.exit(2); };
function safeLocation(location) {
  // A credential can itself be a filename, including a substring between ordinary filename characters.
  for (const rule of RULES) location = location.replace(new RegExp(rule.source.replace(/\\b/g, ""), "g"), "[redacted]");
  return /[\s"\\\x00-\x1f\x7f]/.test(location) ? JSON.stringify(location) : location;
}
const add = (rule, location) => { location = safeLocation(location); const key = `${rule} ${location}`; if (seen.has(key)) return; seen.add(key); findings.push({ rule, location }); };

function git(args, { cwd, input, allowFail = false } = {}) {
  const result = spawnSync("git", args, { cwd, input, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  if (result.error || result.status !== 0) { if (allowFail) return null; fail(); }
  return result.stdout;
}
const gitIn = (root, args, options) => git(["-C", root, "-c", "core.quotepath=false", ...args], options);

function pushText(state, chunk, final) {
  if (state.binary) return;
  const start = state.seen;
  state.seen += chunk.length;
  if (start < BINARY_PROBE && chunk.subarray(0, Math.min(chunk.length, BINARY_PROBE - start)).indexOf(0) !== -1) { state.binary = true; state.pending = ""; state.matched.clear(); return; }
  if (chunk.length) state.pending += chunk.toString("latin1");
  const limit = final ? Number.POSITIVE_INFINITY : state.pending.length - MAX_MATCH;
  if (limit <= 0) return;
  for (const rule of RULES) {
    if (state.matched.has(rule.id)) continue;
    const pattern = new RegExp(rule.source, "g");
    let match;
    while ((match = pattern.exec(state.pending))) {
      if (match.index + match[0].length <= limit) { state.matched.add(rule.id); break; }
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
  if (!final) state.pending = state.pending.slice(-MAX_MATCH * 2);
}

function scanBuffer(buffer) {
  const state = { binary: false, pending: "", matched: new Set(), seen: 0 };
  const step = 1024 * 1024;
  if (!buffer.length) return state;
  for (let offset = 0; offset < buffer.length; offset += step) pushText(state, buffer.subarray(offset, offset + step), offset + step >= buffer.length);
  return state;
}

function blobOid(buffer, algo) {
  const hash = createHash(algo);
  hash.update(`blob ${buffer.length}\0`);
  hash.update(buffer);
  return hash.digest("hex");
}

function locationsFor(oid, entry) {
  const locations = [];
  for (const path of entry?.paths ?? []) if (path) locations.push(`${oid}:${path}`);
  for (const path of entry?.worktree ?? []) locations.push(`worktree:${path}`);
  if (!locations.length) locations.push(oid);
  return locations;
}

function record(matched, locations) {
  for (const rule of matched) for (const location of locations) add(rule, location);
}

// One cat-file process reads every blob. The extra newline after each object is git's framing, not content.
function readBlobs(root, oids, onBlob) {
  if (!oids.length) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", root, "-c", "core.quotepath=false", "cat-file", "--batch"], { env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let buf = Buffer.alloc(0), header = null, settled = false;
    const rejectOnce = () => { if (settled) return; settled = true; child.kill(); reject(new Error("git")); };
    const resolveOnce = () => { if (!settled) { settled = true; resolvePromise(); } };
    const pump = () => {
      while (true) {
        if (!header) {
          const nl = buf.indexOf(10);
          if (nl < 0) return;
          const parts = buf.subarray(0, nl).toString("utf8").split(" ");
          buf = buf.subarray(nl + 1);
          const size = Number(parts[2]);
          if (parts.length !== 3 || !OID.test(parts[0]) || !Number.isInteger(size) || size < 0) return rejectOnce();
          header = { oid: parts[0], size, got: 0, binary: false, pending: "", matched: new Set(), seen: 0 };
        }
        const need = header.size - header.got;
        if (buf.length < need) { pushText(header, buf, false); header.got += buf.length; buf = Buffer.alloc(0); return; }
        pushText(header, buf.subarray(0, need), false); header.got += need; buf = buf.subarray(need);
        if (buf.length < 1) return;
        if (buf[0] !== 10) return rejectOnce();
        buf = buf.subarray(1);
        if (!header.binary) pushText(header, Buffer.alloc(0), true);
        onBlob(header);
        header = null;
      }
    };
    child.stdout.on("data", chunk => { if (settled) return; buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; try { pump(); } catch { rejectOnce(); } });
    child.on("error", rejectOnce);
    child.stdin.on("error", rejectOnce);
    child.on("close", code => { if (settled) return; if (code !== 0 || header || buf.length) rejectOnce(); else resolveOnce(); });
    child.stdin.end(`${oids.join("\n")}\n`);
  });
}

function insideRepo(root, full) {
  const rel = relative(resolve(root), resolve(full));
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

async function main() {
  const cwd = process.cwd();
  const workTree = git(["rev-parse", "--is-inside-work-tree"], { cwd, allowFail: true });
  if (!workTree || workTree.toString("utf8").trim() !== "true") fail();
  const root = git(["rev-parse", "--show-toplevel"], { cwd }).toString("utf8").trim();
  const format = gitIn(root, ["rev-parse", "--show-object-format"]).toString("utf8").trim();
  if (format !== "sha1" && format !== "sha256") fail();

  /** @type {Map<string, {paths: Set<string>, worktree: string[]}>} */
  const blobs = new Map();
  const remember = (oid, path) => {
    if (!OID.test(oid)) fail();
    let entry = blobs.get(oid);
    if (!entry) blobs.set(oid, entry = { paths: new Set(), worktree: [] });
    if (path) entry.paths.add(path);
    return entry;
  };

  // Other refs still exist when the current branch is unborn. rev-list also rejects corrupt referenced objects.
  {
    const listed = gitIn(root, ["rev-list", "--objects", "--all"]).toString("utf8");
    const records = [];
    for (const line of listed.split("\n")) {
      if (!line) continue;
      const space = line.indexOf(" ");
      const oid = space === -1 ? line.replace(/\r$/, "") : line.slice(0, space);
      const path = space === -1 ? "" : line.slice(space + 1).replace(/\r$/, "");
      if (!OID.test(oid)) fail();
      records.push({ oid, path });
    }
    if (records.length) {
      const checked = gitIn(root, ["cat-file", "--batch-check"], { input: Buffer.from(`${records.map(item => item.oid).join("\n")}\n`) }).toString("utf8");
      const types = new Map();
      for (const line of checked.split("\n")) {
        if (!line) continue;
        const [oid, type, size] = line.split(" ");
        if (!oid || type === "missing" || size === undefined) fail();
        types.set(oid, type);
      }
      for (const item of records) {
        const type = types.get(item.oid);
        if (!type) fail();
        if (type === "blob") remember(item.oid, item.path);
      }
    }
  }

  const listed = gitIn(root, ["ls-files", "-z", "-c", "-o", "--exclude-standard"]);
  const extras = new Map();
  for (const path of listed.toString("utf8").split("\0")) {
    if (!path) continue;
    if (path.split("/").includes("..") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) fail();
    const full = join(root, path);
    if (!insideRepo(root, full)) fail();
    let info;
    try { info = lstatSync(full); } catch (error) { if (error?.code === "ENOENT") continue; fail(); }
    if (info.isSymbolicLink()) {
      let link;
      try { link = readlinkSync(full); } catch { fail(); }
      record(scanBuffer(Buffer.from(link)).matched, [`worktree:${path}`]);
      continue;
    }
    if (!info.isFile()) continue;
    let data;
    try { data = readFileSync(full); } catch (error) { if (error?.code === "ENOENT") continue; fail(); }
    // The same blob is read once from git. A worktree file that is not that blob is its own text.
    const oid = blobOid(data, format), entry = blobs.get(oid);
    if (entry) { entry.worktree.push(path); continue; }
    const state = scanBuffer(data);
    if (state.binary) continue;
    let extra = extras.get(oid);
    if (!extra) extras.set(oid, extra = { matched: state.matched, worktree: [] });
    extra.worktree.push(path);
  }

  const oids = [...blobs.keys()];
  await readBlobs(root, oids, state => { if (!state.binary) record(state.matched, locationsFor(state.oid, blobs.get(state.oid))); });
  for (const [oid, extra] of extras) record(extra.matched, locationsFor(oid, { worktree: extra.worktree }));

  findings.sort((a, b) => a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.location < b.location ? -1 : a.location > b.location ? 1 : 0);
  if (findings.length) { process.stdout.write(findings.map(item => `${item.rule} ${item.location}\n`).join("")); process.exit(1); }
}

main().catch(() => fail());
