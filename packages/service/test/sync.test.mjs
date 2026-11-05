import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rename, cp, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { startService } from "../src/server.ts";
import { Sync, FolderTransport, recoverSync } from "../src/sync.ts";
import { connect } from "../../client/dist/index.js";
import { main } from "../../cli/src/main.ts";
import { newEntry, encrypt, encryptJson, decrypt, decryptJson, unlock, sealSync, openSync, syncPatterns, SYNC_PACKAGE_CAP, SYNC_BLOB_CAP, VaultMemory } from "vault-core";
const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-sync-")), folder = join(scratch, "shared"), services = [], clients = [], password = "Synthetic sync master password", nextPassword = "Synthetic next master password", hidden = [], previousHome = process.env.VAULT_HOME, previousLocale = process.env.LC_ALL;
let checks = 0, stage = "all entry kinds", now = Date.now();
const regression = count => { checks += count; };
const tokens = () => { let token; return { async get() { return token; }, async set(value) { token = value; } }; };
const make = async name => { const home = join(scratch, name), service = await startService({ home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(service); const api = await connect({ home, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(api); return { home, service, api }; };
const reject = (run, code) => assert.rejects(run, error => error.code === code);
async function files(root) { const result = []; for (const item of await readdir(root, { withFileTypes: true })) { const path = join(root, item.name); if (item.isDirectory()) result.push(...await files(path)); else result.push(path); } return result; }
const state = async v => JSON.parse(await readFile(join(v.home, "sync", "state.json"), "utf8"));
const key = v => v.service.vault.memory.get(v.service.vault.memory.ticket());
const storeHash = async v => { const paths = (await files(join(v.home, "store"))).sort(), hash = createHash("sha256"); for (const path of paths) hash.update(await readFile(path)); return hash.digest("hex"); };
const equal = async (a, b) => { const rows = async v => (await v.api.entries.list()).map(row => row.entry).sort((a, b) => a.id.localeCompare(b.id)); assert.deepEqual(await rows(a), await rows(b)); checks++; };
const sync = async v => { now++; await v.api.sync.now(); };
// A forced checkpoint run bypasses the service queue, so a scheduled pulse of the same service could replay the fresh outbox into the same staging index at once. Hold this service's pulses until the forced run is done, then let them go.
const forced = async v => { const engine = v.service.sync, pulse = engine.pulse; let release; const gate = new Promise(done => { release = done; }); engine.pulse = async function (...args) { await gate; return pulse.apply(this, args); }; try { while (engine.pulsing) await new Promise(done => setTimeout(done, 10)); const c = engine.config; await engine.run(c, await engine.current(c, key(v)), key(v), v.service.vault.memory.ticket(), true, c); } finally { engine.pulse = pulse; release(); } };
async function fingerprints(root) { const result = {}; for (const path of (await files(root)).sort()) { const info = await stat(path, { bigint: true }); result[path.slice(root.length)] = { ino: info.ino, mtime: info.mtimeNs }; } return result; }
const rewritten = (before, after) => Object.keys(after).filter(name => !before[name] || before[name].ino !== after[name].ino || before[name].mtime !== after[name].mtime);
async function pendingSnapshot(v, header) { const path = join(v.home, "sync", "outbox", header.index, "snapshot"), { parts } = JSON.parse(await readFile(join(path, "parts.json"), "utf8")), publications = []; for (let part = 0; part < parts; part++) { const payload = await decryptJson(key(v), JSON.parse(await readFile(join(path, `${part}.json`), "utf8")), `sync-local:${header.datasetId}:${header.index}:${part}`); if (payload.section === "publications") for (const item of payload.items) { publications[item.publication] ??= { path: item.path, bytes: "" }; publications[item.publication].bytes += item.bytes; } } return { publications }; }
try {
  stage = "idle and single-entry write measurement";
  const measured = await make("measured"), measuredPeer = await make("measured-peer"), measuredFolder = join(scratch, "measured-shared"), measuredEntries = [];
  await measured.api.create(password);
  const measuredChunkId = randomUUID(), measuredChunk = Buffer.from("synthetic-measured-attachment"); await measured.service.vault.store.putChunk(measuredChunkId, await encrypt(key(measured), Uint8Array.from(measuredChunk), `chunk:${measuredChunkId}`));
  for (let i = 0; i < 300; i++) { const entry = newEntry("login"); entry.title = `synthetic-measured-${i}`; if (i === 299) entry.files = [{ id: randomUUID(), name: "synthetic-measured-file", type: "application/octet-stream", size: measuredChunk.length, chunks: [measuredChunkId] }]; measuredEntries.push(entry); const sealed = await encryptJson(key(measured), entry, `entry:${entry.id}`); await writeFile(join(measured.home, "store", `entry-${entry.id}.json`), JSON.stringify({ version: 1, value: { id: entry.id, sealed, chunks: entry.files.flatMap(file => file.chunks) } })); } measuredChunk.fill(0);
  await mkdir(join(measured.home, "sync", "outbox", randomUUID(), "snapshot"), { recursive: true });
  await measured.service.sync.setup(measuredFolder); await measuredPeer.service.sync.join(measuredFolder, password, false);
  assert.deepEqual(await readdir(join(measured.home, "sync", "outbox")), []); regression(1);
  const measuredStore = join(measured.home, "store"), measuredIndex = join(measured.home, "sync", "index"), measuredKept = join(measured.home, "sync", "kept"), storeInode = (await stat(measuredStore, { bigint: true })).ino, idleFiles = await fingerprints(measuredStore), idleIndexFiles = await fingerprints(measuredIndex), idleIndexInfo = await stat(measuredIndex, { bigint: true }), idleKeptFiles = await fingerprints(measuredKept), idleHeader = await state(measured);
  const measurementRead = FolderTransport.prototype.read, reads = [];
  const measurementChunkRead = measured.service.vault.store.getChunk; let idleChunkReads = 0;
  measured.service.vault.store.getChunk = async function (...args) { idleChunkReads++; return measurementChunkRead.apply(this, args); };
  FolderTransport.prototype.read = async function (...args) { reads.push(args[0]); return measurementRead.apply(this, args); };
  try { now++; await measured.service.sync.pulse(); } finally { FolderTransport.prototype.read = measurementRead; measured.service.vault.store.getChunk = measurementChunkRead; }
  assert.equal(idleChunkReads, 0); regression(1);
  assert.equal((await stat(measuredStore, { bigint: true })).ino, storeInode); assert.deepEqual(await fingerprints(measuredStore), idleFiles); assert.deepEqual(await fingerprints(measuredIndex), idleIndexFiles); assert.equal((await stat(measuredIndex, { bigint: true })).ino, idleIndexInfo.ino); assert.equal((await stat(measuredIndex, { bigint: true })).mtimeNs, idleIndexInfo.mtimeNs); assert.deepEqual(await fingerprints(measuredKept), idleKeptFiles); assert.equal((await state(measured)).index, idleHeader.index); assert.equal((await state(measured)).lastSynced, new Date(now).toISOString()); assert.deepEqual(await readdir(join(measured.home, "sync", "outbox")), []); assert.deepEqual(reads, []); regression(10);
  const editMeasured = async (entry, note) => { entry.note = note; const row = (await measured.service.vault.store.entries()).find(row => row.id === entry.id); await measured.service.vault.store.save(entry.id, await encryptJson(key(measured), entry, `entry:${entry.id}`), row.version, []); };
  await editMeasured(measuredEntries[0], "synthetic-one-edited-entry"); const localAfterEdit = await fingerprints(measuredStore), peerBeforeEdit = await fingerprints(join(measuredPeer.home, "store")), ownPackages = new Set((await files(measuredFolder)).filter(path => /[\\/](batches|checkpoints)[\\/]/.test(path)).map(path => path.slice(join(measuredFolder, "Vault Sync", idleHeader.datasetId).length + 1).replaceAll("\\", "/"))); reads.length = 0;
  FolderTransport.prototype.read = async function (...args) { reads.push(args[0]); return measurementRead.apply(this, args); };
  try { now++; await measured.service.sync.pulse(); } finally { FolderTransport.prototype.read = measurementRead; }
  assert.deepEqual(rewritten(idleFiles, await fingerprints(measuredStore)), [`${process.platform === "win32" ? "\\" : "/"}entry-${measuredEntries[0].id}.json`]); assert.deepEqual(await fingerprints(measuredStore), localAfterEdit); assert.equal(reads.some(path => ownPackages.has(path)), false); regression(3);
  await measuredPeer.service.sync.pulse(); assert.deepEqual(rewritten(peerBeforeEdit, await fingerprints(join(measuredPeer.home, "store"))), [`${process.platform === "win32" ? "\\" : "/"}entry-${measuredEntries[0].id}.json`]); await equal(measured, measuredPeer); regression(1);
  stage = "unfinished local outbox writes";
  for (const kind of ["no-header", "partial-header", "no-manifest", "partial-manifest", "missing-part"]) { const header = { ...await state(measured), index: randomUUID() }, path = join(measured.home, "sync", "outbox", header.index); await mkdir(join(path, "snapshot"), { recursive: true }); await writeFile(join(path, "snapshot", "0.json"), "{}"); if (kind === "partial-header") await writeFile(join(path, "state.json"), '{"format":'); else if (kind !== "no-header") await writeFile(join(path, "state.json"), JSON.stringify(header)); if (kind === "partial-manifest") await writeFile(join(path, "snapshot", "parts.json"), '{"parts":'); if (kind === "missing-part") { await rm(join(path, "snapshot", "0.json")); await writeFile(join(path, "snapshot", "parts.json"), '{"parts":1}'); } }
  now++; await measured.service.sync.pulse(); assert.deepEqual(await readdir(join(measured.home, "sync", "outbox")), []); assert.equal((await measured.service.sync.status()).failure, null); assert.deepEqual(await fingerprints(measuredStore), localAfterEdit); regression(3);
  stage = "actionable folder and local failures";
  const measurementList = FolderTransport.prototype.list;
  for (const [errno, cause] of [["ENOENT", "sync_folder_missing"], ["EPERM", "sync_permission_denied"], ["EACCES", "sync_access_denied"], ["EBUSY", "sync_busy"]]) {
    FolderTransport.prototype.list = async function () { throw Object.assign(new Error("synthetic_file_failure"), { code: errno }); };
    try { await reject(() => measured.service.sync.pulse(), cause); } finally { FolderTransport.prototype.list = measurementList; }
    assert.equal((await measured.service.sync.status()).failure.cause, cause); regression(2);
    const originalOpen = fs.promises.open;
    fs.promises.open = async (path, ...args) => { if (dirname(path) === measuredStore && args[0] === "wx") throw Object.assign(new Error("synthetic_local_failure"), { code: errno }); return originalOpen(path, ...args); }; syncBuiltinESMExports();
    try { await reject(() => measured.service.sync.pulse(), cause); } finally { fs.promises.open = originalOpen; syncBuiltinESMExports(); }
    assert.equal((await measured.service.sync.status()).failure.cause, cause); regression(2);
    const originalMkdir = fs.mkdirSync, localSync = new Sync(measured.home, measured.service.vault, () => now, async () => {}, () => {}); await localSync.load();
    fs.mkdirSync = (path, ...args) => { if (path === join(measured.home, "sync")) throw Object.assign(new Error("synthetic_permission_failure"), { code: errno }); return originalMkdir(path, ...args); };
    try { await reject(() => localSync.pulse(), cause); } finally { fs.mkdirSync = originalMkdir; }
    assert.equal((await localSync.status()).failure.cause, cause); regression(2);
  }
  await rename(join(measuredFolder, "Vault Sync", idleHeader.datasetId), join(measuredFolder, "missing-dataset"));
  try { await reject(() => measured.service.sync.pulse(), "sync_folder_missing"); assert.equal((await measured.service.sync.status()).failure.cause, "sync_folder_missing"); regression(2); } finally { await rename(join(measuredFolder, "missing-dataset"), join(measuredFolder, "Vault Sync", idleHeader.datasetId)); }
  await measured.service.sync.pulse(); assert.equal((await measured.service.sync.status()).failure, null); regression(1);
  stage = "hard-linked stage process crashes";
  for (const point of ["stage", "swap", "state"]) {
    const beforeCrash = await fingerprints(join(measuredPeer.home, "store")), beforeHash = await storeHash(measuredPeer), beforeHeader = await state(measuredPeer), target = measuredEntries[1];
    await editMeasured(target, `synthetic-crash-${point}`); await measured.service.sync.pulse(); await measuredPeer.api.close(); await measuredPeer.service.shutdown();
    const program = `
      let step = 'imports'; try {
      await import('./test/guard.mjs'); await import('./packages/service/test/privacy-fixture.mjs');
      const fs = (await import('node:fs')).default, { join, dirname } = await import('node:path');
      const { startService } = await import('./packages/service/src/server.ts'), { unlock } = await import('vault-core');
      const home = process.env.SYNC_CRASH_HOME, point = process.env.SYNC_CRASH_POINT, entryId = process.env.SYNC_CRASH_ENTRY;
      step = 'start'; const service = await startService({ home, now: () => 0, idleMs: 1e12, presenceMs: 1e12 });
      step = 'unlock';
      const opened = await unlock((await service.vault.store.envelope()).state, 'Synthetic sync master password'); opened.bytes.fill(0); service.vault.memory.open(opened.key, service.vault.memory.ticket());
      const rename = fs.renameSync, renameAsync = fs.promises.rename, { syncBuiltinESMExports } = await import('node:module');
      const crash = (from, to) => { const outbox = join(home, 'sync', 'outbox');
        if (point === 'stage' && dirname(to).startsWith(outbox) && to.endsWith('entry-' + entryId + '.json') || point === 'swap' && from.startsWith(outbox) && to === join(home, 'store') || point === 'state' && to === join(home, 'sync', 'state.json')) process.exit(86);
      };
      fs.renameSync = (from, to) => { rename(from, to); crash(from, to); };
      fs.promises.rename = async (from, to) => { await renameAsync(from, to); crash(from, to); }; syncBuiltinESMExports();
      step = 'pulse'; await service.sync.pulse(); process.exit(87);
      } catch (error) { process.stdout.write(JSON.stringify({ step, code: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'operation' })); process.exit(88); }
    `;
    let diagnostic = "";
    const exit = await new Promise((done, fail) => { const child = spawn(process.execPath, ["--input-type=module", "-e", program], { cwd: new URL("../../../", import.meta.url), env: { ...process.env, SYNC_CRASH_HOME: measuredPeer.home, SYNC_CRASH_POINT: point, SYNC_CRASH_ENTRY: target.id }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, signal: AbortSignal.timeout(60000) }); child.stdout.on("data", bytes => { diagnostic += bytes; }); child.once("error", fail); child.once("exit", done); }); if (exit !== 86) console.error(`Vault sync crash test ${point}: exit ${exit}, ${diagnostic}.`); assert.equal(exit, 86); regression(1);
    measuredPeer.service = await startService({ home: measuredPeer.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(measuredPeer.service);
    if (point !== "state") { assert.equal(await storeHash(measuredPeer), beforeHash); assert.deepEqual(await fingerprints(join(measuredPeer.home, "store")), beforeCrash); assert.equal((await state(measuredPeer)).index, beforeHeader.index); regression(3); }
    const opened = await unlock((await measuredPeer.service.vault.store.envelope()).state, password); opened.bytes.fill(0); measuredPeer.service.vault.memory.open(opened.key, measuredPeer.service.vault.memory.ticket());
    await measuredPeer.service.sync.pulse(); measuredPeer.api = await connect({ home: measuredPeer.home, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(measuredPeer.api);
    assert.equal((await measuredPeer.api.entries.get(target.id)).entry.note === target.note, true); assert.deepEqual(rewritten(beforeCrash, await fingerprints(join(measuredPeer.home, "store"))), [`${process.platform === "win32" ? "\\" : "/"}entry-${target.id}.json`]); assert.deepEqual(await readdir(join(measuredPeer.home, "sync", "outbox")), []); await equal(measured, measuredPeer); regression(3);
  }
  await measured.api.close(); await measured.service.shutdown(); await measuredPeer.api.close(); await measuredPeer.service.shutdown();
  stage = "all entry kinds";
  const a = await make("a"), b = await make("b"), kit = await a.api.create(password), entries = [];
  for (const kind of ["login", "card", "doc", "note", "key", "custom", "env"]) { const entry = newEntry(kind); entry.title = `synthetic-private-title-${kind}`; entry.note = `synthetic-private-note-${kind}`; entry.fields = [{ id: `SYNTHETIC_${kind.toUpperCase()}_FIELD`, name: `synthetic-private-field-name-${kind}`, value: `synthetic-private-value-${kind}`, secret: true }]; hidden.push(entry.title, entry.note, entry.fields[0].id, entry.fields[0].name, entry.fields[0].value); entries.push(entry); }
  const chunkId = randomUUID(), attached = Buffer.from("synthetic-private-attachment-bytes"), document = entries.find(entry => entry.kind === "doc"); document.files = [{ id: randomUUID(), name: "synthetic-private-filename", type: "application/octet-stream", size: attached.length, chunks: [chunkId] }]; hidden.push(document.files[0].name, attached.toString(), password, kit.recovery);
  await a.service.vault.store.putChunk(chunkId, await encrypt(key(a), Uint8Array.from(attached), `chunk:${chunkId}`)); for (const entry of entries) await a.api.entries.save(entry, 0);
  const started = performance.now(); await a.api.sync.setup(folder); console.log(`Vault sync initial pulse: ${((performance.now() - started) / 1000).toFixed(3)} s.`);
  await b.api.sync.join(folder, { password }); await equal(a, b);
  const bytes = await decrypt(key(b), await b.service.vault.store.getChunk(chunkId), `chunk:${chunkId}`); assert.equal(Buffer.from(bytes).equals(attached), true); bytes.fill(0); attached.fill(0); checks++;
  const c = await make("c"), d = await make("d"); await c.api.sync.join(folder, { recovery: kit.recovery }); await equal(a, c);
  const checkpointRead = FolderTransport.prototype.read; let checkpointReads = 0, batchReads = 0;
  FolderTransport.prototype.read = async function (...args) { if (args[0].includes("/checkpoints/")) checkpointReads++; if (args[0].includes("/batches/")) batchReads++; return checkpointRead.apply(this, args); };
  try { await d.api.sync.join(folder, { password }); } finally { FolderTransport.prototype.read = checkpointRead; } await equal(a, d); assert.equal(checkpointReads > 0, true); assert.equal(batchReads, 0); checks += 2;
  const joinedState = await state(d), checkpointNames = (await files(folder)).filter(path => path.includes("checkpoints")); assert.equal(checkpointNames.length >= 4, true); assert.equal(joinedState.sequence, 0); checks += 2; await c.api.close(); await c.service.shutdown(); await d.api.close(); await d.service.shutdown();
  stage = "join authentication backoff";
  const wrong = await make("wrong"); await reject(() => wrong.api.sync.join(folder, { password: "Synthetic wrong master password" }), "locked"); await reject(() => wrong.api.sync.join(folder, { password }), "limited"); assert.equal((await wrong.api.status()).created, false); now += 1000;
  await reject(() => wrong.api.sync.join(folder, { recovery: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA" }), "locked"); await reject(() => wrong.api.sync.join(folder, { recovery: kit.recovery }), "limited"); assert.equal((await wrong.api.status()).created, false); now += 2000; await wrong.api.sync.join(folder, { recovery: kit.recovery }); checks += 6; await wrong.api.close(); await wrong.service.shutdown();
  const occupied = await make("occupied"); await occupied.api.create(password); await reject(() => occupied.api.sync.join(folder, { password }), "sync_existing"); checks++; await occupied.api.close(); await occupied.service.shutdown();
  stage = "concurrent edits, restore and dismiss";
  const login = entries[0], change = async (v, entryId, value) => { hidden.push(value); const row = await v.api.entries.get(entryId); row.entry.note = value; row.entry.updatedAt = new Date(now).toISOString(); await v.api.entries.save(row.entry, row.version); };
  await change(a, login.id, "synthetic-older-edit"); await change(b, login.id, "synthetic-newer-edit"); await sync(a); await sync(b); await sync(a); await equal(a, b); assert.equal((await a.api.entries.get(login.id)).entry.note === "synthetic-newer-edit", true);
  const conflictsA = await a.api.sync.conflicts(), conflictsB = await b.api.sync.conflicts(); assert.equal(conflictsA.length, 1); assert.equal(conflictsB.length, 1); assert.equal(conflictsA[0].id, conflictsB[0].id); await a.api.sync.restore(conflictsA[0].id); await sync(a); await sync(b); await equal(a, b); assert.equal((await b.api.entries.get(login.id)).entry.note === "synthetic-older-edit", true); await b.api.sync.dismiss(conflictsB[0].id); assert.equal((await b.api.sync.conflicts()).length, 0); checks += 7;
  stage = "delete against edit";
  const note = entries.find(entry => entry.kind === "note"), noteRow = await a.api.entries.get(note.id); await a.api.entries.remove(note.id, noteRow.version); await change(b, note.id, "synthetic-edit-beats-delete"); await sync(a); await sync(b); await sync(a); await equal(a, b); assert.equal((await a.api.entries.get(note.id)).entry.note === "synthetic-edit-beats-delete", true); assert.equal((await a.api.sync.conflicts()).some(row => row.deleted), true); checks += 2;
  stage = "simultaneous attachments keep the losing bytes";
  const digest = async (v, chunk) => { const bytes = await decrypt(key(v), await v.service.vault.store.getChunk(chunk), `chunk:${chunk}`), hash = createHash("sha256").update(bytes).digest("hex"); bytes.fill(0); return hash; };
  const attach = async (v, entryId, label) => { const chunk = randomUUID(), body = Buffer.from(`synthetic-private-${label}-bytes`); hidden.push(body.toString(), `synthetic-private-${label}-file`); await v.service.vault.store.putChunk(chunk, await encrypt(key(v), Uint8Array.from(body), `chunk:${chunk}`)); const row = await v.api.entries.get(entryId); row.entry.files = [{ id: randomUUID(), name: `synthetic-private-${label}-file`, type: "application/octet-stream", size: body.length, chunks: [chunk] }]; row.entry.updatedAt = new Date(now).toISOString(); await v.api.entries.save(row.entry, row.version); return { chunk, hash: createHash("sha256").update(body).digest("hex") }; };
  const lossDoc = newEntry("doc"); lossDoc.title = "synthetic-private-title-loss"; hidden.push(lossDoc.title); await a.api.entries.save(lossDoc, 0); await sync(a); await sync(b);
  const loser = await attach(a, lossDoc.id, "loser"), winner = await attach(b, lossDoc.id, "winner"); await sync(a); await sync(b); await sync(a); await equal(a, b);
  assert.equal((await b.api.entries.get(lossDoc.id)).entry.files[0].chunks[0], winner.chunk); assert.equal(await digest(b, winner.chunk), winner.hash); const lost = (await b.api.sync.conflicts()).find(row => row.title === lossDoc.title); assert.equal(!!lost, true); checks += 3;
  await b.api.sync.restore(lost.id); assert.equal((await b.api.entries.get(lossDoc.id)).entry.files[0].chunks[0], loser.chunk); assert.equal(await digest(b, loser.chunk), loser.hash); await sync(b); await sync(a); await equal(a, b); assert.equal(await digest(a, loser.chunk), loser.hash); checks += 3;
  stage = "same-project environments";
  const envA = newEntry("env"), envB = newEntry("env"); envA.title = envB.title = "synthetic-concurrent-project"; envA.fields = [{ id: "SYNTHETIC_ENV", name: "synthetic-environment-name", value: "synthetic-env-older", secret: true }]; envB.fields = [{ ...envA.fields[0], value: "synthetic-env-newer" }]; hidden.push(envA.title, envA.fields[0].id, envA.fields[0].name, envA.fields[0].value, envB.fields[0].value);
  await a.api.entries.save(envA, 0); await b.api.entries.save(envB, 0); await sync(a); await sync(b); await sync(a); await equal(a, b); assert.equal((await a.api.entries.list()).filter(row => row.entry.kind === "env" && row.entry.title === envA.title).length, 1); assert.equal((await a.api.sync.conflicts()).some(row => row.kind === "env" && row.title === envA.title), true); checks += 2;
  stage = "recovery propagation";
  const recovery = await a.api.recover(kit.recovery, nextPassword); hidden.push(nextPassword, recovery.recovery); await sync(a); await sync(b); await b.api.lock(); await reject(() => b.api.unlock(password), "locked"); now += 1000; await b.api.unlock(nextPassword); await equal(a, b); const later = await make("later"); await later.api.sync.join(folder, { recovery: recovery.recovery }); await equal(a, later); const masterLater = await make("master-later"); await masterLater.api.sync.join(folder, { password: nextPassword }); await equal(a, masterLater); checks++; await later.api.close(); await later.service.shutdown(); await masterLater.api.close(); await masterLater.service.shutdown();
  stage = "incoming package refusal and exact names";
  await change(a, login.id, "synthetic-after-refusal"); await sync(a); const config = await state(a), batchFolder = join(folder, "Vault Sync", config.datasetId, "writers", config.deviceId, config.generationId, "batches"), names = (await readdir(batchFolder)).sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0])), name = names.at(-1), batchPath = join(batchFolder, name), original = await readFile(batchPath, "utf8"), before = await storeHash(b), beforeState = await readFile(join(b.home, "sync", "state.json"), "utf8");
  const tampered = JSON.parse(original); tampered.sealed.data = `${tampered.sealed.data[0] === "A" ? "B" : "A"}${tampered.sealed.data.slice(1)}`;
  for (const invalid of [JSON.stringify(tampered), original.slice(0, -12), "x".repeat(SYNC_PACKAGE_CAP + 1), original.replace('"version":1', '"version":2')]) { await writeFile(batchPath, invalid); await assert.rejects(() => b.api.sync.now()); assert.equal(await storeHash(b), before); assert.equal(await readFile(join(b.home, "sync", "state.json"), "utf8"), beforeState); checks += 3; }
  const match = /^(\d+)-(.+)\.vsync$/.exec(name), address = { datasetId: config.datasetId, deviceId: config.deviceId, generationId: config.generationId, type: "batch", sequence: Number(match[1]), packageId: match[2] }, payload = await openSync(key(a), address, original), foreign = await sealSync(key(a), { ...address, datasetId: randomUUID() }, payload);
  await writeFile(batchPath, foreign); await reject(() => b.api.sync.now(), "invalid"); assert.equal(await storeHash(b), before); checks += 2;
  await writeFile(batchPath, await sealSync(key(a), { ...address, deviceId: randomUUID() }, payload)); await reject(() => b.api.sync.now(), "invalid"); assert.equal(await storeHash(b), before); checks += 2;
  await writeFile(batchPath, original); await rename(batchPath, batchPath.replace(".vsync", "-SCOUT.vsync")); await writeFile(`${batchPath}.partial`, original.slice(0, 12)); await writeFile(join(batchFolder, ".partial-download"), original.slice(0, 12)); await sync(b); assert.equal(await storeHash(b), before); checks++;
  await rename(batchPath.replace(".vsync", "-SCOUT.vsync"), batchPath); await sync(b); await equal(a, b);
  stage = "sequence gap";
  await change(a, login.id, "synthetic-gap-one"); await sync(a); const gapState = await state(a), gapName = (await readdir(batchFolder)).find(name => name.startsWith(`${gapState.sequence}-`)), gapPath = join(batchFolder, gapName), gapBytes = await readFile(gapPath, "utf8"); await rename(gapPath, `${gapPath}.partial`); await change(a, login.id, "synthetic-gap-two"); await sync(a); const gapHash = await storeHash(b), applied = (await state(b)).index;
  await reject(() => b.api.sync.now(), "sync_gap"); assert.equal(await storeHash(b), gapHash); assert.equal((await state(b)).index, applied); await writeFile(gapPath, gapBytes); await sync(b); await equal(a, b); checks += 3;
  stage = "sealed outbox crash replay";
  await change(a, login.id, "synthetic-crash-replay"); const originalWrite = FolderTransport.prototype.write;
  FolderTransport.prototype.write = async function () { throw new Error("synthetic_transport_failure"); };
  try { await reject(() => a.api.sync.now(), "sync_unavailable"); } finally { FolderTransport.prototype.write = originalWrite; }
  const outboxId = (await readdir(join(a.home, "sync", "outbox")))[0], header = JSON.parse(await readFile(join(a.home, "sync", "outbox", outboxId, "state.json"), "utf8")), snapshot = await pendingSnapshot(a, header), pendingBatch = snapshot.publications.find(item => item.path.includes("/batches/")); assert.equal(!!pendingBatch, true);
  await change(a, login.id, "synthetic-write-after-crash"); await a.api.close(); await a.service.shutdown(); a.service = await startService({ home: a.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(a.service); a.api = await connect({ home: a.home, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(a.api); await a.api.unlock(nextPassword); await sync(a); assert.equal(await readFile(join(folder, "Vault Sync", config.datasetId, ...pendingBatch.path.split("/")), "utf8"), pendingBatch.bytes); assert.deepEqual(await readdir(join(a.home, "sync", "outbox")), []); assert.equal((await a.api.entries.get(login.id)).entry.note === "synthetic-write-after-crash", true); await sync(b); await equal(a, b); checks += 4;
  stage = "lock during read and during publishing";
  await change(a, login.id, "synthetic-mid-pulse-lock"); await sync(a); const lockState = await readFile(join(b.home, "sync", "state.json"), "utf8"), lockHash = await storeHash(b), originalRead = FolderTransport.prototype.read; let locked = false;
  FolderTransport.prototype.read = async function (...args) { const result = await originalRead.apply(this, args); if (!locked && args[0].includes("/batches/")) { locked = true; b.service.vault.memory.lock(); } return result; };
  try { await reject(() => b.api.sync.now(), "locked"); } finally { FolderTransport.prototype.read = originalRead; }
  assert.equal(locked, true); assert.equal(await storeHash(b), lockHash); assert.equal(await readFile(join(b.home, "sync", "state.json"), "utf8"), lockState); await b.api.unlock(nextPassword); await sync(b); await equal(a, b); checks += 3;
  await change(a, login.id, "synthetic-lock-during-publish"); const publishState = await readFile(join(a.home, "sync", "state.json"), "utf8"), publishHash = await storeHash(a), publishedBefore = (await files(folder)).sort(); locked = false;
  FolderTransport.prototype.write = async function (...args) { const result = await originalWrite.apply(this, args); if (!locked && args[0].includes("/batches/")) { locked = true; a.service.vault.memory.lock(); } return result; };
  try { await reject(() => a.api.sync.now(), "locked"); } finally { FolderTransport.prototype.write = originalWrite; }
  assert.equal(locked, true); assert.equal(await storeHash(a), publishHash); assert.equal(await readFile(join(a.home, "sync", "state.json"), "utf8"), publishState); assert.deepEqual((await files(folder)).sort(), publishedBefore); assert.deepEqual(await readdir(join(a.home, "sync", "outbox")), []); await a.api.unlock(nextPassword); await sync(a); await sync(b); await equal(a, b); checks += 5;
  stage = "blob size and authentication";
  await change(a, document.id, "synthetic-changed-document"); await sync(a); const blobPath = join(folder, "Vault Sync", config.datasetId, "writers", config.deviceId, config.generationId, "blobs", `${chunkId}.vsync`), originalBlob = await readFile(blobPath, "utf8"), blobHash = await storeHash(b);
  for (const [invalid, code] of [["x".repeat(SYNC_BLOB_CAP + 1), "limited"], [originalBlob.slice(0, -8), "invalid"]]) { await writeFile(blobPath, invalid); await reject(() => b.api.sync.now(), code); assert.equal(await storeHash(b), blobHash); checks += 2; } await writeFile(blobPath, originalBlob); await sync(b); await equal(a, b);
  stage = "missing and foreign objects";
  await change(a, document.id, "synthetic-foreign-object"); await sync(a); const foreignHash = await storeHash(b), foreignState = await readFile(join(b.home, "sync", "state.json"), "utf8"), foreignVault = await make("foreign-vault"); await foreignVault.api.create(nextPassword);
  const blobAddress = { datasetId: config.datasetId, deviceId: config.deviceId, generationId: config.generationId, type: "blob", sequence: 0, packageId: chunkId }, blobPayload = await openSync(key(a), blobAddress, originalBlob), latest = (await readdir(batchFolder)).sort((x, y) => Number(x.split("-")[0]) - Number(y.split("-")[0])).at(-1), latestMatch = /^(\d+)-(.+)\.vsync$/.exec(latest), latestPath = join(batchFolder, latest), latestBytes = await readFile(latestPath, "utf8"), batchAddress = { datasetId: config.datasetId, deviceId: config.deviceId, generationId: config.generationId, type: "batch", sequence: Number(latestMatch[1]), packageId: latestMatch[2] };
  const untouched = async () => { assert.equal(await storeHash(b), foreignHash); assert.equal(await readFile(join(b.home, "sync", "state.json"), "utf8"), foreignState); checks += 2; };
  await rm(blobPath); await reject(() => b.api.sync.now(), "sync_folder_missing"); await untouched(); await writeFile(blobPath, await sealSync(key(foreignVault), blobAddress, blobPayload)); await reject(() => b.api.sync.now(), "invalid"); await untouched(); await writeFile(blobPath, originalBlob);
  await writeFile(latestPath, await sealSync(key(foreignVault), batchAddress, await openSync(key(a), batchAddress, latestBytes))); await reject(() => b.api.sync.now(), "invalid"); await untouched(); await writeFile(latestPath, latestBytes); await sync(b); await equal(a, b); await foreignVault.api.close(); await foreignVault.service.shutdown();
  const emptied = join(scratch, "no-checkpoints"); await cp(folder, emptied, { recursive: true }); for (const path of (await files(emptied)).filter(path => path.includes(`${process.platform === "win32" ? "\\" : "/"}checkpoints${process.platform === "win32" ? "\\" : "/"}`))) await rm(path);
  const bare = await make("no-checkpoint-join"); await reject(() => bare.api.sync.join(emptied, { password: nextPassword }), "sync_checkpoint"); assert.equal((await bare.api.status()).created, false); checks += 2; await bare.api.close(); await bare.service.shutdown();
  stage = "index reconstruction and copied generation";
  const rebuilding = await state(b), conflictsBefore = (await b.api.sync.conflicts()).map(row => row.id).sort(), sequenceBefore = rebuilding.sequence;
  await rm(join(b.home, "sync", "index", rebuilding.index), { recursive: true }); await sync(b); await equal(a, b); assert.equal((await state(b)).sequence, sequenceBefore); assert.deepEqual((await b.api.sync.conflicts()).map(row => row.id).sort(), conflictsBefore); checks += 2;
  const copiedHome = join(scratch, "copied"); await cp(a.home, copiedHome, { recursive: true }); assert.equal(dirname(copiedHome), scratch); await rm(join(copiedHome, "run"), { recursive: true }); const copiedService = await startService({ home: copiedHome, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(copiedService); const copiedApi = await connect({ home: copiedHome, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(copiedApi); const copied = { home: copiedHome, service: copiedService, api: copiedApi };
  await copiedApi.unlock(nextPassword); await sync(copied); const copiedState = await state(copied), sourceState = await state(a); assert.notEqual(copiedState.generationId, sourceState.generationId); assert.notEqual(copiedState.deviceId, sourceState.deviceId); await equal(a, copied); checks += 2; await copied.api.close(); await copied.service.shutdown();
  stage = "restored generation and local commit recovery";
  const restoreHeader = await state(b), restoreBackup = join(scratch, "restore-backup"); await cp(join(b.home, "store"), join(restoreBackup, "store"), { recursive: true }); await cp(join(b.home, "sync", "index", restoreHeader.index), join(restoreBackup, "index"), { recursive: true });
  await change(b, login.id, "synthetic-change-after-local-backup"); await sync(b); await sync(a); await b.api.close(); await b.service.shutdown(); assert.equal(dirname(b.home), scratch); await rm(join(b.home, "store"), { recursive: true }); await cp(join(restoreBackup, "store"), join(b.home, "store"), { recursive: true }); await rm(join(b.home, "sync", "index"), { recursive: true }); await cp(join(restoreBackup, "index"), join(b.home, "sync", "index", restoreHeader.index), { recursive: true }); await writeFile(join(b.home, "sync", "state.json"), JSON.stringify(restoreHeader));
  b.service = await startService({ home: b.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(b.service); b.api = await connect({ home: b.home, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(b.api); await b.api.unlock(nextPassword); await sync(b); assert.notEqual((await state(b)).generationId, restoreHeader.generationId); assert.equal((await b.api.entries.get(login.id)).entry.note === "synthetic-change-after-local-backup", true); await equal(a, b); checks += 2;
  const journalHome = join(scratch, "journal"), journalRoot = join(journalHome, "sync"), journalHeader = await state(a), nextHeader = { ...journalHeader, index: randomUUID() }; await mkdir(journalRoot, { recursive: true }); await cp(join(a.home, "store"), join(journalHome, "store"), { recursive: true }); const journalHash = await storeHash({ home: journalHome });
  await writeFile(join(journalRoot, "state.json"), JSON.stringify(journalHeader)); await writeFile(join(journalRoot, "commit.json"), JSON.stringify({ next: nextHeader, previous: journalHeader })); await rename(join(journalHome, "store"), join(journalRoot, "previous")); await mkdir(join(journalHome, "store")); recoverSync(journalHome); assert.equal(await storeHash({ home: journalHome }), journalHash); assert.equal(JSON.parse(await readFile(join(journalRoot, "state.json"), "utf8")).index, journalHeader.index); await assert.rejects(() => readFile(join(journalRoot, "commit.json"))); checks += 3;
  await cp(join(journalHome, "store"), join(journalRoot, "previous"), { recursive: true }); await writeFile(join(journalRoot, "state.json"), JSON.stringify(nextHeader)); await writeFile(join(journalRoot, "commit.json"), JSON.stringify({ next: nextHeader, previous: journalHeader })); recoverSync(journalHome); assert.equal(await storeHash({ home: journalHome }), journalHash); assert.equal(JSON.parse(await readFile(join(journalRoot, "state.json"), "utf8")).index, nextHeader.index); await assert.rejects(() => readdir(join(journalRoot, "previous"))); checks += 3;
  stage = "writer caps and unchanged local writes on refusal";
  const datasetRoot = join(folder, "Vault Sync", config.datasetId), fakeDevices = [];
  for (let i = 0; i < 65; i++) { const device = randomUUID(); fakeDevices.push(device); await mkdir(join(datasetRoot, "writers", device, randomUUID()), { recursive: true }); }
  const cappedHash = await storeHash(b), cappedState = (await state(b)).index; await reject(() => b.api.sync.now(), "limited"); assert.equal(await storeHash(b), cappedHash); assert.equal((await state(b)).index, cappedState); assert.equal((await b.api.sync.status()).failure.cause, "limited"); checks += 3;
  for (const device of fakeDevices) await rm(join(datasetRoot, "writers", device), { recursive: true }); await sync(b);
  stage = "checkpoints, parts and thirty-day compaction";
  const addRows = async (count, dense = false) => { for (let i = 0; i < count; i++) { const entry = newEntry("note"); entry.title = `synthetic-checkpoint-title-${dense}-${i}`; hidden.push(entry.title); if (dense && i < 30) { entry.note = "synthetic-long-note-".repeat(1600); entry.fields = Array.from({ length: 5 }, (_, field) => ({ id: `SYNTHETIC_DENSE_${field}`, name: "synthetic-dense-field-name", value: "synthetic-long-value-".repeat(1500), secret: true })); } if (dense && i < 30) hidden.push(entry.note, ...entry.fields.flatMap(field => [field.id, field.name, field.value])); const sealed = await encryptJson(key(a), entry, `entry:${entry.id}`); await writeFile(join(a.home, "store", `entry-${entry.id}.json`), JSON.stringify({ version: 1, value: { id: entry.id, sealed, chunks: [] } }), { mode: 0o600 }); } };
  await addRows(500, true); const largeStarted = performance.now(); await sync(a); console.log(`Vault sync split checkpoint: ${((performance.now() - largeStarted) / 1000).toFixed(3)} s.`); const checkpointState = await state(a), checkpointRoot = join(datasetRoot, "writers", config.deviceId, config.generationId, "checkpoints"), splitNames = (await readdir(checkpointRoot)).filter(name => name.startsWith(`${checkpointState.sequence}-`)); assert.equal(checkpointState.operations, 0); assert.equal(splitNames.length > 1, true); for (const name of splitNames) assert.equal(Buffer.byteLength(await readFile(join(checkpointRoot, name), "utf8")) < SYNC_PACKAGE_CAP, true); checks += 2;
  const multipart = await make("multipart"); await multipart.api.sync.join(folder, { password: nextPassword }); await equal(a, multipart);
  await addRows(500); now += 31 * 86400000; await sync(a); const compacted = await state(a), remainingBatches = await readdir(batchFolder); assert.equal(remainingBatches.every(name => !syncPatterns.batch.test(name) || Number(name.split("-")[0]) >= compacted.checkpoint), true); assert.equal((await a.api.entries.list()).length > 1000, true); checks += 2;
  await sync(multipart); await equal(a, multipart); console.log("Vault sync checkpoints and compaction passed.");
  stage = "process stops mid-publication";
  const crashFolder = join(scratch, "crash-shared"), crashP = await make("crash-p"), crashQ = await make("crash-q"), crashDoc = newEntry("doc"); crashDoc.title = "synthetic-private-title-crash"; hidden.push(crashDoc.title);
  await crashP.api.create(password); await crashP.api.entries.save(crashDoc, 0); await crashP.api.sync.setup(crashFolder); await crashQ.api.sync.join(crashFolder, { password }); const crashAttachment = await attach(crashP, crashDoc.id, "crash"), crashState = await state(crashP);
  const crashBatches = join(crashFolder, "Vault Sync", crashState.datasetId, "writers", crashState.deviceId, crashState.generationId, "batches"), crashBefore = (await readdir(crashBatches)).length; await crashP.api.close(); await crashP.service.shutdown();
  const crashProgram = `
    let step = 'imports'; try {
    await import('./test/guard.mjs'); await import('./packages/service/test/privacy-fixture.mjs');
    const { startService } = await import('./packages/service/src/server.ts'), { FolderTransport } = await import('./packages/service/src/sync.ts'), { unlock } = await import('vault-core');
    step = 'start'; const service = await startService({ home: process.env.SYNC_CRASH_HOME, now: () => Number(process.env.SYNC_CRASH_NOW), idleMs: 1e12, presenceMs: 1e12 });
    step = 'unlock'; const opened = await unlock((await service.vault.store.envelope()).state, 'Synthetic sync master password'); opened.bytes.fill(0); service.vault.memory.open(opened.key, service.vault.memory.ticket());
    const write = FolderTransport.prototype.write; FolderTransport.prototype.write = async function (...args) { const result = await write.apply(this, args); if (args[0].includes('/batches/')) process.exit(86); return result; };
    step = 'pulse'; await service.sync.pulse(); process.exit(87);
    } catch (error) { process.stdout.write(JSON.stringify({ step, code: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'operation' })); process.exit(88); }
  `;
  let crashDiagnostic = ""; const crashExit = await new Promise((done, fail) => { const child = spawn(process.execPath, ["--input-type=module", "-e", crashProgram], { cwd: new URL("../../../", import.meta.url), env: { ...process.env, SYNC_CRASH_HOME: crashP.home, SYNC_CRASH_NOW: String(now + 1) }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, signal: AbortSignal.timeout(60000) }); child.stdout.on("data", bytes => { crashDiagnostic += bytes; }); child.once("error", fail); child.once("exit", done); }); if (crashExit !== 86) console.error(`Vault sync mid-publication crash: exit ${crashExit}, ${crashDiagnostic}.`); assert.equal(crashExit, 86);
  assert.equal((await readdir(crashBatches)).length, crashBefore + 1); assert.equal((await readdir(join(crashP.home, "sync", "outbox"))).length, 1); checks += 2;
  crashP.service = await startService({ home: crashP.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(crashP.service); crashP.api = await connect({ home: crashP.home, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(crashP.api); await crashP.api.unlock(password); await sync(crashP);
  assert.equal((await readdir(crashBatches)).length, crashBefore + 1); assert.deepEqual(await readdir(join(crashP.home, "sync", "outbox")), []); assert.equal((await crashP.api.sync.status()).pending, 0); await sync(crashQ); await equal(crashP, crashQ); assert.equal(await digest(crashQ, crashAttachment.chunk), crashAttachment.hash); checks += 4;
  stage = "local write beside a pulse";
  const lateEntry = newEntry("note"); lateEntry.title = "synthetic-late-write"; hidden.push(lateEntry.title); await change(crashP, crashDoc.id, "synthetic-remote-edit"); await sync(crashP);
  const engine = crashQ.service.sync, quiet = engine.quiet, touched = engine.touched; let waits = 0; engine.quiet = async () => { engine.quiet = quiet; waits++; await crashQ.api.entries.save(lateEntry, 0); await quiet(); };
  await sync(crashQ); assert.equal(waits, 1); assert.equal(engine.touched, touched + 1); assert.equal((await crashQ.api.entries.get(lateEntry.id)).entry.title, lateEntry.title); assert.equal((await crashQ.api.entries.get(crashDoc.id)).entry.note, "synthetic-remote-edit"); assert.equal((await crashQ.api.sync.status()).failure, null);
  await sync(crashQ); await sync(crashP); await equal(crashP, crashQ); assert.equal((await crashP.api.entries.get(lateEntry.id)).entry.title, lateEntry.title); assert.equal((await crashQ.api.sync.status()).pending, 0); checks += 7;
  stage = "stale history after compaction";
  const staleFolder = join(scratch, "stale-shared"), staleX = await make("stale-x"), staleY = await make("stale-y"), staleShared = newEntry("note"), staleOwn = newEntry("note"); staleShared.title = "synthetic-stale-shared"; staleOwn.title = "synthetic-stale-own"; hidden.push(staleShared.title, staleOwn.title);
  await staleX.api.create(password); await staleX.api.entries.save(staleShared, 0); await staleX.api.sync.setup(staleFolder); await staleY.api.sync.join(staleFolder, { password }); await equal(staleX, staleY); await change(staleY, staleShared.id, "synthetic-stale-local"); await staleY.api.entries.save(staleOwn, 0); await staleY.api.close(); await staleY.service.shutdown();
  await change(staleX, staleShared.id, "synthetic-stale-remote"); await sync(staleX);
  for (let i = 0; i < 500; i++) { const entry = newEntry("note"); entry.title = `synthetic-stale-title-${i}`; hidden.push(entry.title); await writeFile(join(staleX.home, "store", `entry-${entry.id}.json`), JSON.stringify({ version: 1, value: { id: entry.id, sealed: await encryptJson(key(staleX), entry, `entry:${entry.id}`), chunks: [] } }), { mode: 0o600 }); }
  now += 31 * 86400000; await sync(staleX); const staleState = await state(staleX), staleBatches = join(staleFolder, "Vault Sync", staleState.datasetId, "writers", staleState.deviceId, staleState.generationId, "batches");
  assert.equal((await readdir(staleBatches)).every(name => Number(name.split("-")[0]) >= staleState.checkpoint), true); checks++;
  staleY.service = await startService({ home: staleY.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(staleY.service); staleY.api = await connect({ home: staleY.home, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(staleY.api); await staleY.api.unlock(password);
  await sync(staleY); await sync(staleX); await sync(staleY); await equal(staleX, staleY); assert.equal((await staleX.api.entries.get(staleOwn.id)).entry.title, staleOwn.title); assert.equal((await staleY.api.entries.list()).length, 502); assert.equal((await staleY.api.sync.status()).pending, 0); checks += 4;
  for (const v of [staleX, staleY]) { const kept = await v.api.sync.conflicts(); assert.equal(kept.length, 1); assert.equal(kept[0].title, staleShared.title); assert.equal((await v.api.entries.get(staleShared.id)).entry.note, "synthetic-stale-local"); } checks += 6;
  stage = "compaction leaves no spurious conflicts";
  const reopen = async (v, offset = 0) => { v.service = await startService({ home: v.home, now: () => now + offset, idleMs: 1e12, presenceMs: 1e12 }); services.push(v.service); v.api = await connect({ home: v.home, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(v.api); await v.api.unlock(password); };
  const halt = async v => { await v.api.close(); await v.service.shutdown(); };
  const bulkRows = async (v, count, sealKey = key(v)) => { for (let i = 0; i < count; i++) { const entry = newEntry("note"); entry.title = `synthetic-bulk-title-${randomUUID()}`; hidden.push(entry.title); await writeFile(join(v.home, "store", `entry-${entry.id}.json`), JSON.stringify({ version: 1, value: { id: entry.id, sealed: await encryptJson(sealKey, entry, `entry:${entry.id}`), chunks: [] } }), { mode: 0o600 }); } };
  const history = async (name, compact) => {
    const dir = join(scratch, `${name}-shared`), p = await make(`${name}-p`), q = await make(`${name}-q`), rows = Array.from({ length: 6 }, (_, i) => { const entry = newEntry("note"); entry.title = `synthetic-${name}-${i}`; hidden.push(entry.title); return entry; });
    await p.api.create(password); for (const entry of rows) await p.api.entries.save(entry, 0); await p.api.sync.setup(dir); await q.api.sync.join(dir, { password }); await equal(p, q);
    await change(q, rows[3].id, "synthetic-q-edit"); await q.api.entries.remove(rows[4].id, (await q.api.entries.get(rows[4].id)).version); await change(q, rows[5].id, "synthetic-q-contested"); await halt(q);
    await change(p, rows[0].id, "synthetic-p-once"); await sync(p); for (const note of ["synthetic-p-first", "synthetic-p-second"]) { await change(p, rows[1].id, note); await sync(p); }
    await p.api.entries.remove(rows[2].id, (await p.api.entries.get(rows[2].id)).version); await sync(p); await change(p, rows[5].id, "synthetic-p-contested"); await sync(p);
    await bulkRows(p, 500); if (compact) now += 31 * 86400000; await sync(p);
    const header = await state(p), batches = await readdir(join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches")); assert.equal(batches.every(batch => Number(batch.split("-")[0]) >= header.checkpoint), compact);
    await reopen(q); await sync(q); await sync(p); await sync(q); await equal(p, q);
    const index = async v => (await v.api.sync.conflicts()).map(row => rows.findIndex(entry => entry.title === row.title)), notes = async v => { const result = []; for (const entry of rows) result.push((await v.api.entries.get(entry.id).catch(error => { if (error.code !== "not_found") throw error; }))?.entry.note ?? null); return result; };
    return { q: await index(q), p: await index(p), notes: await notes(q), pending: (await q.api.sync.status()).pending };
  };
  const uncompacted = await history("uncompacted", false), afterCompaction = await history("afterCompaction", true);
  assert.deepEqual(uncompacted, { q: [5], p: [5], notes: ["synthetic-p-once", "synthetic-p-second", null, "synthetic-q-edit", null, "synthetic-q-contested"], pending: 0 }); assert.deepEqual(afterCompaction, uncompacted); checks += 3;
  stage = "several writers and unusable checkpoints";
  const wide = join(scratch, "wide-shared"), wideRows = Array.from({ length: 4 }, (_, i) => { const entry = newEntry("note"); entry.title = `synthetic-wide-${i}`; hidden.push(entry.title); return entry; });
  const wa = await make("wide-a"), wb = await make("wide-b"), wc = await make("wide-c"), wd = await make("wide-d"), otherVault = await make("wide-otherVault"); await otherVault.api.create(nextPassword);
  await wa.api.create(password); for (const entry of wideRows) await wa.api.entries.save(entry, 0); await wa.api.sync.setup(wide); for (const v of [wb, wc, wd]) await v.api.sync.join(wide, { password }); await equal(wa, wb); await halt(wc); await halt(wd);
  await change(wa, wideRows[0].id, "synthetic-wide-a1"); await sync(wa); await sync(wb); await change(wb, wideRows[1].id, "synthetic-wide-b1"); await sync(wb); await sync(wa);
  const keyA = key(wa); await halt(wa); await bulkRows(wa, 500, keyA); await reopen(wa, 62 * 86400000); await sync(wa);
  await sync(wb); await change(wb, wideRows[2].id, "synthetic-wide-b2"); await sync(wb); const keyB = key(wb); await halt(wb); await bulkRows(wb, 500, keyB); await reopen(wb, 31 * 86400000); await sync(wb);
  const wideState = await state(wa), wideBase = join(wide, "Vault Sync", wideState.datasetId, "writers"), checkpointsOf = async v => { const header = await state(v), folder = join(wideBase, header.deviceId, header.generationId, "checkpoints"); return (await readdir(folder)).map(name => ({ name, path: join(folder, name), match: syncPatterns.checkpoint.exec(name), header })); };
  const bState = await state(wb), bBatches = await readdir(join(wideBase, bState.deviceId, bState.generationId, "batches")); assert.equal(bBatches.every(batch => Number(batch.split("-")[0]) >= bState.checkpoint), true); checks++;
  const usableOf = Sync.prototype.usable; let tried = 0; Sync.prototype.usable = function (...args) { tried++; return usableOf.apply(this, args); };
  try { await reopen(wc); await sync(wc); } finally { Sync.prototype.usable = usableOf; }
  assert.equal(tried, 3); await sync(wa); await sync(wb); await sync(wc); await equal(wa, wc); await equal(wb, wc); for (const v of [wa, wb, wc]) { assert.equal((await v.api.sync.conflicts()).length, 0); assert.equal((await v.api.sync.status()).pending, 0); } checks += 7;
  const seal = async (path, owner, opener) => { const match = syncPatterns.checkpoint.exec(basename(path)), parts = path.split(/[\\/]/), address = { datasetId: wideState.datasetId, deviceId: parts.at(-4), generationId: parts.at(-3), type: "checkpoint", sequence: Number(match[1]), packageId: match[2] }; await writeFile(path, await sealSync(key(owner), address, await openSync(key(opener), address, await readFile(path, "utf8")))); };
  const every = join(scratch, "wide-every-foreign"); await cp(wide, every, { recursive: true }); for (const path of (await files(every)).filter(path => /[\\/]checkpoints[\\/]/.test(path))) await seal(path, otherVault, wa);
  const authentic = new Map(); for (const { path } of await checkpointsOf(wa)) { authentic.set(path, await readFile(path, "utf8")); await seal(path, otherVault, wa); }
  await reopen(wd); await sync(wd); await equal(wa, wd); assert.equal((await wd.api.sync.conflicts()).length, 0); checks += 2;
  const lone = await make("wide-lone"); await reject(() => lone.api.sync.join(every, { password }), "invalid"); assert.equal((await lone.api.status()).created, false); checks += 2;
  for (const [path, bytes] of authentic) await writeFile(path, bytes);
  stage = "ancestry survives compaction";
  // The same history runs with and without a checkpoint; the recovering computer must keep the same losing revisions either way. A writer that "cannot see" the others works alone.
  const alone = v => { const engine = v.service.sync, original = engine.writers; engine.writers = async function (...args) { return (await original.apply(this, args)).filter(row => row.deviceId === engine.config.deviceId); }; return () => { engine.writers = original; }; };
  const keptNotes = async v => { const engine = v.service.sync, index = await engine.current(engine.config, key(v)), notes = []; for (const row of index.kept) if (row.entry) notes.push((await decryptJson(key(v), row.entry, `entry:${row.operation.id}`)).note); return notes.sort(); };
  const outcome = async (v, entryId) => ({ note: (await v.api.entries.get(entryId)).entry.note, kept: await keptNotes(v), conflicts: (await v.api.sync.conflicts()).length, pending: (await v.api.sync.status()).pending });
  // An index written before lineage existed: every record keeps only its immediate base.
  const stripLineage = async v => { const c = await state(v), dir = join(v.home, "sync", "index", c.index); let stripped = 0; for (const name of await readdir(dir)) { if (!/^\d+\.json$/.test(name)) continue; const context = `sync-local:${c.datasetId}:${c.index}:${name.slice(0, -5)}`, payload = await decryptJson(key(v), JSON.parse(await readFile(join(dir, name), "utf8")), context); if (payload.section !== "records") continue; for (const item of payload.items) { delete item.lineage; stripped++; } await writeFile(join(dir, name), JSON.stringify(await encryptJson(key(v), payload, context))); } return stripped; };
  const lineage = async (name, compact, mode, strip = false) => {
    const dir = join(scratch, `${name}-shared`), x = await make(`${name}-x`), y = await make(`${name}-y`), rows = Array.from({ length: 3 }, (_, i) => { const entry = newEntry("note"); entry.title = `synthetic-${name}-${i}`; hidden.push(entry.title); return entry; });
    await x.api.create(password); for (const entry of rows) await x.api.entries.save(entry, 0); await x.api.sync.setup(dir); await y.api.sync.join(dir, { password }); await sync(x); await sync(y);
    for (const note of ["synthetic-y-1", "synthetic-y-2"]) { await change(y, rows[0].id, note); await sync(y); }
    if (mode === "pending") await change(y, rows[0].id, "synthetic-y-3"); if (strip) assert.equal(await stripLineage(y) > 0, true); await halt(y);
    const restore = alone(x), target = mode === "pending" ? rows[1] : rows[0];
    for (const note of ["synthetic-x-1", "synthetic-x-2"]) { await change(x, target.id, note); await sync(x); }
    await bulkRows(x, 500); if (compact) now += 31 * 86400000; await sync(x); restore();
    const header = await state(x), batches = await readdir(join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches")); assert.equal(batches.every(batch => Number(batch.split("-")[0]) >= header.checkpoint), compact);
    await reopen(y); await sync(y); await sync(y); return outcome(y, rows[0].id);
  };
  const ancestorExpected = { note: "synthetic-y-3", kept: [], conflicts: 0, pending: 0 }, publishedExpected = { note: "synthetic-x-2", kept: ["synthetic-y-2"], conflicts: 1, pending: 0 };
  assert.deepEqual(await lineage("ancestor-uncompacted", false, "pending"), ancestorExpected); assert.deepEqual(await lineage("ancestor-compacted", true, "pending"), ancestorExpected); checks += 2;
  assert.deepEqual(await lineage("published-uncompacted", false, "published"), publishedExpected); assert.deepEqual(await lineage("published-compacted", true, "published"), publishedExpected); checks += 2;
  stage = "independent writers keep their losing revision";
  const writers = async (name, compact) => {
    const dir = join(scratch, `${name}-shared`), x = await make(`${name}-x`), y = await make(`${name}-y`), z = await make(`${name}-z`), shared = newEntry("note"); shared.title = `synthetic-${name}`; hidden.push(shared.title);
    await x.api.create(password); await x.api.entries.save(shared, 0); await x.api.sync.setup(dir); await y.api.sync.join(dir, { password }); await z.api.sync.join(dir, { password }); await sync(x); await sync(y); await sync(z); await halt(y);
    // Y applies the writer with the lower id first, so that writer edits first and is the one that loses: the uncompacted feed then keeps only its last revision.
    const order = (await state(x)).deviceId < (await state(z)).deviceId ? [x, z] : [z, x];
    for (const [v, tag] of [[order[0], "first"], [order[1], "second"]]) {
      const restore = alone(v); for (let i = 1; i <= 3; i++) { await change(v, shared.id, `synthetic-${tag}-${i}`); await sync(v); }
      if (compact) { await forced(v); }
      restore(); if (compact) { const header = await state(v), batches = join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches"); for (const batch of await readdir(batches)) if (Number(batch.split("-")[0]) < header.sequence) await rm(join(batches, batch)); }
    }
    await reopen(y); await sync(y); await sync(y); return outcome(y, shared.id);
  };
  const writersExpected = { note: "synthetic-second-3", kept: ["synthetic-first-3"], conflicts: 1, pending: 0 };
  assert.deepEqual(await writers("writers-uncompacted", false), writersExpected); assert.deepEqual(await writers("writers-compacted", true), writersExpected); checks += 2;
  stage = "writers who saw each other keep the losing head";
  // X and Z edit alone, exchange their edits, each keeping the other's loser, and checkpoint with the same winner; Y was offline. Y must keep the losing head and restore its exact note and attachment, as the uncompacted feed does.
  const seenWriters = async (name, compact, reverse, after = "restore") => {
    const dir = join(scratch, `${name}-shared`), x = await make(`${name}-x`), y = await make(`${name}-y`), z = await make(`${name}-z`), shared = newEntry("note"), files = {}; shared.title = `synthetic-${name}`; hidden.push(shared.title);
    await x.api.create(password); await x.api.entries.save(shared, 0); await x.api.sync.setup(dir); await y.api.sync.join(dir, { password }); await z.api.sync.join(dir, { password }); await sync(x); await sync(y); await sync(z); await halt(y);
    for (const [v, tag] of [[x, "x"], [z, "z"]]) { const restore = alone(v); for (let i = 1; i <= 3; i++) { await change(v, shared.id, `synthetic-${tag}-head-${i}`); if (i === 3) files[tag] = await attach(v, shared.id, `${name}-${tag}`); await sync(v); } restore(); }
    const order = reverse ? [z, x] : [x, z]; for (let pass = 0; pass < 2; pass++) for (const v of order) await sync(v);
    assert.equal((await x.api.sync.conflicts()).length > 0 && (await z.api.sync.conflicts()).length > 0, true);
    if (after === "dismiss") for (const v of [x, z]) for (const row of await v.api.sync.conflicts()) await v.api.sync.dismiss(row.id);
    if (compact) for (const v of order) { await forced(v); const header = await state(v), batches = join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches"); for (const batch of await readdir(batches)) if (Number(batch.split("-")[0]) < header.sequence) await rm(join(batches, batch)); }
    await reopen(y); await sync(y); await sync(y);
    const result = await outcome(y, shared.id); if (after !== "restore") return { result, y, z, shared, dir, order };
    const engine = y.service.sync, index = await engine.current(engine.config, key(y)); let head;
    for (const row of index.kept) if (row.entry && (await decryptJson(key(y), row.entry, `entry:${row.operation.id}`)).note === "synthetic-x-head-3") head = row.operation.revision;
    assert.equal(!!head, true); await y.api.sync.restore(head); await sync(y); const restored = (await y.api.entries.get(shared.id)).entry;
    return { result, note: restored.note, bytes: await digest(y, restored.files[0].chunks[0]) === files.x.hash, pending: (await y.api.sync.status()).pending };
  };
  for (const reverse of [false, true]) {
    const control = await seenWriters(`seen-uncompacted-${reverse}`, false, reverse), compacted = await seenWriters(`seen-compacted-${reverse}`, true, reverse);
    assert.equal(control.result.note, "synthetic-z-head-3"); assert.equal(compacted.result.note, control.result.note); assert.deepEqual(compacted.result.kept, ["synthetic-x-head-3"]); assert.equal(control.result.kept.includes("synthetic-x-head-3"), true); assert.equal(compacted.result.pending + control.result.pending, 0);
    assert.deepEqual({ note: compacted.note, bytes: compacted.bytes, pending: compacted.pending }, { note: "synthetic-x-head-3", bytes: true, pending: 0 }); assert.deepEqual({ note: control.note, bytes: control.bytes, pending: control.pending }, { note: "synthetic-x-head-3", bytes: true, pending: 0 }); checks += 7;
  }
  stage = "dismissed conflicts do not return through checkpoints";
  // Both writers dismissed what they kept before their checkpoints, so the recovering computer has nothing to restore; and a conflict dismissed on the recovering computer stays dismissed when a later checkpoint still carries it.
  const dismissedWriters = await seenWriters("dismissed-writers", true, false, "dismiss"); assert.deepEqual(dismissedWriters.result, { note: "synthetic-z-head-3", kept: [], conflicts: 0, pending: 0 }); checks++;
  const held = await seenWriters("dismissed-local", true, false, "keep"); assert.deepEqual(held.result.kept, ["synthetic-x-head-3"]);
  for (const row of await held.y.api.sync.conflicts()) await held.y.api.sync.dismiss(row.id); await sync(held.y); await halt(held.y);
  { const restore = alone(held.z); await change(held.z, held.shared.id, "synthetic-z-after-dismiss"); await sync(held.z); restore(); await forced(held.z); const header = await state(held.z), batches = join(held.dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches"); for (const batch of await readdir(batches)) if (Number(batch.split("-")[0]) < header.sequence) await rm(join(batches, batch)); }
  assert.equal((await held.z.api.sync.conflicts()).length > 0, true); await reopen(held.y); await sync(held.y); await sync(held.y); assert.deepEqual(await outcome(held.y, held.shared.id), { note: "synthetic-z-after-dismiss", kept: [], conflicts: 0, pending: 0 }); checks += 3;
  stage = "index without lineage keeps no spurious ancestor";
  assert.deepEqual(await lineage("legacy-uncompacted", false, "pending", true), ancestorExpected); assert.deepEqual(await lineage("legacy-compacted", true, "pending", true), ancestorExpected); checks += 2;
  stage = "another writer's checkpoint carries a different losing head";
  // X, Z and W edit alone (W last, so W wins), exchange everything, then X dismisses Z's loser and Z dismisses X's; W keeps both. One checkpoint closes every gap, yet Y must also keep what the others' checkpoints carry, and restore each with its exact note and attachment bytes.
  const threeWriters = async (name, compact, tamper = false) => {
    const dir = join(scratch, `${name}-shared`), x = await make(`${name}-x`), y = await make(`${name}-y`), z = await make(`${name}-z`), w = await make(`${name}-w`), shared = newEntry("note"), files = {}, foreign = randomUUID(); shared.title = `synthetic-${name}`; hidden.push(shared.title);
    await x.api.create(password); await x.api.entries.save(shared, 0); await x.api.sync.setup(dir); for (const v of [y, z, w]) await v.api.sync.join(dir, { password }); for (const v of [x, y, z, w]) await sync(v); await halt(y);
    for (const [v, tag] of [[x, "x"], [z, "z"], [w, "w"]]) { now += 1000; const restore = alone(v); for (let i = 1; i <= 3; i++) { await change(v, shared.id, `synthetic-${tag}-${i}`); if (i === 3) files[tag] = await attach(v, shared.id, `${name}-${tag}`); await sync(v); } restore(); }
    for (let pass = 0; pass < 2; pass++) for (const v of [x, z, w]) await sync(v);
    for (const [v, other] of [[x, "z"], [z, "x"]]) for (const row of (await v.service.sync.current(v.service.sync.config, key(v))).kept) if (row.entry && (await decryptJson(key(v), row.entry, `entry:${row.operation.id}`)).note.startsWith(`synthetic-${other}-`)) await v.api.sync.dismiss(row.operation.revision);
    if (compact) for (const v of [w, x, z]) { now += 1000; await forced(v); const header = await state(v), batches = join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches"); for (const batch of await readdir(batches)) if (Number(batch.split("-")[0]) < header.sequence) await rm(join(batches, batch)); }
    // The newest checkpoint of X names a device that is no writer of the dataset.
    if (tamper) { const header = await state(x), root = join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "checkpoints"); let changed = 0; for (const file of await readdir(root)) { const m = syncPatterns.checkpoint.exec(file); if (Number(m[1]) !== header.sequence) continue; const address = { datasetId: header.datasetId, deviceId: header.deviceId, generationId: header.generationId, type: "checkpoint", sequence: header.sequence, packageId: m[2] }, cp = await openSync(key(x), address, await readFile(join(root, file), "utf8")); if (!cp.kept?.length) continue; cp.kept[0].operation.deviceId = foreign; cp.time = now + 1000; await writeFile(join(root, file), await sealSync(key(x), address, cp)); changed++; } assert.equal(changed > 0, true); }
    await reopen(y); await sync(y); await sync(y);
    const index = await y.service.sync.current(y.service.sync.config, key(y)), result = await outcome(y, shared.id), heads = {}; for (const row of index.kept) if (row.entry) heads[(await decryptJson(key(y), row.entry, `entry:${row.operation.id}`)).note] = row.operation.revision;
    return { result, y, heads, files, shared, foreign: index.kept.some(row => row.operation.deviceId === foreign) };
  };
  const threeControl = await threeWriters("three-uncompacted", false), threeCompacted = await threeWriters("three-compacted", true);
  assert.equal(threeControl.result.note, "synthetic-w-3"); assert.equal(threeCompacted.result.note, "synthetic-w-3"); assert.equal(threeCompacted.result.pending + threeControl.result.pending, 0);
  for (const tag of ["x", "z"]) { assert.equal(`synthetic-${tag}-3` in threeControl.heads, true); assert.equal(`synthetic-${tag}-3` in threeCompacted.heads, true); }
  for (const [label, run] of [["control", threeControl], ["compacted", threeCompacted]]) for (const tag of ["x", "z"]) { await run.y.api.sync.restore(run.heads[`synthetic-${tag}-3`]); await sync(run.y); const restored = (await run.y.api.entries.get(run.shared.id)).entry; assert.deepEqual({ label, note: restored.note, bytes: await digest(run.y, restored.files[0].chunks[0]) === run.files[tag].hash, pending: (await run.y.api.sync.status()).pending }, { label, note: `synthetic-${tag}-3`, bytes: true, pending: 0 }); }
  checks += 16;
  stage = "checkpoint carrying an operation of an unknown device";
  // The newest checkpoint of X carries a kept operation of a device no writer has: it is passed over, an older checkpoint serves, and nothing foreign is stored. The result matches the untampered history.
  const forged = await threeWriters("three-forged", true, true);
  assert.equal(forged.foreign, false); assert.equal(forged.result.note, "synthetic-w-3"); assert.equal(forged.result.pending, 0); assert.deepEqual(forged.result.kept, threeCompacted.result.kept); assert.equal(Object.keys(forged.heads).filter(note => /^synthetic-[xz]-3$/.test(note)).length, 2); checks += 5;
  stage = "carried head proved an ancestor by this computer's own batches past the lineage cap";
  // X's last edit is applied by Y, which then publishes 65 descendants (more than the 64 a lineage keeps) while X and Z never see them; Z edits alone and X and Z exchange that, X keeping its old head as a loser. After X and Z compact, Y recovers from their checkpoints: X's old head is an ancestor of Y's own chain, which Y's surviving batches prove, so only the genuine head of Y's chain stays a conflict, as without compaction.
  const deep = async (name, compact) => {
    const dir = join(scratch, `${name}-shared`), x = await make(`${name}-x`), y = await make(`${name}-y`), z = await make(`${name}-z`), shared = newEntry("note"); shared.title = `synthetic-${name}`; hidden.push(shared.title);
    await x.api.create(password); await x.api.entries.save(shared, 0); await x.api.sync.setup(dir); for (const v of [y, z]) await v.api.sync.join(dir, { password }); for (const v of [x, y, z]) await sync(v);
    let undo = alone(x); for (let i = 1; i <= 3; i++) { await change(x, shared.id, `synthetic-x-${i}`); await sync(x); } undo(); await sync(y);
    const yDevice = (await state(y)).deviceId, unseen = v => { const engine = v.service.sync, original = engine.writers; engine.writers = async function (...args) { return (await original.apply(this, args)).filter(row => row.deviceId !== yDevice); }; return () => { engine.writers = original; }; }, forget = [x, z].map(unseen);
    undo = alone(y); for (let i = 1; i <= 65; i++) { now += 10; await change(y, shared.id, `synthetic-y-descendant-${i}`); await sync(y); } undo(); await halt(y);
    now += 1000; undo = alone(z); for (let i = 1; i <= 3; i++) { await change(z, shared.id, `synthetic-z-independent-${i}`); await sync(z); } undo();
    for (let pass = 0; pass < 2; pass++) for (const v of [x, z]) await sync(v);
    if (compact) for (const v of [x, z]) { now += 1000; await forced(v); const header = await state(v), batches = join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches"); for (const batch of await readdir(batches)) if (Number(batch.split("-")[0]) < header.sequence) await rm(join(batches, batch)); }
    for (const undoOne of forget) undoOne();
    await reopen(y); await sync(y); await sync(y); return outcome(y, shared.id);
  };
  const deepExpected = { note: "synthetic-z-independent-3", kept: ["synthetic-y-descendant-65"], conflicts: 1, pending: 0 };
  assert.deepEqual(await deep("deep-uncompacted", false), deepExpected); assert.deepEqual(await deep("deep-compacted", true), deepExpected); checks += 2;
  stage = "local write while the store is staged";
  for (const variant of ["edit", "delete"]) {
    const dir = join(scratch, `staged-${variant}-shared`), p = await make(`staged-${variant}-p`), q = await make(`staged-${variant}-q`), rows = Array.from({ length: 3 }, (_, i) => { const entry = newEntry("note"); entry.title = `synthetic-staged-${variant}-${i}`; hidden.push(entry.title); return entry; });
    await p.api.create(password); for (const entry of rows) await p.api.entries.save(entry, 0); await p.api.sync.setup(dir); await q.api.sync.join(dir, { password }); await sync(p); await sync(q); await change(p, rows[0].id, "synthetic-staged-remote"); await sync(p);
    // The local write lands after the staging pass read the store file and before it links it.
    const original = fsp.link; let fired = 0;
    fsp.link = async function (source, destination, ...rest) { if (!fired && String(source).includes(q.home) && String(source).includes(`entry-${rows[0].id}`) && String(destination).includes("outbox")) { fired++; if (variant === "delete") await q.api.entries.remove(rows[0].id, (await q.api.entries.get(rows[0].id)).version); else await change(q, rows[0].id, "synthetic-staged-local"); await change(q, rows[1].id, "synthetic-staged-beside"); } return original.call(this, source, destination, ...rest); };
    syncBuiltinESMExports();
    try { await sync(q); } finally { fsp.link = original; syncBuiltinESMExports(); }
    assert.equal(fired, 1); assert.equal((await q.api.sync.status()).failure, null); assert.equal((await q.api.entries.get(rows[1].id)).entry.note, "synthetic-staged-beside");
    if (variant === "delete") await reject(() => q.api.entries.get(rows[0].id), "not_found"); else assert.equal((await q.api.entries.get(rows[0].id)).entry.note, "synthetic-staged-local");
    await sync(q); await sync(p); await equal(p, q); assert.equal((await q.api.sync.status()).pending, 0); assert.equal((await q.api.sync.status()).failure, null); checks += 7;
  }
  stage = "lock during the staging link pass ends the pulse locked";
  {
    const dir = join(scratch, "lockstage-shared"), p = await make("lockstage-p"), q = await make("lockstage-q"), rows = Array.from({ length: 24 }, (_, i) => { const entry = newEntry("note"); entry.title = `synthetic-lockstage-${i}`; hidden.push(entry.title); return entry; });
    await p.api.create(password); for (const entry of rows) await p.api.entries.save(entry, 0); await p.api.sync.setup(dir); await q.api.sync.join(dir, { password }); await sync(p); await sync(q); await change(p, rows[0].id, "synthetic-lockstage-remote"); await sync(p);
    const lockHash = await storeHash(q), lockState = await readFile(join(q.home, "sync", "state.json"), "utf8"), original = fsp.link, tasks = []; let fired = 0, gate;
    fsp.link = function (source, destination, ...rest) { const task = (async () => { if (!fired && String(source).includes(q.home) && String(source).includes(`entry-${rows[0].id}`) && String(destination).includes("outbox")) { fired++; gate = q.api.lock(); await gate; } return original.call(this, source, destination, ...rest); })(); tasks.push(task); return task; };
    syncBuiltinESMExports();
    try { await reject(() => q.api.sync.now(), "locked"); } finally { fsp.link = original; syncBuiltinESMExports(); await gate; await Promise.allSettled(tasks); }
    assert.equal(fired, 1); assert.equal(await storeHash(q), lockHash); assert.equal(await readFile(join(q.home, "sync", "state.json"), "utf8"), lockState); await assert.rejects(() => stat(join(q.home, "sync", "failure.json")), { code: "ENOENT" });
    await q.api.unlock(password); assert.equal((await q.api.sync.status()).failure, null); await sync(q); await sync(p); await sync(q); await equal(p, q); assert.equal((await q.api.entries.get(rows[0].id)).entry.note, "synthetic-lockstage-remote"); assert.equal((await q.api.sync.status()).pending, 0); assert.equal((await q.api.sync.status()).failure, null); checks += 8;
  }
  stage = "corrupt or removed packages apply nothing";
  {
    const dir = join(scratch, "packages-shared"), p = await make("packages-p"), q = await make("packages-q"), row = newEntry("note"); row.title = "synthetic-packages"; hidden.push(row.title);
    await p.api.create(password); await p.api.entries.save(row, 0); await p.api.sync.setup(dir); await q.api.sync.join(dir, { password }); await sync(q);
    for (const note of ["synthetic-packages-1", "synthetic-packages-2"]) { await change(p, row.id, note); await sync(p); }
    const header = await state(p), batches = join(dir, "Vault Sync", header.datasetId, "writers", header.deviceId, header.generationId, "batches"), names = (await readdir(batches)).sort((m, n) => Number(m.split("-")[0]) - Number(n.split("-")[0])), older = join(batches, names.at(-2)), bytes = await readFile(older, "utf8");
    const before = await storeHash(q), beforeState = await readFile(join(q.home, "sync", "state.json"), "utf8"), untouchedQ = async () => { assert.equal(await storeHash(q), before); assert.equal(await readFile(join(q.home, "sync", "state.json"), "utf8"), beforeState); assert.deepEqual(await readdir(join(q.home, "sync", "outbox")), []); };
    await writeFile(older, bytes.slice(0, -8)); await reject(() => q.api.sync.now(), "invalid"); await untouchedQ();
    await rm(older); await reject(() => q.api.sync.now(), "sync_gap"); await untouchedQ();
    await writeFile(older, bytes); await sync(q); await equal(p, q); assert.equal((await q.api.entries.get(row.id)).entry.note, "synthetic-packages-2"); checks += 8;
  }
  stage = "idle time and scheduled queue";
  let clock = 0; const idle = await make("idle"), memory = new VaultMemory(() => clock, 100); idle.service.vault.memory = memory; memory.open(key(a), memory.ticket()); await idle.service.vault.store.create((await a.service.vault.store.envelope()).state); await idle.api.sync.setup(join(scratch, "idle-shared")); clock = 99; await idle.api.sync.now(); clock = 100; assert.throws(() => memory.get(memory.ticket())); checks++;
  let scheduledClock = 0; const scheduledHome = join(scratch, "scheduled"), scheduledService = await startService({ home: scheduledHome, now: () => scheduledClock, idleMs: 1200000, presenceMs: 1200000 }); services.push(scheduledService); const scheduledApi = await connect({ home: scheduledHome, app: { id: "vault-app", name: "Synthetic sync app", kind: "cosmic" }, tokens: tokens() }); clients.push(scheduledApi);
  await scheduledApi.create(password); await scheduledApi.sync.setup(join(scratch, "scheduled-folder")); const scheduledEntry = newEntry("note"); await scheduledApi.entries.save(scheduledEntry, 0);
  const scheduledKey = scheduledService.vault.memory.get(scheduledService.vault.memory.ticket()); await scheduledApi.lock(); assert.equal((await scheduledApi.sync.status()).pending, 1); assert.equal((await scheduledApi.sync.status()).conflicts, 0); scheduledService.vault.memory.open(scheduledKey, scheduledService.vault.memory.ticket()); checks += 2;
  const touch = scheduledService.vault.memory.touch; scheduledService.vault.memory.touch = () => { throw new Error("sync_activity"); };
  try { scheduledClock = 4999; scheduledService.checkSync(); assert.equal((await scheduledApi.sync.status()).pending, 1); scheduledClock = 5000; scheduledService.checkSync(); assert.equal((await scheduledApi.sync.status()).pending, 0); assert.equal((await scheduledApi.sync.status()).lastSynced, new Date(5000).toISOString()); scheduledClock = 64999; scheduledService.checkSync(); assert.equal((await scheduledApi.sync.status()).lastSynced, new Date(5000).toISOString()); scheduledClock = 65000; scheduledService.checkSync(); assert.equal((await scheduledApi.sync.status()).lastSynced, new Date(65000).toISOString()); } finally { scheduledService.vault.memory.touch = touch; } checks += 5;
  await scheduledApi.lock(); scheduledClock = 70000; await scheduledApi.unlock(password); assert.equal((await scheduledApi.sync.status()).lastSynced, new Date(70000).toISOString()); await scheduledApi.close(); await scheduledService.shutdown(); checks++;
  stage = "CLI languages and family consent";
  process.env.VAULT_HOME = a.home; const lines = [], answers = [], io = { isTTY: () => true, async ask() { return answers.shift(); }, write(value) { lines.push(value); }, error(value) { lines.push(value); }, out(value) { lines.push(value); }, err(value) { lines.push(value); } };
  process.env.LC_ALL = "en"; assert.equal(await main(["sync", "status"], io), 0); assert.equal(lines.some(line => line.startsWith("Folder: ")), true); assert.equal(lines.some(line => line.includes("pending changes")), true); checks += 3;
  lines.length = 0; process.env.LC_ALL = "es"; assert.equal(await main(["sync", "status"], io), 0); assert.equal(lines.some(line => line.startsWith("Carpeta: ")), true); assert.equal(lines.some(line => line.includes("cambios pendientes")), true); checks += 3;
  lines.length = 0; process.env.VAULT_HOME = join(scratch, "no-consent"); answers.push("no"); assert.equal(await main(["sync", "setup", join(scratch, "refused")], io), 1); await assert.rejects(() => readdir(process.env.VAULT_HOME)); assert.equal(lines.some(line => line.includes("fortaleza")), true); checks += 3;
  stage = "secret-free folder and local records";
  for (const path of await files(folder)) { const content = await readFile(path, "utf8"); for (const secret of new Set(hidden)) assert.equal(content.includes(secret), false); }
  for (const v of [a, b, c, d]) for (const path of [...await files(join(v.home, "sync")), ...await files(join(v.home, "logs"))]) { const content = await readFile(path, "utf8"); for (const secret of hidden) assert.equal(content.includes(secret), false); } checks += 2;
  stage = "leave isolation";
  await change(b, login.id, "synthetic-before-leave"); FolderTransport.prototype.write = async function (...args) { if (args[0].includes("/batches/")) throw new Error("synthetic_transport_failure"); return originalWrite.apply(this, args); }; try { await reject(() => b.api.sync.now(), "sync_unavailable"); } finally { FolderTransport.prototype.write = originalWrite; } assert.equal((await readdir(join(b.home, "sync", "outbox"))).length, 1); checks++;
  const writerB = await state(b), writerA = await state(a); await b.api.sync.leave(true); await assert.rejects(() => readdir(join(folder, "Vault Sync", writerB.datasetId, "writers", writerB.deviceId))); assert.equal((await readdir(join(folder, "Vault Sync", writerA.datasetId, "writers", writerA.deviceId))).length > 0, true); assert.equal((await b.api.sync.status()).configured, false); checks += 3;
  await assert.rejects(() => readdir(join(b.home, "sync", "outbox"))); assert.equal((await b.api.sync.status()).failure, null); checks += 2;
  console.log(`Vault sync service: ${checks} checks passed.`);
} catch (error) { console.error(`Vault sync service failed at ${stage}: ${error?.code ?? "assertion"}.`); if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*sync\.(?:test\.mjs|ts):\d+:\d+/.test(line)).join("\n")); throw new Error("sync service check failed"); }
finally { for (const api of clients) await api.close().catch(() => undefined); for (const service of services) await service.shutdown(); if (previousHome === undefined) delete process.env.VAULT_HOME; else process.env.VAULT_HOME = previousHome; if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale; assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); }
