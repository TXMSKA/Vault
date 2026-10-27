import "../../../test/guard.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS, newEntry, encrypt, decrypt, decryptJson, encryptJson, unlock } from "vault-core";
import { Vault } from "../src/vault.ts";

const parent = resolve(fileURLToPath(new URL("../../../.test-tmp/", import.meta.url))); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, "service-backup-")), vaults = [], password = "Synthetic backup master password", backupPassword = "Synthetic encrypted backup password", wrongPassword = "Synthetic wrong backup password";
const app = { id: "vault-app", name: "Synthetic backup app", kind: "cosmic", status: "granted", kinds: [...KINDS], permissions: [] };
let checks = 0, stage = "20 MiB fixture";
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "rejects"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
const key = vault => vault.memory.get(vault.memory.ticket());
const make = async name => { const vault = new Vault(join(scratch, name, "store"), () => 0, 1e12, () => {}); vaults.push(vault); await vault.create(password); return vault; };
const entries = async vault => (await vault.rows()).map(row => row.entry);
const normalized = values => values.map(value => { const entry = structuredClone(value); for (const file of entry.files) file.chunks = []; return entry; }).sort((a, b) => a.id.localeCompare(b.id));
const chunkNames = async vault => (await readdir(vault.store.folder)).filter(name => name.startsWith("chunk-")).sort();
async function fixture(vault, count, size) {
  const values = KINDS.map(kind => { const entry = newEntry(kind); entry.title = `synthetic-private-backup-${kind}`; entry.note = `synthetic-private-backup-note-${kind}`; if (kind === "apikey") { entry.fields.find(field => field.id === "key").value = `synthetic-private-backup-value-${kind}`; } else entry.fields = [{ id: "SYNTHETIC_BACKUP_FIELD", name: "Synthetic field", value: `synthetic-private-backup-value-${kind}`, secret: true }]; return entry; });
  const document = values.find(entry => entry.kind === "doc"), chunks = [], hash = createHash("sha256"), bytes = Buffer.alloc(size);
  try {
    await vault.store.staged(async store => { for (let index = 0; index < count; index++) { bytes.fill(index % 251); if (size >= 4) bytes.writeUInt32BE(index); const id = randomUUID(); chunks.push(id); hash.update(bytes); await store.putChunk(id, await encrypt(key(vault), Uint8Array.from(bytes), `chunk:${id}`)); } });
    document.files = [{ id: randomUUID(), name: "synthetic-private-backup-file.bin", type: "application/octet-stream", size: count * size, chunks }];
    for (const entry of values) await vault.save(app, entry, 0);
    return { entries: values, document, digest: hash.digest("hex") };
  } finally { bytes.fill(0); }
}
async function attachmentHash(vault, document) {
  const hash = createHash("sha256"); for (const id of document.files[0].chunks) { const bytes = await decrypt(key(vault), await vault.store.getChunk(id), `chunk:${id}`); try { hash.update(bytes); } finally { bytes.fill(0); } } return hash.digest("hex");
}
async function measured(operation) {
  const before = process.memoryUsage().rss, start = performance.now(); let peak = before;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); }, timer = setInterval(sample, 5);
  try { const value = await operation(); sample(); return { value, growth: peak - before, ms: performance.now() - start }; } finally { clearInterval(timer); }
}
async function inspect(path, expected) {
  const hash = createHash("sha256"), lines = createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity }); let index = 0, header, backupKey, trailer, bytes = 0;
  for await (const line of lines) {
    const value = JSON.parse(line); bytes += Buffer.byteLength(`${line}\n`);
    for (const hidden of [password, backupPassword, expected.document.title, expected.document.note, expected.document.files[0].name]) check.equal(line.includes(hidden), false);
    if (index === 0) { header = value; check.deepEqual(Object.keys(header).sort(), ["counts", "envelope", "format", "version"]); check.equal(header.format, "vault-backup"); check.equal(header.version, 2); check.deepEqual(header.counts, { entries: expected.entries.length, chunks: expected.document.files[0].chunks.length }); const opened = await unlock(header.envelope, backupPassword); backupKey = opened.key; opened.bytes.fill(0); }
    else if (index <= expected.entries.length) { check.deepEqual(Object.keys(value), ["entry"]); check.deepEqual(await decryptJson(backupKey, value.entry, `backup-entry:${index - 1}`), expected.entries[index - 1]); }
    else if (index <= expected.entries.length + header.counts.chunks) { const chunk = index - expected.entries.length - 1; check.deepEqual(Object.keys(value).sort(), ["chunk", "id"]); check.equal(value.id, expected.document.files[0].chunks[chunk]); const opened = await decrypt(backupKey, value.chunk, `backup-chunk:${chunk}:${value.id}`); check.equal(opened.length, 32768); opened.fill(0); }
    else { check.equal(trailer, undefined); check.deepEqual(Object.keys(value), ["end"]); trailer = await decryptJson(backupKey, value.end, "backup-end"); check.deepEqual(trailer, { ...header.counts, digest: hash.digest("hex") }); }
    if (!trailer) hash.update(`${line}\n`); index++;
  }
  check.equal(index, expected.entries.length + expected.document.files[0].chunks.length + 2); check.equal(Boolean(trailer), true); check.equal(bytes, (await stat(path)).size);
}
async function unchanged(vault, operation) {
  const beforeEntries = await entries(vault), beforeChunks = await chunkNames(vault); await check.rejects(operation); check.deepEqual(await entries(vault), beforeEntries); check.deepEqual(await chunkNames(vault), beforeChunks);
}
async function altered(path, lines, change) { const changed = await change([...lines]); await writeFile(path, changed.join("\n") + "\n", { mode: 0o600 }); return path; }

try {
  const source = await make("source"), large = await fixture(source, 640, 32768), path = join(scratch, "large.vault"), destination = await make("destination");
  // Store enumeration determines entry order; the attachment's chunk order stays unchanged.
  large.entries = await entries(source);
  stage = "20 MiB export";
  const exported = await measured(() => source.exportToFile(backupPassword, path));
  check.deepEqual(exported.value, { entries: KINDS.length, chunks: 640, bytes: (await stat(path)).size }); check.equal(exported.growth < 64 * 1024 * 1024, true);
  console.log(`Vault backup 20 MiB export: ${(exported.growth / 1024 / 1024).toFixed(3)} MiB peak RSS growth, ${(exported.ms / 1000).toFixed(3)} s.`);
  if (process.platform !== "win32") check.equal((await stat(path)).mode & 0o777, 0o600);
  stage = "version 2 encrypted lines and trailer digest"; await inspect(path, large);
  stage = "20 MiB restore";
  const restored = await measured(() => destination.restoreFromFile(app, path, backupPassword));
  check.deepEqual(restored.value, { imported: KINDS.length, duplicates: 0, skipped: 0 }); check.equal(restored.growth < 64 * 1024 * 1024, true);
  console.log(`Vault backup 20 MiB restore: ${(restored.growth / 1024 / 1024).toFixed(3)} MiB peak RSS growth, ${(restored.ms / 1000).toFixed(3)} s.`);
  const restoredEntries = await entries(destination), document = restoredEntries.find(entry => entry.kind === "doc"); check.deepEqual(normalized(restoredEntries), normalized(large.entries)); check.equal(await attachmentHash(destination, document), large.digest);
  check.equal(new Set(document.files[0].chunks).size, 640); check.equal(document.files[0].chunks.some(id => large.document.files[0].chunks.includes(id)), false);

  stage = "legacy backups and duplicate rules";
  const smallSource = await make("small-source"), small = await fixture(smallSource, 2, 32), smallPath = join(scratch, "small.vault"), legacyDestination = await make("legacy-destination"); await smallSource.exportToFile(backupPassword, smallPath);
  const legacy = await smallSource.export(backupPassword); check.equal(legacy.version, 1); check.deepEqual(await legacyDestination.restore(app, legacy, backupPassword), { imported: KINDS.length, duplicates: 0, skipped: 0 }); check.deepEqual(normalized(await entries(legacyDestination)), normalized(small.entries)); check.equal(await attachmentHash(legacyDestination, (await entries(legacyDestination)).find(entry => entry.kind === "doc")), small.digest);
  const beforeDuplicateChunks = await chunkNames(legacyDestination); check.deepEqual(await legacyDestination.restoreFromFile(app, smallPath, backupPassword), { imported: 0, duplicates: KINDS.length, skipped: 0 }); check.deepEqual(await chunkNames(legacyDestination), beforeDuplicateChunks);

  stage = "invalid files apply nothing";
  const lines = (await readFile(smallPath, "utf8")).trimEnd().split("\n"), firstChunk = KINDS.length + 1, empty = await make("invalid-destination"), badPath = name => join(scratch, `${name}.vault`);
  const mutations = [
    ["no-trailer", values => values.slice(0, -1)],
    ["changed-chunk", values => { const chunk = JSON.parse(values[firstChunk]); chunk.chunk.data = `${chunk.chunk.data[0] === "A" ? "B" : "A"}${chunk.chunk.data.slice(1)}`; values[firstChunk] = JSON.stringify(chunk); return values; }],
    ["swapped-chunks", values => { [values[firstChunk], values[firstChunk + 1]] = [values[firstChunk + 1], values[firstChunk]]; return values; }],
    ["swapped-entries", values => { [values[1], values[2]] = [values[2], values[1]]; return values; }],
    ["foreign-header", values => { const header = JSON.parse(values[0]); header.format = "vault-sync"; values[0] = JSON.stringify(header); return values; }],
    ["wrong-count", values => { const header = JSON.parse(values[0]); header.counts.chunks++; values[0] = JSON.stringify(header); return values; }],
    ["over-chunk-limit", values => { const header = JSON.parse(values[0]); header.counts.chunks = 6401; values[0] = JSON.stringify(header); return values; }],
    ["over-entry-limit", values => { const header = JSON.parse(values[0]); header.counts.entries = 4097; values[0] = JSON.stringify(header); return values; }],
    ["negative-count", values => { const header = JSON.parse(values[0]); header.counts.entries = -1; values[0] = JSON.stringify(header); return values; }],
    ["extra-line", values => [...values, "{}"]],
    ["extra-header-key", values => { const header = JSON.parse(values[0]); header.extra = true; values[0] = JSON.stringify(header); return values; }],
  ];
  for (const [name, change] of mutations) { const changed = await altered(badPath(name), lines, change); await unchanged(empty, () => empty.restoreFromFile(app, changed, backupPassword)); }
  await unchanged(empty, () => empty.restoreFromFile(app, smallPath, wrongPassword));
  await unchanged(legacyDestination, () => legacyDestination.restoreFromFile(app, badPath("no-trailer"), backupPassword));
  const opened = await unlock(JSON.parse(lines[0]).envelope, backupPassword); opened.bytes.fill(0);
  // Authenticated chunk IDs must still match the entries' claims, even with a valid recomputed trailer.
  const forged = await altered(badPath("foreign-chunk-id"), lines, async values => { const id = randomUUID(), original = JSON.parse(values[firstChunk]), bytes = await decrypt(opened.key, original.chunk, `backup-chunk:0:${original.id}`); try { values[firstChunk] = JSON.stringify({ id, chunk: await encrypt(opened.key, bytes, `backup-chunk:0:${id}`) }); } finally { bytes.fill(0); } const digest = createHash("sha256").update(values.slice(0, -1).join("\n") + "\n").digest("hex"); values[values.length - 1] = JSON.stringify({ end: await encryptJson(opened.key, { entries: KINDS.length, chunks: 2, digest }, "backup-end") }); return values; });
  await unchanged(empty, () => empty.restoreFromFile(app, forged, backupPassword));

  stage = "changed source during the second pass";
  const mutableSource = await make("mutable-source"), mutablePath = join(scratch, "mutable.vault"); await fixture(mutableSource, 2, 32768); await mutableSource.exportToFile(backupPassword, mutablePath);
  const mutableLines = (await readFile(mutablePath, "utf8")).trimEnd().split("\n"), changedLine = firstChunk + 1, changedOffset = Buffer.byteLength(mutableLines.slice(0, changedLine).join("\n") + "\n") + mutableLines[changedLine].indexOf('"data":"') + 8, originalWriteFile = fs.promises.writeFile;
  let changedSource = false;
  fs.promises.writeFile = async function (path, ...args) {
    if (!changedSource && typeof path === "string" && dirname(path).startsWith(join(empty.store.folder, ".restore-"))) { changedSource = true; const file = await open(mutablePath, "r+"); try { const byte = Buffer.alloc(1); await file.read(byte, 0, 1, changedOffset); byte[0] = byte[0] === 65 ? 66 : 65; await file.write(byte, 0, 1, changedOffset); } finally { await file.close(); } }
    return originalWriteFile.call(this, path, ...args);
  }; syncBuiltinESMExports();
  try { await unchanged(empty, () => empty.restoreFromFile(app, mutablePath, backupPassword)); } finally { fs.promises.writeFile = originalWriteFile; syncBuiltinESMExports(); }
  check.equal(changedSource, true); check.deepEqual((await readdir(empty.store.folder)).filter(name => name.startsWith(".restore-")), []);

  stage = "absolute paths and exclusive output";
  const existing = join(scratch, "existing.vault"); await writeFile(existing, "synthetic-existing-file\n", { mode: 0o600 }); await check.rejects(() => smallSource.exportToFile(backupPassword, existing)); check.equal(await readFile(existing, "utf8"), "synthetic-existing-file\n");
  for (const invalid of ["relative.vault", "", `${scratch}\0bad`, join(scratch, "x".repeat(4096))]) { await check.rejects(() => smallSource.exportToFile(backupPassword, invalid)); await unchanged(empty, () => empty.restoreFromFile(app, invalid, backupPassword)); }
  stage = "partial output cleanup";
  const failed = join(scratch, "failed.vault"), originalGetChunk = smallSource.store.getChunk; let reads = 0;
  smallSource.store.getChunk = async function (...args) { if (++reads === 2) throw new Error("synthetic_chunk_failure"); return originalGetChunk.apply(this, args); };
  try { await check.rejects(() => smallSource.exportToFile(backupPassword, failed)); } finally { smallSource.store.getChunk = originalGetChunk; }
  check.equal(reads, 2); await check.rejects(() => stat(failed), error => error.code === "ENOENT");
  const syncFailed = join(scratch, "sync-failed.vault"), originalOpen = fs.promises.open; let synced = false, closed = false;
  fs.promises.open = async function (path, ...args) { const file = await originalOpen.call(this, path, ...args); if (path === syncFailed) { check.deepEqual(args, ["wx", 0o600]); const close = file.close.bind(file); file.sync = async () => { synced = true; throw new Error("synthetic_sync_failure"); }; file.close = async () => { closed = true; return close(); }; } return file; }; syncBuiltinESMExports();
  try { await check.rejects(() => smallSource.exportToFile(backupPassword, syncFailed)); } finally { fs.promises.open = originalOpen; syncBuiltinESMExports(); }
  check.equal(synced, true); check.equal(closed, true); await check.rejects(() => stat(syncFailed), error => error.code === "ENOENT");

  stage = "6400 chunks across entries";
  // Tiny synthetic chunks exercise the store's full claim limit without repeating the 20 MiB memory measurement.
  const scaleSource = new Vault(join(scratch, "scale-source", "store"), () => 0, 1e12, () => {}), scaleDestination = new Vault(join(scratch, "scale-destination", "store"), () => 0, 1e12, () => {}), scaleEntries = [], saved = [], stored = new Map(); vaults.push(scaleSource, scaleDestination);
  scaleSource.memory.open(key(source), scaleSource.memory.ticket()); scaleDestination.memory.open(key(destination), scaleDestination.memory.ticket()); await mkdir(scaleDestination.store.folder, { recursive: true });
  for (let index = 0; index < 10; index++) { const entry = newEntry("doc"); entry.title = `synthetic-scale-${index}`; entry.files = [{ id: randomUUID(), name: "synthetic-scale-file", type: "application/octet-stream", size: 640, chunks: Array.from({ length: 640 }, () => randomUUID()) }]; scaleEntries.push(entry); }
  const scaleRows = []; for (const entry of scaleEntries) scaleRows.push({ id: entry.id, sealed: await encryptJson(key(scaleSource), entry, `entry:${entry.id}`), version: 1, chunks: entry.files.flatMap(file => file.chunks) });
  scaleSource.store.entries = async () => scaleRows; scaleSource.store.getChunk = async id => encrypt(key(scaleSource), Uint8Array.of(7), `chunk:${id}`);
  scaleDestination.rows = async () => saved.map(entry => ({ entry, version: 1 })); scaleDestination.save = async (_app, entry) => { saved.push(structuredClone(entry)); return { version: 1 }; }; scaleDestination.store.putChunk = async (id, sealed) => { check.equal(stored.has(id), false); stored.set(id, sealed); return { version: 1 }; }; scaleDestination.store.removeChunk = async id => { stored.delete(id); };
  const scalePath = join(scratch, "scale.vault"), scaleExport = await scaleSource.exportToFile(backupPassword, scalePath); check.equal(scaleExport.chunks, 6400); check.equal(scaleExport.entries, 10); check.deepEqual(await scaleDestination.restoreFromFile(app, scalePath, backupPassword), { imported: 10, duplicates: 0, skipped: 0 }); check.equal(stored.size, 6400); check.deepEqual(normalized(saved), normalized(scaleEntries));
  for (const entry of saved) for (const id of entry.files[0].chunks) { const bytes = await decrypt(key(scaleDestination), stored.get(id), `chunk:${id}`); check.equal(bytes.length, 1); check.equal(bytes[0], 7); bytes.fill(0); }
  console.log(`Vault backup service: ${checks} checks passed.`);
} catch (error) {
  console.error(`Vault backup service failed at ${stage}: ${error?.name === "AssertionError" ? "assertion" : "operation"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*backup\.(?:test\.mjs|ts):\d+:\d+/.test(line)).join("\n"));
  throw new Error("backup service check failed");
} finally { for (const vault of vaults) vault.memory.lock(); assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true }); }
