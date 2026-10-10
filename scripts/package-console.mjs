// Packs build/stage (see scripts/stage.mjs) for the console install: build/release gets vault-x64.zip, install.ps1 and SHA256SUMS.txt.
// The zip is written here with Node's own zlib, so it needs no archiver and keeps forward slashes in its entry names.
// Usage: node scripts/package-console.mjs [--keep | --finish]
//   (no option)  clears build/release, then writes the zip and install.ps1 and sums the files there.
//   --keep       does the same without clearing, so the installer that is already in build/release stays (the signed release repacks the zip this way).
//   --finish     for the end of npm run dist: checks that build/release has the five release files (see scripts/release-files.mjs), removes the
//                debug files electron-builder leaves, writes latest.yml and the blockmap again when the installer changed since it was built (signing
//                does that), and writes SHA256SUMS.txt for the five files.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { INSTALLER, RELEASE_FILES, SUMS_FILE, filesIn, latestHash, refreshLatest, releaseProblems, sha512Base64, sizes, sumsText } from "./release-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), stage = join(root, "build", "stage"), release = join(root, "build", "release");
const fail = message => { console.error(message); process.exit(1); };
const mode = process.argv[2];
if (process.argv.length > 3 || mode !== undefined && mode !== "--keep" && mode !== "--finish") fail("Usage: node scripts/package-console.mjs [--keep | --finish]");
if (mode !== "--finish" && !existsSync(join(stage, "lib", "package.json"))) fail("There is no staged layout. Run node scripts/stage.mjs first.");
const files = folder => readdirSync(folder, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(folder, item.name)) : [join(folder, item.name)]).sort();

// ZIP, version 2.0: names in UTF-8, each file deflated or stored when deflating does not help, no ZIP64 (the layout is far below 4 GiB).
function zip(list) {
  const parts = [], central = []; let offset = 0;
  for (const file of list) {
    const name = Buffer.from(relative(stage, file).split(sep).join("/")), data = readFileSync(file), packed = deflateRawSync(data, { level: 9 }), deflated = packed.length < data.length, body = deflated ? packed : data;
    const when = statSync(file).mtime, time = when.getHours() << 11 | when.getMinutes() << 5 | when.getSeconds() >> 1, date = Math.max(0, when.getFullYear() - 1980) << 9 | (when.getMonth() + 1) << 5 | when.getDate();
    const shared = Buffer.alloc(26); // version needed, flags, method, time, date, crc, sizes, name length, extra length
    shared.writeUInt16LE(20, 0); shared.writeUInt16LE(0x0800, 2); shared.writeUInt16LE(deflated ? 8 : 0, 4); shared.writeUInt16LE(time, 6); shared.writeUInt16LE(date, 8);
    shared.writeUInt32LE(crc32(data), 10); shared.writeUInt32LE(body.length, 14); shared.writeUInt32LE(data.length, 18); shared.writeUInt16LE(name.length, 22);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, name]);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); shared.copy(entry, 6, 0, 26);
    entry.writeUInt32LE(offset, 42); central.push(Buffer.concat([entry, name]));
    parts.push(local, body); offset += local.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (offset + directory.length > 0xfffffffe || list.length > 0xfffe) throw new Error("The layout is too large for a plain ZIP.");
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const report = list => list.map(([name, size]) => `${name}  ${size} bytes`).join("\n");
if (mode === "--finish") {
  const { missing, unexpected } = releaseProblems(existsSync(release) ? filesIn(release) : []);
  if (missing.length) fail(`build/release lacks ${missing.join(", ")}. Run npm run dist.`);
  for (const name of unexpected) rmSync(join(release, name));
  // Signing changes the installer after electron-builder wrote its blockmap and latest.yml, and the updater refuses an installer that does not match them.
  const installer = join(release, INSTALLER), latest = join(release, "latest.yml"), text = readFileSync(latest, "utf8"), hash = sha512Base64(installer);
  if (latestHash(text) !== hash) {
    const { buildBlockMap } = createRequire(import.meta.url)("app-builder-lib/out/targets/blockmap/blockmap.js");
    const info = await buildBlockMap(installer, "gzip", `${installer}.blockmap`);
    if (info.sha512 !== hash) fail("The installer changed while its blockmap was written.");
    writeFileSync(latest, refreshLatest(text, info.sha512, info.size));
    console.log("The installer changed since it was built: latest.yml and the blockmap were written again.");
  }
  writeFileSync(join(release, SUMS_FILE), sumsText(release, RELEASE_FILES));
  const lines = [`Release files in ${release}`, report(sizes(release, [...RELEASE_FILES, SUMS_FILE]))];
  if (unexpected.length) lines.push(`Removed: ${unexpected.join(", ")}`);
  console.log([...lines, readFileSync(join(release, SUMS_FILE), "utf8")].join("\n").trimEnd());
} else {
  if (mode !== "--keep") rmSync(release, { recursive: true, force: true });
  mkdirSync(release, { recursive: true });
  copyFileSync(join(root, "scripts", "install.ps1"), join(release, "install.ps1"));
  writeFileSync(join(release, "vault-x64.zip"), zip(files(stage)));
  // One line per file, as sha256sum prints it. The sums file cannot list itself, and a folder beside the files (the unpacked app) is not one of them.
  const sums = sumsText(release, filesIn(release).filter(name => name !== SUMS_FILE));
  writeFileSync(join(release, SUMS_FILE), sums);
  console.log(`Packed ${release}\n${sums}`.trimEnd());
}
