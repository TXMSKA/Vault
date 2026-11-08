import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { newEntry } from "vault-core";
import { connect, findService, VaultClientError } from "../../client/src/index.ts";
import { serviceEnv } from "../../client/src/paths.ts";
import { startService } from "../src/server.ts";
import { routes } from "../src/routes.ts";
import { ServiceError } from "../src/errors.ts";

const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-cosmic-")), home = join(scratch, "home");
const vaultPassword = `vault ${randomBytes(18).toString("base64url")}`, cosmicPassword = `cosmic ${randomBytes(18).toString("base64url")} 密碼`, nextPassword = `next ${randomBytes(18).toString("base64url")}`, otherPassword = `other ${randomBytes(18).toString("base64url")}`, wrongPassword = `wrong ${randomBytes(18).toString("base64url")}`;
const email = `person.${randomBytes(4).toString("hex")}@example.invalid`, otherEmail = `other.${randomBytes(4).toString("hex")}@example.invalid`;
const secrets = [vaultPassword, cosmicPassword, nextPassword, otherPassword, wrongPassword, email, otherEmail];
const clients = [], services = [];
let now = 1_700_000_000_000, checks = 0, stage = "origin", child, releaseGate = () => {}, originalFetch = globalThis.fetch;
const savedSite = process.env.VAULT_QUANTUM_SITE;
const output = [], writeOut = process.stdout.write.bind(process.stdout), writeErr = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, encoding, callback) => { output.push(String(chunk)); return writeOut(chunk, encoding, callback); };
process.stderr.write = (chunk, encoding, callback) => { output.push(String(chunk)); return writeErr(chunk, encoding, callback); };
const check = Object.fromEntries(["equal", "deepEqual", "match", "rejects"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
const rejects = (operation, code) => check.rejects(operation, error => error instanceof VaultClientError && error.code === code && error.cause === undefined);
const hide = (value, ...allowed) => { const text = typeof value === "string" ? value : JSON.stringify(value); check.equal(secrets.some(secret => secret && !allowed.includes(secret) && text.includes(secret)), false); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = (promise, label) => Promise.race([promise, pause(5000).then(() => { throw new Error(label); })]);
const tokens = () => { let value; return { async get() { return value; }, async set(token) { value = token; }, token: () => value }; };
const login = (website, username, secret) => { const entry = newEntry("login"); entry.title = "Synthetic"; for (const field of entry.fields) field.value = ({ website, username, password: secret })[field.id] ?? ""; return entry; };
async function probe(service, path, { method = "GET", api, body, type = body === undefined ? "none" : "json", raw } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((done, fail) => {
    const request = http.request({ hostname: "127.0.0.1", port: service.port, path, method, headers: { ...(api ? { Authorization: `Bearer ${api.token()}` } : {}), ...(type === "json" ? { "Content-Type": "application/json" } : {}), ...(type === "text" ? { "Content-Type": "text/plain" } : {}) } }, response => {
      const parts = []; response.on("data", chunk => parts.push(chunk)); response.on("end", () => { const text = Buffer.concat(parts).toString("utf8"); let value; try { value = JSON.parse(text); } catch { value = {}; } done({ status: response.statusCode, value, headers: response.headers, text }); });
    });
    request.on("error", fail); request.setTimeout(10000, () => request.destroy(new Error("test_timeout"))); request.end(payload);
  });
}
function errorShape(result, status, code) {
  hide(result.text); check.equal(result.status, status); check.equal(result.headers["cache-control"], "no-store"); check.deepEqual(Object.keys(result.value), ["error"]);
  check.deepEqual(Object.keys(result.value.error).sort(), ["code", "fields", "message", "requestId"]); check.equal(result.value.error.code, code);
  check.equal(result.value.error.message, "Vault could not complete the request."); check.deepEqual(result.value.error.fields, {}); check.match(result.value.error.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}
async function withheld(promise, codes) {
  let body = ""; try { body = JSON.stringify(await promise); } catch (error) { body = error instanceof VaultClientError ? error.code : "error"; }
  hide(body); check.equal(body.includes(cosmicPassword), false); if (codes) check.equal(codes.includes(body), true);
}
function arm(service) {
  const current = service.vault.store.entries.bind(service.vault.store); let release, open, active = true;
  const promise = new Promise(resolve => { release = resolve; }), opened = new Promise(resolve => { open = resolve; });
  service.vault.store.entries = async () => { if (active) { active = false; open(); await promise; } return current(); };
  const stop = () => { active = false; service.vault.store.entries = current; release(); }; releaseGate = stop; return { opened, stop };
}
try {
  process.env.VAULT_QUANTUM_SITE = "https://accounts.example/account/";
  const service = await startService({ home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(service);
  check.equal(service.vault.cosmicOrigin, "https://accounts.example");
  process.env.VAULT_QUANTUM_SITE = "https://other.example";
  check.equal(service.vault.cosmicOrigin, "https://accounts.example");
  process.env.VAULT_QUANTUM_SITE = "https://accounts.example/account/";
  check.equal(routes.some(route => route.path.includes("installed") || route.path.includes("unlock") && route.path.includes("cosmic")), false);
  let reads = 0; const rawEntries = service.vault.store.entries.bind(service.vault.store);
  service.vault.store.entries = async () => { reads++; return rawEntries(); };
  const as = async (id, kind = "cosmic", folder = home) => { const store = tokens(), api = await connect({ home: folder, app: { id, name: `Synthetic ${id}`, kind }, tokens: store }); clients.push(api); const token = store.token(); secrets.push(token); return Object.assign(api, { token: () => token }); };
  const callerIds = ["nebula", "nova", "horizon", "lyra", "hivem1nd"];
  const cli = await as("vault-cli"), ui = await as("vault-app"), horizon = await as("horizon"), nova = await as("nova"), nebula = await as("nebula"), lyra = await as("lyra"), host = await as("hivem1nd");
  check.equal((await findService(home)).serviceVersion, "0.1.0");
  check.equal(Object.hasOwn(horizon.cosmic, "unlock"), false);

  stage = "missing and locked";
  const beforeMissing = reads;
  const missing = await probe(service, "/v1/cosmic/password/status", { method: "POST", api: horizon, body: { email } });
  hide(missing.text); check.equal(missing.status, 200); check.equal(missing.headers["cache-control"], "no-store"); check.deepEqual(missing.value, { state: "none" });
  errorShape(await probe(service, "/v1/cosmic/password/read", { method: "POST", api: horizon, body: { email } }), 404, "not_found");
  check.equal(reads, beforeMissing);
  const created = await cli.create(vaultPassword); secrets.push(created.recovery); await cli.lock();
  const beforeLocked = reads;
  const locked = await probe(service, "/v1/cosmic/password/status", { method: "POST", api: host, body: { email } });
  hide(locked.text); check.deepEqual(locked.value, { state: "locked" }); check.equal(locked.headers["cache-control"], "no-store");
  errorShape(await probe(service, "/v1/cosmic/password/read", { method: "POST", api: host, body: { email } }), 423, "locked");
  check.equal(reads, beforeLocked); check.equal((await horizon.cosmic.passwordStatus(email)).state, "locked"); await rejects(() => horizon.cosmic.readPassword(email), "locked");

  stage = "open vault";
  await horizon.unlock(vaultPassword);
  check.equal((await horizon.cosmic.passwordStatus(email)).state, "none"); await rejects(() => horizon.cosmic.readPassword(email), "not_found");
  const entry = login("https://accounts.example/account", email, cosmicPassword); entry.fields.reverse();
  const ignored = [login("https://accounts.example:8443/login", email, cosmicPassword), login("http://accounts.example/login", email, cosmicPassword), login("https://sub.accounts.example/login", email, cosmicPassword), login("https://user:secret@accounts.example/login", email, cosmicPassword), login("https://cosmic.txmska.com/account", email, cosmicPassword), login("https://accounts.example", email, ""), login("https://accounts.example", `${email} `, cosmicPassword), login("https://accounts.example", otherEmail, otherPassword)];
  const note = newEntry("note"); note.title = "Synthetic";
  let version = (await cli.entries.save(entry, 0)).version; for (const extra of ignored) await cli.entries.save(extra, 0); await cli.entries.save(note, 0);
  const status = await probe(service, "/v1/cosmic/password/status", { method: "POST", api: horizon, body: { email } });
  hide(status.text); check.equal(status.status, 200); check.deepEqual(status.value, { state: "available" }); check.equal(status.headers["cache-control"], "no-store");
  const opened = await probe(service, "/v1/cosmic/password/read", { method: "POST", api: horizon, body: { email } });
  check.equal(opened.status, 200); check.equal(opened.headers["cache-control"], "no-store"); check.equal(opened.value.password === cosmicPassword, true); check.deepEqual(Object.keys(opened.value), ["password"]); hide(opened.text, cosmicPassword);
  const other = await horizon.cosmic.readPassword(otherEmail); check.equal(other.password === otherPassword, true); hide(other, otherPassword);
  for (const api of [nebula, nova, horizon, lyra, host]) { await cli.lock(); check.equal((await api.cosmic.passwordStatus(email)).state, "locked"); await api.unlock(vaultPassword); const value = await api.cosmic.readPassword(email); check.equal(value.password === cosmicPassword, true); hide(value, cosmicPassword); }
  const [first, second] = await Promise.all([horizon.cosmic.readPassword(email), lyra.cosmic.readPassword(email)]);
  check.equal(first.password === cosmicPassword && second.password === cosmicPassword, true); hide(first, cosmicPassword); hide(second, cosmicPassword);

  stage = "callers";
  const stranger = await as("synthetic-host", "app"), pending = await as("synthetic-pending", "app"), agent = await as("synthetic-agent", "agent"), worker = await as("lyra-worker", "app");
  await cli.apps.allow("synthetic-host"); await stranger.present(); await cli.apps.allow("synthetic-agent");
  await rejects(() => cli.apps.allow("lyra-worker"), "forbidden"); await rejects(() => as("hivem1nd", "agent"), "invalid");
  for (const [api, code] of [[cli, "forbidden"], [ui, "forbidden"], [stranger, "forbidden"], [pending, "pending"], [agent, "forbidden"], [worker, "pending"]]) {
    const before = reads; errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", api, body: { email } }), 403, code); errorShape(await probe(service, "/v1/cosmic/password/read", { method: "POST", api, body: { email } }), 403, code); check.equal(reads, before);
  }
  const beforeRevoked = reads; await cli.apps.revoke("hivem1nd"); errorShape(await probe(service, "/v1/cosmic/password/read", { method: "POST", api: host, body: { email } }), 403, "revoked"); check.equal(reads, beforeRevoked);
  await cli.apps.allow("hivem1nd"); await host.present();
  const lyraToken = lyra.token(); await lyra.close(); const beforeAbsent = reads;
  errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", api: { token: () => lyraToken }, body: { email } }), 403, "not_present"); check.equal(reads, beforeAbsent);
  const lyraAgain = await as("lyra");

  stage = "validation";
  now += 60000;
  const invalid = ["", ` ${email}`, `${email} `, "person@example", "a@b", `${email}\n`, `${"a".repeat(320)}@b.co`, "person@@example.invalid"];
  for (const value of invalid) { const before = reads; errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", api: lyraAgain, body: { email: value } }), 400, "invalid"); check.equal(reads, before); }
  for (const body of [{}, { email: null }, { email: 1 }, { email, appId: "horizon" }]) { const before = reads; errorShape(await probe(service, "/v1/cosmic/password/read", { method: "POST", api: lyraAgain, body }), 400, "invalid"); check.equal(reads, before); }
  const beforeQuery = reads; errorShape(await probe(service, "/v1/cosmic/password/status?extra=1", { method: "POST", api: lyraAgain, body: { email } }), 400, "invalid"); check.equal(reads, beforeQuery);
  errorShape(await probe(service, "/v1/cosmic/password/status", { api: lyraAgain }), 405, "method_not_allowed");
  errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", api: lyraAgain, type: "text", raw: "{}" }), 415, "unsupported_media_type");
  errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", api: lyraAgain, type: "json", raw: `{"email":"a@b.c","pad":"${"x".repeat(300000)}"}` }), 413, "too_large");
  errorShape(await probe(service, "/v1/cosmic/password/missing", { method: "POST", api: lyraAgain, body: { email } }), 404, "not_found");
  errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", body: { email } }), 401, "unauthenticated");

  stage = "changes";
  const duplicate = login("https://accounts.example/login", email, cosmicPassword); const duplicateVersion = (await cli.entries.save(duplicate, 0)).version;
  errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", api: horizon, body: { email } }), 409, "conflict");
  errorShape(await probe(service, "/v1/cosmic/password/read", { method: "POST", api: horizon, body: { email } }), 409, "conflict");
  await cli.entries.remove(duplicate.id, duplicateVersion); check.equal((await horizon.cosmic.passwordStatus(email)).state, "available");
  entry.fields.find(field => field.id === "password").value = nextPassword; version = (await cli.entries.save(entry, version)).version;
  const changed = await horizon.cosmic.readPassword(email); check.equal(changed.password === nextPassword, true); check.equal(changed.password === cosmicPassword, false); hide(changed, nextPassword);
  entry.fields.find(field => field.id === "password").value = cosmicPassword; version = (await cli.entries.save(entry, version)).version;
  await horizon.cosmic.passwordStatus(email); await cli.entries.remove(entry.id, version); await rejects(() => horizon.cosmic.readPassword(email), "not_found");
  entry.fields.find(field => field.id === "password").value = cosmicPassword; version = (await cli.entries.save(entry, 0)).version;
  check.equal((await horizon.cosmic.readPassword(email)).password === cosmicPassword, true);

  stage = "delay";
  await cli.lock(); errorShape(await probe(service, "/v1/unlock", { method: "POST", api: horizon, body: { password: wrongPassword } }), 423, "locked");
  const between = await probe(service, "/v1/cosmic/password/status", { method: "POST", api: nebula, body: { email } }); hide(between.text); check.deepEqual(between.value, { state: "locked" });
  const limited = await probe(service, "/v1/unlock", { method: "POST", api: lyraAgain, body: { password: wrongPassword } }); errorShape(limited, 429, "limited"); check.equal(limited.headers["retry-after"], "60");
  now += 31000; await nova.unlock(vaultPassword); check.equal((await nova.cosmic.passwordStatus(email)).state, "available");

  stage = "rate";
  now += 60000;
  for (let index = 0; index < 61; index++) {
    const result = await probe(service, "/v1/cosmic/password/status", { method: "POST", api: horizon, body: { email } });
    if (index < 60) { hide(result.text); check.equal(result.status, 200); check.deepEqual(result.value, { state: "available" }); }
    else { errorShape(result, 429, "rate_limited"); check.equal(result.headers["retry-after"], "60"); }
  }
  for (let index = 0; index < 60; index++) { const result = await probe(service, "/v1/cosmic/password/status", { method: "POST", api: nova, body: { email } }); hide(result.text); check.equal(result.status, 200); }
  errorShape(await probe(service, "/v1/cosmic/password/status", { method: "POST", api: lyraAgain, body: { email } }), 429, "rate_limited");

  stage = "corrupt"; now += 60000;
  const storedEntries = service.vault.store.entries;
  service.vault.store.entries = async () => [{ id: randomUUID(), version: 1, sealed: { iv: Buffer.alloc(12, 7).toString("base64"), data: Buffer.alloc(32, 9).toString("base64") }, chunks: [] }];
  try {
    const corruptStatus = await probe(service, "/v1/cosmic/password/status", { method: "POST", api: nebula, body: { email } });
    check.equal(corruptStatus.value?.state === "none", false); errorShape(corruptStatus, 500, "internal");
    errorShape(await probe(service, "/v1/cosmic/password/read", { method: "POST", api: nebula, body: { email } }), 500, "internal");
  } finally { service.vault.store.entries = storedEntries; }

  stage = "client body";
  const seen = []; globalThis.fetch = (url, init) => { if (String(url).includes("/v1/cosmic/password/")) seen.push(String(init?.body ?? "")); return originalFetch(url, init); };
  try { await host.cosmic.passwordStatus(email); const value = await host.cosmic.readPassword(email); check.equal(value.password === cosmicPassword, true); hide(value, cosmicPassword); }
  finally { globalThis.fetch = originalFetch; }
  check.equal(seen.length === 2 && seen.every(body => body === JSON.stringify({ email })), true);
  check.equal(seen.some(body => secrets.some(secret => secret !== email && body.includes(secret))), false);

  stage = "idle";
  let idleNow = 1_800_000_000_000; const idle = await startService({ home: join(scratch, "idle"), now: () => idleNow, idleMs: 5000, presenceMs: 1e12 }); services.push(idle);
  const idleCli = await as("vault-cli", "cosmic", idle.home), idleHorizon = await as("horizon", "cosmic", idle.home);
  const idleCreated = await idleCli.create(vaultPassword); secrets.push(idleCreated.recovery); await idleCli.entries.save(login("https://accounts.example/account", email, cosmicPassword), 0);
  idleNow += 4999; check.equal((await idleHorizon.cosmic.passwordStatus(email)).state, "available"); idleNow += 1; check.equal((await idleHorizon.cosmic.passwordStatus(email)).state, "locked");
  await idleHorizon.unlock(vaultPassword); const failedAt = idleNow; idleNow = failedAt + 4999; await rejects(() => idleHorizon.cosmic.readPassword(otherEmail), "not_found"); idleNow = failedAt + 5000; check.equal((await idleHorizon.cosmic.passwordStatus(email)).state, "locked");
  await idleHorizon.unlock(vaultPassword); const readAt = idleNow; idleNow = readAt + 4999; const extended = await idleHorizon.cosmic.readPassword(email); check.equal(extended.password === cosmicPassword, true); hide(extended, cosmicPassword);
  idleNow = readAt + 9998; check.equal((await idleHorizon.cosmic.passwordStatus(email)).state, "available"); idleNow = readAt + 9999; check.equal((await idleHorizon.cosmic.passwordStatus(email)).state, "locked");
  await idleHorizon.unlock(vaultPassword); const heldIdle = arm(idle); const idleRead = idleHorizon.cosmic.readPassword(email); await until(heldIdle.opened, "entries_not_called"); idleNow += 5000; heldIdle.stop(); await withheld(idleRead, ["locked"]);

  stage = "adverse";
  now += 60000; const adverse = service;
  await horizon.unlock(vaultPassword);
  let held = arm(adverse); let reading = horizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called"); adverse.vault.auth.lock(); held.stop(); await withheld(reading, ["locked"]);
  await horizon.unlock(vaultPassword); held = arm(adverse); reading = horizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called"); adverse.vault.auth.lock(); await adverse.vault.auth.unlock(vaultPassword); held.stop(); await withheld(reading, ["locked"]);
  const alone = await startService({ home: join(scratch, "alone"), now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(alone);
  const aloneCli = await as("vault-cli", "cosmic", alone.home), aloneHorizon = await as("horizon", "cosmic", alone.home);
  const aloneCreated = await aloneCli.create(vaultPassword); secrets.push(aloneCreated.recovery); await aloneCli.entries.save(login("https://accounts.example/account", email, cosmicPassword), 0); await aloneCli.close();
  held = arm(alone); reading = aloneHorizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called"); await aloneHorizon.close(); held.stop(); await withheld(reading, ["locked", "unavailable", "not_present", "closed"]);
  await horizon.unlock(vaultPassword); held = arm(adverse); reading = horizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called"); await adverse.apps.setStatus("horizon", "revoked"); held.stop(); await withheld(reading, ["revoked"]);
  await cli.apps.allow("horizon"); await horizon.present(); await horizon.unlock(vaultPassword);
  const originalPulse = adverse.sync.pulse.bind(adverse.sync), originalSave = adverse.vault.store.save.bind(adverse.vault.store); let pulsed = false, saved = false;
  adverse.sync.pulse = async () => { pulsed = true; throw new ServiceError("unavailable", 503); }; adverse.vault.store.save = async (...args) => { saved = true; return originalSave(...args); };
  try {
    held = arm(adverse); reading = horizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called");
    const queuedNote = newEntry("note"); queuedNote.title = "Queued"; const syncing = cli.sync.now().catch(error => error), writing = cli.entries.save(queuedNote, 0).catch(error => error);
    await pause(200); check.equal(pulsed, false); check.equal(saved, false); held.stop();
    const queuedValue = await reading; check.equal(queuedValue.password === cosmicPassword, true); hide(queuedValue, cosmicPassword); await syncing; await writing; check.equal(pulsed, true); check.equal(saved, true);
  } finally { adverse.sync.pulse = originalPulse; adverse.vault.store.save = originalSave; releaseGate(); }
  held = arm(adverse); const surviving = horizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called"); const expired = horizon.cosmic.readPassword(email); await pause(200); now += 30001; held.stop();
  const survived = await surviving; check.equal(survived.password === cosmicPassword, true); hide(survived, cosmicPassword); await withheld(expired, ["busy"]);
  held = arm(adverse); const blocker = horizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called");
  const settled = []; const burst = Array.from({ length: 24 }, () => horizon.cosmic.readPassword(email).then(value => { settled.push({ ok: true, value }); }, error => { settled.push({ ok: false, error }); }));
  const burstDeadline = Date.now() + 2000; while (settled.every(result => result.ok) && Date.now() < burstDeadline) await pause(20);
  held.stop(); await Promise.all(burst); const blocked = await blocker; check.equal(blocked.password === cosmicPassword, true); hide(blocked, cosmicPassword);
  let busy = 0; for (const result of settled) { if (result.ok) { check.equal(result.value.password === cosmicPassword, true); hide(result.value, cosmicPassword); } else { check.equal(result.error instanceof VaultClientError && result.error.code === "busy", true); busy++; } }
  check.equal(busy > 0, true);
  const stoppingHome = join(scratch, "stopping"); const stopping = await startService({ home: stoppingHome, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(stopping);
  const stoppingCli = await as("vault-cli", "cosmic", stoppingHome), stoppingHorizon = await as("horizon", "cosmic", stoppingHome);
  const stoppingCreated = await stoppingCli.create(vaultPassword); secrets.push(stoppingCreated.recovery); await stoppingCli.entries.save(login("https://accounts.example/account", email, cosmicPassword), 0);
  held = arm(stopping); reading = stoppingHorizon.cosmic.readPassword(email); await until(held.opened, "entries_not_called"); const closing = stopping.shutdown(); held.stop(); await withheld(reading, ["locked", "unavailable", "busy"]); await closing;

  stage = "old and malformed";
  const old = await startService({ home: join(scratch, "old"), now: () => now, idleMs: 1e12, presenceMs: 1e12, routes: routes.filter(route => !route.path.startsWith("/v1/cosmic/password/")) }); services.push(old);
  const oldClient = await as("horizon", "cosmic", old.home); await rejects(() => oldClient.cosmic.passwordStatus(email), "not_found"); await rejects(() => oldClient.cosmic.readPassword(email), "not_found");
  const malformedRoutes = routes.map(route => {
    if (route.path === "/v1/cosmic/password/status") return { ...route, handle: c => c.body.email === "extra@example.invalid" ? { state: "none", extra: true } : c.body.email === "bad@example.invalid" ? { state: "nope" } : c.body.email === "list@example.invalid" ? ["none"] : { state: "locked" } };
    if (route.path === "/v1/cosmic/password/read") return { ...route, handle: c => { c.vault.cosmicTicket = c.vault.memory.ticket(); return c.body.email === "extra@example.invalid" ? { password: "synthetic", state: "none" } : c.body.email === "type@example.invalid" ? { password: 1 } : { password: "synthetic" }; } };
    return route;
  });
  const malformed = await startService({ home: join(scratch, "malformed"), now: () => now, idleMs: 1e12, presenceMs: 1e12, routes: malformedRoutes }); services.push(malformed);
  const malformedCli = await as("vault-cli", "cosmic", malformed.home), malformedHorizon = await as("horizon", "cosmic", malformed.home);
  const malformedCreated = await malformedCli.create(vaultPassword); secrets.push(malformedCreated.recovery); await malformedCli.unlock(vaultPassword);
  check.equal((await malformedHorizon.cosmic.passwordStatus(email)).state, "locked");
  for (const value of ["extra@example.invalid", "bad@example.invalid", "list@example.invalid"]) await rejects(() => malformedHorizon.cosmic.passwordStatus(value), "unavailable");
  await rejects(() => malformedHorizon.cosmic.readPassword("extra@example.invalid"), "unavailable"); await rejects(() => malformedHorizon.cosmic.readPassword("type@example.invalid"), "unavailable");
  const accepted = await malformedHorizon.cosmic.readPassword(email); check.equal(accepted.password === "synthetic", true); check.equal(accepted.password === cosmicPassword, false);

  stage = "spawn";
  const childHome = join(scratch, "child"); process.env.VAULT_QUANTUM_SITE = "http://127.0.0.1:9/account"; const childEnv = serviceEnv(childHome); process.env.VAULT_QUANTUM_SITE = "https://accounts.example/account/";
  let childOut = ""; child = spawn(process.execPath, ["--import", new URL("./privacy-fixture.mjs", import.meta.url).href, fileURLToPath(new URL("../src/main.ts", import.meta.url))], { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", chunk => { childOut += chunk; }); child.stderr.on("data", chunk => { childOut += chunk; });
  let record; const deadline = Date.now() + 8000; while (Date.now() < deadline && child.exitCode === null) { record = await findService(childHome, 200); if (record) break; await pause(50); }
  hide(childOut); check.equal(Boolean(record), true);
  const childCli = await as("vault-cli", "cosmic", childHome), childHorizon = await as("horizon", "cosmic", childHome);
  const childCreated = await childCli.create(vaultPassword); secrets.push(childCreated.recovery); await childCli.entries.save(login("http://127.0.0.1:9/login", email, cosmicPassword), 0);
  check.equal((await childHorizon.cosmic.passwordStatus(email)).state, "available"); const childValue = await childHorizon.cosmic.readPassword(email); check.equal(childValue.password === cosmicPassword, true); hide(childValue, cosmicPassword); hide(childOut);
  await childCli.close(); await childHorizon.close(); child.kill(); await Promise.race([new Promise(resolve => child.once("exit", resolve)), pause(1000)]);

  stage = "logs";
  for (const folder of [home, idle.home, alone.home, stoppingHome, old.home, malformed.home, childHome]) { const text = await readFile(join(folder, "logs", "events.jsonl"), "utf8"); hide(text); check.equal(text.includes(email), false); }
  const mainLog = await readFile(join(home, "logs", "events.jsonl"), "utf8"); check.equal(mainLog.includes("cosmic_password_status") && mainLog.includes("cosmic_password_read"), true);
  const logPath = join(home, "logs", "events.jsonl"); await rm(logPath); await mkdir(logPath);
  try { const failed = await probe(service, "/v1/cosmic/password/read", { method: "POST", api: host, body: { email } }); hide(failed.text); errorShape(failed, 503, "unavailable"); }
  finally { await rm(logPath, { recursive: true, force: true }); }
  hide(output.join("")); console.log(`Vault cosmic password: ${checks} checks passed.`);
} catch (error) {
  const leaked = secrets.some(secret => secret && output.join("").includes(secret));
  console.error(`Vault cosmic password failed at ${stage}: ${leaked ? "leak" : error instanceof VaultClientError || error instanceof ServiceError ? error.code : "assertion"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*cosmic-password\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  throw new Error("cosmic password check failed");
} finally {
  releaseGate(); globalThis.fetch = originalFetch; process.stdout.write = writeOut; process.stderr.write = writeErr;
  if (child && child.exitCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once("exit", resolve)), pause(1000)]); if (child.exitCode === null) child.kill(); }
  for (const client of clients) await client.close().catch(() => undefined);
  for (const service of services) await service.shutdown().catch(() => undefined);
  if (savedSite === undefined) delete process.env.VAULT_QUANTUM_SITE; else process.env.VAULT_QUANTUM_SITE = savedSite;
  assert.equal(resolve(scratch).startsWith(parent), true); await rm(scratch, { recursive: true, force: true });
}
