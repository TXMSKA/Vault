import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { newEntry } from "vault-core";
import { connect, findService, VaultClientError } from "../../client/dist/index.js";
import { startService } from "../src/server.ts";
import { Apps } from "../src/secrets.ts";
import { ServiceError } from "../src/errors.ts";
import { routes } from "../src/routes.ts";
import { PROMPT_LIMITS } from "../src/prompts.ts";

const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-keys-")), home = join(scratch, "home"), clients = [], services = [];
const password = randomBytes(30).toString("base64"), wrongPassword = randomBytes(30).toString("base64"), firstKey = randomBytes(30).toString("base64"), rotatedKey = randomBytes(30).toString("base64"), latestKey = randomBytes(30).toString("base64");
const secrets = [password, wrongPassword, firstKey, rotatedKey, latestKey], uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let now = 1000000, checks = 0, stage = "registration", helloRefused = false, helloCalls = 0, helloWindow;
const check = Object.fromEntries(["equal", "deepEqual", "match", "rejects"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
const rejects = (operation, code) => check.rejects(operation, error => error instanceof VaultClientError && error.code === code);
const noSecrets = value => check.equal(secrets.some(secret => JSON.stringify(value).includes(secret)), false);
const tokens = () => { let value; return { async get() { return value; }, async set(token) { value = token; }, token: () => value }; };
const as = async (id, kind = "cosmic") => { const store = tokens(), api = await connect({ home, app: { id, name: `Synthetic ${id}`, kind }, tokens: store }); clients.push(api); return Object.assign(api, { token: () => store.token() }); };
const auth = api => `Bearer ${api.token()}`;
const apiKey = (title, key = firstKey, apps = "lyra", updatedAt = new Date(now).toISOString()) => {
  const entry = newEntry("apikey"); entry.title = title; entry.updatedAt = updatedAt;
  for (const field of entry.fields) field.value = ({ key, apps })[field.id]; return entry;
};
async function probe(service, path, { method = "GET", api, body } = {}) {
  return new Promise((done, fail) => {
    const request = http.request({ hostname: "127.0.0.1", port: service.port, path, method, headers: { ...(api ? { Authorization: auth(api) } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) } }, response => {
      let content = ""; response.on("data", chunk => { content += chunk; }); response.on("end", () => { try { done({ status: response.statusCode, value: JSON.parse(content), headers: response.headers }); } catch { fail(new Error("invalid_test_response")); } });
    });
    request.on("error", fail); request.setTimeout(10000, () => request.destroy(new Error("test_timeout"))); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
function errorShape(result, status, code, fields = {}) {
  check.equal(result.status, status); check.deepEqual(Object.keys(result.value), ["error"]); check.deepEqual(Object.keys(result.value.error).sort(), ["code", "fields", "message", "requestId"]);
  check.equal(result.value.error.code, code); check.equal(result.value.error.message, "Vault could not complete the request."); check.deepEqual(result.value.error.fields, fields); check.match(result.value.error.requestId, uuid); noSecrets(result.value);
}
async function tree(folder) {
  let contents = "";
  for (const item of await readdir(folder, { withFileTypes: true })) { const path = join(folder, item.name); contents += item.isDirectory() ? await tree(path) : await readFile(path, "utf8"); } return contents;
}
try {
  // This exercises the Hello route's proof and grant ordering without a real biometric dialog.
  const table = routes.map(route => route.path !== "/v1/keys/approve/hello" ? route : { ...route, handle: c => route.handle({ ...c, hello: { ...c.hello, async unlock(hwnd) { helloCalls++; helloWindow = hwnd; if (helloRefused) throw new ServiceError("cancelled", 403); await c.vault.auth.unlock(password); } } }) });
  const service = await startService({ home, now: () => now, idleMs: 1e9, presenceMs: 1e12, prompts: { waitMs: 5 }, routes: table }); services.push(service);
  const ui = await as("vault-app"), cli = await as("vault-cli"), lyra = await as("lyra"), nova = await as("nova"), nebula = await as("nebula"), horizon = await as("horizon"), agent = await as("synthetic-agent", "agent");
  await cli.apps.allow("synthetic-agent");
  const identity = await lyra.apps.self(); check.equal(identity.kind, "cosmic"); check.equal(identity.status, "granted"); check.deepEqual(identity.kinds, []); check.deepEqual(identity.permissions, []);
  check.equal((await cli.apps.allow("lyra")).status, "granted"); check.deepEqual((await nova.apps.self()).kinds, ["env"]); check.deepEqual((await horizon.apps.self()).kinds, ["login"]); check.equal((await nebula.apps.self()).kinds.includes("apikey"), false);
  await rejects(() => as("lyra", "app"), "invalid");
  check.equal((await findService(home)).serviceVersion, "0.1.0"); check.equal((await probe(service, "/v1/health")).value.serviceVersion, "0.1.0");
  await ui.create(password);
  const login = newEntry("login"); login.title = "Synthetic login"; login.fields.find(field => field.id === "password").value = firstKey; login.fields.find(field => field.id === "website").value = "https://synthetic.example";
  const environment = newEntry("env"); environment.title = "synthetic-project"; environment.fields = [{ id: "SYNTHETIC_API_VALUE", name: "Synthetic", value: firstKey, secret: true }];
  await ui.entries.save(login, 0); await ui.entries.save(environment, 0);
  const original = apiKey("Synthetic payments"), other = apiKey("Synthetic weather", latestKey), hidden = apiKey("Synthetic hidden", firstKey, "nova"), empty = apiKey("Synthetic empty", ""), noApps = apiKey("Synthetic unlinked", firstKey, "");
  for (const entry of [original, other, hidden, empty, noApps]) await ui.entries.save(entry, 0);

  stage = "Lyra route isolation";
  const ask = { project: environment.title, commands: [[process.execPath, "-e", ""]], cwd: scratch, env: {} };
  const refused = [
    ["GET", "/v1/entries"], ["GET", `/v1/entries/get?id=${original.id}`], ["POST", "/v1/entries", { entry: original, expected: 1 }], ["POST", "/v1/entries/remove", { id: original.id, expected: 1 }],
    ["GET", "/v1/logins?origin=https%3A%2F%2Fsynthetic.example"], ["GET", "/v1/logins/all"], ["GET", `/v1/logins/get?id=${login.id}`], ["GET", "/v1/env?project=synthetic-project"],
    ["POST", "/v1/import", { format: "chrome", text: "name,url,username,password\r\nSynthetic,https://synthetic.example,user,synthetic\r\n" }], ["POST", "/v1/import/env", { project: environment.title, text: "SYNTHETIC=synthetic" }],
    ["POST", "/v1/apps/permissions/import", { password }], ["POST", "/v1/apps/permissions/import/hello", { hwnd: "1" }], ["POST", "/v1/apps/permissions/import/request", {}],
    ["POST", "/v1/runs", ask], ["GET", `/v1/runs/get?after=0&id=${randomUUID()}`], ["GET", "/v1/runs"], ["POST", "/v1/chunks", { data: [Buffer.from(firstKey).toString("base64")] }],
    ...routes.filter(route => route.path.startsWith("/v1/sync")).map(route => [route.method, route.path, route.method === "GET" ? undefined : {}]),
  ];
  for (const [method, path, body] of refused) { const result = await probe(service, path, { api: lyra, method, body }); errorShape(result, 403, "forbidden"); }
  await rejects(() => ui.permissions.importWithPassword(password, "lyra"), "forbidden");
  for (const api of [agent, nova, nebula, horizon, ui, cli]) {
    errorShape(await probe(service, "/v1/keys", { api }), 403, "forbidden");
    errorShape(await probe(service, "/v1/keys/read", { api, method: "POST", body: { id: original.id } }), 403, "forbidden");
  }
  for (const api of [nova, nebula, horizon]) await rejects(() => api.entries.get(original.id), "not_found");
  check.equal((await nebula.entries.list()).some(row => row.entry.kind === "apikey"), false);

  stage = "key list and request validation";
  const byId = rows => rows.sort((a, b) => a.id.localeCompare(b.id)), expected = [original, other].map(entry => ({ id: entry.id, label: entry.title }));
  const listed = await lyra.keys.list(); check.deepEqual(byId(listed), byId(expected)); noSecrets(listed);
  for (const row of listed) check.deepEqual(Object.keys(row).sort(), ["id", "label"]);
  errorShape(await probe(service, "/v1/keys"), 401, "unauthenticated");
  errorShape(await probe(service, "/v1/keys/read", { method: "POST", body: { id: original.id } }), 401, "unauthenticated");
  errorShape(await probe(service, `/v1/keys?id=${original.id}`, { api: lyra }), 400, "invalid");
  for (const body of [{}, { id: original.id, extra: true }, { id: 3 }, { id: "synthetic" }, { provider: "openai" }]) errorShape(await probe(service, "/v1/keys/read", { api: lyra, method: "POST", body }), 400, "invalid");
  for (const entry of [hidden.id, empty.id, noApps.id, login.id, environment.id, randomUUID()]) errorShape(await probe(service, "/v1/keys/read", { api: lyra, method: "POST", body: { id: entry } }), 404, "not_found");
  check.deepEqual(await ui.keys.usage(), []); check.deepEqual(service.prompts.pending(), []);

  stage = "first read and password approval";
  const first = await probe(service, "/v1/keys/read", { api: lyra, method: "POST", body: { id: original.id } }), promptId = first.value.error.fields.prompt;
  check.match(promptId, uuid); errorShape(first, 403, "key_approval_required", { prompt: promptId });
  let clientPrompt;
  await check.rejects(() => lyra.keys.read(original.id), error => { clientPrompt = error.prompt; return error instanceof VaultClientError && error.code === "key_approval_required"; }); check.equal(clientPrompt, promptId);
  const prompts = await ui.prompts.list(); check.equal(prompts.length, 1); check.deepEqual(prompts[0], { id: promptId, kind: "key", app: { id: "lyra", name: "Synthetic lyra" }, summary: { entry: original.id, label: original.title }, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PROMPT_LIMITS.expiresMs).toISOString() }); noSecrets(prompts);
  await rejects(() => lyra.keys.approve(promptId, password), "forbidden"); await rejects(() => agent.keys.approve(promptId, password), "forbidden"); await rejects(() => nova.keys.usage(), "forbidden");
  await rejects(() => ui.keys.approve(promptId, wrongPassword), "locked"); check.deepEqual((await lyra.apps.self()).permissions, []); check.equal(service.prompts.pending().length, 1); check.deepEqual(await ui.keys.usage(), []);
  now += 31000; check.deepEqual(await ui.keys.approve(promptId, password), { ok: true }); check.deepEqual((await lyra.apps.self()).permissions, [`key:${original.id}`]); check.deepEqual(await lyra.prompts.wait(promptId), { state: "done" }); check.deepEqual(service.prompts.pending(), []);
  await rejects(() => ui.keys.approve(promptId, password), "not_pending");
  const read = await lyra.keys.read(original.id); check.deepEqual(Object.keys(read), ["key"]); check.equal(read.key === firstKey, true);
  check.deepEqual(await ui.keys.usage(), [{ entry: original.id, app: "lyra", lastRead: new Date(now).toISOString() }]); check.deepEqual(await cli.keys.usage(), await ui.keys.usage());
  const persisted = new Apps(home); await persisted.load(); check.deepEqual(persisted.list().find(row => row.id === "lyra").permissions, [`key:${original.id}`]);

  stage = "rotation and a second key";
  const rotated = structuredClone(original); rotated.fields.find(field => field.id === "key").value = rotatedKey; rotated.updatedAt = new Date(++now).toISOString(); await ui.entries.save(rotated, 1);
  const fresh = await lyra.keys.read(original.id); check.equal(fresh.key === rotatedKey, true); check.deepEqual(service.prompts.pending(), []); check.deepEqual(await ui.keys.usage(), [{ entry: original.id, app: "lyra", lastRead: new Date(now).toISOString() }]);
  // Each key the person chose in Lyra is approved on its own; an approved key never stands in for another.
  let latestPrompt; await check.rejects(() => lyra.keys.read(other.id), error => { latestPrompt = error.prompt; return error.code === "key_approval_required"; }); check.equal(latestPrompt !== promptId, true); check.deepEqual(service.prompts.pending()[0].summary, { entry: other.id, label: other.title });
  await check.rejects(() => lyra.keys.read(other.id), error => error.code === "key_approval_required" && error.prompt === latestPrompt);

  stage = "Hello proof";
  helloRefused = true; await rejects(() => cli.keys.approveWithHello(latestPrompt, "42"), "cancelled"); check.equal(helloCalls, 1); check.equal(helloWindow, 42n); check.equal((await lyra.apps.self()).permissions.includes(`key:${other.id}`), false); check.equal(service.prompts.pending().length, 1);
  helloRefused = false; check.deepEqual(await cli.keys.approveWithHello(latestPrompt, "42"), { ok: true }); check.equal(helloCalls, 2); check.equal((await lyra.keys.read(other.id)).key === latestKey, true); check.equal((await lyra.keys.read(original.id)).key === rotatedKey, true);
  check.deepEqual((await ui.keys.usage()).find(row => row.entry === other.id), { entry: other.id, app: "lyra", lastRead: new Date(now).toISOString() });

  stage = "revocation";
  await rejects(() => lyra.keys.revoke("lyra", other.id), "forbidden"); check.deepEqual(await cli.keys.revoke("lyra", other.id), { ok: true });
  check.equal((await lyra.apps.self()).permissions.includes(`key:${other.id}`), false); check.equal((await ui.entries.get(other.id)).entry.fields.find(field => field.id === "apps").value.includes("lyra"), false); check.equal((await lyra.keys.list()).some(row => row.id === other.id), false);
  await rejects(() => lyra.keys.read(other.id), "not_found");
  // Stopping a key cancels the request still waiting for it.
  const older = apiKey("Synthetic older"); await ui.entries.save(older, 0);
  let olderPrompt; await check.rejects(() => lyra.keys.read(older.id), error => { olderPrompt = error.prompt; return error.code === "key_approval_required"; }); check.equal(service.prompts.pending()[0].summary.entry, older.id);
  check.deepEqual(await ui.keys.revoke("lyra", older.id), { ok: true }); check.deepEqual(await lyra.prompts.wait(olderPrompt), { state: "cancelled" }); await rejects(() => ui.keys.approve(olderPrompt, password), "not_pending");
  await ui.keys.revoke("lyra", original.id); await rejects(() => lyra.keys.read(original.id), "not_found"); check.equal((await ui.entries.get(original.id)).entry.fields.find(field => field.id === "apps").value, ""); check.equal((await lyra.apps.self()).permissions.includes(`key:${original.id}`), false);
  check.deepEqual(await ui.keys.revoke("nova", hidden.id), { ok: true }); check.equal((await ui.entries.get(hidden.id)).entry.fields.find(field => field.id === "apps").value, "");

  stage = "refused, expired and stale prompts";
  const declinedKey = apiKey("Synthetic declined"); await ui.entries.save(declinedKey, 0);
  let declined; await check.rejects(() => lyra.keys.read(declinedKey.id), error => { declined = error.prompt; return error.code === "key_approval_required"; }); await ui.prompts.dismiss(declined); check.deepEqual(await lyra.prompts.wait(declined), { state: "cancelled" }); await rejects(() => ui.keys.approve(declined, password), "not_pending");
  let expired; await check.rejects(() => lyra.keys.read(declinedKey.id), error => { expired = error.prompt; return error.code === "key_approval_required"; }); now += PROMPT_LIMITS.expiresMs; check.deepEqual(await lyra.prompts.wait(expired), { state: "expired" }); await rejects(() => cli.keys.approve(expired, password), "not_pending");
  let stale; await check.rejects(() => lyra.keys.read(declinedKey.id), error => { stale = error.prompt; return error.code === "key_approval_required"; }); await ui.entries.remove(declinedKey.id, 1); await rejects(() => ui.keys.approve(stale, password), "not_found"); check.equal((await lyra.apps.self()).permissions.includes(`key:${declinedKey.id}`), false); await ui.prompts.dismiss(stale);

  stage = "UUIDv7 entry approval";
  const seventh = apiKey("Synthetic UUIDv7"); seventh.id = seventh.id.slice(0, 14) + "7" + seventh.id.slice(15); await ui.entries.save(seventh, 0);
  let seventhPrompt; await check.rejects(() => lyra.keys.read(seventh.id), error => { seventhPrompt = error.prompt; return error.code === "key_approval_required"; }); check.deepEqual(await cli.keys.approve(seventhPrompt, password), { ok: true }); check.equal((await lyra.keys.read(seventh.id)).key === firstKey, true); check.equal((await lyra.apps.self()).permissions.includes(`key:${seventh.id}`), true);

  stage = "locked responses and usage lifetime";
  await ui.lock();
  errorShape(await probe(service, "/v1/keys", { api: lyra }), 423, "locked");
  for (const entry of [original.id, seventh.id, randomUUID()]) errorShape(await probe(service, "/v1/keys/read", { api: lyra, method: "POST", body: { id: entry } }), 423, "locked");
  check.equal((await ui.status()).unlocked, false); await ui.unlock(password);
  const logs = await readFile(join(home, "logs", "events.jsonl"), "utf8"); noSecrets(logs); noSecrets(await tree(join(home, "store"))); noSecrets(await readFile(join(home, "secrets", "apps.json"), "utf8"));
  check.equal(logs.includes("key_approval_required"), true); check.equal((await ui.keys.usage()).every(row => Object.keys(row).sort().join() === "app,entry,lastRead"), true);
  for (const api of clients) await api.close().catch(() => undefined); await service.shutdown();
  const restarted = await startService({ home, now: () => now, idleMs: 1e9, presenceMs: 1e12 }); services.push(restarted);
  const reopened = await as("vault-app"); await reopened.unlock(password); check.deepEqual(await reopened.keys.usage(), []);

  stage = "permission persistence boundaries";
  const permission = `key:${randomUUID()}`, lyraApp = { ...identity, permissions: [permission] }, row = { app: lyraApp, tokenHash: "a".repeat(64) };
  const load = async (name, rows) => { const folder = join(scratch, name); await mkdir(join(folder, "secrets"), { recursive: true }); await writeFile(join(folder, "secrets", "apps.json"), JSON.stringify(rows)); const apps = new Apps(folder); await apps.load(); return apps; };
  const apps = await load("permissions", [row]); check.deepEqual(apps.list()[0].permissions, [permission]); check.deepEqual((await apps.grant("lyra", permission)).permissions, [permission]);
  check.deepEqual((await apps.revoke("lyra", permission)).permissions, []); check.deepEqual((await apps.grant("lyra", permission)).permissions, [permission]);
  await check.rejects(() => apps.grant("lyra", "import"), error => error.code === "forbidden"); await check.rejects(() => apps.grant("lyra", "key:invalid"), error => error.code === "forbidden");
  const cap = Array.from({ length: 4096 }, () => `key:${randomUUID()}`), full = await load("permissions-cap", [{ ...row, app: { ...lyraApp, permissions: cap } }]); check.equal(full.list()[0].permissions.length, 4096);
  await check.rejects(() => full.grant("lyra", `key:${randomUUID()}`), error => error.code === "limited"); check.equal(full.list()[0].permissions.length, 4096);
  const invalid = [
    ["overflow", { ...lyraApp, permissions: [...cap, `key:${randomUUID()}`] }], ["duplicate", { ...lyraApp, permissions: [permission, permission] }], ["malformed", { ...lyraApp, permissions: ["key:invalid"] }], ["import", { ...lyraApp, permissions: ["import"] }],
    ["nova", { ...lyraApp, id: "nova" }], ["nebula", { ...lyraApp, id: "nebula" }], ["agent", { ...lyraApp, id: "synthetic-agent", kind: "agent" }],
  ];
  for (const [name, app] of invalid) { stage = `permission persistence ${name}`; await check.rejects(() => load(`permissions-${name}`, [{ ...row, app }]), error => error instanceof ServiceError && error.code === "unavailable"); }
  for (const status of ["pending", "revoked"]) { const denied = await load(`permissions-${status}`, [{ ...row, app: { ...lyraApp, status, permissions: [] } }]); await check.rejects(() => denied.grant("lyra", permission), error => error.code === "forbidden"); }
  stage = "legacy Lyra registration migration";
  for (const status of ["pending", "revoked"]) {
    const legacy = await load(`legacy-${status}`, [{ ...row, app: { ...identity, kind: "app", status } }]); check.deepEqual(legacy.list()[0], { ...identity, status });
    check.deepEqual(await legacy.setStatus("lyra", "granted"), identity);
    const persisted = new Apps(join(scratch, `legacy-${status}`)); await persisted.load(); check.deepEqual(persisted.list()[0], identity);
  }
  await check.rejects(() => load("legacy-granted", [{ ...row, app: { ...identity, kind: "app" } }]), error => error instanceof ServiceError && error.code === "invalid");
  console.log(`Vault API keys service: ${checks} checks passed.`);
} catch (error) {
  console.error(`Vault API keys service failed at ${stage}: ${error instanceof ServiceError || error instanceof VaultClientError ? error.code : "assertion"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*keys\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  throw new Error("API keys service check failed");
} finally {
  for (const api of clients) await api.close().catch(() => undefined); for (const service of services) await service.shutdown();
  assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true });
}
