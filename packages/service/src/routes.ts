import { id } from "vault-core";
import type { AppView } from "../../client/src/types.ts";
import { object, text, ServiceError } from "./errors.ts";
import { isAgent, manages } from "./secrets.ts";
import type { Apps } from "./secrets.ts";
import type { Vault } from "./vault.ts";
import type { Lifecycle } from "./lifecycle.ts";
import type { helloAdapter } from "./hello.ts";
import { parseImport, formats } from "./imports.ts";
import { dotenv } from "./dotenv.ts";
import type { Runs } from "./runs.ts";
import type { Sync } from "./sync.ts";
import type { Prompts } from "./prompts.ts";
import type { Settings } from "./settings.ts";
import { appIdPattern } from "../../client/src/paths.ts";
import { isReason } from "../../client/src/prompts.ts";
import type { ImportFormat } from "../../client/src/types.ts";
export type Context = { app?: AppView; apps: Apps; vault: Vault; lifecycle: Lifecycle; runs: Runs; sync: Sync; prompts: Prompts; settings: Settings; hello: ReturnType<typeof helloAdapter>; body: Record<string, unknown>; query: URLSearchParams; id?: string; idleMs: number };
export type Route = { method: string; path: string; access: "public" | "bootstrap" | "granted" | "manage" | "run"; keys: string; query?: string; handle(c: Context): unknown | Promise<unknown> };
const password = (value: unknown) => { const result = text(value, 128); if (result.length < 15) throw new ServiceError("invalid"); return result; };
const active = (c: Context) => c.lifecycle.requirePresence(c.app!.id);
const windowHandle = (value: unknown) => { const hwnd = text(value, 20); if (!/^[1-9][0-9]{0,18}$/.test(hwnd)) throw new ServiceError("invalid"); return BigInt(hwnd); };
// An app proposes runs only when it holds the project kind; an allowed agent holds no kind and may only propose.
const proposer = (c: Context) => { if (!isAgent(c.app!) && !c.app!.kinds.includes("env")) throw new ServiceError("not_found", 404); };
const locked = (error: unknown) => error instanceof Error && error.message === "locked";
async function waiting(c: Context) {
  const rows = c.runs.list();
  for (const row of rows) {
    try { row.short = Object.entries(await c.vault.environment(c.app!, row.project)).filter(([, value]) => value.length > 0 && value.length < 4).map(([name]) => name); }
    catch (error) { if (error instanceof ServiceError && ["not_found", "conflict"].includes(error.code)) row.problem = error.code === "conflict" ? "ambiguous" : "missing"; else if (!locked(error)) throw error; }
  }
  return rows;
}
// The values are read only after the person's proof, and from then on only the service holds them.
async function approve(c: Context, batchId: unknown, proof: () => Promise<unknown>) {
  const batch = c.runs.pending(batchId); await proof();
  let values: Record<string, string>;
  try { values = await c.vault.environment(c.app!, batch.project); }
  catch (error) { if (error instanceof ServiceError && ["not_found", "conflict"].includes(error.code)) c.runs.fail(batch.id, error.code); throw error; }
  c.runs.start(batch.id, values); return { ok: true };
}
// A permission is recorded only after the same proof that unlocks Vault, so an app cannot give itself one without it.
// vault-app and vault-cli may name the app that receives it, after their own proof; any other caller can only prove for itself.
async function permit(c: Context, proof: () => Promise<unknown>) {
  const named = Object.hasOwn(c.body, "app"); if (named && !manages(c.app!)) throw new ServiceError("forbidden", 403);
  const target = named ? text(c.body.app, 40) : c.app!.id; if (!appIdPattern.test(target)) throw new ServiceError("invalid");
  await proof(); const app = await c.apps.grant(target, "import"); c.prompts.granted(target); return app;
}
const onlyApp = (c: Context) => { if (c.app!.id !== "vault-app") throw new ServiceError("forbidden", 403); };
const reason = (value: unknown) => { if (value !== undefined && !isReason(value)) throw new ServiceError("invalid"); return value as string | undefined; };
export const routes: Route[] = [
  { method: "GET", path: "/v1/sync", access: "manage", keys: "", handle: c => c.sync.status() },
  { method: "POST", path: "/v1/sync/setup", access: "manage", keys: "folder", handle: c => { active(c); return c.sync.setup(text(c.body.folder, 4096)); } },
  { method: "POST", path: "/v1/sync/join", access: "manage", keys: "folder,password|folder,recovery", handle: c => { active(c); return c.sync.join(text(c.body.folder, 4096), text(c.body.password ?? c.body.recovery, 128), Object.hasOwn(c.body, "recovery")); } },
  { method: "POST", path: "/v1/sync/now", access: "manage", keys: "", handle: c => { active(c); return c.sync.pulse(); } },
  { method: "GET", path: "/v1/sync/conflicts", access: "manage", keys: "", handle: c => c.sync.conflicts() },
  { method: "POST", path: "/v1/sync/conflicts/restore", access: "manage", keys: "id", handle: c => { active(c); return c.sync.resolveConflict(id(c.body.id), true); } },
  { method: "POST", path: "/v1/sync/conflicts/dismiss", access: "manage", keys: "id", handle: c => c.sync.resolveConflict(id(c.body.id), false) },
  { method: "POST", path: "/v1/sync/leave", access: "manage", keys: "remove", handle: c => { if (typeof c.body.remove !== "boolean") throw new ServiceError("invalid"); return c.sync.leave(c.body.remove); } },
  { method: "GET", path: "/v1/health", access: "public", keys: "", handle: () => ({ ok: true, pid: process.pid, serviceVersion: "0.1.0" }) },
  { method: "POST", path: "/v1/apps/register", access: "bootstrap", keys: "id,kind,name", handle: c => c.apps.register(c.body) },
  { method: "GET", path: "/v1/status", access: "granted", keys: "", handle: async c => { c.lifecycle.check(); let unlocked = false; try { c.vault.memory.get(c.vault.memory.ticket()); unlocked = true; } catch {} return { created: !!(await c.vault.store.envelope()).state, unlocked, present: c.lifecycle.presences.size, idleMs: c.idleMs, ...manages(c.app!) ? { hello: { available: c.hello.availableNow(), enabled: await c.hello.enabled() } } : {} }; } },
  { method: "POST", path: "/v1/apps/present", access: "granted", keys: "session", handle: c => { c.lifecycle.present(c.app!.id, id(c.body.session)); return { ok: true }; } },
  { method: "POST", path: "/v1/apps/leave", access: "granted", keys: "session", handle: c => { c.lifecycle.leave(c.app!.id, id(c.body.session)); return { ok: true }; } },
  { method: "POST", path: "/v1/create", access: "manage", keys: "password", handle: c => { active(c); return c.vault.create(password(c.body.password)); } },
  { method: "POST", path: "/v1/unlock", access: "granted", keys: "password", handle: async c => { active(c); await c.vault.auth.unlock(text(c.body.password, 128)); return { ok: true }; } },
  { method: "POST", path: "/v1/recover", access: "manage", keys: "password,recovery", handle: async c => { active(c); const result = await c.vault.auth.recover(text(c.body.recovery, 128), password(c.body.password)); await c.hello.disable(); return { recovery: result.recovery }; } },
  { method: "POST", path: "/v1/unlock/hello/enable", access: "manage", keys: "password", handle: async c => { active(c); await c.hello.enable(text(c.body.password, 128)); return { ok: true }; } },
  { method: "POST", path: "/v1/unlock/hello", access: "granted", keys: "hwnd", handle: async c => { active(c); await c.hello.unlock(windowHandle(c.body.hwnd)); return { ok: true }; } },
  { method: "POST", path: "/v1/unlock/hello/disable", access: "manage", keys: "", handle: async c => { await c.hello.disable(); return { ok: true }; } },
  { method: "POST", path: "/v1/lock", access: "granted", keys: "", handle: c => { c.vault.auth.lock(); return { ok: true }; } },
  { method: "GET", path: "/v1/logins", access: "granted", keys: "", query: "origin", handle: c => c.vault.list(c.app!, text(c.query.get("origin"))) },
  { method: "GET", path: "/v1/logins/all", access: "granted", keys: "", handle: c => c.vault.summaries(c.app!) },
  { method: "GET", path: "/v1/logins/get", access: "granted", keys: "", query: "id", handle: c => c.vault.login(c.app!, c.query.get("id")) },
  { method: "GET", path: "/v1/entries", access: "granted", keys: "", handle: c => c.vault.list(c.app!) },
  { method: "GET", path: "/v1/entries/get", access: "granted", keys: "", query: "id", handle: c => c.vault.get(c.app!, c.query.get("id")) },
  { method: "POST", path: "/v1/entries", access: "granted", keys: "entry,expected", handle: c => c.vault.save(c.app!, c.body.entry, c.body.expected) },
  { method: "POST", path: "/v1/entries/remove", access: "granted", keys: "expected,id", handle: c => c.vault.remove(c.app!, c.body.id, c.body.expected) },
  { method: "GET", path: "/v1/env", access: "granted", keys: "", query: "project", handle: c => { if (c.app!.id !== "nova") throw new ServiceError("not_found", 404); return c.vault.environment(c.app!, text(c.query.get("project"), 500)); } },
  { method: "POST", path: "/v1/runs", access: "run", keys: "commands,cwd,env,project", handle: c => { proposer(c); c.prompts.room(c.app!.id); const result = c.runs.submit(c.app!, c.body); c.prompts.announce(); return result; } },
  { method: "GET", path: "/v1/runs/get", access: "run", keys: "", query: "after,id", handle: c => { proposer(c); return c.runs.progress(c.app!, c.query.get("id"), c.query.get("after"), manages(c.app!)); } },
  { method: "GET", path: "/v1/runs", access: "manage", keys: "", handle: waiting },
  { method: "POST", path: "/v1/runs/approve", access: "manage", keys: "id,password", handle: c => { active(c); return approve(c, c.body.id, () => c.vault.auth.unlock(text(c.body.password, 128))); } },
  { method: "POST", path: "/v1/runs/approve/hello", access: "manage", keys: "hwnd,id", handle: c => { active(c); const hwnd = windowHandle(c.body.hwnd); return approve(c, c.body.id, () => c.hello.unlock(hwnd)); } },
  { method: "POST", path: "/v1/runs/reject", access: "manage", keys: "id", handle: c => { c.runs.reject(c.body.id); return { ok: true }; } },
  { method: "POST", path: "/v1/import", access: "granted", keys: "format,text", handle: c => { if (!manages(c.app!) && !c.app!.permissions.includes("import")) throw new ServiceError("permission_required", 403); if (!formats.includes(String(c.body.format))) throw new ServiceError("invalid"); const parsed = parseImport(c.body.format as ImportFormat, text(c.body.text, 8 * 1024 * 1024)); return c.vault.import(c.app!, parsed.entries, parsed.skipped); } },
  { method: "POST", path: "/v1/import/env", access: "manage", keys: "project,text", handle: c => { const parsed = dotenv(text(c.body.text, 4 * 1024 * 1024)); return c.vault.importEnv(c.app!, text(c.body.project, 500), parsed.variables, parsed.skipped); } },
  { method: "POST", path: "/v1/export", access: "manage", keys: "password", handle: c => c.vault.export(password(c.body.password)) },
  { method: "POST", path: "/v1/restore", access: "manage", keys: "backup,password", handle: c => c.vault.restore(c.app!, c.body.backup, text(c.body.password, 128)) },
  { method: "GET", path: "/v1/apps", access: "manage", keys: "", handle: c => c.apps.list() },
  { method: "GET", path: "/v1/apps/self", access: "granted", keys: "", handle: c => { active(c); return c.apps.list().find(app => app.id === c.app!.id); } },
  { method: "POST", path: "/v1/apps/permissions/import", access: "granted", keys: "password|app,password", handle: c => { active(c); return permit(c, () => c.vault.auth.unlock(text(c.body.password, 128))); } },
  { method: "POST", path: "/v1/apps/permissions/import/hello", access: "granted", keys: "hwnd|app,hwnd", handle: c => { active(c); const hwnd = windowHandle(c.body.hwnd); return permit(c, () => c.hello.unlock(hwnd)); } },
  { method: "POST", path: "/v1/apps/permissions/import/request", access: "granted", keys: "", handle: c => { active(c); return c.prompts.permission(c.app!, manages(c.app!) || c.app!.permissions.includes("import")); } },
  { method: "GET", path: "/v1/settings", access: "manage", keys: "", handle: c => c.settings.get() },
  // The choices apply to the running service at once: the idle time to the key in memory, the last-app rule to the presences.
  { method: "PUT", path: "/v1/settings", access: "manage", keys: "idleMinutes,language,lockWithLastApp,theme", handle: async c => { const next = await c.settings.save(c.body); c.vault.memory.setIdle(c.settings.idleMs); c.lifecycle.lockWithLastApp = next.lockWithLastApp; return next; } },
  { method: "GET", path: "/v1/prompts", access: "manage", keys: "", handle: c => { onlyApp(c); return c.prompts.poll(); } },
  { method: "GET", path: "/v1/prompts/wait", access: "granted", keys: "", query: "id", handle: c => c.prompts.wait(c.app!, c.query.get("id")) },
  { method: "POST", path: "/v1/prompts/unlock", access: "granted", keys: "|reason", handle: c => { active(c); return c.prompts.unlock(c.app!, reason(c.body.reason)); } },
  { method: "POST", path: "/v1/prompts/dismiss", access: "manage", keys: "id", handle: c => { onlyApp(c); c.prompts.dismiss(c.body.id); return { ok: true }; } },
  { method: "POST", path: "/v1/apps/{id}/allow", access: "manage", keys: "", handle: c => c.apps.setStatus(c.id!, "granted") },
  { method: "POST", path: "/v1/apps/{id}/revoke", access: "manage", keys: "", handle: async c => { const app = await c.apps.setStatus(c.id!, "revoked"); c.lifecycle.revoke(app.id); return app; } },
];
export function validateRoutes(table: Route[]) {
  const seen = new Set();
  for (const route of table) { const key = `${route.method} ${route.path}`; if (!["public", "bootstrap", "granted", "manage", "run"].includes(route.access) || typeof route.keys !== "string" || seen.has(key)) throw new ServiceError("invalid_routes", 500); seen.add(key); }
}
export function validateInput(route: Route, body: unknown, query: URLSearchParams) {
  const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join() : undefined;
  if (!route.keys.split("|").includes(keys!)) throw new ServiceError("invalid"); object(body, keys!);
  if ([...query.keys()].sort().join() !== (route.query ?? "")) throw new ServiceError("invalid");
}
