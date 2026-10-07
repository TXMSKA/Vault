import { FileVaultStore, VaultMemory, createVaultUnlock, createEnvelope, encryptJson, decryptJson, encrypt, decrypt, unlock, KINDS, id, version, chunkIds, VaultError } from "vault-core";
import type { Entry, VaultLogger } from "vault-core";
import type { AppView, Backup, EntryRow, ImportCount } from "../../client/src/types.ts";
import { ServiceError, object, text } from "./errors.ts";
import { duplicateKey, MAX_ENTRIES } from "./imports.ts";
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
export class Vault {
  store: FileVaultStore; memory: VaultMemory; auth: ReturnType<typeof createVaultUnlock>;
  constructor(home: string, now: () => number, idle: number, logger: VaultLogger) {
    this.store = new FileVaultStore(home); this.memory = new VaultMemory(now, idle); this.auth = createVaultUnlock(this.store, { memory: this.memory, clock: now, logger });
  }
  key() { const ticket = this.memory.ticket(); const key = this.memory.get(ticket); this.memory.touch(); return { key, ticket }; }
  check(ticket: number) { this.memory.get(ticket); }
  allowed(app: AppView, kind: Entry["kind"]) { if (!app.kinds.includes(kind)) throw new ServiceError("not_found", 404); }
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
    return (await this.rows()).filter(row => app.kinds.includes(row.entry.kind) && (requested === undefined || row.entry.kind === "login" && row.entry.fields.some(field => {
      if (field.id !== "website") return false; try { return origin(field.value) === requested; } catch { return false; }
    })));
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
    this.allowed(app, row.entry.kind); version(expected); this.check(ticket); await this.store.remove(entry, expected as number); this.check(ticket); return { ok: true };
  }
  async get(app: AppView, entryId: unknown) {
    const entry = id(entryId);
    // Horizon must use origin-filtered logins even when it already knows an ID.
    if (app.id === "horizon") throw new ServiceError("not_found", 404);
    const row = (await this.rows()).find(row => row.entry.id.toLowerCase() === entry.toLowerCase());
    if (!row) throw new ServiceError("not_found", 404);
    this.allowed(app, row.entry.kind); return row;
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
