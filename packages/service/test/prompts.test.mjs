import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { startService } from "../src/server.ts";
import { PROMPT_LIMITS } from "../src/prompts.ts";
import { START_GUARD_MS } from "../src/starter.ts";
import { connect, VaultClientError } from "../../client/dist/index.js";
import { newEntry } from "vault-core";
import { main } from "../../cli/src/main.ts";

// Settings, the prompt queue for Vault's own app, the app start and the CLI's unlock prompts. Every value is synthetic; every home is a temporary folder.
const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-prompts-")), services = [], clients = [], seen = [], homes = [];
const previousHome = process.env.VAULT_HOME, previousLocale = process.env.LC_ALL;
// Every service in this file lives in one process, and each one listens for SIGINT and SIGTERM.
process.setMaxListeners(60);
const password = randomBytes(30).toString("base64"), wrongPassword = randomBytes(30).toString("base64"), canary = randomBytes(30).toString("base64");
let checks = 0, stage = "settings";
// Each assertion counts as one check.
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "match", "rejects"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
const rejects = (operation, code) => check.rejects(operation, error => error instanceof VaultClientError && error.code === code);
const wait = ms => new Promise(done => setTimeout(done, ms));
const timed = async operation => { const start = Date.now(), value = await operation(); return { value, ms: Date.now() - start }; };
const clock = () => { const c = { time: 1000000 }; c.now = () => c.time; return c; };
const iso = time => new Date(time).toISOString();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const defaults = { idleMinutes: 5, lockWithLastApp: true, language: "system", theme: "system" };
const open = service => { try { service.vault.memory.get(service.vault.memory.ticket()); return true; } catch { return false; } };
// What an app or the CLI could be shown is kept to prove that no value reaches it.
const note = value => { seen.push(JSON.stringify(value)); return value; };
const tokens = () => { let value; return { async get() { return value; }, async set(token) { value = token; }, token: () => value }; };
const begin = async (name, c, options = {}) => { const home = join(scratch, name); homes.push(home); const service = await startService({ home, now: c.now, presenceMs: 1e12, ...options }); services.push(service); return { home, service }; };
const as = async (home, id, kind = "cosmic") => { const store = tokens(), api = await connect({ home, app: { id, name: `Synthetic ${id}`, kind }, tokens: store }); clients.push(api); return Object.assign(api, { token: () => store.token() }); };
// A non-manager app is pending until a manager allows it, and only then holds a presence.
const joined = async (home, manager, id, kind = "app") => { const api = await as(home, id, kind); await manager.apps.allow(id); if (kind !== "agent") await api.present(); return api; };
async function probe(service, route, { method = "GET", auth, body } = {}) {
  return new Promise((done, fail) => {
    const request = http.request({ hostname: "127.0.0.1", port: service.port, path: route, method, headers: { ...(auth ? { Authorization: auth } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) } }, response => {
      let content = ""; response.on("data", chunk => { content += chunk; }); response.on("end", () => {
        try { done({ status: response.statusCode, value: JSON.parse(content), headers: new Headers(Object.entries(response.headers).map(([name, value]) => [name, String(value)])) }); } catch (error) { fail(error); }
      });
    });
    request.on("error", fail); request.setTimeout(10000, () => request.destroy(new Error("timeout"))); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function tree(folder) {
  let contents = "";
  for (const item of await readdir(folder, { withFileTypes: true })) { const path = join(folder, item.name); contents += item.isDirectory() ? await tree(path) : await readFile(path, "utf8"); }
  return contents;
}
// A stand-in for the Vault app: a small program that appends its arguments, VAULT_HOME and folder to a log beside it, then exits.
async function fakeApp() {
  const folder = join(scratch, "fake-app"); await mkdir(folder);
  if (process.platform === "win32") {
    const source = join(folder, "fake-app.cs"), exe = join(folder, "fake-app.exe");
    await writeFile(source, 'using System; using System.IO; using System.Reflection; class P { static void Main(string[] a) { File.AppendAllText(Assembly.GetExecutingAssembly().Location + ".log", string.Join(" ", a) + "|" + Environment.GetEnvironmentVariable("VAULT_HOME") + "|" + Directory.GetCurrentDirectory() + "\\n"); } }');
    execFileSync(join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", "/target:exe", `/out:${exe}`, source], { windowsHide: true, stdio: "ignore" });
    return exe;
  }
  const script = join(folder, "fake-app"); await writeFile(script, '#!/bin/sh\nprintf "%s|%s|%s\\n" "$*" "$VAULT_HOME" "$PWD" >> "$0.log"\n', { mode: 0o755 }); return script;
}
try {
  stage = "settings";
  {
    const c = clock(), { home, service } = await begin("settings", c);
    const ui = await as(home, "vault-app"), cli = await as(home, "vault-cli"), plain = await joined(home, cli, "synthetic-app"), agent = await joined(home, cli, "synthetic-agent", "agent");
    // Nothing is written until the first change, and the running service starts on the five minutes the defaults name.
    check.deepEqual(await ui.settings.get(), defaults); check.deepEqual(await cli.settings.get(), defaults); check.equal((await ui.status()).idleMs, 300000);
    await assert.rejects(() => stat(join(home, "settings.json"))); checks++;
    await rejects(() => plain.settings.get(), "forbidden"); await rejects(() => plain.settings.set(defaults), "forbidden"); await rejects(() => agent.settings.get(), "forbidden");
    const auth = `Bearer ${ui.token()}`, put = body => probe(service, "/v1/settings", { method: "PUT", auth, body });
    for (const bad of [{}, { ...defaults, extra: 1 }, { idleMinutes: 5, lockWithLastApp: true, language: "system" }, { ...defaults, idleMinutes: 2 }, { ...defaults, idleMinutes: "5" }, { ...defaults, idleMinutes: 5.5 }, { ...defaults, idleMinutes: null }, { ...defaults, lockWithLastApp: "true" }, { ...defaults, lockWithLastApp: 1 }, { ...defaults, language: "fr" }, { ...defaults, language: "" }, { ...defaults, theme: "blue" }, { ...defaults, theme: ["dark"] }, [], "dark"]) check.equal((await put(bad)).status, 400);
    check.equal((await probe(service, "/v1/settings?extra=1", { auth })).status, 400); check.equal((await probe(service, "/v1/settings", { method: "POST", auth, body: defaults })).status, 405);
    for (const bad of [{ ...defaults, theme: "blue" }, { ...defaults, extra: 1 }, { theme: "dark" }, null]) await rejects(() => ui.settings.set(bad), "invalid");
    await assert.rejects(() => stat(join(home, "settings.json"))); check.deepEqual(await ui.settings.get(), defaults); checks++;
    // A shorter idle time applies to the key already in memory at once, and the whole choice is stored.
    await ui.create(password); c.time += 100000; check.equal((await ui.status()).unlocked, true);
    const chosen = { idleMinutes: 1, lockWithLastApp: false, language: "es", theme: "dark" };
    check.deepEqual(await ui.settings.set(chosen), chosen); check.deepEqual(await cli.settings.get(), chosen);
    check.equal(service.vault.memory.idle, 60000); check.equal((await ui.status()).idleMs, 60000); check.equal((await ui.status()).unlocked, false);
    check.deepEqual(JSON.parse(await readFile(join(home, "settings.json"), "utf8")), chosen); check.deepEqual((await readdir(home)).filter(name => name.includes(".tmp")), []);
    await ui.unlock(password); c.time += 59000; check.equal((await ui.status()).unlocked, true); c.time += 1000; check.equal((await ui.status()).unlocked, false);
    // A new process reads the choices back: its idle time and its last-app rule are the stored ones.
    for (const api of [ui, cli, plain]) await api.close();
    await service.shutdown();
    const again = await begin("settings", c), ui2 = await as(home, "vault-app");
    check.deepEqual(await ui2.settings.get(), chosen); check.equal(again.service.vault.memory.idle, 60000); check.equal(again.service.lifecycle.lockWithLastApp, false); check.equal((await ui2.status()).idleMs, 60000);
    check.equal((await readFile(join(home, "logs", "events.jsonl"), "utf8")).includes('"event":"settings"'), true);
    // A file that is missing the keys, holds a wrong value, an extra key, no JSON or too much means the defaults, and the next change replaces it.
    const junk = { "settings-value": JSON.stringify({ ...defaults, idleMinutes: 2 }), "settings-extra": JSON.stringify({ ...defaults, extra: 1 }), "settings-partial": JSON.stringify({ idleMinutes: 15 }), "settings-text": "not json", "settings-large": JSON.stringify({ ...defaults, theme: "dark" }) + " ".repeat(5000) };
    for (const [name, content] of Object.entries(junk)) {
      await mkdir(join(scratch, name)); await writeFile(join(scratch, name, "settings.json"), content);
      const broken = await begin(name, c); check.deepEqual(broken.service.settings.get(), defaults); check.equal(broken.service.vault.memory.idle, 300000);
    }
    const repaired = join(scratch, "settings-text"), mender = await as(repaired, "vault-app"); await mender.settings.set(chosen); check.deepEqual(JSON.parse(await readFile(join(repaired, "settings.json"), "utf8")), chosen);
  }

  stage = "lock with the last app";
  {
    const c = clock(), { home, service } = await begin("rule", c);
    const first = await as(home, "vault-app"); await first.create(password); check.equal(service.lifecycle.lockWithLastApp, true);
    // True is today's rule: the vault locks the moment the last app leaves.
    await first.close(); check.equal(open(service), false);
    const second = await as(home, "vault-app"); check.equal((await second.status()).unlocked, false);
    await second.settings.set({ ...defaults, lockWithLastApp: false }); check.equal(service.lifecycle.lockWithLastApp, false);
    await second.unlock(password); await second.close(); check.equal(open(service), true);
    // False keeps it open with nobody there, until the idle time runs out.
    const third = await as(home, "vault-app"); check.equal((await third.status()).unlocked, true);
    c.time += 299000; check.equal((await third.status()).unlocked, true); c.time += 1000; check.equal((await third.status()).unlocked, false);
    await third.settings.set(defaults); await third.unlock(password); await third.close(); check.equal(open(service), false);
    // Prompts and their polling never count as use of the key.
    const fourth = await as(home, "vault-app"), asker = await joined(home, fourth, "synthetic-app"); await fourth.unlock(password); c.time += 200000;
    await asker.permissions.request(); await asker.prompts.unlock("synthetic reason"); service.prompts.limits.waitMs = 100; note(await fourth.prompts.list());
    const idleCheck = await asker.prompts.unlock(); await fourth.prompts.dismiss((await fourth.prompts.list()).find(p => p.kind === "permission").id); check.deepEqual(await asker.prompts.wait(idleCheck.id), { state: "done" });
    c.time += 99999; check.equal((await fourth.status()).unlocked, true); c.time += 1; check.equal((await fourth.status()).unlocked, false);
  }

  stage = "prompt queue: access and unlock";
  {
    const c = clock(), { home, service } = await begin("prompts", c, { prompts: { waitMs: 5000 } }), S = service;
    const ui = await as(home, "vault-app"), cli = await as(home, "vault-cli");
    const asker = await joined(home, cli, "synthetic-app"), other = await joined(home, cli, "other-app"), third = await joined(home, cli, "third-app"), fourth = await joined(home, cli, "fourth-app"), agent = await joined(home, cli, "claude-code", "agent");
    const askerAuth = `Bearer ${asker.token()}`, queue = async () => { S.prompts.limits.waitMs = 300; try { return note(await ui.prompts.list()); } finally { S.prompts.limits.waitMs = 5000; } };
    check.deepEqual({ total: PROMPT_LIMITS.total, perApp: PROMPT_LIMITS.perApp, expiresMs: PROMPT_LIMITS.expiresMs, waitMs: PROMPT_LIMITS.waitMs, guard: START_GUARD_MS }, { total: 50, perApp: 5, expiresMs: 300000, waitMs: 25000, guard: 30000 });
    const project = newEntry("env"); project.title = "synthetic-project"; project.fields = [{ id: "SYNTHETIC_PROJECT_VALUE", name: "Synthetic variable", secret: true, value: canary }];
    await ui.create(password); await ui.entries.save(project, 0); await ui.lock();
    for (const api of [asker, cli, agent]) await rejects(() => api.prompts.list(), "forbidden");
    for (const api of [asker, cli, agent]) await rejects(() => api.prompts.dismiss(randomUUID()), "forbidden");
    await rejects(() => agent.prompts.unlock(), "forbidden"); await rejects(() => agent.permissions.request(), "forbidden"); await rejects(() => agent.prompts.wait(randomUUID()), "forbidden");
    // With nothing waiting the call holds for the wait and then answers an empty list.
    S.prompts.limits.waitMs = 300; const none = await timed(() => ui.prompts.list()); S.prompts.limits.waitMs = 5000;
    check.deepEqual(none.value, []); check.equal(none.ms >= 200, true);

    const first = await asker.prompts.unlock("synthetic reason");
    check.match(first.id, uuid); check.equal(first.expiresAt, iso(c.time + PROMPT_LIMITS.expiresMs));
    const shown = await timed(() => ui.prompts.list()); note(shown.value);
    check.equal(shown.ms < 4000, true); check.deepEqual(shown.value, [{ id: first.id, kind: "unlock", app: { id: "synthetic-app", name: "Synthetic synthetic-app" }, createdAt: iso(c.time), expiresAt: first.expiresAt, summary: { reason: "synthetic reason" } }]);
    const bare = await asker.prompts.unlock(), edge = await asker.prompts.unlock("x".repeat(120));
    check.deepEqual((await queue()).map(p => p.summary.reason), ["synthetic reason", null, "x".repeat(120)]);
    for (const bad of [{ reason: "" }, { reason: "   " }, { reason: "x".repeat(121) }, { reason: "line\nbreak" }, { reason: `${String.fromCharCode(0x202e)}reversed` }, { reason: 5 }, { reason: null }, { why: "x" }, { reason: "fine", extra: 1 }, []]) check.equal((await probe(S, "/v1/prompts/unlock", { method: "POST", auth: askerAuth, body: bad })).status, 400);
    for (const bad of ["", "   ", "x".repeat(121), "a\tb", 5]) await rejects(() => asker.prompts.unlock(bad), "invalid");
    check.equal((await probe(S, "/v1/prompts/unlock", { method: "POST", auth: `Bearer ${agent.token()}`, body: {} })).status, 403);

    // The asker polls its prompt; nobody else may.
    S.prompts.limits.waitMs = 300; const pending = await timed(() => asker.prompts.wait(first.id)); S.prompts.limits.waitMs = 5000;
    check.deepEqual(pending.value, { state: "pending" }); check.equal(pending.ms >= 200, true);
    await rejects(() => other.prompts.wait(first.id), "not_found"); await rejects(() => ui.prompts.wait(first.id), "not_found"); await rejects(() => asker.prompts.wait(randomUUID()), "not_found"); await rejects(() => asker.prompts.wait("synthetic"), "invalid");
    check.equal((await probe(S, "/v1/prompts/wait", { auth: askerAuth })).status, 400); check.equal((await probe(S, `/v1/prompts/wait?id=${first.id}&extra=1`, { auth: askerAuth })).status, 400);

    // An unlock, by any route, answers every unlock prompt at once and wakes the ones already waiting.
    const hearing = timed(() => asker.prompts.wait(first.id)); await wait(150); await ui.unlock(password);
    const heard = await hearing; check.deepEqual(heard.value, { state: "done" }); check.equal(heard.ms < 4000, true);
    check.deepEqual(await asker.prompts.wait(bare.id), { state: "done" }); check.deepEqual(await asker.prompts.wait(edge.id), { state: "done" }); check.deepEqual(await queue(), []);
    const ready = await asker.prompts.unlock("already open"), readyWait = await timed(() => asker.prompts.wait(ready.id));
    check.deepEqual(readyWait.value, { state: "done" }); check.equal(readyWait.ms < 4000, true); check.deepEqual(await queue(), []);
    await ui.lock(); const viaCli = await asker.prompts.unlock(), viaCliWait = timed(() => asker.prompts.wait(viaCli.id)); await wait(100); await cli.unlock(password);
    check.deepEqual((await viaCliWait).value, { state: "done" });

    stage = "prompt queue: dismiss, expiry and arrival";
    await ui.lock(); const turned = await asker.prompts.unlock(), cancelling = timed(() => asker.prompts.wait(turned.id)); await wait(150);
    check.deepEqual(await ui.prompts.dismiss(turned.id), { ok: true }); const cancelled = await cancelling;
    check.deepEqual(cancelled.value, { state: "cancelled" }); check.equal(cancelled.ms < 4000, true); check.deepEqual(await asker.prompts.wait(turned.id), { state: "cancelled" });
    await rejects(() => ui.prompts.dismiss(turned.id), "not_pending"); await rejects(() => ui.prompts.dismiss(randomUUID()), "not_found"); await rejects(() => ui.prompts.dismiss("synthetic"), "invalid");
    check.equal((await probe(S, "/v1/prompts/dismiss", { method: "POST", auth: `Bearer ${ui.token()}`, body: { id: turned.id, extra: 1 } })).status, 400);
    check.deepEqual(await queue(), []);
    const aging = await asker.prompts.unlock(); c.time += PROMPT_LIMITS.expiresMs - 1; check.equal((await ui.prompts.list()).some(p => p.id === aging.id), true);
    c.time += 1; check.deepEqual(await queue(), []); check.deepEqual(await asker.prompts.wait(aging.id), { state: "expired" });
    c.time += 120000; await rejects(() => asker.prompts.wait(aging.id), "not_found");
    // A call that is waiting for the next prompt returns as soon as one arrives, of any kind.
    const arriving = timed(() => ui.prompts.list()); await wait(150); const late = await asker.prompts.unlock("arrives late"); const arrived = await arriving;
    check.deepEqual(arrived.value.map(p => p.id), [late.id]); check.equal(arrived.ms < 4000, true); await ui.prompts.dismiss(late.id);

    stage = "prompt queue: runs";
    const quiet = [process.execPath, "-e", ""], ask = commands => ({ project: "synthetic-project", commands, cwd: scratch, env: { SYNTHETIC_ENV_VALUE: canary } });
    const arrivingRun = timed(() => ui.prompts.list()); await wait(150); const run1 = await agent.runs.submit(ask([quiet])); const arrivedRun = await arrivingRun;
    check.equal(arrivedRun.ms < 4000, true); check.deepEqual(note(arrivedRun.value), [{ id: run1.id, kind: "run", app: { id: "claude-code", name: "Synthetic claude-code" }, createdAt: iso(c.time), expiresAt: run1.expiresAt, summary: { project: "synthetic-project", cwd: scratch, commands: [quiet] } }]);
    check.equal(JSON.stringify(arrivedRun.value).includes(canary), false);
    await ui.runs.approve(run1.id, password); check.deepEqual(await queue(), []); await rejects(() => ui.prompts.dismiss(run1.id), "not_found");
    const run2 = await agent.runs.submit(ask([quiet])); check.deepEqual((await queue()).map(p => p.id), [run2.id]); await ui.runs.reject(run2.id); check.deepEqual(await queue(), []);
    const run3 = await agent.runs.submit(ask([quiet])); check.deepEqual(await ui.prompts.dismiss(run3.id), { ok: true }); check.equal((await agent.runs.get(run3.id)).status, "rejected"); check.deepEqual(await queue(), []);
    await ui.lock(); const run4 = await agent.runs.submit(ask([quiet])), mixed = await asker.prompts.unlock("between"); check.deepEqual((await queue()).map(p => p.id).sort(), [run4.id, mixed.id].sort());
    c.time += 10 * 60 * 1000; check.deepEqual(await queue(), []); check.equal((await agent.runs.get(run4.id)).status, "expired"); check.deepEqual(await asker.prompts.wait(mixed.id), { state: "expired" });

    stage = "prompt queue: permissions";
    const wanting = await asker.permissions.request(); check.match(wanting.id, uuid);
    check.deepEqual(note(await queue()), [{ id: wanting.id, kind: "permission", app: { id: "synthetic-app", name: "Synthetic synthetic-app" }, createdAt: iso(c.time), expiresAt: wanting.expiresAt, summary: { permission: "import" } }]);
    S.prompts.limits.waitMs = 300; check.deepEqual(await asker.prompts.wait(wanting.id), { state: "pending" }); S.prompts.limits.waitMs = 5000;
    // Only a manager names the app that receives the permission, and only after a proof that works.
    await rejects(() => other.permissions.importWithPassword(password, "synthetic-app"), "forbidden"); await rejects(() => other.permissions.importWithHello("1", "synthetic-app"), "forbidden");
    await rejects(() => ui.permissions.importWithPassword(password, "Bad Id"), "invalid"); await rejects(() => ui.permissions.importWithPassword(password, "nobody-app"), "not_found"); await rejects(() => ui.permissions.importWithPassword(password, "claude-code"), "forbidden");
    check.equal((await probe(S, "/v1/apps/permissions/import", { method: "POST", auth: `Bearer ${ui.token()}`, body: { app: "Bad Id", password } })).status, 400);
    check.equal((await probe(S, "/v1/apps/permissions/import", { method: "POST", auth: askerAuth, body: { app: "synthetic-app", password } })).status, 403);
    await rejects(() => ui.permissions.importWithHello("1", "synthetic-app"), "not_found"); await rejects(() => ui.permissions.importWithPassword(wrongPassword, "synthetic-app"), "locked"); c.time += 31000;
    check.deepEqual((await asker.apps.self()).permissions, []); check.equal((await queue()).length, 1);
    const hearingGrant = timed(() => asker.prompts.wait(wanting.id)); await wait(150);
    const granted = await ui.permissions.importWithPassword(password, "synthetic-app"); check.equal(granted.id, "synthetic-app"); check.deepEqual(granted.permissions, ["import"]);
    const grantHeard = await hearingGrant; check.deepEqual(grantHeard.value, { state: "done" }); check.equal(grantHeard.ms < 4000, true);
    check.deepEqual((await asker.apps.self()).permissions, ["import"]); check.deepEqual(await queue(), []);
    // The CLI is a manager too, and an app proving for itself works as before and answers its own request.
    const forThird = await third.permissions.request(); check.deepEqual((await cli.permissions.importWithPassword(password, "third-app")).permissions, ["import"]); check.deepEqual(await third.prompts.wait(forThird.id), { state: "done" });
    const forOther = await other.permissions.request(); check.deepEqual((await other.permissions.importWithPassword(password)).permissions, ["import"]); check.deepEqual(await other.prompts.wait(forOther.id), { state: "done" });
    // A permission already held, or a manager that needs none, is answered when asked.
    for (const api of [asker, cli]) { const held = await api.permissions.request(), heldWait = await timed(() => api.prompts.wait(held.id)); check.deepEqual(heldWait.value, { state: "done" }); check.equal(heldWait.ms < 4000, true); }
    check.deepEqual(await queue(), []);
    // Turning a request down refuses it: the permission stays out.
    const refused = await fourth.permissions.request(), refusing = timed(() => fourth.prompts.wait(refused.id)); await wait(100); await ui.prompts.dismiss(refused.id);
    check.deepEqual((await refusing).value, { state: "cancelled" }); check.deepEqual((await fourth.apps.self()).permissions, []); await rejects(() => fourth.import("chrome", "name,url,username,password\r\nx,https://x.example,u,p\r\n"), "permission_required");
    const lapsing = await fourth.permissions.request(); c.time += PROMPT_LIMITS.expiresMs; check.deepEqual(await fourth.prompts.wait(lapsing.id), { state: "expired" }); check.deepEqual(await queue(), []);
    check.equal(seen.some(text => text.includes(canary) || text.includes(password)), false);
  }


  stage = "prompt queue: limits";
  {
    const c = clock(), { home, service } = await begin("limits", c, { prompts: { waitMs: 300 } });
    const ui = await as(home, "vault-app"), cli = await as(home, "vault-cli"), agent = await joined(home, cli, "claude-code", "agent");
    const ask = { project: "synthetic-project", commands: [[process.execPath, "-e", ""]], cwd: scratch, env: {} };
    const apps = []; for (let i = 0; i < 10; i++) apps.push(await joined(home, cli, `limit-app-${i}`));
    // Five per app, runs and prompts together: the CLI's fifth prompt closes its share, and a dismissed one frees a place for a run.
    const mine = []; for (let i = 0; i < 5; i++) mine.push(await cli.prompts.unlock());
    await rejects(() => cli.runs.submit(ask), "limited"); await rejects(() => cli.prompts.unlock(), "limited");
    await ui.prompts.dismiss(mine[0].id); check.match((await cli.runs.submit(ask)).id, uuid); await rejects(() => cli.prompts.unlock(), "limited");
    // The sixth request answers 429 in the usual error shape.
    const own = []; for (let i = 0; i < 5; i++) own.push(await apps[0].prompts.unlock(`limit ${i}`));
    const sixth = await probe(service, "/v1/prompts/unlock", { method: "POST", auth: `Bearer ${apps[0].token()}`, body: {} }); note(sixth.value);
    check.equal(sixth.status, 429); check.deepEqual(Object.keys(sixth.value.error).sort(), ["code", "fields", "message", "requestId"]); check.equal(sixth.value.error.code, "limited"); check.equal(sixth.headers.get("retry-after"), "60");
    await rejects(() => apps[0].permissions.request(), "limited"); await ui.prompts.dismiss(own[0].id); await apps[0].prompts.unlock(); await rejects(() => apps[0].prompts.unlock(), "limited");
    // Fifty in all: the CLI and nine apps hold five each, so the tenth app, a permission request and a run proposal are all refused.
    for (const api of apps.slice(1, 9)) for (let i = 0; i < 5; i++) await api.prompts.unlock();
    check.equal(service.prompts.pending().length, 50);
    const tenth = apps[9];
    await rejects(() => tenth.prompts.unlock(), "limited"); await rejects(() => tenth.permissions.request(), "limited"); await rejects(() => agent.runs.submit(ask), "limited");
    check.equal((await probe(service, "/v1/prompts/unlock", { method: "POST", auth: `Bearer ${tenth.token()}`, body: {} })).status, 429);
    await ui.prompts.dismiss(service.prompts.pending()[0].id); await tenth.prompts.unlock(); check.equal(service.prompts.pending().length, 50); await rejects(() => tenth.prompts.unlock(), "limited");
  }

  stage = "app start";
  {
    const c = clock(), { home } = await begin("starter", c, { prompts: { waitMs: 300, perApp: 40 } });
    const cli = await as(home, "vault-cli"), asker = await joined(home, cli, "synthetic-app"), other = await joined(home, cli, "other-app"), agent = await joined(home, cli, "claude-code", "agent");
    const exe = await fakeApp(), log = `${exe}.log`, record = app => writeFile(join(home, "install.json"), JSON.stringify({ version: 1, command: process.execPath, args: [], ...app === undefined ? {} : { app } }));
    const lines = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const until = async condition => { for (let spent = 0; spent < 30000; spent += 100) { if (await condition()) return; await wait(100); } throw new Error("start_timeout"); };
    const quiet = async () => { await wait(1000); return (await lines()).length; };
    const ask = { project: "synthetic-project", commands: [[process.execPath, "-e", ""]], cwd: scratch, env: {} };
    // Nothing starts without a recorded app, or with one that is not an absolute path to an existing file.
    await asker.prompts.unlock(); await record(undefined); await asker.prompts.unlock();
    for (const bad of [join(scratch, "missing-app.exe"), "fake-app.exe", dirname(exe), 5, ""]) { await record(bad); await asker.prompts.unlock(); }
    check.equal(await quiet(), 0);
    // A vault-app that is present answers the prompts itself.
    await record(exe); const present = await as(home, "vault-app"); await asker.prompts.unlock(); check.equal(await quiet(), 0); await present.close();
    // Without one the app starts, detached, in its prompts view, with the service's own home and its own folder.
    await asker.prompts.unlock(); await until(async () => (await lines()).length === 1);
    const first = (await lines())[0], expected = `--prompts|${home}|${dirname(exe)}`;
    check.equal(process.platform === "win32" ? first.toLowerCase() : first, process.platform === "win32" ? expected.toLowerCase() : expected);
    // It starts again only when the last start is thirty seconds old.
    await asker.prompts.unlock(); check.equal(await quiet(), 1); c.time += START_GUARD_MS - 1; await asker.prompts.unlock(); check.equal(await quiet(), 1);
    c.time += 1; await asker.prompts.unlock(); await until(async () => (await lines()).length === 2);
    // Every kind of prompt starts it: a run proposal and a permission request as well.
    c.time += START_GUARD_MS; await agent.runs.submit(ask); await until(async () => (await lines()).length === 3);
    c.time += START_GUARD_MS; await other.permissions.request(); await until(async () => (await lines()).length === 4);
    check.equal((await lines()).every(line => line.startsWith("--prompts|")), true); check.equal(await quiet(), 4);
  }

  stage = "CLI with the Vault app installed";
  {
    const c = clock(), { home, service } = await begin("cli", c, { prompts: { waitMs: 300 } });
    const install = app => writeFile(join(home, "install.json"), JSON.stringify({ version: 1, command: process.execPath, args: [], ...app ? { app } : {} }));
    await install(process.execPath);
    const ui = await as(home, "vault-app"), login = newEntry("login"), project = newEntry("env");
    login.title = "Synthetic"; login.fields.find(field => field.id === "password").value = canary;
    project.title = "synthetic-project"; project.fields = [{ id: "SYNTHETIC_CLI_VALUE", name: "Synthetic variable", secret: true, value: canary }];
    await ui.create(password); await ui.entries.save(login, 0); await ui.entries.save(project, 0); await ui.lock(); await joined(home, ui, "claude-code", "agent");
    process.env.VAULT_HOME = home; process.env.LC_ALL = "en";
    const output = [], errors = [], asked = [], answers = [];
    const io = { isTTY: () => true, async ask(label) { asked.push(label); if (!answers.length) throw new Error("unexpected_prompt"); return answers.shift(); }, write(value) { output.push(value); }, error(value) { errors.push(value); }, out(value) { output.push(value); }, err(value) { errors.push(value); } };
    const quietIo = { ...io, isTTY: () => false }, reset = () => { output.length = 0; errors.length = 0; asked.length = 0; };
    // This test plays the Vault app: it takes the first prompt of a kind and answers it through the client, as the app would.
    const answer = async (kind, act) => { for (;;) { const found = (await ui.prompts.list()).find(prompt => prompt.kind === kind); if (found) { note(found); await act(found); return found; } await wait(50); } };
    const unlocking = () => answer("unlock", () => ui.unlock(password)), window = "Unlock Vault in its window.";
    const echo = join(scratch, "echo.mjs"); await writeFile(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");

    // The prompt replaces the password question, in both languages, and names the command that asked.
    reset(); let app = unlocking(); check.equal(await main(["unlock"], io), 0); let found = await app;
    check.deepEqual(errors, [window]); check.deepEqual(output, ["Vault unlocked."]); check.deepEqual(asked, []); check.equal(found.app.id, "vault-cli"); check.equal(found.summary.reason, "vault unlock"); check.equal(open(service), true);
    reset(); check.equal(await main(["unlock"], io), 0); check.deepEqual(errors, []); check.deepEqual(output, ["Vault unlocked."]);
    await ui.lock(); reset(); process.env.LC_ALL = "es"; app = unlocking(); check.equal(await main(["unlock"], io), 0); await app;
    check.deepEqual(errors, ["Desbloquear Vault en su ventana."]); check.deepEqual(output, ["Vault desbloqueado."]); process.env.LC_ALL = "en";
    await ui.lock(); reset(); answers.push("yes"); app = unlocking(); check.equal(await main(["get", login.id, "password", "--reveal"], io), 0); found = await app;
    check.equal(output.length, 1); check.equal(output[0] === canary, true); check.deepEqual(errors, [window]); check.equal(asked.length, 1); check.equal(asked[0].includes("Master"), false); check.equal(found.summary.reason, "vault get");
    // --terminal keeps the question in the terminal, before or after the command, and makes no prompt.
    for (const args of [["unlock", "--terminal"], ["--terminal", "unlock"]]) {
      await ui.lock(); reset(); answers.push(password); check.equal(await main(args, io), 0);
      check.equal(asked.length, 1); check.match(asked[0], /Master password/); check.deepEqual(errors, []); check.deepEqual(output, ["Vault unlocked."]);
    }
    check.deepEqual(await ui.prompts.list(), []);
    for (const args of [["status", "--terminal"], ["lock", "--terminal"], ["unlock", "--terminal", "--terminal"], ["sync", "status", "--terminal"], ["settings", "--terminal"], ["install", "--terminal"], ["apps", "--terminal"]]) { reset(); check.equal(await main(args, io), 2); }
    // Turning the prompt down, or letting it lapse, ends the command with its own message.
    await ui.lock(); reset(); app = answer("unlock", prompt => ui.prompts.dismiss(prompt.id)); check.equal(await main(["unlock"], io), 1); await app; check.deepEqual(errors, [window, "Cancelled."]);
    reset(); app = answer("unlock", async () => { c.time += 300000; }); check.equal(await main(["unlock"], io), 1); await app; check.deepEqual(errors, [window, "Nobody unlocked Vault in time. Try again."]);
    // Approvals happen in the window, with or without a terminal; --terminal keeps today's flow.
    for (const [language, line] of [["en", "Approvals happen in Vault's window."], ["es", "Las aprobaciones se hacen en la ventana de Vault."]]) { process.env.LC_ALL = language; for (const channel of [io, quietIo]) { reset(); check.equal(await main(["approve"], channel), 0); check.deepEqual(output, [line]); check.deepEqual(asked, []); } }
    process.env.LC_ALL = "en"; await ui.unlock(password); reset(); check.equal(await main(["approve", "--terminal"], io), 0); check.deepEqual(output, ["No requests are waiting."]);
    reset(); check.equal(await main(["approve", "--terminal"], quietIo), 1); check.equal(errors[0].includes("A terminal is required"), true);
    // A run waits in the window whether a person or an agent typed it; after "--" the flag belongs to the command.
    reset(); app = answer("run", prompt => ui.runs.approve(prompt.id, password)); check.equal(await main(["run", "--project", "synthetic-project", "--", process.execPath, echo, "--terminal"], io), 0); found = await app;
    check.equal(errors.some(line => line.startsWith("Waiting for approval in Vault's window.")), true); check.equal(output.join(""), '["--terminal"]'); check.deepEqual(found.summary.commands, [[process.execPath, echo, "--terminal"]]); check.equal(found.app.id, "vault-cli"); check.deepEqual(asked, []);
    reset(); app = answer("run", prompt => ui.runs.approve(prompt.id, password)); check.equal(await main(["run", "--agent", "claude-code", "--project", "synthetic-project", "--", process.execPath, echo], quietIo), 0); found = await app;
    check.equal(errors.some(line => line.startsWith("Waiting for approval in Vault's window.")), true); check.equal(found.app.id, "claude-code"); check.equal(output.join(""), "[]");
    await ui.lock(); reset(); answers.push(password); check.equal(await main(["run", "--terminal", "--project", "synthetic-project", "--", process.execPath, echo], io), 0);
    check.equal(asked.length, 1); check.match(asked[0], /Master password/); check.equal(errors.some(line => line.includes("window")), false); check.equal(output.join("").endsWith("[]"), true);
    // Without an app recorded nothing changes.
    await install(undefined); await ui.lock(); reset(); answers.push(password); check.equal(await main(["unlock"], io), 0);
    check.equal(asked.length, 1); check.match(asked[0], /Master password/); check.deepEqual(errors, []); check.deepEqual(output, ["Vault unlocked."]);
    reset(); check.equal(await main(["approve"], quietIo), 1); check.equal(errors[0].includes("A terminal is required"), true); await install(process.execPath);
    // Settings, in both languages: all four on separate lines, a change at a time, nothing outside the listed values.
    reset(); check.equal(await main(["settings"], io), 0);
    check.deepEqual(output.map(line => line.split(" | ").slice(0, 2).join(" | ")), ["idleMinutes | 5", "lockWithLastApp | true", "language | system", "theme | system"]);
    check.equal(output[0].endsWith("(1, 5, 15, 30, 60, 240)"), true); check.equal(output[1].includes("lock when the last app closes"), true);
    reset(); process.env.LC_ALL = "es"; check.equal(await main(["settings"], io), 0); check.equal(output[0].includes("minutos sin uso"), true); check.equal(output[2].includes("idioma"), true);
    reset(); check.equal(await main(["settings", "set", "theme", "dark"], io), 0); check.deepEqual(output, ["Se guardó."]); process.env.LC_ALL = "en";
    for (const [key, value] of [["idleMinutes", "15"], ["lockWithLastApp", "false"], ["language", "es"]]) { reset(); check.equal(await main(["settings", "set", key, value], io), 0); check.deepEqual(output, ["Saved."]); }
    check.deepEqual(await ui.settings.get(), { idleMinutes: 15, lockWithLastApp: false, language: "es", theme: "dark" }); check.equal(service.vault.memory.idle, 900000); check.equal(service.lifecycle.lockWithLastApp, false);
    for (const args of [["settings", "set", "idleMinutes", "2"], ["settings", "set", "idleMinutes", "15x"], ["settings", "set", "idleMinutes", ""], ["settings", "set", "bogus", "1"], ["settings", "set", "constructor", "1"], ["settings", "set", "lockWithLastApp", "maybe"], ["settings", "set", "lockWithLastApp", "constructor"], ["settings", "set", "theme", "blue"], ["settings", "set", "language", ""], ["settings", "set"], ["settings", "set", "theme"], ["settings", "get"], ["settings", "set", "theme", "dark", "extra"]]) { reset(); check.equal(await main(args, io), 2); }
    check.deepEqual(await ui.settings.get(), { idleMinutes: 15, lockWithLastApp: false, language: "es", theme: "dark" });
  }

  stage = "secret-free records";
  {
    for (const folder of homes) {
      const logs = await readFile(join(folder, "logs", "events.jsonl"), "utf8").catch(() => ""), store = await tree(join(folder, "store")).catch(() => "");
      const files = [logs, store, await readFile(join(folder, "settings.json"), "utf8").catch(() => ""), await readFile(join(folder, "install.json"), "utf8").catch(() => "")];
      check.equal(files.some(content => [canary, password, wrongPassword].some(secret => content.includes(secret))), false);
    }
    const events = await readFile(join(scratch, "prompts", "logs", "events.jsonl"), "utf8");
    for (const name of ["prompt_unlock", "prompt_dismiss", "permission_request", "run_request", "app_permission"]) check.equal(events.includes(`"event":"${name}"`), true);
    check.equal(seen.some(text => text.includes(canary) || text.includes(password) || text.includes(wrongPassword)), false);
  }
  console.log(`Vault prompts service: ${checks} checks passed.`);
} catch (error) {
  console.error(`Vault prompts service failed at ${stage}: ${error?.code ?? "assertion"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*prompts\.(?:test\.mjs|ts):\d+:\d+/.test(line)).join("\n"));
  throw new Error("prompts service check failed");
} finally {
  for (const api of clients) await api.close().catch(() => undefined);
  for (const service of services) await service.shutdown();
  await wait(200);
  if (previousHome === undefined) delete process.env.VAULT_HOME; else process.env.VAULT_HOME = previousHome;
  if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale;
  assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true });
}
