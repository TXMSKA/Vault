// Packs build/stage (see scripts/stage.mjs) for the console install: build/release gets vault-x64.zip, install.ps1 and SHA256SUMS.txt.
// The zip is written here with Node's own zlib, so it needs no archiver and keeps forward slashes in its entry names.
// Usage: node scripts/package-console.mjs
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url)), stage = join(root, "build", "stage"), release = join(root, "build", "release");
if (!existsSync(join(stage, "lib", "package.json"))) { console.error("There is no staged layout. Run node scripts/stage.mjs first."); process.exit(1); }
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

rmSync(release, { recursive: true, force: true }); mkdirSync(release, { recursive: true });
copyFileSync(join(root, "scripts", "install.ps1"), join(release, "install.ps1"));
writeFileSync(join(release, "vault-x64.zip"), zip(files(stage)));
// One line per file, as sha256sum prints it. The sums file cannot list itself.
const sums = readdirSync(release).sort().map(name => `${createHash("sha256").update(readFileSync(join(release, name))).digest("hex")}  ${name}\n`).join("");
writeFileSync(join(release, "SHA256SUMS.txt"), sums);
console.log(`Packed ${release}\n${sums}`.trimEnd());
