import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger, VaultError } from "vault-core";
import { resolveHome, appIdPattern } from "../../client/src/paths.ts";
import { prepareHome } from "../../client/src/private.ts";
import { atomicJson } from "../../client/src/files.ts";
import type { AppView } from "../../client/src/types.ts";
import { routes, validateRoutes, validateInput } from "./routes.ts";
import type { Route } from "./routes.ts";
import { acquireLock } from "./lock.ts";
import { bootstrapKey, matches, Apps, manages, blocked } from "./secrets.ts";
import { Vault } from "./vault.ts";
import { Lifecycle } from "./lifecycle.ts";
import { helloAdapter } from "./hello.ts";
import { ServiceError } from "./errors.ts";
export function respond(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Content-Type": "application/json; charset=utf-8", ...headers }); response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage, cap: number): Promise<unknown> {
  if (request.method === "GET" && request.headers["content-length"] === undefined && request.headers["transfer-encoding"] === undefined) return {};
  if (!/^application\/json(?:;.*)?$/i.test(request.headers["content-type"] ?? "")) throw new ServiceError("unsupported_media_type", 415);
  if (Number(request.headers["content-length"]) > cap) throw new ServiceError("too_large", 413);
  return new Promise((done, fail) => {
    const parts: Buffer[] = []; let size = 0;
    request.on("data", (part: Buffer) => { size += part.length; if (size > cap) { parts.length = 0; fail(new ServiceError("too_large", 413)); } else parts.push(part); });
    request.once("end", () => { if (size > cap) return; try { done(JSON.parse(Buffer.concat(parts).toString("utf8"))); } catch { fail(new ServiceError("invalid")); } }); request.once("error", () => fail(new ServiceError("invalid"))); request.once("aborted", () => fail(new ServiceError("invalid")));
  });
}
export type ServiceOptions = { home?: string; now?: () => number; idleMs?: number; presenceMs?: number; routes?: Route[] };
export async function startService(options: ServiceOptions = {}) {
  const home = resolve(options.home ?? resolveHome()), now = options.now ?? Date.now, idleMs = options.idleMs ?? 300000;
  if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw new ServiceError("invalid");
  const table = options.routes ?? routes; validateRoutes(table); prepareHome(home);
  const release = acquireLock(home), recordPath = join(home, "run", "service.json");
  const logger = createLogger(record => appendFileSync(join(home, "logs", "events.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 }), now);
  let bootstrap: string, apps: Apps;
  try { bootstrap = bootstrapKey(home); apps = new Apps(home); await apps.load(); }
  catch (error) { release(); throw error; }
  const vault = new Vault(join(home, "store"), now, idleMs, logger), lifecycle = new Lifecycle(vault.memory, now, options.presenceMs), hello = helloAdapter(home, vault);
  const limits = new Map<string, { start: number; count: number }>(); let port = 0, pending = 0, stopping: Promise<void> | undefined, queue: Promise<unknown> = Promise.resolve();
  const take = (actor: string, max: number) => {
    let bucket = limits.get(actor); if (!bucket || now() - bucket.start >= 60000) { bucket = { start: now(), count: 0 }; limits.set(actor, bucket); }
    if (++bucket.count > max) throw new ServiceError("rate_limited", 429);
  };
  const audit = (outcome: string, requestId: string, actor = "unknown") => logger("request", { actor, source: "loopback", outcome, requestId });
  const server = http.createServer((request, response) => {
    const requestId = randomUUID(); let app: AppView | undefined, event = "request";
    void (async () => {
      if (stopping) throw new ServiceError("unavailable", 503);
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? "")) throw new ServiceError("bad_host", 421);
      if (request.headers.origin !== undefined || String(request.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") throw new ServiceError("browser_refused", 403);
      take("local", 600);
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new ServiceError("invalid");
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      let routeId: string | undefined;
      const matchesPath = table.filter(route => { if (!route.path.includes("{id}")) return route.path === url.pathname; const [before, after] = route.path.split("{id}"); if (!url.pathname.startsWith(before) || !url.pathname.endsWith(after)) return false; const value = url.pathname.slice(before.length, -after.length); if (!appIdPattern.test(value)) return false; routeId = value; return true; });
      if (!matchesPath.length) throw new ServiceError("not_found", 404);
      const route = matchesPath.find(route => route.method === request.method); if (!route) throw new ServiceError("method_not_allowed", 405);
      event = ({ "/v1/apps/register": "app_register", "/v1/apps/{id}/allow": "app_allow", "/v1/apps/{id}/revoke": "app_revoke", "/v1/unlock": "unlock", "/v1/recover": "recovery", "/v1/create": "create", "/v1/lock": "lock", "/v1/import": "import", "/v1/export": "export", "/v1/restore": "restore" } as Record<string, string>)[route.path] ?? "request";
      const authorization = request.headers.authorization ?? "";
      const authenticate = () => {
        if (route.access === "bootstrap") { if (!authorization.startsWith("Bootstrap ") || !matches(authorization.slice(10), bootstrap)) throw new ServiceError("unauthenticated", 401); }
        else if (route.access !== "public") {
          app = authorization.startsWith("Bearer ") ? apps.byToken(authorization.slice(7)) : undefined;
          if (!app) throw new ServiceError("unauthenticated", 401);
          if (app.status !== "granted") throw new ServiceError(app.status, 403);
          if (blocked(app) || route.access === "manage" && !manages(app)) throw new ServiceError("forbidden", 403);
        }
      };
      authenticate(); take(app?.id ?? route.access, route.access === "bootstrap" ? 30 : 240);
      const cap = ["/v1/import", "/v1/restore"].includes(route.path) ? 12 * 1024 * 1024 : 256 * 1024;
      const body = await readBody(request, cap); validateInput(route, body, url.searchParams);
      const execute = async () => {
        authenticate(); lifecycle.check();
        const result = await route.handle({ app, apps, vault, lifecycle, hello, body: body as Record<string, unknown>, query: url.searchParams, id: routeId, idleMs });
        authenticate(); lifecycle.check();
        // A response that contains values must still have a live key after async work.
        if (["/v1/entries", "/v1/entries/get", "/v1/logins", "/v1/logins/all", "/v1/logins/get", "/v1/env", "/v1/export"].includes(route.path)) vault.memory.get(vault.memory.ticket());
        logger(event, { actor: app?.id ?? "unknown", source: "loopback", outcome: "allowed", requestId }); respond(response, 200, result);
      };
      // Lock and presence departures invalidate in-flight key work immediately.
      if (["/v1/lock", "/v1/apps/leave", "/v1/apps/present"].includes(route.path)) await execute();
      else {
        if (pending >= 20) throw new ServiceError("busy", 503); pending++;
        const enqueued = now(); const run = queue.catch(() => undefined).then(async () => { if (now() - enqueued > 30000 || stopping) throw new ServiceError("busy", 503); await execute(); }); queue = run;
        try { await run; } finally { pending--; }
      }
    })().catch(error => {
      const mapped = error instanceof ServiceError ? error : error instanceof VaultError ? new ServiceError(error.code, ({ invalid: 400, locked: 423, conflict: 409, unavailable: 503, not_found: 404, limited: 429 })[error.code]) : error instanceof Error && error.message === "locked" ? new ServiceError("locked", 423) : new ServiceError("internal", 500);
      try { audit(mapped.code, requestId, app?.id); } catch { vault.memory.lock(); }
      if (!response.headersSent && !response.destroyed) respond(response, mapped.status, { error: { code: mapped.code, message: "Vault could not complete the request.", fields: {}, requestId } }, mapped.status === 429 ? { "Retry-After": "60" } : {});
      request.resume();
    });
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.maxConnections = 64;
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  async function checkLifecycle() { if (lifecycle.shouldExit()) await shutdown(); }
  const timer = setInterval(() => { void checkLifecycle().catch(() => { process.exitCode = 1; }); }, 1000); timer.unref();
  async function shutdown() {
    if (stopping) return stopping;
    vault.memory.lock(); clearInterval(timer);
    stopping = (async () => {
      try { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await queue.catch(() => undefined); }
      finally { await rm(recordPath, { force: true }); release(); process.off("SIGINT", signal); process.off("SIGTERM", signal); }
    })(); return stopping;
  }
  const signal = () => { void shutdown().catch(() => { process.exitCode = 1; }); };
  try {
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", () => { server.off("error", fail); done(); }); }); port = (server.address() as { port: number }).port;
    await atomicJson(recordPath, { version: 1, pid: process.pid, port, serviceVersion: "0.1.0", startedAt: new Date(now()).toISOString() }); process.on("SIGINT", signal); process.on("SIGTERM", signal);
  } catch (error) { clearInterval(timer); server.close(); release(); throw error; }
  return { home, port, server, vault, apps, lifecycle, checkLifecycle, shutdown };
}
