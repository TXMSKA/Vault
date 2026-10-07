import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_ENTRIES } from "./model.js";
import type { Sealed, VaultState } from "./model.js";
import { chunkIds, id, sealed, shape, stateInput, version, VaultError } from "./store.js";
import type { StoredEntry, StoredEnvelope, VaultStore } from "./store.js";

type Row = { version: number; value: unknown };
type Owner = { pid: number; token: string; time: number };
const identities = new Map<string, object>();
export type FileStoreOptions = { lockTimeoutMs?: number; staleLockMs?: number };
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function errno(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && error.code === code; }
// Windows refuses to open, replace or delete a file another process has open for a moment; that is contention, not failure.
const busy = (error: unknown) => process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].some(code => errno(error, code));
async function settle<T>(operation: () => Promise<T>, deadline?: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!busy(error) || (deadline === undefined ? attempt >= 50 : performance.now() >= deadline)) throw error;
      await pause(5 + Math.floor(Math.random() * 15));
    }
  }
}
function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) { return errno(error, "ESRCH"); }
}
async function batch<T, U>(values: T[], operation: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(values.length); let next = 0, failure: { index: number; reason: unknown } | undefined;
  const failed = (index: number, reason: unknown) => { if (!failure || index < failure.index) failure = { index, reason }; };
  // A slow Windows file must not stall all later work; keep the pool bounded and drain it before unlocking.
  const worker = async () => {
    while (!failure && next < values.length) {
      const index = next++;
      try { results[index] = await operation(values[index]); }
      catch (reason) { failed(index, reason); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, values.length) }, worker));
  if (failure) throw failure.reason;
  return results;
}
export function defaultVaultFolder(): string {
  if (process.env.VAULT_HOME) return join(resolve(process.env.VAULT_HOME), "store");
  if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) throw new VaultError("unavailable");
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  if (!base) throw new VaultError("unavailable"); return join(base, "Cosmic", "vault");
}
export class FileVaultStore implements VaultStore {
  readonly folder: string;
  readonly identity: object;
  private timeout: number;
  private stale: number;
  constructor(folder = defaultVaultFolder(), options: FileStoreOptions = {}) {
    this.folder = resolve(folder); this.timeout = options.lockTimeoutMs ?? 10000; this.stale = options.staleLockMs ?? 30000;
    const scope = process.platform === "win32" ? this.folder.toLowerCase() : this.folder;
    this.identity = identities.get(scope) ?? {}; identities.set(scope, this.identity);
    if (![this.timeout, this.stale].every(n => Number.isSafeInteger(n) && n > 0)) throw new VaultError("invalid");
  }
  private async prepare() {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.folder); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VaultError("unavailable");
    if (process.platform !== "win32") await chmod(this.folder, 0o700);
  }
  private async json(name: string, max: number, deadline?: number): Promise<unknown> {
    let file;
    try { file = await settle(() => open(join(this.folder, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), deadline); }
    catch (error) { if (errno(error, "ENOENT")) return undefined; throw error; }
    try {
      const stat = await file.stat(); if (!stat.isFile() || stat.size > max) throw new VaultError("invalid");
      if (process.platform !== "win32") await file.chmod(0o600);
      // One extra byte detects external growth without allocating the maximum row size for every small entry.
      const bytes = Buffer.alloc(stat.size + 1); let count = 0;
      while (count <= stat.size) { const read = await file.read(bytes, count, bytes.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      if (count > stat.size) throw new VaultError("invalid");
      return JSON.parse(bytes.subarray(0, count).toString("utf8")) as unknown;
    } finally { await file.close(); }
  }
  private async owner(name = ".lock", deadline?: number): Promise<Owner | null> {
    let value;
    try { value = await this.json(name, 1024, deadline); }
    // Older writers can expose the interval between exclusive creation and the owner write.
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    if (value === undefined) return null;
    shape(value, "pid,time,token"); const v = value as Owner;
    if (!Number.isSafeInteger(v.pid) || v.pid < 1 || !Number.isSafeInteger(v.time) || v.time < 0) throw new VaultError("unavailable");
    id(v.token); return v;
  }
  private async acquire(): Promise<Owner> {
    const start = performance.now(), owner = { pid: process.pid, token: randomUUID(), time: Date.now() };
    const candidate = join(this.folder, `.tmp-${owner.token}`), path = join(this.folder, ".lock");
    let acquired = false;
    try {
      const file = await settle(() => open(candidate, "wx", 0o600));
      try { await file.writeFile(JSON.stringify(owner)); await file.sync(); } finally { await file.close(); }
      // An exclusive hard link publishes a complete owner; failed writes cannot leave an ownerless lock.
      while (performance.now() - start < this.timeout) {
        try { await link(candidate, path); acquired = true; return owner; }
        catch (error) { if (!errno(error, "EEXIST") && !busy(error)) throw error; }
        try {
          const previous = await this.owner();
          if (previous && Date.now() - previous.time >= this.stale && dead(previous.pid)) await this.reap(".lock", previous, candidate);
        } catch (error) {
          // A delete-pending Windows lock is still contention, even if an observation exhausted its short retry.
          if (!busy(error)) throw error;
        }
        await pause(10 + Math.floor(Math.random() * 20));
      }
      throw new VaultError("unavailable");
    } finally { if (!acquired) await this.erasePath(candidate); }
  }
  private async reap(name: string, previous: Owner, candidate: string, depth = 0): Promise<void> {
    // A claim per dead owner prevents two removers from deleting a new owner's lock.
    const claim = `.reap-${previous.token}`, path = join(this.folder, claim); let acquired = false;
    try { await link(candidate, path); acquired = true; }
    catch (error) { if (!errno(error, "EEXIST") && !busy(error)) throw error; }
    if (!acquired) {
      const guard = await this.owner(claim);
      // A crashed remover has its own token, so recovery of its claim uses the same exclusive protocol.
      if (guard && dead(guard.pid) && depth < 8) await this.reap(claim, guard, candidate, depth + 1);
      return;
    }
    try { const current = await this.owner(name); if (current?.token === previous.token) await this.erase(name); }
    finally { await this.erase(claim); }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.prepare(); const owner = await this.acquire();
      try { return await operation(); }
      finally {
        try {
          // Release must survive contention within the lock budget, or a completed write strands a live owner's lock.
          const deadline = performance.now() + this.timeout;
          const current = await this.owner(".lock", deadline); if (current?.token !== owner.token) throw new VaultError("unavailable");
          await settle(() => unlink(join(this.folder, ".lock")), deadline);
        } finally { await this.erase(`.tmp-${owner.token}`); }
      }
    } catch (error) { throw error instanceof VaultError ? error : new VaultError("unavailable"); }
  }
  private async write(name: string, value: unknown) {
    const temp = join(this.folder, `.tmp-${randomUUID()}`); let present = true;
    try {
      const file = await settle(() => open(temp, "wx", 0o600));
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await settle(() => rename(temp, join(this.folder, name))); present = false;
      // Windows does not support opening a directory for fsync; POSIX needs it for rename durability.
      if (process.platform !== "win32") {
        const folder = await open(this.folder, "r"); try { await folder.sync(); } finally { await folder.close(); }
      }
    } finally { if (present) await this.erasePath(temp); }
  }
  private async erasePath(path: string) { try { await settle(() => unlink(path)); } catch (error) { if (!errno(error, "ENOENT")) throw error; } }
  private erase(name: string) { return this.erasePath(join(this.folder, name)); }
  private async row(name: string, max: number): Promise<Row | null> {
    const value = await this.json(name, max); if (value === undefined) return null;
    shape(value, "value,version"); const row = value as Row; version(row.version); return row;
  }
  private async names(kind: "entry" | "chunk", limit: number): Promise<string[]> {
    const names = (await readdir(this.folder)).filter(name => name.startsWith(`${kind}-`) && name.endsWith(".json"));
    if (names.length > limit) throw new VaultError("limited");
    for (const name of names) if (id(name.slice(kind.length + 1, -5)).toLowerCase() !== name.slice(kind.length + 1, -5)) throw new VaultError("invalid");
    return names.sort();
  }
  private async inventory(): Promise<StoredEntry[]> {
    const names = await this.names("entry", MAX_ENTRIES);
    const read = async (name: string): Promise<StoredEntry> => {
      const row = await this.row(name, 420000); if (!row) throw new VaultError("unavailable");
      shape(row.value, "chunks,id,sealed"); const value = row.value as { id: string; sealed: Sealed; chunks: string[] };
      if (id(value.id).toLowerCase() !== name.slice(6, -5)) throw new VaultError("invalid");
      return { id: value.id, version: row.version, sealed: sealed(value.sealed, 220000), chunks: chunkIds(value.chunks) };
    };
    // Bounded parallel reads keep large inventories from monopolizing the lock or exhausting file handles.
    return batch(names, read);
  }
  envelope(): Promise<StoredEnvelope> {
    return this.locked(async () => { const row = await this.row("envelope.json", 2048); return row ? { state: stateInput(row.value), version: row.version } : { state: null, version: 0 }; });
  }
  create(value: VaultState) {
    const state = stateInput(value);
    return this.locked(async () => {
      if (await this.row("envelope.json", 2048)) throw new VaultError("conflict");
      await this.write("envelope.json", { version: 1, value: state }); return { version: 1 };
    });
  }
  replace(value: VaultState, expected: number) {
    const state = stateInput(value); version(expected);
    return this.locked(async () => {
      const row = await this.row("envelope.json", 2048); if (!row || row.version !== expected) throw new VaultError("conflict");
      const next = version(expected + 1); await this.write("envelope.json", { version: next, value: state }); return { version: next };
    });
  }
  entries() { return this.locked(() => this.inventory()); }
  save(entryId: string, value: Sealed, expected: number, chunks: string[]) {
    const entry = id(entryId).toLowerCase(), payload = sealed(value, 220000), claims = chunkIds(chunks).map(value => value.toLowerCase()); version(expected, true);
    return this.locked(async () => {
      const rows = await this.inventory(), current = rows.find(row => row.id.toLowerCase() === entry);
      if ((current?.version ?? 0) !== expected) throw new VaultError("conflict");
      if (current && current.id !== entryId) throw new VaultError("invalid");
      if (!current && rows.length >= MAX_ENTRIES) throw new VaultError("limited");
      await batch(claims, async chunk => { const row = await this.row(`chunk-${chunk}.json`, 47000); if (!row) throw new VaultError("invalid"); sealed(row.value, 32784); });
      if (rows.some(row => row.id.toLowerCase() !== entry && row.chunks.some(chunk => claims.includes(chunk)))) throw new VaultError("conflict");
      const next = version(expected + 1);
      await this.write(`entry-${entry}.json`, { version: next, value: { id: entryId, sealed: payload, chunks: claims } });
      await batch((current?.chunks ?? []).filter(chunk => !claims.includes(chunk)), chunk => this.erase(`chunk-${chunk}.json`));
      return { version: next };
    });
  }
  remove(entryId: string, expected: number) {
    const entry = id(entryId).toLowerCase(); version(expected);
    return this.locked(async () => {
      const row = (await this.inventory()).find(row => row.id.toLowerCase() === entry); if (!row) throw new VaultError("not_found");
      if (row.version !== expected) throw new VaultError("conflict");
      await this.erase(`entry-${entry}.json`); await batch(row.chunks, chunk => this.erase(`chunk-${chunk}.json`));
    });
  }
  putChunk(chunkId: string, value: Sealed) {
    const chunk = id(chunkId).toLowerCase(), payload = sealed(value, 32784);
    return this.locked(async () => {
      if (await this.row(`chunk-${chunk}.json`, 47000)) throw new VaultError("conflict");
      if ((await this.names("chunk", 6400)).length >= 6400) throw new VaultError("limited");
      await this.write(`chunk-${chunk}.json`, { version: 1, value: payload }); return { version: 1 };
    });
  }
  getChunk(chunkId: string) {
    const chunk = id(chunkId).toLowerCase();
    return this.locked(async () => { const row = await this.row(`chunk-${chunk}.json`, 47000); if (!row) throw new VaultError("not_found"); return sealed(row.value, 32784); });
  }
  removeChunk(chunkId: string) {
    const chunk = id(chunkId).toLowerCase();
    return this.locked(async () => {
      if ((await this.inventory()).some(row => row.chunks.includes(chunk))) throw new VaultError("conflict");
      await this.erase(`chunk-${chunk}.json`);
    });
  }
}
