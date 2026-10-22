import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { id, VaultError, SYNC_BLOB_CAP, SYNC_CALL_MS, SYNC_FILE_LIMIT, SYNC_PACKAGE_CAP } from "vault-core";
import { readCapped } from "../../client/src/files.ts";
import { privateDirectoryAsync, privateFileAsync } from "../../client/src/private.ts";
import { object, ServiceError, text } from "./errors.ts";
import { limited } from "./sync.ts";
import type { SyncTransport } from "./sync.ts";

export type QuantumAccount = { api: string; site: string; account: string };
type Credentials = { api: string; site: string; refreshToken: string | null; deviceId: string; account: string | null };
type Reply = { status: number; headers: Headers; bytes: Buffer };
type Pending = { server: Server; timer: ReturnType<typeof setTimeout>; promise: Promise<{ account: string }>; done: (account: { account: string }) => void; fail: (error: ServiceError) => void; accepted: boolean };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const opaque = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (reply: Reply): Record<string, unknown> => { try { const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.bytes)); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new VaultError("invalid"); } };

export function quantumUrl(value: unknown): string {
  try { const input = text(value, 2048), url = new URL(input); if (!input || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === "http:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(); return url.href.replace(/\/+$/, ""); }
  catch { throw new ServiceError("invalid"); }
}
function failed(reply: Reply): never {
  let code = ""; try { const error = json(reply).error; if (error && typeof error === "object" && !Array.isArray(error)) code = String((error as Record<string, unknown>).code); } catch {}
  if (reply.status === 401) throw new ServiceError("sync_signin_required", 401);
  if (reply.status === 403 && code === "sync_plan_required") throw new ServiceError("sync_plan_required", 403);
  if (code === "pool_exceeded") throw new ServiceError("sync_storage_full", 409);
  if (code === "writer_limit_exceeded" || reply.status === 413) throw new VaultError("limited");
  if (reply.status === 409 && code === "object_conflict") throw new VaultError("conflict");
  if (reply.status === 404) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  if (reply.status === 429) throw new ServiceError("sync_busy", 503);
  if (reply.status >= 500) throw new ServiceError("sync_unavailable", 503);
  throw new VaultError("invalid");
}

export class QuantumAuth {
  private home: string; private filename: string; private language: () => string; private credentials: Credentials | null = null; private access: string | null = null;
  private refreshing: Promise<void> | null = null; private revision = 0; private pending = new Map<string, Pending>(); private writing: Promise<void> = Promise.resolve();
  constructor(home: string, language: () => string = () => "en") { this.home = resolve(home); this.filename = join(this.home, "secrets", "quantum.json"); this.language = language; }
  async load(): Promise<void> {
    try { await lstat(this.filename); } catch (error) { if (missing(error)) return; throw new ServiceError("sync_signin_required", 401); }
    try {
      await privateFileAsync(this.filename, this.home); const v = object(JSON.parse(await readCapped(this.filename, 8192)), "account,api,deviceId,refreshToken,site");
      const api = quantumUrl(v.api), site = quantumUrl(v.site); id(v.deviceId); if (v.refreshToken !== null && !opaque(v.refreshToken) || v.account !== null && (!text(v.account, 320) || /[\x00-\x1f\x7f]/.test(v.account as string)) || (v.refreshToken === null) !== (v.account === null)) throw new Error();
      this.credentials = { api, site, deviceId: v.deviceId as string, refreshToken: v.refreshToken as string | null, account: v.account as string | null };
    } catch { throw new ServiceError("sync_signin_required", 401); }
  }
  identity(): { api: string; site: string; deviceId: string; account: string } { const c = this.credentials; if (!c?.refreshToken || !c.account) throw new ServiceError("sync_signin_required", 401); return { api: c.api, site: c.site, deviceId: c.deviceId, account: c.account }; }
  private async save(value: Credentials, revision = this.revision) {
    const pending = this.writing.catch(() => {}).then(async () => {
      if (revision !== this.revision) throw new ServiceError("sync_signin_required", 401); await privateDirectoryAsync(join(this.home, "secrets"), this.home); const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await privateFileAsync(temporary, this.home); if (revision !== this.revision) throw new ServiceError("sync_signin_required", 401); await rename(temporary, this.filename); if (revision !== this.revision) throw new ServiceError("sync_signin_required", 401); }
      finally { await rm(temporary, { force: true }); }
    }); this.writing = pending; return pending;
  }
  async clear(deviceId?: string): Promise<void> {
    const previous = this.credentials; if (deviceId) id(deviceId); this.access = null; this.credentials = null; this.stop(); await this.writing.catch(() => {}); await rm(this.filename, { force: true });
    if (deviceId && previous) { const next = { ...previous, deviceId, refreshToken: null, account: null }; await this.save(next); this.credentials = next; }
  }
  private async raw(api: string, path: string, init: RequestInit = {}, cap = SYNC_PACKAGE_CAP, signal: AbortSignal = AbortSignal.timeout(SYNC_CALL_MS)): Promise<Reply> {
    return limited(async live => {
      let response: Response; try { response = await fetch(`${api}${path}`, { ...init, redirect: "error", signal }); } catch { throw new ServiceError("sync_unavailable", 503); } live();
      const ceiling = response.ok ? cap : 65536, length = response.headers.get("content-length"), reader = response.body?.getReader();
      try {
        if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > ceiling)) throw new VaultError("limited");
        const parts: Uint8Array[] = []; let size = 0;
        if (reader) for (;;) { let next; try { next = await reader.read(); } catch { throw new ServiceError("sync_unavailable", 503); } live(); if (next.done) break; size += next.value.byteLength; if (size > ceiling) throw new VaultError("limited"); parts.push(next.value); }
        if (length !== null && Number(length) !== size) throw new VaultError("invalid"); return { status: response.status, headers: response.headers, bytes: Buffer.concat(parts, size) };
      } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
    });
  }
  private token(reply: Reply): { accessToken: string; refreshToken: string } {
    const v = json(reply); if (!opaque(v.accessToken) || !opaque(v.refreshToken) || v.tokenType !== "Bearer" || !Number.isSafeInteger(v.expiresIn) || (v.expiresIn as number) < 1 || typeof v.deviceId !== "string" || !v.deviceId || v.deviceId.length > 128) throw new ServiceError("sync_signin_failed"); return { accessToken: v.accessToken as string, refreshToken: v.refreshToken as string };
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const pending = (async () => {
      const c = this.credentials, revision = this.revision; this.identity(); if (!c?.refreshToken) throw new ServiceError("sync_signin_required", 401);
      const reply = await this.raw(c.api, "/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grantType: "refresh_token", refreshToken: c.refreshToken, appId: "vault" }) }, 8192, signal);
      if (revision !== this.revision) throw new ServiceError("sync_signin_required", 401);
      if (reply.status === 400 || reply.status === 401 || reply.status === 403) { await this.clear(); throw new ServiceError("sync_signin_required", 401); }
      if (reply.status < 200 || reply.status >= 300) failed(reply); const tokens = this.token(reply), next = { ...c, refreshToken: tokens.refreshToken };
      await this.save(next, revision); this.credentials = next; this.access = tokens.accessToken;
    })(); this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = null; }
  }
  async request(api: string, path: string, init: RequestInit = {}, cap = SYNC_PACKAGE_CAP): Promise<Reply> {
    return limited(async live => {
      if (quantumUrl(api) !== this.identity().api || !path.startsWith("/v1/") || path.includes("\\")) throw new ServiceError("sync_signin_required", 401);
      const revision = this.revision, signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(SYNC_CALL_MS)]) : AbortSignal.timeout(SYNC_CALL_MS); if (!this.access) await this.refresh(signal); live(); let retried = false, delayed = false;
      for (;;) {
        const access = this.access; if (!access || revision !== this.revision || api !== this.identity().api) throw new ServiceError("sync_signin_required", 401); const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${access}`);
        const reply = await this.raw(api, path, { ...init, headers }, cap, signal); live(); if (revision !== this.revision) throw new ServiceError("sync_signin_required", 401);
        if (reply.status === 401 && !retried) { retried = true; if (this.access === access) await this.refresh(signal); live(); continue; }
        if (reply.status === 429 && !delayed) {
          delayed = true; const value = reply.headers.get("Retry-After"), seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value ? Math.max(0, (Date.parse(value) - Date.now()) / 1000) : 0;
          await new Promise<void>(done => setTimeout(done, Math.min(5000, Number.isFinite(seconds) ? seconds * 1000 : 0))); live(); continue;
        }
        if (reply.status === 401) { await this.clear(); throw new ServiceError("sync_signin_required", 401); }
        if (reply.status < 200 || reply.status >= 300) failed(reply); return reply;
      }
    });
  }
  async start(api: string, site: string, deviceId?: string): Promise<{ url: string; id: string }> {
    api = quantumUrl(api); site = quantumUrl(site); deviceId ??= this.credentials?.deviceId ?? randomUUID(); id(deviceId); this.stop(); this.pending.clear();
    const revision = ++this.revision, next: Credentials = { api, site, deviceId, refreshToken: null, account: null }; this.access = null; await this.save(next); this.credentials = next;
    const verifier = randomBytes(32).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url"), requestId = randomUUID(); let redirectUri = "";
    let done!: Pending["done"], fail!: Pending["fail"]; const promise = new Promise<{ account: string }>((resolve, reject) => { done = resolve; fail = reject; }); void promise.catch(() => {});
    const server = createServer((request, response) => {
      let url: URL; try { if (!request.url || request.url.length > 4096) throw new Error(); url = new URL(request.url, "http://127.0.0.1"); } catch { response.writeHead(400).end(); return; }
      const pending = this.pending.get(requestId); if (request.method !== "GET" || url.pathname !== "/callback") { response.writeHead(404).end(); return; }
      const codes = url.searchParams.getAll("code"); if (!pending || pending.accepted || codes.length !== 1 || !opaque(codes[0])) { response.writeHead(400).end(); return; }
      pending.accepted = true; clearTimeout(pending.timer); server.close();
      void (async () => {
        try {
          const reply = await this.raw(api, "/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grantType: "authorization_code", code: codes[0], codeVerifier: verifier, redirectUri, appId: "vault" }) }, 8192);
          if (reply.status < 200 || reply.status >= 300) throw new Error(); const tokens = this.token(reply);
          const me = await this.raw(api, "/v1/me", { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, 65536); if (me.status !== 200) throw new Error();
          const account = text(json(me).email, 320); if (!account || /[\x00-\x1f\x7f]/.test(account) || revision !== this.revision) throw new Error();
          const credentials = { ...next, refreshToken: tokens.refreshToken, account }; await this.save(credentials, revision);
          this.credentials = credentials; this.access = tokens.accessToken; response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" }).end(`<!doctype html><html><meta charset="utf-8"><title>Vault</title><p>${/^es(?:-|$)/i.test(this.language()) ? "Vault inició sesión. Se puede cerrar esta ventana." : "Vault is signed in. This window can be closed."}</p></html>`); done({ account });
        } catch { response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(`<!doctype html><html><meta charset="utf-8"><title>Vault</title><p>${/^es(?:-|$)/i.test(this.language()) ? "No se pudo iniciar sesión en Vault." : "Vault sign-in failed."}</p></html>`); fail(new ServiceError("sync_signin_failed")); }
      })();
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1;
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); }); }
    catch { server.close(); throw new ServiceError("sync_signin_failed"); }
    const address = server.address(); if (!address || typeof address === "string") { server.close(); throw new ServiceError("sync_signin_failed"); } redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const timer = setTimeout(() => { server.close(); fail(new ServiceError("sync_signin_timeout")); }, 300000); timer.unref(); this.pending.set(requestId, { server, timer, promise, done, fail, accepted: false });
    const url = new URL(`${site}/authorize`); for (const [key, value] of Object.entries({ appId: "vault", redirectUri, codeChallenge: challenge, computerId: deviceId, deviceName: hostname().trim().slice(0, 128) || "Vault" })) url.searchParams.set(key, value); return { url: url.href, id: requestId };
  }
  async wait(requestId: string): Promise<{ account: string }> { id(requestId); const pending = this.pending.get(requestId); if (!pending) throw new ServiceError("sync_signin_failed"); return pending.promise; }
  async poll(requestId: string): Promise<{ pending: true } | { account: string }> { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([this.wait(requestId), new Promise<{ pending: true }>(done => { timer = setTimeout(() => done({ pending: true }), 20000); timer.unref(); })]); } finally { if (timer) clearTimeout(timer); } }
  async signOut(): Promise<{ ok: true }> { const c = this.credentials; if (c?.refreshToken) { try { await this.request(c.api, "/v1/oauth/revoke", { method: "POST" }); } catch {} } await this.clear(); return { ok: true }; }
  async datasets(): Promise<string[]> {
    const api = this.identity().api, result = new Set<string>(); let after: string | null = null;
    return limited(async live => { for (;;) { const query = new URLSearchParams({ limit: "1000", ...(after ? { after } : {}) }), value = json(await this.request(api, `/v1/datasets?${query}`)); live(); if (!Array.isArray(value.datasets) || value.datasets.length > 1000 || value.after !== null && (typeof value.after !== "string" || !value.after || value.after.length > 255)) throw new VaultError("invalid");
      for (const row of value.datasets) { if (!row || typeof row !== "object" || row.appId !== "vault") throw new VaultError("invalid"); id(row.id); result.add(row.id); if (result.size > SYNC_FILE_LIMIT) throw new VaultError("limited"); }
      if (value.after === null) return [...result].sort(); if (after !== null && value.after <= after || !value.datasets.length) throw new VaultError("invalid"); after = value.after as string;
    } });
  }
  async createDataset(datasetId: string): Promise<void> { id(datasetId); await this.request(this.identity().api, `/v1/datasets/${datasetId}`, { method: "PUT" }); }
  async usage(): Promise<{ used: number; pool: number | null }> { const value = json(await this.request(this.identity().api, "/v1/usage")); if (!Number.isSafeInteger(value.usedBytes) || (value.usedBytes as number) < 0 || value.poolBytes !== null && (!Number.isSafeInteger(value.poolBytes) || (value.poolBytes as number) < 0)) throw new VaultError("invalid"); return { used: value.usedBytes as number, pool: value.poolBytes as number | null }; }
  stop(): void { this.revision++; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.server.close(); pending.fail(new ServiceError("sync_signin_failed")); } }
}

export class QuantumTransport implements SyncTransport {
  private auth: QuantumAuth; private api: string; private datasetId: string; private own: string;
  constructor(auth: QuantumAuth, api: string, datasetId: string, own: string) { id(datasetId); const pair = own.split("/"); if (pair.length !== 2) throw new VaultError("invalid"); pair.forEach(id); this.auth = auth; this.api = quantumUrl(api); this.datasetId = datasetId; this.own = own; }
  private path(name: string): string { if (!name || name.length > 255 || !/^[A-Za-z0-9_./-]+$/.test(name) || name.split("/").some(part => !part || part === "." || part === "..")) throw new VaultError("invalid"); return `/v1/datasets/${this.datasetId}/objects/${name}`; }
  private async objects(prefix: string, visit: (path: string) => void | Promise<void>, allowMissingRoot = false): Promise<void> {
    let after: string | null = null, previous = "";
    return limited(async live => { for (;;) {
      const query = new URLSearchParams({ prefix, limit: "1000", ...(after ? { after } : {}) }); let reply: Reply;
      try { reply = await this.auth.request(this.api, `/v1/datasets/${this.datasetId}/objects?${query}`); } catch (error) { if (allowMissingRoot && missing(error)) return; throw error; } live(); const value = json(reply);
      if (!Array.isArray(value.objects) || value.objects.length > 1000 || value.after !== null && (typeof value.after !== "string" || !value.after || value.after.length > 255)) throw new VaultError("invalid");
      for (const row of value.objects) { if (!row || typeof row !== "object" || typeof row.path !== "string" || !row.path.startsWith(prefix) || row.path <= previous) throw new VaultError("invalid"); this.path(row.path); previous = row.path; await visit(row.path); live(); }
      if (value.after === null) return; if (after !== null && value.after <= after || !value.objects.length || value.after !== previous) throw new VaultError("invalid"); after = value.after as string;
    } });
  }
  async list(name: string, allowMissingRoot = false): Promise<string[]> { if (name) this.path(name); const prefix = name ? `${name}/` : "", names = new Set<string>(); await this.objects(prefix, path => { names.add(path.slice(prefix.length).split("/")[0]); if (names.size > SYNC_FILE_LIMIT) throw new VaultError("limited"); }, allowMissingRoot); return [...names].sort(); }
  async read(name: string, cap = SYNC_PACKAGE_CAP): Promise<string> { const reply = await this.auth.request(this.api, this.path(name), {}, cap); try { const checksum = reply.headers.get("X-Content-SHA256"); if (!checksum || !/^[0-9a-f]{64}$/.test(checksum) || digest(reply.bytes) !== checksum) throw new VaultError("invalid"); try { return new TextDecoder("utf-8", { fatal: true }).decode(reply.bytes); } catch { throw new VaultError("invalid"); } } finally { reply.bytes.fill(0); } }
  async write(name: string, bytes: string, dataset = false): Promise<boolean> {
    if (Buffer.byteLength(bytes) > (name.includes("/blobs/") ? SYNC_BLOB_CAP : SYNC_PACKAGE_CAP) || !(dataset && name === "dataset.vsync") && !name.startsWith(`writers/${this.own}/`)) throw new VaultError("invalid");
    const reply = await this.auth.request(this.api, this.path(name), { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(Buffer.byteLength(bytes)), "X-Content-SHA256": digest(bytes) }, body: bytes }); if (reply.status !== 200 && reply.status !== 201) throw new VaultError("invalid"); return reply.status === 201;
  }
  async remove(name: string, dataset = false): Promise<void> { if (!(dataset && name === "dataset.vsync") && !name.startsWith(`writers/${this.own}/`)) throw new VaultError("invalid"); try { await this.auth.request(this.api, this.path(name), { method: "DELETE" }); } catch (error) { if (!missing(error)) throw error; } }
  async leave(): Promise<void> { const deviceId = this.own.split("/")[0]; await this.objects(`writers/${deviceId}/`, async path => { try { await this.auth.request(this.api, this.path(path), { method: "DELETE" }); } catch (error) { if (!missing(error)) throw error; } }, true); }
}
