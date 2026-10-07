import { id } from "vault-core";
import type { AppView } from "../../client/src/types.ts";
import { object, text, ServiceError } from "./errors.ts";
import type { Apps } from "./secrets.ts";
import type { Vault } from "./vault.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { helloAdapter } from "./hello.ts";
import { parseImport, formats } from "./imports.ts";
import type { ImportFormat } from "../../client/src/types.ts";
export type Context = { app?: AppView; apps: Apps; vault: Vault; lifecycle: Lifecycle; hello: ReturnType<typeof helloAdapter>; body: Record<string, unknown>; query: URLSearchParams; id?: string; idleMs: number };
export type Route = { method: string; path: string; access: "public" | "bootstrap" | "granted" | "manage"; keys: string; query?: string; handle(c: Context): unknown | Promise<unknown> };
const password = (value: unknown) => { const result = text(value, 128); if (result.length < 15) throw new ServiceError("invalid"); return result; };
const active = (c: Context) => c.lifecycle.requirePresence(c.app!.id);
export const routes: Route[] = [
  { method: "GET", path: "/v1/health", access: "public", keys: "", handle: () => ({ ok: true, pid: process.pid, serviceVersion: "0.1.0" }) },
  { method: "POST", path: "/v1/apps/register", access: "bootstrap", keys: "id,kind,name", handle: c => c.apps.register(c.body) },
  { method: "GET", path: "/v1/status", access: "granted", keys: "", handle: async c => { c.lifecycle.check(); let unlocked = false; try { c.vault.memory.get(c.vault.memory.ticket()); unlocked = true; } catch {} return { created: !!(await c.vault.store.envelope()).state, unlocked, present: c.lifecycle.presences.size, idleMs: c.idleMs }; } },
  { method: "POST", path: "/v1/apps/present", access: "granted", keys: "session", handle: c => { c.lifecycle.present(c.app!.id, id(c.body.session)); return { ok: true }; } },
  { method: "POST", path: "/v1/apps/leave", access: "granted", keys: "session", handle: c => { c.lifecycle.leave(c.app!.id, id(c.body.session)); return { ok: true }; } },
  { method: "POST", path: "/v1/create", access: "manage", keys: "password", handle: c => { active(c); return c.vault.create(password(c.body.password)); } },
  { method: "POST", path: "/v1/unlock", access: "granted", keys: "password", handle: async c => { active(c); await c.vault.auth.unlock(text(c.body.password, 128)); return { ok: true }; } },
  { method: "POST", path: "/v1/recover", access: "manage", keys: "password,recovery", handle: async c => { active(c); const result = await c.vault.auth.recover(text(c.body.recovery, 128), password(c.body.password)); await c.hello.disable(); return { recovery: result.recovery }; } },
  { method: "POST", path: "/v1/unlock/hello/enable", access: "manage", keys: "password", handle: async c => { active(c); await c.hello.enable(text(c.body.password, 128)); return { ok: true }; } },
  { method: "POST", path: "/v1/unlock/hello", access: "granted", keys: "hwnd", handle: async c => { active(c); const hwnd = text(c.body.hwnd, 20); if (!/^[1-9][0-9]{0,18}$/.test(hwnd)) throw new ServiceError("invalid"); await c.hello.unlock(BigInt(hwnd)); return { ok: true }; } },
  { method: "POST", path: "/v1/unlock/hello/disable", access: "manage", keys: "", handle: async c => { await c.hello.disable(); return { ok: true }; } },
  { method: "POST", path: "/v1/lock", access: "granted", keys: "", handle: c => { c.vault.auth.lock(); return { ok: true }; } },
  { method: "GET", path: "/v1/logins", access: "granted", keys: "", query: "origin", handle: c => c.vault.list(c.app!, text(c.query.get("origin"))) },
  { method: "GET", path: "/v1/logins/all", access: "granted", keys: "", handle: c => c.vault.summaries(c.app!) },
  { method: "GET", path: "/v1/logins/get", access: "granted", keys: "", query: "id", handle: c => c.vault.login(c.app!, c.query.get("id")) },
  { method: "GET", path: "/v1/entries", access: "granted", keys: "", handle: c => c.vault.list(c.app!) },
  { method: "GET", path: "/v1/entries/get", access: "granted", keys: "", query: "id", handle: c => c.vault.get(c.app!, c.query.get("id")) },
  { method: "POST", path: "/v1/entries", access: "granted", keys: "entry,expected", handle: c => c.vault.save(c.app!, c.body.entry, c.body.expected) },
  { method: "POST", path: "/v1/entries/remove", access: "granted", keys: "expected,id", handle: c => c.vault.remove(c.app!, c.body.id, c.body.expected) },
  { method: "GET", path: "/v1/env", access: "granted", keys: "", query: "project", handle: c => c.vault.environment(c.app!, text(c.query.get("project"), 500)) },
  { method: "POST", path: "/v1/import", access: "manage", keys: "format,text", handle: c => { if (!formats.includes(String(c.body.format))) throw new ServiceError("invalid"); const parsed = parseImport(c.body.format as ImportFormat, text(c.body.text, 8 * 1024 * 1024)); return c.vault.import(c.app!, parsed.entries, parsed.skipped); } },
  { method: "POST", path: "/v1/export", access: "manage", keys: "password", handle: c => c.vault.export(password(c.body.password)) },
  { method: "POST", path: "/v1/restore", access: "manage", keys: "backup,password", handle: c => c.vault.restore(c.app!, c.body.backup, text(c.body.password, 128)) },
  { method: "GET", path: "/v1/apps", access: "manage", keys: "", handle: c => c.apps.list() },
  { method: "POST", path: "/v1/apps/{id}/allow", access: "manage", keys: "", handle: c => c.apps.setStatus(c.id!, "granted") },
  { method: "POST", path: "/v1/apps/{id}/revoke", access: "manage", keys: "", handle: async c => { const app = await c.apps.setStatus(c.id!, "revoked"); c.lifecycle.revoke(app.id); return app; } },
];
export function validateRoutes(table: Route[]) {
  const seen = new Set();
  for (const route of table) { const key = `${route.method} ${route.path}`; if (!["public", "bootstrap", "granted", "manage"].includes(route.access) || typeof route.keys !== "string" || seen.has(key)) throw new ServiceError("invalid_routes", 500); seen.add(key); }
}
export function validateInput(route: Route, body: unknown, query: URLSearchParams) {
  object(body, route.keys);
  if ([...query.keys()].sort().join() !== (route.query ?? "")) throw new ServiceError("invalid");
}
