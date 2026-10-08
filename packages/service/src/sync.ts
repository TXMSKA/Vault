import fs from "node:fs";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, unlink } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { decrypt, decryptJson, encryptJson, unlock, hashProof, sealed, shape, stateInput, chunkIds, id, syncDataset, syncOperation, syncApplied, syncNumber, syncPatterns, syncWinner, sealSync, openSync, VaultError, FileVaultStore, SYNC_PACKAGE_CAP, SYNC_BLOB_CAP, SYNC_FILE_LIMIT, SYNC_WRITER_LIMIT, SYNC_CALL_MS, SYNC_CHECKPOINT_OPS, SYNC_TOMBSTONE_MS, SYNC_COMPACT_MS } from "vault-core";
import type { SyncAddress, SyncOperation, SyncEntry, SyncCheckpoint, SyncBatch, SyncBlob, VaultState, StoredEntry, Sealed, Entry, VaultLogger } from "vault-core";
import type { SyncStatus, SyncConflict } from "../../client/src/types.ts";
import { privateDirectory } from "../../client/src/private.ts";
import { validateEntry } from "./vault.ts";
import type { Vault } from "./vault.ts";
import { ServiceError, object, text } from "./errors.ts";
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const writer = (a: { deviceId: string; generationId: string }) => `${a.deviceId}/${a.generationId}`;
const binding = (home: string) => createHash("sha256").update(hostname()).update("\0").update(process.platform === "win32" ? resolve(home).toLowerCase() : resolve(home)).update("\0").update(String(fs.statSync(home).birthtimeMs)).digest("hex");
async function limited<T>(run: (live: () => void) => Promise<T>): Promise<T> {
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const live = () => { if (expired) throw new ServiceError("sync_timeout", 503); };
  try { return await Promise.race([run(live), new Promise<never>((_done, fail) => { timer = setTimeout(() => { expired = true; fail(new ServiceError("sync_timeout", 503)); }, SYNC_CALL_MS); timer.unref(); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export class FolderTransport {
  root: string; own: string;
  constructor(root: string, own: string) { this.root = resolve(root); this.own = own; }
  private path(name: string) { const result = resolve(this.root, name), inside = relative(this.root, result); if (!inside || inside.startsWith("..") || isAbsolute(inside) || name.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new VaultError("invalid"); return result; }
  private async safe(path: string, live: () => void) {
    let current = path;
    for (;;) { const stat = await lstat(current); live(); if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) throw new VaultError("invalid"); if (current === this.root) break; const parent = dirname(current); if (parent === current) throw new VaultError("invalid"); current = parent; }
    const actual = await realpath(this.root); if (process.platform === "win32" ? actual.toLowerCase() !== this.root.toLowerCase() : actual !== this.root) throw new VaultError("invalid"); live();
  }
  private async directory(path: string, live: () => void): Promise<void> {
    const parent = dirname(path); let stat;
    try { stat = await lstat(path); live(); } catch (error) { if (!missing(error) || parent === path) throw error; await this.directory(parent, live); live(); await mkdir(path, { mode: 0o700 }); live(); stat = await lstat(path); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultError("invalid"); const actual = await realpath(path); live(); if (process.platform === "win32" ? actual.toLowerCase() !== path.toLowerCase() : actual !== path) throw new VaultError("invalid");
  }
  async list(name: string, allowMissingRoot = false): Promise<string[]> {
    return limited(async live => {
      const path = name ? this.path(name) : this.root; let directory;
      try { await this.safe(path, live); directory = await opendir(path); live(); }
      catch (error) { if (missing(error)) { if (!allowMissingRoot) await this.safe(this.root, live); return []; } throw error; }
      const names: string[] = [];
      try { for (;;) { const item = await directory.read(); live(); if (!item) break; if (names.length >= SYNC_FILE_LIMIT) throw new VaultError("limited"); names.push(item.name); } return names.sort(); }
      finally { await directory.close(); }
    });
  }
  async read(name: string, cap = SYNC_PACKAGE_CAP): Promise<string> {
    return limited(async live => {
      const path = this.path(name); await this.safe(path, live); const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { live(); const stat = await file.stat(); live(); if (!stat.isFile() || stat.size > cap) throw new VaultError("limited"); const bytes = Buffer.alloc(stat.size + 1); let count = 0;
        try { while (count < bytes.length) { const part = await file.read(bytes, count, bytes.length - count, count); live(); if (!part.bytesRead) break; count += part.bytesRead; } if (count !== stat.size) throw new VaultError("invalid"); return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)); } finally { bytes.fill(0); }
      } finally { await file.close(); }
    });
  }
  async write(name: string, bytes: string, dataset = false): Promise<boolean> {
    if (Buffer.byteLength(bytes) > (name.includes("/blobs/") ? SYNC_BLOB_CAP : SYNC_PACKAGE_CAP) || !(dataset && name === "dataset.vsync") && !name.startsWith(`writers/${this.own}/`)) throw new VaultError("invalid");
    return limited(async live => {
      const path = this.path(name), parent = dirname(path); await this.directory(parent, live); await this.safe(parent, live);
      try { const previous = await this.read(name, name.includes("/blobs/") ? SYNC_BLOB_CAP : SYNC_PACKAGE_CAP); live(); if (previous !== bytes) throw new VaultError("conflict"); return false; } catch (error) { if (!missing(error)) throw error; }
      const temporary = join(parent, `.partial-${randomUUID()}`); let published = false;
      try { const file = await open(temporary, "wx", 0o600); try { live(); await file.writeFile(bytes); live(); await file.sync(); live(); } finally { await file.close(); } live(); await rename(temporary, path); published = true; live(); return true; }
      catch (error) { if (published) await unlink(path); throw error; } finally { await rm(temporary, { force: true }); }
    });
  }
  async remove(name: string, dataset = false) { if (!(dataset && name === "dataset.vsync") && !name.startsWith(`writers/${this.own}/`)) throw new VaultError("invalid"); return limited(async live => { const path = this.path(name); await this.safe(path, live); live(); await unlink(path); live(); }); }
  async leave() { return limited(async live => { const path = this.path(`writers/${this.own.split("/")[0]}`); try { await this.safe(path, live); live(); await rm(path, { recursive: true }); live(); } catch (error) { if (!missing(error)) throw error; } }); }
}
type RecordRow = { operation: SyncOperation; localVersion: number };
type Kept = { operation: SyncOperation; entry: Sealed | null; blobs: SyncBlob[] };
type Index = { records: RecordRow[]; applied: Record<string, number>; kept: Kept[] };
type State = { format: 1; folder: string; datasetId: string; deviceId: string; generationId: string; binding: string; sequence: number; operations: number; checkpoint: number; index: string; lastSynced: string | null; failure: { writer: string | null; cause: string } | null; computers: string[]; conflicts: number };
type Publication = { path: string; bytes: string };
type Snapshot = { index: Index; rows: StoredEntry[]; envelope: { state: VaultState; version: number }; chunks: SyncBlob[]; state: State; publications: Publication[]; before: { rows: StoredEntry[]; envelope: { state: VaultState | null; version: number } } };
const emptyIndex = (): Index => ({ records: [], applied: {}, kept: [] });
function state(value: unknown): State {
  const v = object(value, "binding,checkpoint,computers,conflicts,datasetId,deviceId,failure,folder,format,generationId,index,lastSynced,operations,sequence") as unknown as State;
  if (v.format !== 1 || !/^[0-9a-f]{64}$/.test(v.binding) || !isAbsolute(text(v.folder, 4096)) || v.lastSynced !== null && !Number.isFinite(Date.parse(text(v.lastSynced, 64)))) throw new VaultError("invalid");
  [v.datasetId, v.deviceId, v.generationId, v.index].forEach(id); [v.sequence, v.operations, v.checkpoint].forEach(n => syncNumber(n));
  if (!Array.isArray(v.computers) || v.computers.length > SYNC_WRITER_LIMIT) throw new VaultError("invalid"); v.computers.forEach(id); syncNumber(v.conflicts);
  if (v.failure !== null) { object(v.failure, "cause,writer"); text(v.failure.cause, 80); if (v.failure.writer !== null) { const pair = v.failure.writer.split("/"); if (pair.length !== 2) throw new VaultError("invalid"); pair.forEach(id); } } return v;
}
function indexInput(value: unknown): Index {
  const v = object(value, "applied,kept,records") as unknown as Index; syncApplied(v.applied);
  if (!Array.isArray(v.records) || v.records.length > 10000 || !Array.isArray(v.kept) || v.kept.length > 10000) throw new VaultError("limited");
  for (const row of v.records) { object(row, "localVersion,operation"); syncOperation(row.operation); syncNumber(row.localVersion); }
  if (new Set(v.records.map(row => row.operation.id.toLowerCase())).size !== v.records.length) throw new VaultError("invalid");
  for (const kept of v.kept) { object(kept, "blobs,entry,operation"); syncOperation(kept.operation); if (kept.entry !== null) sealed(kept.entry, 220000); if (!Array.isArray(kept.blobs) || kept.blobs.length > 2560) throw new VaultError("invalid"); for (const blob of kept.blobs) { shape(blob, "id,sealed"); id(blob.id); sealed(blob.sealed, 32784); } } return v;
}
function atomic(path: string, value: unknown) { const temporary = `${path}.${randomUUID()}.tmp`, fd = fs.openSync(temporary, "wx", 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } try { fs.renameSync(temporary, path); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } }
function localRead(path: string, cap = SYNC_PACKAGE_CAP) { const stat = fs.lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) throw new VaultError("invalid"); return JSON.parse(fs.readFileSync(path, "utf8")); }
// Recovery runs before routes can see the store. A crash before the state pointer commits rolls the store back.
export function recoverSync(home: string) {
  const root = join(home, "sync"), journal = join(root, "commit.json"); if (!fs.existsSync(root)) return; privateDirectory(root); if (!fs.existsSync(journal)) return;
  const v = object(localRead(journal, 16384), "next,previous"), next = state(v.next), previous = v.previous === null ? null : state(v.previous), backup = join(root, "previous"), store = join(home, "store");
  for (const path of [backup, store]) if (fs.existsSync(path)) { const actual = fs.realpathSync.native(path); if (fs.lstatSync(path).isSymbolicLink() || (process.platform === "win32" ? actual.toLowerCase() !== path.toLowerCase() : actual !== path)) throw new VaultError("invalid"); }
  let committed = false; try { committed = state(localRead(join(root, "state.json"), 16384)).index === next.index; } catch {}
  if (!committed && fs.existsSync(backup)) { if (fs.existsSync(store)) fs.rmSync(store, { recursive: true }); fs.renameSync(backup, store); }
  if (!committed) { if (previous) atomic(join(root, "state.json"), previous); else fs.rmSync(join(root, "state.json"), { force: true }); }
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true }); fs.unlinkSync(journal);
}
export class Sync {
  private home: string; private vault: Vault; private now: () => number; private disableHello: () => Promise<void>; private logger: VaultLogger;
  private config: State | null = null; private failure: State["failure"] = null; private joinFailures = { count: 0, until: 0 }; private root: string; private prepared = false;
  constructor(home: string, vault: Vault, now: () => number, disableHello: () => Promise<void>, logger: VaultLogger) { this.home = home; this.vault = vault; this.now = now; this.disableHello = disableHello; this.logger = logger; this.root = join(home, "sync"); }
  async load() { try { this.config = state(localRead(join(this.root, "state.json"), 16384)); } catch (error) { if (!missing(error)) throw new ServiceError("sync_state", 503); } try { const failure = object(localRead(join(this.root, "failure.json"), 4096), "cause,writer"); text(failure.cause, 80); if (failure.writer !== null) { const pair = text(failure.writer, 80).split("/"); if (pair.length !== 2) throw new VaultError("invalid"); pair.forEach(id); } this.failure = failure as State["failure"]; } catch (error) { if (!missing(error)) throw new ServiceError("sync_state", 503); } }
  private check(ticket: number) { return this.vault.memory.get(ticket); }
  private prepare() { if (this.prepared) return; for (const name of ["", "index", "outbox", "kept"]) privateDirectory(join(this.root, name)); this.prepared = true; }
  private async pending(key: CryptoKey) {
    const result: Snapshot[] = [];
    for (const name of fs.readdirSync(join(this.root, "outbox")).filter(name => syncPatterns.writer.test(name))) {
      const path = join(this.root, "outbox", name); let header: State;
      // The manifest and header are the completion markers for a local write. Never replay a partial write.
      try {
        header = state(localRead(join(path, "state.json"), 16384)); if (header.index !== name) throw new VaultError("invalid");
        const manifest = object(localRead(join(path, "snapshot", "parts.json"), 1024), "parts"); if (syncNumber(manifest.parts, false) > 4096) throw new VaultError("limited");
      } catch (error) {
        if (!missing(error) && !(error instanceof SyntaxError) && !(error instanceof VaultError && ["invalid", "limited"].includes(error.code))) throw error;
        fs.rmSync(path, { recursive: true, force: true }); continue;
      }
      if (this.config?.index === header.index) { fs.rmSync(path, { recursive: true, force: true }); continue; }
      try { result.push(await this.readSnapshot(join(path, "snapshot"), header, key)); }
      catch (error) { if (!missing(error)) throw error; fs.rmSync(path, { recursive: true, force: true }); }
    }
    if (result.length > 1) throw new VaultError("invalid"); return result;
  }
  private transport(c: State) { return new FolderTransport(join(c.folder, "Vault Sync", c.datasetId), writer(c)); }
  private address(c: State, type: SyncAddress["type"], sequence: number, packageId: string, source = c): SyncAddress { return { datasetId: c.datasetId, deviceId: source.deviceId, generationId: source.generationId, type, sequence, packageId }; }
  private async saveSnapshot(path: string, snapshot: Snapshot, key: CryptoKey, ticket: number) {
    privateDirectory(path); let part = 0;
    const write = async (section: string, items: unknown[]) => { const value = await encryptJson(key, { section, items }, `sync-local:${snapshot.state.datasetId}:${snapshot.state.index}:${part}`); this.check(ticket); atomic(join(path, `${part++}.json`), value); };
    await write("meta", [{ state: snapshot.state, envelope: snapshot.envelope, beforeEnvelope: snapshot.before.envelope, applied: snapshot.index.applied }]);
    const groups: { section: string; items: unknown[] }[] = [
      { section: "records", items: snapshot.index.records }, { section: "rows", items: snapshot.rows }, { section: "beforeRows", items: snapshot.before.rows }, { section: "chunks", items: snapshot.chunks },
      { section: "kept", items: snapshot.index.kept.map(item => ({ ...item, blobs: [] })) }, { section: "keptBlobs", items: snapshot.index.kept.flatMap(item => item.blobs.map(blob => ({ revision: item.operation.revision, blob }))) },
    ];
    for (const group of groups) { let size = 0, items: unknown[] = []; for (const item of group.items) { const length = Buffer.byteLength(JSON.stringify(item)); if (size + length > 3 * 1024 * 1024 && items.length) { await write(group.section, items); items = []; size = 0; } if (length > 3 * 1024 * 1024) throw new VaultError("limited"); items.push(item); size += length; } if (items.length) await write(group.section, items); }
    for (let publication = 0; publication < snapshot.publications.length; publication++) { const item = snapshot.publications[publication], parts = Math.max(1, Math.ceil(item.bytes.length / (3 * 1024 * 1024))); for (let piece = 0; piece < parts; piece++) await write("publications", [{ publication, path: item.path, part: piece, parts, bytes: item.bytes.slice(piece * 3 * 1024 * 1024, (piece + 1) * 3 * 1024 * 1024) }]); }
    this.check(ticket); atomic(join(path, "parts.json"), { parts: part });
  }
  private async readSnapshot(path: string, c: State, key: CryptoKey): Promise<Snapshot> {
    const manifest = object(localRead(join(path, "parts.json"), 1024), "parts"), parts = syncNumber(manifest.parts, false); if (parts > 4096) throw new VaultError("limited");
    const snapshot: Snapshot = { index: emptyIndex(), rows: [], chunks: [], envelope: null!, state: null!, publications: [], before: { rows: [], envelope: null! } }, publicationParts = new Map<number, { path: string; parts: number; pieces: string[] }>(); let meta = false;
    for (let part = 0; part < parts; part++) {
      const payload = object(await decryptJson(key, sealed(localRead(join(path, `${part}.json`)), SYNC_PACKAGE_CAP), `sync-local:${c.datasetId}:${c.index}:${part}`), "items,section"), section = text(payload.section, 32), items = payload.items;
      if (!Array.isArray(items) || items.length > 10000) throw new VaultError("invalid");
      if (section === "meta") { if (meta || items.length !== 1) throw new VaultError("invalid"); meta = true; const v = object(items[0], "applied,beforeEnvelope,envelope,state"); snapshot.state = state(v.state); if (snapshot.state.index !== c.index || snapshot.state.datasetId !== c.datasetId) throw new VaultError("invalid"); snapshot.index.applied = syncApplied(v.applied); snapshot.envelope = v.envelope as Snapshot["envelope"]; snapshot.before.envelope = v.beforeEnvelope as Snapshot["before"]["envelope"]; }
      else if (section === "records") snapshot.index.records.push(...items);
      else if (section === "kept") snapshot.index.kept.push(...items);
      else if (section === "rows") snapshot.rows.push(...items);
      else if (section === "beforeRows") snapshot.before.rows.push(...items);
      else if (section === "chunks") snapshot.chunks.push(...items);
      else if (section === "keptBlobs") for (const item of items) { const v = object(item, "blob,revision"), kept = snapshot.index.kept.find(item => item.operation.revision === id(v.revision)); if (!kept) throw new VaultError("invalid"); kept.blobs.push(v.blob as SyncBlob); }
      else if (section === "publications") for (const item of items) { const v = object(item, "bytes,part,parts,path,publication"), publication = syncNumber(v.publication), piece = syncNumber(v.part), count = syncNumber(v.parts, false), name = text(v.path, 512), bytes = text(v.bytes, 3 * 1024 * 1024); if (publication >= SYNC_FILE_LIMIT || count > 3 || piece >= count) throw new VaultError("invalid"); const previous = publicationParts.get(publication) ?? { path: name, parts: count, pieces: [] }; if (previous.path !== name || previous.parts !== count || previous.pieces.length !== piece) throw new VaultError("invalid"); previous.pieces.push(bytes); publicationParts.set(publication, previous); }
      else throw new VaultError("invalid");
      if (snapshot.index.records.length > 10000 || snapshot.rows.length > 4096 || snapshot.before.rows.length > 4096 || snapshot.chunks.length > 6400 || snapshot.index.kept.length > 10000) throw new VaultError("limited");
    }
    if (!meta) throw new VaultError("invalid"); indexInput(snapshot.index); object(snapshot.envelope, "state,version"); stateInput(snapshot.envelope.state); syncNumber(snapshot.envelope.version, false); object(snapshot.before.envelope, "state,version"); if (snapshot.before.envelope.state) stateInput(snapshot.before.envelope.state); syncNumber(snapshot.before.envelope.version);
    for (const row of [...snapshot.rows, ...snapshot.before.rows]) { object(row, "chunks,id,sealed,version"); id(row.id); syncNumber(row.version, false); sealed(row.sealed, 220000); chunkIds(row.chunks); }
    for (const blob of snapshot.chunks) { object(blob, "id,sealed"); id(blob.id); sealed(blob.sealed, 32784); }
    for (let publication = 0; publication < publicationParts.size; publication++) { const item = publicationParts.get(publication); if (!item || item.pieces.length !== item.parts) throw new VaultError("invalid"); const bytes = item.pieces.join(""); if (Buffer.byteLength(bytes) > SYNC_PACKAGE_CAP) throw new VaultError("limited"); snapshot.publications.push({ path: item.path, bytes }); } return snapshot;
  }
  private async current(c: State, key: CryptoKey): Promise<Index> { try { return (await this.readSnapshot(join(this.root, "index", c.index), c, key)).index; } catch (error) { if (!missing(error)) throw error; return this.rebuild(c, key); } }
  private async rebuild(c: State, key: CryptoKey): Promise<Index> {
    const index = (await this.checkpoint(c, key)).index;
    for (const source of await this.writers(c)) {
      const sourceId = writer(source), names = (await this.transport(c).list(`writers/${sourceId}/batches`)).map(name => ({ name, match: syncPatterns.batch.exec(name) })).filter(item => item.match).sort((a, b) => Number(a.match![1]) - Number(b.match![1])); let last = index.applied[sourceId] ?? 0;
      for (const { name, match } of names) { const sequence = Number(match![1]); if (sequence <= last) continue; if (sequence !== last + 1) throw new ServiceError("sync_gap", 503);
        const batch = await openSync(key, this.address(c, "batch", sequence, match![2], source as State), await this.transport(c).read(`writers/${sourceId}/batches/${name}`)) as SyncBatch;
        for (const op of batch.operations) { if (op.deviceId !== source.deviceId) throw new VaultError("invalid"); await this.validate(op, key); const old = index.records.find(row => row.operation.id.toLowerCase() === op.id.toLowerCase()); if (!old) index.records.push({ operation: op, localVersion: 0 }); else if (op.base === old.operation.revision || syncWinner(old.operation, op) === op) old.operation = op; } last = sequence;
      } if (last) index.applied[sourceId] = last;
    }
    const rows = await this.vault.store.entries(), envelope = await this.vault.store.envelope();
    for (const row of index.records) { const op = row.operation, local = rows.find(item => item.id === op.id); row.localVersion = op.record === "envelope" ? same(op.value, envelope.state) ? envelope.version : 0 : op.value && local && same((op.value as SyncEntry).sealed, local.sealed) && same((op.value as SyncEntry).chunks, local.chunks) ? local.version : 0; }
    for (const name of fs.readdirSync(join(this.root, "kept"))) { const match = syncPatterns.blob.exec(name.replace(/\.json$/, ".vsync")); if (!match) continue; const revision = match[1], value = object(await decryptJson(key, sealed(localRead(join(this.root, "kept", name))), `sync-kept:${c.datasetId}:${revision}`), "blobs,entry,operation") as unknown as Kept; syncOperation(value.operation); if (value.operation.revision !== revision || !Array.isArray(value.blobs) || value.blobs.length) throw new VaultError("invalid");
      if (value.operation.record === "entry" && value.operation.value) for (const chunkId of (value.operation.value as SyncEntry).chunks) { const blob = object(await decryptJson(key, sealed(localRead(join(this.root, "kept", `${revision}-${chunkId}.json`), SYNC_BLOB_CAP), SYNC_BLOB_CAP), `sync-kept-blob:${c.datasetId}:${revision}:${chunkId}`), "id,sealed") as unknown as SyncBlob; if (blob.id !== chunkId) throw new VaultError("invalid"); sealed(blob.sealed, 32784); value.blobs.push(blob); } index.kept.push(value);
    }
    return indexInput(index);
  }
  private async writers(c: State, allowMissingRoot = false): Promise<{ deviceId: string; generationId: string }[]> {
    const transport = this.transport(c), devices = (await transport.list("writers", allowMissingRoot)).filter(name => syncPatterns.writer.test(name)); if (devices.length > SYNC_WRITER_LIMIT) throw new VaultError("limited"); const result = [];
    for (const deviceId of devices) for (const generationId of (await transport.list(`writers/${deviceId}`)).filter(name => syncPatterns.writer.test(name))) { if (result.length >= SYNC_WRITER_LIMIT) throw new VaultError("limited"); result.push({ deviceId, generationId }); } return result;
  }
  private async validate(op: SyncOperation, key: CryptoKey): Promise<Entry | null> {
    syncOperation(op); if (op.record !== "entry" || op.value === null) return null; const value = op.value as SyncEntry, entry = validateEntry(await decryptJson(key, value.sealed, `entry:${op.id}`));
    if (entry.id !== op.id || [...value.chunks].map(id => id.toLowerCase()).sort().join() !== entry.files.flatMap(file => file.chunks).map(id => id.toLowerCase()).sort().join()) throw new VaultError("invalid"); return entry;
  }
  private async blobs(c: State, source: { deviceId: string; generationId: string }, op: SyncOperation, key: CryptoKey): Promise<SyncBlob[]> {
    if (op.record !== "entry" || !op.value) return []; const result = [];
    for (const chunkId of (op.value as SyncEntry).chunks) { const blob = await openSync(key, this.address(c, "blob", 0, chunkId, source as State), await this.transport(c).read(`writers/${writer(source)}/blobs/${chunkId}.vsync`, SYNC_BLOB_CAP)) as SyncBlob;
      if (blob.id !== chunkId) throw new VaultError("invalid"); const bytes = await decrypt(key, blob.sealed, `chunk:${chunkId}`); try { if (bytes.length > 32768) throw new VaultError("invalid"); } finally { bytes.fill(0); } result.push(blob); } return result;
  }
  private async checkpoint(c: State, key: CryptoKey): Promise<{ index: Index; blobs: SyncBlob[] }> {
    const candidates: { source: { deviceId: string; generationId: string }; sequence: number; packageId: string; names: string[]; parts: number; time: number; records: SyncOperation[]; applied: Record<string, number> }[] = [];
    for (const source of await this.writers(c)) {
      const groups = new Map<string, string[]>(); for (const name of await this.transport(c).list(`writers/${writer(source)}/checkpoints`)) { const m = syncPatterns.checkpoint.exec(name); if (!m) continue; const group = `${m[1]}-${m[2]}`; groups.set(group, [...groups.get(group) ?? [], name]); }
      for (const names of groups.values()) { const first = syncPatterns.checkpoint.exec(names[0])!, parts = Number(first[4]); if (names.length !== parts || new Set(names.map(name => syncPatterns.checkpoint.exec(name)![3])).size !== parts) continue;
        const records: SyncOperation[] = []; let time = 0, applied: Record<string, number> | undefined;
        for (const name of names) { const m = syncPatterns.checkpoint.exec(name)!, value = await openSync(key, this.address(c, "checkpoint", Number(m[1]), m[2], source as State), await this.transport(c).read(`writers/${writer(source)}/checkpoints/${name}`)) as SyncCheckpoint;
          if (value.parts !== parts || value.part !== Number(m[3]) || applied && (!same(value.applied, applied) || value.time !== time)) throw new VaultError("invalid"); applied = value.applied; time = value.time; records.push(...value.records); }
        if (records.length > 10000 || new Set(records.map(op => op.id.toLowerCase())).size !== records.length) throw new VaultError("limited"); candidates.push({ source, sequence: Number(first[1]), packageId: first[2], names, parts, time, records, applied: applied! });
      }
    }
    candidates.sort((a, b) => b.time - a.time || writer(b.source).localeCompare(writer(a.source))); const newest = candidates[0]; if (!newest) throw new ServiceError("sync_checkpoint", 503);
    const blobs: SyncBlob[] = []; for (const op of newest.records) { await this.validate(op, key); if (op.value) blobs.push(...await this.findBlobs(c, op, key, newest.source)); }
    return { index: { records: newest.records.map(operation => ({ operation, localVersion: 0 })), applied: newest.applied, kept: [] }, blobs };
  }
  private async findBlobs(c: State, op: SyncOperation, key: CryptoKey, preferred: { deviceId: string; generationId: string }): Promise<SyncBlob[]> {
    try { return await this.blobs(c, preferred, op, key); } catch (error) { if (!missing(error)) throw error; }
    for (const source of await this.writers(c)) { try { return await this.blobs(c, source, op, key); } catch (error) { if (!missing(error)) throw error; } } throw new VaultError("invalid");
  }
  async status(): Promise<SyncStatus> {
    const c = this.config; if (!c) return { configured: false, folder: null, lastSynced: null, computers: [], pending: 0, conflicts: 0, failure: this.failure };
    const marker = object(localRead(join(this.root, "index", c.index, "versions.json"), 1024 * 1024), "envelope,rows"); syncNumber(marker.envelope); if (!Array.isArray(marker.rows) || marker.rows.length > 4096) throw new VaultError("invalid");
    const versions = new Map<string, number>(); for (const row of marker.rows) { object(row, "id,version"); const recordId = id(row.id); if (versions.has(recordId)) throw new VaultError("invalid"); versions.set(recordId, syncNumber(row.version, false)); }
    const rows = await this.vault.store.entries(), env = await this.vault.store.envelope(), pending = rows.filter(row => versions.get(row.id) !== row.version).length + [...versions.keys()].filter(recordId => !rows.some(row => row.id === recordId)).length + (marker.envelope !== env.version ? 1 : 0);
    return { configured: true, folder: c.folder, lastSynced: c.lastSynced, computers: c.computers, pending, conflicts: c.conflicts, failure: this.failure ?? c.failure };
  }
  private initial(folder: string, datasetId: string): State { return { format: 1, folder: resolve(folder), datasetId, deviceId: randomUUID(), generationId: randomUUID(), binding: binding(this.home), sequence: 0, operations: 0, checkpoint: 0, index: randomUUID(), lastSynced: null, failure: null, computers: [], conflicts: 0 }; }
  async setup(folder: string) {
    if (this.config) throw new ServiceError("conflict", 409); const ticket = this.vault.memory.ticket(), key = this.check(ticket), env = await this.vault.store.envelope(); if (!env.state) throw new VaultError("not_found");
    const c = this.initial(folder, randomUUID()); this.check(ticket); this.prepare();
    try { const pending = await this.pending(key); if (pending.length) { const snapshot = pending[0], header = snapshot.state; if (header.folder !== resolve(folder) || header.binding !== binding(this.home)) throw new VaultError("conflict"); await this.finish(snapshot, key, ticket, null); }
      else await this.run(c, emptyIndex(), key, ticket, true, null, undefined, JSON.stringify({ format: "vault-sync", version: 1, datasetId: c.datasetId, createdAt: this.now(), envelope: env.state }));
    } catch (error) { this.failure = { writer: null, cause: this.cause(error) }; throw error; } return this.status();
  }
  async join(folder: string, secret: string, recovery: boolean) {
    if (this.config || (await this.vault.store.envelope()).state) throw new ServiceError("sync_existing", 409);
    if (this.now() < this.joinFailures.until) throw new VaultError("limited");
    const base = resolve(folder, "Vault Sync"), discovery = new FolderTransport(base, ""), datasets = (await discovery.list("")).filter(name => syncPatterns.writer.test(name)); if (datasets.length !== 1) throw new ServiceError("sync_dataset", 400);
    const c = this.initial(folder, datasets[0]), transport = this.transport(c), dataset = syncDataset(JSON.parse(await transport.read("dataset.vsync", 4096))); if (dataset.datasetId !== c.datasetId) throw new VaultError("invalid");
    const candidates: { envelope: VaultState; bytes?: string; address?: SyncAddress; time: number }[] = [];
    for (const source of await this.writers(c)) {
      const names = (await transport.list(`writers/${writer(source)}/envelopes`)).map(name => ({ name, match: syncPatterns.batch.exec(name) })).filter(item => item.match).sort((a, b) => Number(b.match![1]) - Number(a.match![1])); const candidate = names[0]; if (!candidate) continue;
      const v = object(JSON.parse(await transport.read(`writers/${writer(source)}/envelopes/${candidate.name}`, 4096)), "envelope,format,sealed,time,version"); if (v.format !== "vault-sync" || v.version !== 1) throw new VaultError("invalid"); candidates.push({ envelope: stateInput(v.envelope), time: syncNumber(v.time), bytes: JSON.stringify({ format: v.format, version: v.version, sealed: v.sealed }), address: this.address(c, "envelope", Number(candidate.match![1]), candidate.match![2], source as State) });
    }
    candidates.sort((a, b) => b.time - a.time || b.address!.deviceId.localeCompare(a.address!.deviceId)); candidates.splice(15);
    candidates.push({ envelope: dataset.envelope, time: dataset.createdAt }); const ticket = this.vault.memory.ticket(); let opened: Awaited<ReturnType<typeof unlock>> | undefined, chosen: VaultState | undefined;
    for (const candidate of candidates) { try { opened = await unlock(candidate.envelope, secret, recovery); const actual = Buffer.from(await hashProof(opened.proof), "base64"), expected = Buffer.from(recovery ? candidate.envelope.recoveryHash : candidate.envelope.masterHash, "base64"); if (!timingSafeEqual(actual, expected)) throw new VaultError("locked"); if (candidate.bytes) { const op = await openSync(opened.key, candidate.address!, candidate.bytes) as SyncOperation; if (!same(op.value, candidate.envelope) || op.time !== candidate.time) throw new VaultError("invalid"); } chosen = candidate.envelope; break; } catch { opened?.bytes.fill(0); opened = undefined; } }
    if (!opened || !chosen) { const count = ++this.joinFailures.count; this.joinFailures.until = this.now() + Math.min(30000, 500 * 2 ** Math.min(count, 6)); throw new VaultError("locked"); }
    opened.bytes.fill(0); this.joinFailures = { count: 0, until: 0 }; if (!this.vault.memory.open(opened.key, ticket)) throw new VaultError("locked");
    try { const checkpoint = await this.checkpoint(c, opened.key); this.check(ticket); this.prepare(); await this.run(c, checkpoint.index, opened.key, ticket, true, null, { envelope: chosen, blobs: checkpoint.blobs }); return this.status(); }
    catch (error) { this.vault.memory.lock(); this.failure = { writer: null, cause: this.cause(error) }; throw error; }
  }
  private cause(error: unknown): string {
    const causes: Record<string, string> = { ENOENT: "sync_folder_missing", EPERM: "sync_permission_denied", EACCES: "sync_access_denied", EBUSY: "sync_busy" };
    let source = error;
    for (let depth = 0; depth < 8 && source && typeof source === "object"; depth++) {
      const code = (source as NodeJS.ErrnoException).code; if (code && causes[code]) return causes[code]; source = (source as Error).cause;
    }
    return error instanceof VaultError || error instanceof ServiceError ? error.code : error instanceof Error && error.message === "locked" ? "locked" : "sync_unavailable";
  }
  async pulse() {
    const original = this.config; if (!original) throw new ServiceError("sync_unconfigured", 400); const ticket = this.vault.memory.ticket(), key = this.check(ticket);
    try {
      this.prepare(); let c = original;
      if (c.binding !== binding(this.home)) { for (const name of fs.readdirSync(join(this.root, "outbox"))) if (syncPatterns.writer.test(name)) fs.rmSync(join(this.root, "outbox", name), { recursive: true }); c = { ...c, deviceId: randomUUID(), generationId: randomUUID(), binding: binding(this.home), sequence: 0, operations: 0, checkpoint: 0 }; }
      const pending = await this.pending(key);
      const published = (await this.transport(c).list(`writers/${writer(c)}/batches`)).map(name => ({ name, match: syncPatterns.batch.exec(name) })).filter(item => item.match && Number(item.match[1]) > c.sequence);
      if (published.length) { const known = new Set(pending.flatMap(snapshot => snapshot.publications.map(item => item.path)));
        if (published.some(item => !known.has(`writers/${writer(c)}/batches/${item.name}`))) { for (const snapshot of pending) fs.rmSync(join(this.root, "outbox", snapshot.state.index), { recursive: true }); pending.length = 0; c = { ...c, deviceId: randomUUID(), generationId: randomUUID(), binding: binding(this.home), sequence: 0, operations: 0, checkpoint: 0 }; }
      }
      if (pending.length) { await this.finish(pending[0], key, ticket, c); c = this.config!; }
      await this.run(c, await this.current(c, key), key, ticket, false, this.config); this.failure = null; return this.status();
    } catch (error) { const cause = this.cause(error); if (cause !== "locked") { this.failure = { writer: this.receiving, cause }; try { atomic(join(this.root, "failure.json"), this.failure); this.logger("sync_pulse", { outcome: "denied" }); } catch {} } throw cause.startsWith("sync_") ? new ServiceError(cause, 503) : error instanceof VaultError || error instanceof ServiceError ? error : new VaultError("locked"); }
    finally { this.receiving = null; }
  }
  private receiving: string | null = null;
  private async run(c: State, index: Index, key: CryptoKey, ticket: number, force: boolean, previous: State | null, joining?: { envelope: VaultState; blobs: SyncBlob[] }, dataset?: string) {
    index = structuredClone(index); const appliedBefore = { ...index.applied }, rows = await this.vault.store.entries(), currentEnv = await this.vault.store.envelope(), env = { state: currentEnv.state ?? joining?.envelope!, version: currentEnv.version || 1 }, chunks = new Map<string, SyncBlob>(), publications: Publication[] = [], operations: SyncOperation[] = [];
    const rowMap = new Map(rows.map(row => [row.id.toLowerCase(), row]));
    for (const blob of joining?.blobs ?? []) chunks.set(blob.id, blob);
    const record = (op: SyncOperation) => index.records.find(row => row.operation.id.toLowerCase() === op.id.toLowerCase());
    const set = (op: SyncOperation, localVersion: number) => { const old = record(op); if (old) { old.operation = op; old.localVersion = localVersion; } else index.records.push({ operation: op, localVersion }); };
    const make = (record: SyncOperation["record"], recordId: string, value: SyncOperation["value"], old?: RecordRow): SyncOperation => ({ record, id: recordId, revision: randomUUID(), base: old?.operation.revision ?? null, deviceId: c.deviceId, time: this.now(), value });
    if (!joining) {
      for (const row of rows) { const old = index.records.find(item => item.operation.id === row.id); if (old?.localVersion === row.version) continue; const op = make("entry", row.id, { sealed: row.sealed, chunks: row.chunks }, old); await this.validate(op, key); operations.push(op); set(op, row.version); }
      for (const old of [...index.records]) if (old.operation.record === "entry" && old.localVersion > 0 && !rowMap.has(old.operation.id.toLowerCase())) { const op = make("entry", old.operation.id, null, old); operations.push(op); set(op, 0); }
      const oldEnv = index.records.find(item => item.operation.id === "envelope"); if (oldEnv?.localVersion !== env.version) { const op = make("envelope", "envelope", env.state, oldEnv); operations.push(op); set(op, env.version); }
    }
    const keep = (op: SyncOperation, fallback: SyncOperation) => { if (index.kept.some(item => item.operation.revision === op.revision)) return; const entry = op.record === "entry" ? (op.value ?? fallback.value) as SyncEntry | null : null; index.kept.push({ operation: op, entry: entry?.sealed ?? null, blobs: op.record === "entry" && op.value ? (op.value as SyncEntry).chunks.map(chunkId => { const blob = chunks.get(chunkId); if (!blob) throw new VaultError("invalid"); return blob; }) : [] }); };
    const apply = async (op: SyncOperation) => {
      const old = record(op); if (old?.operation.revision === op.revision) return;
      if (old && op.base !== old.operation.revision) { const winner = syncWinner(old.operation, op); keep(winner === op ? old.operation : op, winner); if (winner !== op) return; }
      if (op.record === "envelope") { if (!same(env.state, op.value)) { env.state = stateInput(op.value); env.version++; } set(op, env.version); return; }
      const entry = await this.validate(op, key);
      if (entry?.kind === "env") {
        for (const other of [...index.records]) { if (other.operation.id === op.id || other.operation.record !== "entry" || !other.operation.value) continue; const theirs = await this.validate(other.operation, key); if (theirs?.kind !== "env" || theirs.title !== entry.title) continue;
          const winner = syncWinner(other.operation, op); keep(winner === op ? other.operation : op, winner);
          if (winner !== op) { set(op, 0); return; } rowMap.delete(other.operation.id.toLowerCase()); other.localVersion = 0;
        }
      }
      const before = rowMap.get(op.id.toLowerCase()); if (op.value) { const value = op.value as SyncEntry; const next = same(before?.sealed, value.sealed) ? before!.version : (before?.version ?? 0) + 1; rowMap.set(op.id.toLowerCase(), { id: op.id, version: next, sealed: value.sealed, chunks: value.chunks }); set(op, next); }
      else { rowMap.delete(op.id.toLowerCase()); set(op, 0); }
    };
    if (joining) { for (const item of [...index.records]) { const op = item.operation; index.records = index.records.filter(row => row !== item); await apply(op); } }
    const outgoing = async (op: SyncOperation) => { if (op.record !== "entry" || !op.value) return; for (const chunkId of (op.value as SyncEntry).chunks) { let blob = chunks.get(chunkId); if (!blob) { blob = { id: chunkId, sealed: await this.vault.store.getChunk(chunkId) }; chunks.set(chunkId, blob); } const path = `writers/${writer(c)}/blobs/${chunkId}.vsync`; if (!publications.some(item => item.path === path)) { let bytes; try { bytes = await this.transport(c).read(path, SYNC_BLOB_CAP); const opened = await openSync(key, this.address(c, "blob", 0, chunkId), bytes) as SyncBlob; if (!same(opened, blob)) throw new VaultError("conflict"); } catch (error) { if (!missing(error)) throw error; bytes = await sealSync(key, this.address(c, "blob", 0, chunkId), blob); } publications.push({ path, bytes }); } } };
    for (const op of operations) await outgoing(op);
    const batches: SyncOperation[][] = []; let batch: SyncOperation[] = [], size = 0;
    for (const op of operations) { const length = Buffer.byteLength(JSON.stringify(op)); if (size + length > 5 * 1024 * 1024 && batch.length) { batches.push(batch); batch = []; size = 0; } batch.push(op); size += length; } if (batch.length) batches.push(batch);
    for (const operations of batches) { c = { ...c, sequence: c.sequence + 1 }; const packageId = randomUUID(); publications.push({ path: `writers/${writer(c)}/batches/${c.sequence}-${packageId}.vsync`, bytes: await sealSync(key, this.address(c, "batch", c.sequence, packageId), { operations }) }); index.applied[writer(c)] = c.sequence;
      for (const op of operations.filter(op => op.record === "envelope")) { const packageId = randomUUID(), bytes = JSON.parse(await sealSync(key, this.address(c, "envelope", c.sequence, packageId), op)); publications.push({ path: `writers/${writer(c)}/envelopes/${c.sequence}-${packageId}.vsync`, bytes: JSON.stringify({ ...bytes, envelope: op.value, time: op.time }) }); }
    }
    // Validate every incoming package and blob before preparing any local or folder writes.
    const incoming: { op: SyncOperation; blobs: SyncBlob[] }[] = [];
    const sources = await this.writers(c, dataset !== undefined);
    if (!sources.some(source => writer(source) === writer(c)) && sources.length >= SYNC_WRITER_LIMIT) throw new VaultError("limited");
    for (const source of sources) {
      const sourceId = writer(source); if (sourceId === writer(c)) continue; this.receiving = sourceId;
      const names = (await this.transport(c).list(`writers/${sourceId}/batches`)).map(name => ({ name, match: syncPatterns.batch.exec(name) })).filter(item => item.match).sort((a, b) => Number(a.match![1]) - Number(b.match![1])); let last = index.applied[sourceId] ?? 0;
      const future = names.filter(item => Number(item.match![1]) > last); if (new Set(future.map(item => item.match![1])).size !== future.length) throw new VaultError("invalid");
      for (const { name, match } of names) { const seq = Number(match![1]); if (seq <= last) continue; if (seq !== last + 1) throw new ServiceError("sync_gap", 503);
        const value = await openSync(key, this.address(c, "batch", seq, match![2], source as State), await this.transport(c).read(`writers/${sourceId}/batches/${name}`)) as SyncBatch;
        for (const op of value.operations) { if (incoming.length >= 10000) throw new VaultError("limited"); if (op.deviceId !== source.deviceId) throw new VaultError("invalid"); await this.validate(op, key); incoming.push({ op, blobs: await this.blobs(c, source, op, key) }); } last = seq;
      } if (last > 0) index.applied[sourceId] = last;
    }
    this.receiving = null;
    const computers = [...new Set([...sources.map(source => source.deviceId), c.deviceId])], lastSynced = new Date(this.now()).toISOString();
    const expired = index.records.some(row => row.operation.value === null && this.now() - row.operation.time >= SYNC_TOMBSTONE_MS);
    if (!force && !joining && !dataset && !operations.length && !incoming.length && same(index.applied, appliedBefore) && !expired && c.operations < SYNC_CHECKPOINT_OPS && previous?.deviceId === c.deviceId && previous.generationId === c.generationId && fs.existsSync(join(this.root, "index", c.index, "parts.json")) && fs.existsSync(join(this.root, "index", c.index, "versions.json"))) {
      // No snapshot, staging store, index or kept files on an idle pulse.
      c = { ...c, lastSynced, computers, failure: null }; this.check(ticket); atomic(join(this.root, "state.json"), c); this.config = c; this.failure = null;
      fs.rmSync(join(this.root, "failure.json"), { force: true }); return;
    }
    for (const row of rows) for (const chunkId of row.chunks) if (!chunks.has(chunkId)) chunks.set(chunkId, { id: chunkId, sealed: await this.vault.store.getChunk(chunkId) });
    for (const item of incoming) { for (const blob of item.blobs) { const existing = chunks.get(blob.id); if (existing && !same(existing, blob)) throw new VaultError("conflict"); chunks.set(blob.id, blob); } await apply(item.op); }
    if (rowMap.size > 4096 || chunks.size > 6400) throw new VaultError("limited");
    // A suppressed same-project record stays indexed so it cannot be captured as a new deletion.
    const liveChunks = new Set([...rowMap.values()].flatMap(row => row.chunks)); if ([...rowMap.values()].flatMap(row => row.chunks).length !== liveChunks.size) throw new VaultError("conflict");
    index.records = index.records.filter(row => row.operation.value !== null || this.now() - row.operation.time < SYNC_TOMBSTONE_MS);
    c = { ...c, index: randomUUID(), operations: c.operations + operations.length + incoming.length, lastSynced, failure: null, computers, conflicts: index.kept.length };
    if (force || c.operations >= SYNC_CHECKPOINT_OPS) {
      for (const row of index.records) if (row.localVersion > 0) await outgoing(row.operation);
      const records = index.records.filter(row => row.operation.record === "envelope" || row.localVersion > 0 || row.operation.value === null).map(row => row.operation), groups: SyncOperation[][] = [[]]; let size = 0;
      for (const op of records) { const length = Buffer.byteLength(JSON.stringify(op)); if (size + length > 5 * 1024 * 1024) { groups.push([]); size = 0; } groups.at(-1)!.push(op); size += length; }
      const checkpointId = randomUUID(), time = this.now(); for (let part = 1; part <= groups.length; part++) publications.push({ path: `writers/${writer(c)}/checkpoints/${c.sequence}-${checkpointId}-${part}-${groups.length}.vsync`, bytes: await sealSync(key, this.address(c, "checkpoint", c.sequence, checkpointId), { records: groups[part - 1], applied: index.applied, time, part, parts: groups.length }) }); c.checkpoint = c.sequence; c.operations = 0;
    }
    if (dataset) publications.push({ path: "dataset.vsync", bytes: dataset });
    this.check(ticket); const snapshot: Snapshot = { index, rows: [...rowMap.values()], envelope: env, chunks: [...chunks.values()].filter(blob => liveChunks.has(blob.id)), state: c, publications, before: { rows, envelope: currentEnv } }; this.prepare(); const path = join(this.root, "outbox", c.index);
    try { await this.saveSnapshot(join(path, "snapshot"), snapshot, key, ticket); this.check(ticket); atomic(join(path, "state.json"), c); await this.finish(snapshot, key, ticket, previous); }
    catch (error) { if (this.cause(error) === "locked") fs.rmSync(path, { recursive: true, force: true }); throw error; }
  }
  private async finish(snapshot: Snapshot, key: CryptoKey, ticket: number, previous: State | null) {
    const c = snapshot.state, path = join(this.root, "outbox", c.index), transport = this.transport(c), written: string[] = [], removed: Publication[] = []; this.check(ticket);
    const currentRows = await this.vault.store.entries(), currentEnv = await this.vault.store.envelope(), plannedRows = new Map(snapshot.rows.map(row => [row.id.toLowerCase(), row])), currentChunks = new Map(snapshot.chunks.map(blob => [blob.id, blob]));
    // A later local write survives replay of an already sealed batch after a failed publication.
    for (const row of currentRows) if (!same(row, snapshot.before.rows.find(before => before.id === row.id))) { plannedRows.set(row.id.toLowerCase(), row); for (const chunkId of row.chunks) currentChunks.set(chunkId, { id: chunkId, sealed: await this.vault.store.getChunk(chunkId) }); const record = snapshot.index.records.find(item => item.operation.id === row.id); if (record) record.localVersion = 0; }
    for (const row of snapshot.before.rows) if (!currentRows.some(current => current.id === row.id)) plannedRows.delete(row.id.toLowerCase());
    if (!same(currentEnv, snapshot.before.envelope) && currentEnv.state) { snapshot.envelope = { state: currentEnv.state, version: currentEnv.version }; const record = snapshot.index.records.find(item => item.operation.id === "envelope"); if (record) record.localVersion = 0; }
    snapshot.rows = [...plannedRows.values()]; const claims = new Set(snapshot.rows.flatMap(row => row.chunks)); snapshot.chunks = [...currentChunks.values()].filter(blob => claims.has(blob.id));
    const stage = join(path, "store"); privateDirectory(stage);
    for (const name of fs.readdirSync(stage)) fs.unlinkSync(join(stage, name));
    // Store writes replace files by atomic rename, so editing the stage never changes its live hard links.
    const link = (name: string) => { const source = join(this.home, "store", name), stat = fs.lstatSync(source); if (!stat.isFile() || stat.isSymbolicLink()) throw new VaultError("invalid"); fs.linkSync(source, join(stage, name)); };
    if (currentEnv.state) link("envelope.json");
    for (const row of currentRows) link(`entry-${row.id.toLowerCase()}.json`);
    for (const name of fs.readdirSync(join(this.home, "store"))) { const match = /^chunk-(.+)\.json$/.exec(name); if (match && syncPatterns.writer.test(match[1])) link(name); }
    await new FileVaultStore(stage).staged(async store => {
      let envelopeVersion = currentEnv.version; if (!currentEnv.state) envelopeVersion = (await store.create(snapshot.envelope.state)).version;
      while (envelopeVersion < snapshot.envelope.version) { this.check(ticket); envelopeVersion = (await store.replace(snapshot.envelope.state, envelopeVersion)).version; }
      if (envelopeVersion !== snapshot.envelope.version || !same((await store.envelope()).state, snapshot.envelope.state)) throw new VaultError("conflict");
      const ensure = async (blob: SyncBlob) => { try { if (!same(await store.getChunk(blob.id), blob.sealed)) throw new VaultError("conflict"); } catch (error) { if (!(error instanceof VaultError && error.code === "not_found")) throw error; this.check(ticket); await store.putChunk(blob.id, blob.sealed); } };
      for (const blob of snapshot.chunks) { this.check(ticket); await ensure(blob); }
      for (const row of currentRows) if (!snapshot.rows.some(next => next.id === row.id)) { this.check(ticket); await store.remove(row.id, row.version); }
      for (const row of snapshot.rows) {
        let expected = currentRows.find(before => before.id === row.id)?.version ?? 0; if (row.version < expected || row.version - expected > 10000) throw new VaultError("invalid");
        while (expected < row.version) { this.check(ticket); for (const chunkId of row.chunks) { const blob = snapshot.chunks.find(blob => blob.id === chunkId); if (!blob) throw new VaultError("invalid"); await ensure(blob); } expected = (await store.save(row.id, row.sealed, expected, row.chunks)).version; }
      }
    }); this.check(ticket);
    const keptFiles: { name: string; value: Sealed }[] = [];
    for (const kept of snapshot.index.kept) { const name = `${kept.operation.revision}.json`; if (!fs.existsSync(join(this.root, "kept", name))) keptFiles.push({ name, value: await encryptJson(key, { ...kept, blobs: [] }, `sync-kept:${c.datasetId}:${kept.operation.revision}`) }); this.check(ticket); for (const blob of kept.blobs) { const name = `${kept.operation.revision}-${blob.id}.json`; if (!fs.existsSync(join(this.root, "kept", name))) keptFiles.push({ name, value: await encryptJson(key, blob, `sync-kept-blob:${c.datasetId}:${kept.operation.revision}:${blob.id}`) }); this.check(ticket); } }
    try {
      for (const item of snapshot.publications) { this.check(ticket); if (await transport.write(item.path, item.bytes, item.path === "dataset.vsync" && previous === null)) written.push(item.path); this.check(ticket); }
      const garbage = snapshot.publications.some(item => item.path.startsWith(`writers/${writer(c)}/checkpoints/`)) ? await this.compact(c, snapshot.index, key, ticket) : [];
      for (const item of garbage) { this.check(ticket); await transport.remove(item.path); removed.push(item); this.check(ticket); }
      if (!same(currentEnv.state, snapshot.envelope.state)) { this.check(ticket); await this.disableHello(); }
      await this.saveSnapshot(join(this.root, "index", c.index), { ...snapshot, publications: [] }, key, ticket); this.check(ticket); atomic(join(this.root, "index", c.index, "versions.json"), { envelope: snapshot.index.records.find(row => row.operation.record === "envelope")?.localVersion ?? 0, rows: snapshot.index.records.filter(row => row.operation.record === "entry" && row.localVersion > 0).map(row => ({ id: row.operation.id, version: row.localVersion })) }); this.check(ticket);
      // No async boundary exists between the final ticket check and the durable state pointer.
      this.logger("sync_pulse", { outcome: "allowed" }); atomic(join(this.root, "commit.json"), { next: c, previous }); const backup = join(this.root, "previous"), store = join(this.home, "store");
      fs.renameSync(store, backup);
      try { fs.renameSync(stage, store); for (const item of keptFiles) atomic(join(this.root, "kept", item.name), item.value); atomic(join(this.root, "state.json"), c); }
      catch (error) { if (fs.existsSync(store)) fs.rmSync(store, { recursive: true }); fs.renameSync(backup, store); fs.rmSync(join(this.root, "commit.json"), { force: true }); throw error; }
      this.config = c; this.failure = null;
    } catch (error) {
      for (const item of removed.reverse()) await transport.write(item.path, item.bytes);
      for (const name of written.reverse()) await transport.remove(name, name === "dataset.vsync" && previous === null);
      fs.rmSync(join(this.root, "index", c.index), { recursive: true, force: true }); throw error;
    }
    fs.rmSync(join(this.root, "previous"), { recursive: true }); fs.unlinkSync(join(this.root, "commit.json")); fs.rmSync(path, { recursive: true });
    fs.rmSync(join(this.root, "failure.json"), { force: true });
    const keptNames = new Set(snapshot.index.kept.flatMap(kept => [`${kept.operation.revision}.json`, ...kept.blobs.map(blob => `${kept.operation.revision}-${blob.id}.json`)]));
    for (const name of fs.readdirSync(join(this.root, "kept"))) if (!keptNames.has(name)) fs.unlinkSync(join(this.root, "kept", name));
    for (const name of fs.readdirSync(join(this.root, "index"))) if (syncPatterns.writer.test(name) && name !== c.index) fs.rmSync(join(this.root, "index", name), { recursive: true });
  }
  private async compact(c: State, index: Index, key: CryptoKey, ticket: number): Promise<Publication[]> {
    if (!c.checkpoint) return []; const transport = this.transport(c), prefix = `writers/${writer(c)}`, cutoff = this.now() - SYNC_COMPACT_MS, garbage: Publication[] = [];
    const referenced = new Set(index.records.flatMap(row => row.operation.record === "entry" && row.operation.value ? (row.operation.value as SyncEntry).chunks : []).concat(index.kept.flatMap(kept => kept.blobs.map(blob => blob.id))));
    const reference = (ops: SyncOperation[]) => { for (const op of ops) if (op.record === "entry" && op.value) for (const chunkId of (op.value as SyncEntry).chunks) referenced.add(chunkId); };
    for (const name of await transport.list(`${prefix}/batches`)) { const m = syncPatterns.batch.exec(name); if (!m) continue; const bytes = await transport.read(`${prefix}/batches/${name}`), batch = await openSync(key, this.address(c, "batch", Number(m[1]), m[2]), bytes) as SyncBatch; this.check(ticket); if (Number(m[1]) < c.checkpoint && batch.operations.every(op => op.time < cutoff)) garbage.push({ path: `${prefix}/batches/${name}`, bytes }); else reference(batch.operations); }
    for (const name of await transport.list(`${prefix}/checkpoints`)) { const m = syncPatterns.checkpoint.exec(name); if (!m) continue; const checkpoint = await openSync(key, this.address(c, "checkpoint", Number(m[1]), m[2]), await transport.read(`${prefix}/checkpoints/${name}`)) as SyncCheckpoint; this.check(ticket); reference(checkpoint.records); }
    for (const name of await transport.list(`${prefix}/blobs`)) { const m = syncPatterns.blob.exec(name); if (m && !referenced.has(m[1])) { garbage.push({ path: `${prefix}/blobs/${name}`, bytes: await transport.read(`${prefix}/blobs/${name}`, SYNC_BLOB_CAP) }); this.check(ticket); } } return garbage;
  }
  async conflicts(): Promise<SyncConflict[]> {
    const c = this.config; if (!c) throw new ServiceError("sync_unconfigured"); const ticket = this.vault.memory.ticket(), key = this.check(ticket), index = await this.current(c, key), result: SyncConflict[] = [];
    for (const kept of index.kept) { const entry = kept.entry ? validateEntry(await decryptJson(key, kept.entry, `entry:${kept.operation.id}`)) : null; result.push({ id: kept.operation.revision, kind: entry?.kind ?? null, title: entry?.title ?? "", deviceId: kept.operation.deviceId, time: new Date(kept.operation.time).toISOString(), deleted: kept.operation.value === null }); } this.check(ticket); return result;
  }
  async resolveConflict(conflictId: string, restore: boolean) {
    id(conflictId); const c = this.config; if (!c) throw new ServiceError("sync_unconfigured"); const ticket = this.vault.memory.ticket(), key = this.check(ticket), snapshot = await this.readSnapshot(join(this.root, "index", c.index), c, key), kept = snapshot.index.kept.find(item => item.operation.revision === conflictId); if (!kept) throw new VaultError("not_found");
    const rows = await this.vault.store.entries(), envelope = await this.vault.store.envelope(), chunks = new Map<string, SyncBlob>(); if (!envelope.state) throw new VaultError("not_found");
    for (const row of rows) for (const chunkId of row.chunks) if (!chunks.has(chunkId)) chunks.set(chunkId, { id: chunkId, sealed: await this.vault.store.getChunk(chunkId) });
    snapshot.before = { rows, envelope }; snapshot.rows = structuredClone(rows); snapshot.envelope = { state: envelope.state, version: envelope.version };
    if (restore) {
      const op = kept.operation, before = rows.find(row => row.id === op.id);
      if (op.record === "envelope") snapshot.envelope = { state: stateInput(op.value), version: envelope.version + 1 };
      else if (op.value === null) snapshot.rows = snapshot.rows.filter(row => row.id !== op.id);
      else {
        const entry = await this.validate(op, key); for (const blob of kept.blobs) { const old = chunks.get(blob.id); if (old && !same(old, blob)) throw new VaultError("conflict"); chunks.set(blob.id, blob); }
        if (entry?.kind === "env") for (const row of rows) { const other = validateEntry(await decryptJson(key, row.sealed, `entry:${row.id}`)); if (other.id !== entry.id && other.kind === "env" && other.title === entry.title) snapshot.rows = snapshot.rows.filter(item => item.id !== row.id); }
        const value = op.value as SyncEntry; snapshot.rows = snapshot.rows.filter(row => row.id !== op.id); snapshot.rows.push({ id: op.id, version: (before?.version ?? 0) + 1, sealed: value.sealed, chunks: value.chunks });
      }
    }
    snapshot.index.kept = snapshot.index.kept.filter(item => item !== kept); snapshot.state = { ...c, index: randomUUID(), conflicts: snapshot.index.kept.length }; snapshot.publications = [];
    const claims = new Set(snapshot.rows.flatMap(row => row.chunks)); snapshot.chunks = [...chunks.values()].filter(blob => claims.has(blob.id)); this.check(ticket);
    const path = join(this.root, "outbox", snapshot.state.index);
    try { await this.saveSnapshot(join(path, "snapshot"), snapshot, key, ticket); this.check(ticket); atomic(join(path, "state.json"), snapshot.state); await this.finish(snapshot, key, ticket, c); }
    catch (error) { if (this.cause(error) === "locked") fs.rmSync(path, { recursive: true, force: true }); throw error; } return { ok: true as const };
  }
  async leave(remove: boolean) { const c = this.config; if (!c) throw new ServiceError("sync_unconfigured"); this.prepare(); if (remove) { if (c.binding !== binding(this.home)) throw new VaultError("conflict"); await this.transport(c).leave(); } fs.rmSync(join(this.root, "state.json"), { force: true }); fs.rmSync(join(this.root, "outbox"), { recursive: true, force: true }); fs.rmSync(join(this.root, "failure.json"), { force: true }); this.prepared = false; this.config = null; this.failure = null; return { ok: true as const }; }
}
