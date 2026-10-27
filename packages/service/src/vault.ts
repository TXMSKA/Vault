import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { FileVaultStore, VaultMemory, createVaultUnlock, createEnvelope, encryptJson, decryptJson, encrypt, decrypt, unlock, newEntry, KINDS, id, version, chunkIds, stateInput, sealed as sealedInput, VaultError } from "vault-core";
import type { Entry, VaultLogger } from "vault-core";
import type { AppView, Backup, EntryRow, EnvImportCount, ImportCount, LoginSummary } from "../../client/src/types.ts";
import { ServiceError, object, text } from "./errors.ts";
import { duplicateKey, MAX_ENTRIES } from "./imports.ts";
import { MAX_VARIABLES } from "./dotenv.ts";
import { appIdPattern } from "../../client/src/paths.ts";
import { manages } from "./secrets.ts";
import type { Prompts } from "./prompts.ts";
export function validateEntry(value: unknown): Entry {
  const v = object(value, "favorite,fields,files,id,kind,note,recovery,title,totp,updatedAt"); id(v.id);
  if (!KINDS.includes(v.kind as Entry["kind"]) || typeof v.favorite !== "boolean" || !Array.isArray(v.fields) || v.fields.length > 100 || !Array.isArray(v.files) || v.files.length > 50 || !Array.isArray(v.recovery) || v.recovery.length > 100) throw new ServiceError("invalid");
  text(v.title, 500); text(v.note, 32000); text(v.totp, 8192); if (!Number.isFinite(Date.parse(text(v.updatedAt, 64)))) throw new ServiceError("invalid");
  const names = new Set<string>();
  for (const field of v.fields) {
    const f = object(field, "id,name,secret,value"); const fieldId = text(f.id, 100); text(f.name, 100); text(f.value, 32000);
    if (!fieldId || typeof f.secret !== "boolean" || names.has(fieldId.toLowerCase())) throw new ServiceError("invalid"); names.add(fieldId.toLowerCase());
    if (v.kind === "env" && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldId) || f.secret !== true)) throw new ServiceError("invalid");
  }
  if (v.kind === "apikey") {
    const entry = value as Entry, fields = ["key", "apps"];
    if (entry.fields.length !== fields.length || fields.some(name => !entry.fields.some(field => field.id === name && field.secret === (name === "key")))) throw new ServiceError("invalid");
    const apps = keyApps(entry); if (apps.some(app => !appIdPattern.test(app)) || new Set(apps).size !== apps.length) throw new ServiceError("invalid");
  }
  for (const recovery of v.recovery) { const r = object(recovery, "used,value"); text(r.value, 8192); if (typeof r.used !== "boolean") throw new ServiceError("invalid"); }
  for (const file of v.files) {
    const f = object(file, "chunks,id,name,size,type"); id(f.id); text(f.name, 180); text(f.type, 120); chunkIds(f.chunks);
    if (!Number.isSafeInteger(f.size) || Number(f.size) < 0 || Number(f.size) > 20 * 1024 * 1024) throw new ServiceError("invalid");
  }
  if (Buffer.byteLength(JSON.stringify(v)) > 220000 - 16) throw new ServiceError("too_large", 413);
  return value as Entry;
}
export function origin(value: string): string {
  let url; try { url = new URL(value); } catch { throw new ServiceError("invalid"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new ServiceError("invalid"); return url.origin;
}
const fieldValue = (entry: Entry, name: string) => entry.fields.find(field => field.id === name)?.value ?? "";
const keyApps = (entry: Entry) => fieldValue(entry, "apps").split(",").map(app => app.trim()).filter(Boolean);
const batchIds = (value: unknown) => { if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new ServiceError("invalid"); return value.map(value => id(value).toLowerCase()); };
const backupPath = (value: string) => { const path = text(value, 4096); if (!isAbsolute(path)) throw new ServiceError("invalid"); return path; };
// The cap includes a maximum-sized sealed entry; chunk lines are much smaller.
async function* backupLines(file: FileHandle) {
  const buffer = Buffer.alloc(32768), decoder = new TextDecoder("utf-8", { fatal: true }); let pending = Buffer.alloc(0), position = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead;
    let start = 0;
    while (start < bytesRead) {
      const end = buffer.indexOf(10, start), stop = end < 0 || end >= bytesRead ? bytesRead : end + 1, part = buffer.subarray(start, stop);
      if (pending.length + part.length > 310000) throw new ServiceError("invalid");
      pending = Buffer.concat([pending, part]); start = stop;
      if (part.at(-1) === 10) {
        const bytes = pending; pending = Buffer.alloc(0);
        if (bytes.length === 1 || bytes.includes(13)) throw new ServiceError("invalid");
        let value: unknown; try { value = JSON.parse(decoder.decode(bytes.subarray(0, -1))); } catch { throw new ServiceError("invalid"); }
        yield { value, bytes };
      }
    }
  }
  if (pending.length) throw new ServiceError("invalid");
}
type BackupScan = { key: CryptoKey; digest: string; entries: number; chunks: number };
async function scanBackup(file: FileHandle, password: string, entry: (value: Entry, index: number) => Promise<void>, chunk: (id: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>, previous?: BackupScan): Promise<BackupScan> {
  const hash = createHash("sha256"), claims = new Set<string>(), seen = new Set<string>(); let header: { entries: number; chunks: number } | undefined, key: CryptoKey | undefined, entries = 0, chunks = 0, digest: string | undefined;
  for await (const line of backupLines(file)) {
    if (digest !== undefined) throw new ServiceError("invalid");
    if (!header) {
      const value = object(line.value, "counts,envelope,format,version"), counts = object(value.counts, "chunks,entries");
      if (value.format !== "vault-backup" || value.version !== 2 || !Number.isSafeInteger(counts.entries) || Number(counts.entries) < 0 || Number(counts.entries) > MAX_ENTRIES || !Number.isSafeInteger(counts.chunks) || Number(counts.chunks) < 0 || Number(counts.chunks) > 6400) throw new ServiceError("invalid");
      const state = stateInput(value.envelope); header = { entries: counts.entries as number, chunks: counts.chunks as number };
      if (previous) key = previous.key;
      else { const opened = await unlock(state, password); opened.bytes.fill(0); key = opened.key; }
    } else if (entries < header.entries) {
      const value = object(line.value, "entry"), opened = validateEntry(await decryptJson(key!, sealedInput(value.entry, 220000), `backup-entry:${entries}`));
      for (const claim of chunkIds(opened.files.flatMap(file => file.chunks))) { const normalized = claim.toLowerCase(); if (claims.has(normalized) || claims.size >= header.chunks) throw new ServiceError("invalid"); claims.add(normalized); }
      await entry(opened, entries++);
    } else if (chunks < header.chunks) {
      const value = object(line.value, "chunk,id"), chunkId = id(value.id), normalized = chunkId.toLowerCase();
      if (!claims.has(normalized) || seen.has(normalized)) throw new ServiceError("invalid"); seen.add(normalized);
      const bytes = await decrypt(key!, sealedInput(value.chunk, 32784), `backup-chunk:${chunks++}:${chunkId}`);
      try { await chunk(normalized, bytes); } finally { bytes.fill(0); }
    } else {
      const value = object(line.value, "end"), end = object(await decryptJson(key!, sealedInput(value.end, 256), "backup-end"), "chunks,digest,entries");
      digest = hash.digest("hex");
      if (claims.size !== chunks || end.entries !== entries || end.chunks !== chunks || end.digest !== digest || previous && previous.digest !== digest) throw new ServiceError("invalid");
      continue;
    }
    hash.update(line.bytes);
  }
  if (!header || !key || digest === undefined) throw new ServiceError("invalid"); return { key, digest, entries, chunks };
}
export class Vault {
  store: FileVaultStore; memory: VaultMemory; auth: ReturnType<typeof createVaultUnlock>; now: () => number; lastRead = new Map<string, Map<string, string>>();
  constructor(home: string, now: () => number, idle: number, logger: VaultLogger) {
    this.store = new FileVaultStore(home); this.memory = new VaultMemory(now, idle); this.auth = createVaultUnlock(this.store, { memory: this.memory, clock: now, logger }); this.now = now;
  }
  key() { const ticket = this.memory.ticket(); const key = this.memory.get(ticket); this.memory.touch(); return { key, ticket }; }
  check(ticket: number) { this.memory.get(ticket); }
  allowed(app: AppView, kind: Entry["kind"]) { if (!app.kinds.includes(kind) || kind === "apikey" && !manages(app)) throw new ServiceError("not_found", 404); }
  private async keyRows(app: AppView) {
    if (app.id !== "lyra" || app.kind !== "cosmic") throw new ServiceError("forbidden", 403);
    return (await this.rows()).filter(({ entry }) => entry.kind === "apikey" && keyApps(entry).includes(app.id) && fieldValue(entry, "key").length > 0);
  }
  /** Lists the keys the person allowed for the app, by name, without their values. */
  async keyList(app: AppView) { return (await this.keyRows(app)).map(({ entry }) => ({ id: entry.id, label: entry.title })); }
  /** Reads the entry the person chose in the app, on every request. */
  async keyRead(app: AppView, entryId: string, prompts: Prompts) {
    const row = (await this.keyRows(app)).find(({ entry }) => entry.id.toLowerCase() === entryId.toLowerCase());
    if (!row) throw new ServiceError("not_found", 404);
    const { entry } = row;
    if (!app.permissions.includes(`key:${entry.id.toLowerCase()}`)) { const prompt = prompts.key(app, { entry: entry.id, label: entry.title }); throw new ServiceError("key_approval_required", 403, { prompt: prompt.id }); }
    let usage = this.lastRead.get(entry.id); if (!usage) { usage = new Map(); this.lastRead.set(entry.id, usage); } usage.set(app.id, new Date(this.now()).toISOString());
    return { key: fieldValue(entry, "key") };
  }
  async keyApproval(app: AppView, entry: string) { if (!(await this.keyRows(app)).some(row => row.entry.id.toLowerCase() === entry.toLowerCase())) throw new ServiceError("not_found", 404); }
  async keyRevoke(app: AppView, target: string, entryId: string) {
    const row = await this.get(app, entryId); if (row.entry.kind !== "apikey") throw new ServiceError("not_found", 404);
    const entry = structuredClone(row.entry); entry.fields.find(field => field.id === "apps")!.value = keyApps(entry).filter(app => app !== target).join(","); entry.updatedAt = new Date(this.now()).toISOString();
    await this.save(app, entry, row.version); return { ok: true };
  }
  async keyUsage() {
    const entries = new Set((await this.rows()).filter(row => row.entry.kind === "apikey").map(row => row.entry.id));
    for (const entry of this.lastRead.keys()) if (!entries.has(entry)) this.lastRead.delete(entry);
    return [...this.lastRead].flatMap(([entry, apps]) => [...apps].map(([app, lastRead]) => ({ entry, app, lastRead })));
  }
  async rows(): Promise<EntryRow[]> {
    const { key, ticket } = this.key(), rows = await this.store.entries();
    const opened: EntryRow[] = [];
    for (const row of rows) {
      const entry = validateEntry(await decryptJson(key, row.sealed, `entry:${row.id}`)); if (entry.id !== row.id) throw new ServiceError("invalid");
      if (chunkIds(entry.files.flatMap(file => file.chunks)).map(id => id.toLowerCase()).sort().join() !== [...row.chunks].sort().join()) throw new ServiceError("invalid");
      opened.push({ entry, version: row.version });
    }
    this.check(ticket); return opened;
  }
  async list(app: AppView, site?: string) {
    if (app.id === "horizon" && site === undefined) throw new ServiceError("forbidden", 403);
    const requested = site === undefined ? undefined : origin(site);
    if (requested !== undefined) this.allowed(app, "login");
    return (await this.rows()).filter(row => app.kinds.includes(row.entry.kind) && (row.entry.kind !== "apikey" || manages(app)) && (requested === undefined || row.entry.kind === "login" && row.entry.fields.some(field => {
      if (field.id !== "website") return false; try { return origin(field.value) === requested; } catch { return false; }
    })));
  }
  async summaries(app: AppView): Promise<LoginSummary[]> {
    this.allowed(app, "login");
    return (await this.rows()).filter(row => row.entry.kind === "login").map(({ entry, version }) => ({ id: entry.id, version, title: entry.title, username: fieldValue(entry, "username"), website: fieldValue(entry, "website") }));
  }
  async login(app: AppView, entryId: unknown) {
    const entry = id(entryId); this.allowed(app, "login");
    const row = (await this.rows()).find(row => row.entry.id.toLowerCase() === entry.toLowerCase());
    if (!row || row.entry.kind !== "login") throw new ServiceError("not_found", 404);
    return row;
  }
  async save(app: AppView, input: unknown, expected: unknown) {
    // Check the stored kind before replacement validation so hidden IDs stay indistinguishable.
    const entryId = id((input as Entry)?.id);
    const { key, ticket } = this.key(), existing = (await this.rows()).find(row => row.entry.id.toLowerCase() === entryId.toLowerCase());
    if (existing) this.allowed(app, existing.entry.kind);
    const entry = validateEntry(input); version(expected, true); this.allowed(app, entry.kind);
    if (!existing && expected !== 0) throw new ServiceError("not_found", 404);
    if (entry.kind === "env" && (await this.rows()).some(row => row.entry.kind === "env" && row.entry.title === entry.title && row.entry.id !== entry.id)) throw new ServiceError("conflict", 409);
    const sealed = await encryptJson(key, entry, `entry:${entry.id}`); this.check(ticket);
    const result = await this.store.save(entry.id, sealed, expected as number, entry.files.flatMap(file => file.chunks)); this.check(ticket); return result;
  }
  async remove(app: AppView, entryId: unknown, expected: unknown) {
    const entry = id(entryId); const { ticket } = this.key();
    const row = (await this.rows()).find(row => row.entry.id.toLowerCase() === entry.toLowerCase()); if (!row) throw new ServiceError("not_found", 404);
    this.allowed(app, row.entry.kind); version(expected); this.check(ticket); await this.store.remove(entry, expected as number); this.check(ticket); this.lastRead.delete(row.entry.id); return { ok: true };
  }
  async get(app: AppView, entryId: unknown) {
    const entry = id(entryId);
    // Horizon must use origin-filtered logins even when it already knows an ID.
    if (app.id === "horizon") throw new ServiceError("not_found", 404);
    const row = (await this.rows()).find(row => row.entry.id.toLowerCase() === entry.toLowerCase());
    if (!row) throw new ServiceError("not_found", 404);
    this.allowed(app, row.entry.kind); return row;
  }
  async putChunks(app: AppView, data: unknown) {
    this.allowed(app, "doc");
    if (!Array.isArray(data) || data.length < 1 || data.length > 64) throw new ServiceError("invalid");
    for (const value of data) {
      if (typeof value !== "string" || value.length > 43692) throw new ServiceError("invalid");
      const bytes = Buffer.from(value, "base64");
      try { if (!bytes.length || bytes.length > 32768 || bytes.toString("base64") !== value) throw new ServiceError("invalid"); } finally { bytes.fill(0); }
    }
    const { key, ticket } = this.key(), ids: string[] = [];
    try {
      // Sealed first, then written under one store lock: a lock and a folder listing per chunk made a 20 MiB file take minutes.
      const sealed: { id: string; value: Awaited<ReturnType<typeof encrypt>> }[] = [];
      for (const value of data) {
        const bytes = Buffer.from(value, "base64"), next = crypto.randomUUID();
        try { sealed.push({ id: next, value: await encrypt(key, bytes, `chunk:${next}`) }); } finally { bytes.fill(0); }
      }
      this.check(ticket);
      await this.store.staged(async store => { for (const chunk of sealed) { await store.putChunk(chunk.id, chunk.value); ids.push(chunk.id); } });
      this.check(ticket); return { ids };
    } catch (error) { for (const chunk of ids) await this.store.removeChunk(chunk).catch(() => undefined); throw error; }
  }
  async getChunks(app: AppView, entryId: unknown, ids: unknown) {
    const row = await this.get(app, entryId), requested = batchIds(ids), claims = new Set(row.entry.files.flatMap(file => file.chunks).map(chunk => chunk.toLowerCase()));
    if (requested.some(chunk => !claims.has(chunk))) throw new ServiceError("not_found", 404);
    const { key, ticket } = this.key(), data: string[] = [];
    for (const chunk of requested) {
      const bytes = await decrypt(key, await this.store.getChunk(chunk), `chunk:${chunk}`);
      try { this.check(ticket); data.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")); } finally { bytes.fill(0); }
    }
    this.check(ticket); return { data };
  }
  async removeChunks(app: AppView, ids: unknown) {
    this.allowed(app, "doc"); const requested = batchIds(ids), { ticket } = this.key();
    for (const chunk of requested) { this.check(ticket); try { await this.store.removeChunk(chunk); } catch (error) { if (!(error instanceof VaultError && error.code === "not_found")) throw error; } }
    this.check(ticket); return { ok: true };
  }
  async create(password: string) {
    const ticket = this.memory.ticket(), next = await createEnvelope(password); if (!this.memory.current(ticket)) throw new VaultError("locked");
    await this.store.create(next.state); if (!this.memory.open(next.key, ticket)) throw new VaultError("locked"); return { recovery: next.recovery };
  }
  async import(app: AppView, entries: Entry[], skipped = 0): Promise<ImportCount> {
    const rows = await this.rows(), known = new Set(rows.map(row => duplicateKey(row.entry))), ids = new Set(rows.map(row => row.entry.id.toLowerCase())); let duplicates = 0;
    const additions: Entry[] = [];
    for (const entry of entries) { validateEntry(entry); this.allowed(app, entry.kind); const identity = duplicateKey(entry); if (known.has(identity) || ids.has(entry.id.toLowerCase())) { duplicates++; continue; } known.add(identity); ids.add(entry.id.toLowerCase()); additions.push(entry); }
    if (rows.length + additions.length > MAX_ENTRIES) throw new ServiceError("limited", 429);
    for (const entry of additions) await this.save(app, entry, 0);
    return { imported: additions.length, duplicates, skipped };
  }
  async environment(app: AppView, project: string) {
    this.allowed(app, "env"); const rows = (await this.rows()).filter(row => row.entry.kind === "env" && row.entry.title === project);
    if (rows.length !== 1) throw new ServiceError(rows.length ? "conflict" : "not_found", rows.length ? 409 : 404);
    return Object.fromEntries(rows[0].entry.fields.map(field => [field.id, field.value]));
  }
  /** Adds a .env file's variables to the project's entry, or creates it: new names are added, known ones replaced, the rest kept. */
  async importEnv(app: AppView, project: string, variables: [string, string][], skipped: number): Promise<EnvImportCount> {
    this.allowed(app, "env"); if (!project.trim()) throw new ServiceError("invalid");
    const rows = await this.rows(), matching = rows.filter(row => row.entry.kind === "env" && row.entry.title === project);
    if (matching.length > 1) throw new ServiceError("conflict", 409);
    if (!matching.length && rows.length >= MAX_ENTRIES) throw new ServiceError("limited", 429);
    const entry = matching.length ? structuredClone(matching[0].entry) : { ...newEntry("env"), title: project, fields: [] };
    const before = entry.fields.map(field => field.id.toLowerCase()), imported = new Set(variables.map(([name]) => name.toLowerCase())); let added = 0, replaced = 0;
    for (const [name, value] of variables) {
      const field = entry.fields.find(item => item.id.toLowerCase() === name.toLowerCase());
      if (!field) { entry.fields.push({ id: name, name, value, secret: true }); added++; }
      else if (field.value !== value) { field.value = value; replaced++; }
    }
    if (entry.fields.length > MAX_VARIABLES) throw new ServiceError("limited", 429);
    entry.updatedAt = new Date().toISOString(); await this.save(app, entry, matching[0]?.version ?? 0);
    return { added, replaced, unchanged: variables.length - added - replaced, kept: before.filter(name => !imported.has(name)).length, skipped };
  }
  /** Writes an encrypted backup without retaining attachment bytes. */
  async exportToFile(password: string, path: string): Promise<{ entries: number; chunks: number; bytes: number }> {
    backupPath(path); const { key, ticket } = this.key();
    let file: FileHandle; try { file = await open(path, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ServiceError("conflict", 409); throw error; }
    try {
      const rows = await this.store.entries(), claims = rows.flatMap(row => row.chunks), backup = await createEnvelope(password), hash = createHash("sha256"); let bytes = 0;
      if (claims.length > 6400 || new Set(claims.map(id => id.toLowerCase())).size !== claims.length) throw new ServiceError("invalid");
      const counts = { entries: rows.length, chunks: claims.length };
      const line = async (value: unknown, trailer = false) => { this.check(ticket); const data = Buffer.from(`${JSON.stringify(value)}\n`); await file.writeFile(data); bytes += data.length; if (!trailer) hash.update(data); };
      await line({ format: "vault-backup", version: 2, envelope: backup.state, counts });
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index], entry = validateEntry(await decryptJson(key, row.sealed, `entry:${row.id}`));
        if (entry.id !== row.id || chunkIds(entry.files.flatMap(file => file.chunks)).map(id => id.toLowerCase()).sort().join() !== [...row.chunks].sort().join()) throw new ServiceError("invalid");
        await line({ entry: await encryptJson(backup.key, entry, `backup-entry:${index}`) });
      }
      for (let index = 0; index < claims.length; index++) {
        const chunkId = claims[index], data = await decrypt(key, await this.store.getChunk(chunkId), `chunk:${chunkId}`);
        try { await line({ id: chunkId, chunk: await encrypt(backup.key, data, `backup-chunk:${index}:${chunkId}`) }); } finally { data.fill(0); }
      }
      await line({ end: await encryptJson(backup.key, { ...counts, digest: hash.digest("hex") }, "backup-end") }, true);
      this.check(ticket); await file.sync(); await file.close(); return { ...counts, bytes };
    } catch (error) { await file.close().catch(() => undefined); await unlink(path); throw error; }
  }
  /** Validates both passes before publishing the re-encrypted data. */
  async restoreFromFile(app: AppView, path: string, password: string): Promise<ImportCount> {
    backupPath(path); const { key, ticket } = this.key(), file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let staging: string | undefined;
    try {
      if (!(await file.stat()).isFile()) throw new ServiceError("invalid");
      const existing = await this.rows(), known = new Set(existing.map(row => duplicateKey(row.entry))), ids = new Set(existing.map(row => row.entry.id.toLowerCase())), additions = new Map<number, string>(), chunks = new Map<string, string>(); let duplicates = 0;
      const checked = await scanBackup(file, password, async (entry, index) => {
        this.check(ticket); this.allowed(app, entry.kind); const identity = duplicateKey(entry);
        if (known.has(identity) || ids.has(entry.id.toLowerCase())) { duplicates++; return; }
        known.add(identity); ids.add(entry.id.toLowerCase()); additions.set(index, entry.id);
        for (const chunk of entry.files.flatMap(file => file.chunks)) chunks.set(chunk.toLowerCase(), crypto.randomUUID());
      }, async () => { this.check(ticket); });
      if (existing.length + additions.size > MAX_ENTRIES) throw new ServiceError("limited", 429);
      if (!additions.size) return { imported: 0, duplicates, skipped: 0 };
      staging = await mkdtemp(join(this.store.folder, ".restore-"));
      // Only ciphertext reaches staging, and a changed source cannot publish a partial restore.
      await scanBackup(file, password, async (entry, index) => {
        this.check(ticket); if (!additions.has(index)) return;
        for (const file of entry.files) file.chunks = file.chunks.map(chunk => chunks.get(chunk.toLowerCase())!);
        const sealed = await encryptJson(key, entry, `entry:${entry.id}`); this.check(ticket);
        await writeFile(join(staging!, `entry-${index}.json`), JSON.stringify(sealed), { mode: 0o600, flag: "wx" });
      }, async (chunk, bytes) => {
        this.check(ticket); const next = chunks.get(chunk); if (!next) return;
        const sealed = await encrypt(key, bytes, `chunk:${next}`); this.check(ticket);
        await writeFile(join(staging!, `chunk-${next}.json`), JSON.stringify(sealed), { mode: 0o600, flag: "wx" });
      }, checked);
      const installed: string[] = [];
      try {
        for (const next of chunks.values()) { this.check(ticket); const sealed = sealedInput(JSON.parse(await readFile(join(staging, `chunk-${next}.json`), "utf8")), 32784); await this.store.putChunk(next, sealed); installed.push(next); }
        for (const [index, entryId] of additions) { const sealed = sealedInput(JSON.parse(await readFile(join(staging, `entry-${index}.json`), "utf8")), 220000); await this.save(app, await decryptJson(key, sealed, `entry:${entryId}`), 0); }
        this.check(ticket); return { imported: additions.size, duplicates, skipped: 0 };
      } catch (error) { for (const chunk of installed) await this.store.removeChunk(chunk).catch(() => undefined); throw error; }
    } finally { await file.close(); if (staging) await rm(staging, { recursive: true, force: true }); }
  }
  async export(password: string): Promise<Backup> {
    const { key, ticket } = this.key(), entries = (await this.rows()).map(row => row.entry), chunks: { id: string; data: string }[] = [];
    for (const entry of entries) for (const chunk of entry.files.flatMap(file => file.chunks)) {
      const bytes = await decrypt(key, await this.store.getChunk(chunk), `chunk:${chunk}`);
      try { chunks.push({ id: chunk, data: Buffer.from(bytes).toString("base64") }); } finally { bytes.fill(0); }
    }
    const payload = { entries, chunks }; if (Buffer.byteLength(JSON.stringify(payload)) > 6 * 1024 * 1024) throw new ServiceError("too_large", 413);
    const backup = await createEnvelope(password), sealed = await encryptJson(backup.key, payload, "backup"); this.check(ticket);
    return { format: "vault-backup", version: 1, envelope: backup.state, sealed };
  }
  async restore(app: AppView, value: unknown, password: string): Promise<ImportCount> {
    const backup = object(value, "envelope,format,sealed,version"); if (backup.format !== "vault-backup" || backup.version !== 1) throw new ServiceError("invalid");
    const { stateInput, sealed: sealedInput } = await import("vault-core");
    const opened = await unlock(stateInput(backup.envelope), password); opened.bytes.fill(0);
    const payload = object(await decryptJson(opened.key, sealedInput(backup.sealed, 6 * 1024 * 1024 + 16), "backup"), "chunks,entries");
    if (!Array.isArray(payload.entries) || payload.entries.length > MAX_ENTRIES || !Array.isArray(payload.chunks) || payload.chunks.length > 6400) throw new ServiceError("invalid");
    const entries = payload.entries.map(validateEntry), claims = chunkIds(entries.flatMap(entry => entry.files.flatMap(file => file.chunks)));
    const chunks = payload.chunks.map(value => { const chunk = object(value, "data,id"), chunkId = id(chunk.id), data = text(chunk.data, 45000); const bytes = Buffer.from(data, "base64"); if (bytes.length > 32768 || bytes.toString("base64") !== data) throw new ServiceError("invalid"); return { id: chunkId, bytes }; });
    if (new Set(chunks.map(chunk => chunk.id.toLowerCase())).size !== chunks.length || claims.map(id => id.toLowerCase()).sort().join() !== chunks.map(chunk => chunk.id.toLowerCase()).sort().join()) throw new ServiceError("invalid");
    const existing = await this.rows(), known = new Set(existing.map(row => duplicateKey(row.entry))), ids = new Set(existing.map(row => row.entry.id.toLowerCase()));
    const additions: Entry[] = []; let duplicates = 0;
    for (const entry of entries) { this.allowed(app, entry.kind); const identity = duplicateKey(entry); if (known.has(identity) || ids.has(entry.id.toLowerCase())) { duplicates++; continue; } known.add(identity); ids.add(entry.id.toLowerCase()); additions.push(entry); }
    if (existing.length + additions.length > MAX_ENTRIES) throw new ServiceError("limited", 429);
    const { key, ticket } = this.key();
    // Restore into this vault's data key, never copy ciphertext from another envelope.
    try {
      for (const entry of additions) {
        const changed = structuredClone(entry);
        for (const file of changed.files) for (let i = 0; i < file.chunks.length; i++) {
          const chunk = chunks.find(chunk => chunk.id.toLowerCase() === file.chunks[i].toLowerCase())!, next = crypto.randomUUID();
          const sealed = await encrypt(key, Uint8Array.from(chunk.bytes), `chunk:${next}`); this.check(ticket); await this.store.putChunk(next, sealed); file.chunks[i] = next;
        }
        await this.save(app, changed, 0);
      }
    } finally { for (const chunk of chunks) chunk.bytes.fill(0); }
    this.check(ticket); return { imported: additions.length, duplicates, skipped: 0 };
  }
}
