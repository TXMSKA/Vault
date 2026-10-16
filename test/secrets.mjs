// Behavioral checks for scripts/scan-secrets.mjs. Fixtures are built from fragments so this file is not itself a credential.
// Every repository is temporary and removed at the end. Failure text never includes a fixture.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("../scripts/scan-secrets.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "vault-secrets-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "Scanner", GIT_AUTHOR_EMAIL: "scanner@example.invalid", GIT_COMMITTER_NAME: "Scanner", GIT_COMMITTER_EMAIL: "scanner@example.invalid" };
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[name];
const github = ["gh", "p_", "A".repeat(36)].join("");
const aws = ["AK", "IA", "0".repeat(16)].join("");
const google = ["AI", "za", "b".repeat(35)].join("");
const slack = ["xo", "xb-", "1".repeat(11), "-", "2".repeat(11), "-", "c".repeat(24)].join("");
const stripe = ["sk", "_live_", "d".repeat(24)].join("");
const npmToken = ["np", "m_", "e".repeat(36)].join("");
const gitlab = ["gl", "pat-", "f".repeat(20)].join("");
const pem = ["-----BE", "GIN ", "PRIVATE KEY", "-----"].join("");
const linePattern = /^(github-token|aws-access-key|google-api-key|private-api-token|pem-private-key) (?:worktree:|[0-9a-f]{40,64}:)\S+$/;
let checks = 0;
let skipped = 0;
const locked = [];

function git(cwd, args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, env, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
}
function init(name) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "master"]);
  return dir;
}
function write(dir, path, contents) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}
function commit(dir, message) { git(dir, ["add", "-A"]); git(dir, ["commit", "-m", message]); }
function scan(cwd) { return spawnSync(process.execPath, [scanner], { cwd, env, encoding: "utf8", windowsHide: true }); }
function linesOf(result) { return result.stdout.split(/\n/).filter(Boolean); }

function expectClean(cwd) {
  const result = scan(cwd);
  if (result.status !== 0) throw new Error(`expected a clean scan, got ${result.status}`);
  checks++;
  if (result.stdout || result.stderr) throw new Error("a clean scan wrote output");
  checks++;
}
function expectFinding(cwd, token, rule, pathPart) {
  const result = scan(cwd);
  if (result.status !== 1) throw new Error(`expected a finding for ${rule}, got ${result.status}`);
  checks++;
  if (`${result.stdout}${result.stderr}`.includes(token)) throw new Error(`scanner output contained fixture bytes for ${rule}`);
  checks++;
  const lines = linesOf(result);
  if (!lines.length || lines.some(line => !linePattern.test(line))) throw new Error(`a ${rule} line was not a rule and a location`);
  checks++;
  if (!lines.some(line => line.startsWith(`${rule} `) && line.includes(pathPart))) throw new Error(`missing ${rule} location`);
  checks++;
  if (result.stderr) throw new Error(`scanner wrote an error for ${rule}`);
  checks++;
}
function expectClosed(cwd, token) {
  const result = scan(cwd);
  if (result.status !== 2) throw new Error(`expected a closed failure, got ${result.status}`);
  checks++;
  if (result.stdout) throw new Error("a failed scan wrote findings");
  checks++;
  if (/^(fatal|error):/m.test(result.stderr)) throw new Error("git stderr was forwarded");
  checks++;
  if (token && `${result.stdout}${result.stderr}`.includes(token)) throw new Error("a failed scan contained fixture bytes");
  checks++;
}

try {
  const clean = init("clean");
  write(clean, "README.md", "hello\n");
  commit(clean, "clean");
  const sample = readFileSync(join(clean, "README.md")), hash = createHash("sha1");
  hash.update(`blob ${sample.length}\0`); hash.update(sample);
  const gitHash = spawnSync("git", ["-c", "core.autocrlf=false", "hash-object", "README.md"], { cwd: clean, env, encoding: "utf8", windowsHide: true }).stdout.trim();
  if (hash.digest("hex") !== gitHash) throw new Error("blob id algorithm does not match git");
  checks++;
  expectClean(clean);
  expectClean(init("empty"));

  const shapes = init("shapes");
  write(shapes, "docs/note.txt", `${github}\n`);
  write(shapes, "test/fixture.txt", `${aws}\n`);
  write(shapes, "google.txt", `${google}\n`);
  write(shapes, "slack.txt", `${slack}\n`);
  write(shapes, "stripe.txt", `${stripe}\n`);
  write(shapes, "npm.txt", `${npmToken}\n`);
  write(shapes, "gitlab.txt", `${gitlab}\n`);
  write(shapes, "key.pem", `${pem}\n`);
  commit(shapes, "shapes");
  expectFinding(shapes, github, "github-token", "docs/note.txt");
  expectFinding(shapes, aws, "aws-access-key", "test/fixture.txt");
  expectFinding(shapes, google, "google-api-key", "google.txt");
  expectFinding(shapes, slack, "private-api-token", "slack.txt");
  expectFinding(shapes, stripe, "private-api-token", "stripe.txt");
  expectFinding(shapes, npmToken, "private-api-token", "npm.txt");
  expectFinding(shapes, gitlab, "private-api-token", "gitlab.txt");
  expectFinding(shapes, pem, "pem-private-key", "key.pem");

  const history = init("history");
  write(history, "leaked.txt", `${github}\n`);
  commit(history, "add");
  rmSync(join(history, "leaked.txt"));
  commit(history, "remove");
  const removed = scan(history);
  if (removed.status !== 1) throw new Error(`expected a historical finding, got ${removed.status}`);
  checks++;
  if (`${removed.stdout}${removed.stderr}`.includes(github)) throw new Error("scanner output contained fixture bytes for history");
  checks++;
  const removedLines = linesOf(removed);
  if (removedLines.some(line => !linePattern.test(line) || line.startsWith("github-token worktree:leaked.txt"))) throw new Error("historical finding pointed at the working tree");
  checks++;
  if (!removedLines.some(line => /^github-token [0-9a-f]{40}:leaked\.txt$/.test(line))) throw new Error("historical finding had no revision");
  checks++;

  const branch = init("branch");
  write(branch, "README.md", "clean\n");
  commit(branch, "base");
  git(branch, ["checkout", "-b", "other"]);
  write(branch, "branch.txt", `${aws}\n`);
  commit(branch, "side");
  git(branch, ["checkout", "master"]);
  expectFinding(branch, aws, "aws-access-key", "branch.txt");
  git(branch, ["switch", "--orphan", "unborn"]);
  expectFinding(branch, aws, "aws-access-key", "branch.txt");

  const filenames = init("filenames");
  write(filenames, `prefix${github}suffix.txt`, `${github}\n`);
  expectFinding(filenames, github, "github-token", "prefix[redacted]suffix.txt");
  commit(filenames, "credential-shaped path");
  expectFinding(filenames, github, "github-token", "[redacted]");

  // Construct a tree directly: its control-character path need not be representable on the host filesystem.
  const controls = init("controls"), controlPath = `folder\t${github}.txt`;
  const plumbing = (args, input) => {
    const result = spawnSync("git", args, { cwd: controls, env, input, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error("control-path fixture failed");
    return result.stdout.trim();
  };
  const object = plumbing(["hash-object", "-w", "--stdin"], github);
  const tree = plumbing(["mktree", "-z"], `100644 blob ${object}\t${controlPath}\0`);
  const controlCommit = plumbing(["commit-tree", tree, "-m", "control path"]);
  plumbing(["update-ref", "refs/heads/master", controlCommit]);
  const controlScan = scan(controls), controlLines = linesOf(controlScan);
  if (controlScan.status !== 1 || controlLines.length !== 1 || `${controlScan.stdout}${controlScan.stderr}`.includes(github)) throw new Error("control-path finding was not safely escaped");
  checks++;
  const controlLocation = controlLines[0].slice("github-token ".length);
  let decoded;
  try { decoded = JSON.parse(controlLocation); } catch { throw new Error("control-path finding was not quoted"); }
  if (!decoded.includes("[redacted]") || !controlLocation.includes("\\t")) throw new Error("control-path finding lost its redaction or escaped path");
  checks++;

  const ordinary = init("ordinary");
  const prose = ["password=example", "secret: example", "api_key = \"not-a-key\"", "token = placeholder", "ghp_example", "AKIAEXAMPLE", "AIzaSyShort", "xoxb-1", "sk_test_example", "sk_live_short", "npm_short", "glpat-short", "-----BEGIN PUBLIC KEY-----", "-----BEGIN CERTIFICATE-----", "authorization is not a credential"].join("\n") + "\n";
  write(ordinary, "docs/ordinary.txt", prose);
  write(ordinary, "test/ordinary.txt", prose);
  commit(ordinary, "ordinary");
  expectClean(ordinary);

  const binary = init("binary");
  write(binary, "README.md", "clean\n");
  writeFileSync(join(binary, "blob.bin"), Buffer.concat([Buffer.from([0]), Buffer.from(github)]));
  commit(binary, "binary");
  const binaryScan = scan(binary);
  if (binaryScan.status !== 0 || `${binaryScan.stdout}${binaryScan.stderr}`.includes(github)) throw new Error("a binary file was not ignored");
  checks++;

  const untracked = init("untracked");
  write(untracked, "README.md", "clean\n");
  commit(untracked, "base");
  write(untracked, "local.txt", `${google}\n`);
  const loose = scan(untracked);
  if (loose.status !== 1 || `${loose.stdout}${loose.stderr}`.includes(google)) throw new Error("an untracked file was not reported safely");
  checks++;
  if (!linesOf(loose).some(line => line === "google-api-key worktree:local.txt")) throw new Error("an untracked file had no worktree location");
  checks++;
  if (linesOf(loose).some(line => line.includes("local.txt") && !line.startsWith("google-api-key worktree:"))) throw new Error("an untracked file was reported as history");
  checks++;

  const ignored = init("ignored");
  write(ignored, ".gitignore", "ignored.txt\n");
  commit(ignored, "ignore");
  write(ignored, "ignored.txt", `${github}\n`);
  const ignoredScan = scan(ignored);
  if (ignoredScan.status !== 0 || `${ignoredScan.stdout}${ignoredScan.stderr}`.includes(github)) throw new Error("an ignored file was scanned");
  checks++;

  const duplicate = init("duplicate");
  write(duplicate, "a.txt", `${slack}\n`);
  write(duplicate, "b.txt", `${slack}\n`);
  commit(duplicate, "same");
  const duplicated = scan(duplicate);
  if (duplicated.status !== 1 || `${duplicated.stdout}${duplicated.stderr}`.includes(slack)) throw new Error("a repeated blob was not reported safely");
  checks++;
  const dupLines = linesOf(duplicated);
  if (dupLines.filter(line => line === "private-api-token worktree:a.txt" || line === "private-api-token worktree:b.txt").length !== 2) throw new Error("a repeated blob dropped a worktree path");
  checks++;
  if (dupLines.filter(line => /^private-api-token [0-9a-f]{40}:/.test(line)).length !== 1) throw new Error("a repeated blob was scanned as more than one revision");
  checks++;

  const missing = join(scratch, "missing");
  mkdirSync(missing);
  expectClosed(missing);
  const corrupt = init("corrupt");
  write(corrupt, "leaked.txt", `${pem}\n`);
  commit(corrupt, "add");
  writeFileSync(join(corrupt, ".git", "HEAD"), "not a head\n");
  expectClosed(corrupt, pem);
  const missingObject = init("missing-object");
  write(missingObject, "README.md", "clean\n");
  commit(missingObject, "base");
  const missingHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: missingObject, env, encoding: "utf8", windowsHide: true }).stdout.trim();
  rmSync(join(missingObject, ".git", "objects", missingHead.slice(0, 2), missingHead.slice(2)));
  expectClosed(missingObject);

  const blocked = init("blocked");
  write(blocked, "README.md", "clean\n");
  write(blocked, "locked.txt", `${stripe}\n`);
  commit(blocked, "add");
  const lockedFile = join(blocked, "locked.txt");
  if (process.platform === "win32") {
    const who = spawnSync("whoami", { encoding: "utf8", windowsHide: true }).stdout.trim();
    const denial = spawnSync("icacls", [lockedFile, "/inheritance:r", "/deny", `${who}:(R)`], { encoding: "utf8", windowsHide: true });
    if (denial.status !== 0) throw new Error("the fixture could not be made unreadable");
  } else chmodSync(lockedFile, 0);
  locked.push(lockedFile);
  let readable = true;
  try { readFileSync(lockedFile); } catch (error) { readable = !(error?.code === "EACCES" || error?.code === "EPERM"); }
  if (readable && process.platform !== "win32" && process.getuid?.() === 0) skipped++;
  else {
    if (readable) throw new Error("the fixture stayed readable");
    checks++;
    expectClosed(blocked, stripe);
  }

  console.log(`Secrets: ${checks} checks passed, ${skipped} skipped.`);
} catch (error) {
  console.error(`Secret checks failed: ${error?.name === "AssertionError" ? "assertion" : "operation"}.`);
  console.error(error?.message ?? "secret checks failed");
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /secrets\.mjs:\d+:\d+/.test(line)).join("\n"));
  process.exitCode = 1;
} finally {
  for (const file of locked) {
    if (process.platform === "win32") {
      const who = spawnSync("whoami", { encoding: "utf8", windowsHide: true }).stdout.trim();
      spawnSync("icacls", [file, "/remove:d", who, "/grant", `${who}:(F)`], { windowsHide: true });
    } else chmodSync(file, 0o600);
  }
  rmSync(scratch, { recursive: true, force: true });
}
