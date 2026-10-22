import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { mkdtemp, readdir, readFile, writeFile, rm, stat, cp } from "node:fs/promises";
import { startService } from "../src/server.ts";
import { QuantumTransport } from "../src/quantum.ts";
import { connect } from "../../client/dist/index.js";
import { newEntry, encrypt, decrypt } from "vault-core";

const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-quantum-")), services = [], clients = [], password = "Synthetic Quantum master password", hidden = [password];
let checks = 0, stage = "fake Quantum", now = Date.now();
const reject = (run, code) => assert.rejects(run, error => error?.code === code);
const tokens = () => { let token; return { async get() { return token; }, async set(value) { token = value; } }; };
const make = async name => { const home = join(scratch, name), service = await startService({ home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(service); const api = await connect({ home, app: { id: "vault-app", name: "Synthetic Quantum app", kind: "cosmic" }, tokens: tokens() }); clients.push(api); return { home, service, api }; };
const state = async v => JSON.parse(await readFile(join(v.home, "sync", "state.json"), "utf8"));
const secret = async v => JSON.parse(await readFile(join(v.home, "secrets", "quantum.json"), "utf8"));
const key = v => v.service.vault.memory.get(v.service.vault.memory.ticket());
const sync = async v => { now++; return v.api.sync.now(); };
const equal = async (a, b) => { const rows = async v => (await v.api.entries.list()).map(row => row.entry).sort((a, b) => a.id.localeCompare(b.id)); assert.deepEqual(await rows(a), await rows(b)); checks++; };
async function files(root) { const result = []; for (const item of await readdir(root, { withFileTypes: true })) { const path = join(root, item.name); if (item.isDirectory()) result.push(...await files(path)); else result.push(path); } return result; }
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// Tokens and codes remain inside this fixture; only fixed test locations reach output.
async function fakeQuantum() {
  const accounts = new Map(), codes = new Map(), access = new Map(), refresh = new Map(), requests = [], credentials = [];
  const counters = { signin: 0, refresh: 0, revoke: 0, pages: 0, usage: 0, foreign: 0, busy: 0 }, controls = { busy: 0, unavailable: false, badHash: false, lostDatasetResponse: 0, postCreateListingFailure: 0, objectWriteFailure: 0 };
  const account = email => { if (!accounts.has(email)) accounts.set(email, { email, datasets: new Map(), plan: true, full: false, refuseRefresh: false }); return accounts.get(email); };
  const opaque = () => { const value = randomBytes(32).toString("base64url"); credentials.push(value); return value; };
  const pair = chain => { const accessToken = opaque(), refreshToken = opaque(); access.set(accessToken, { chain, expired: false }); refresh.set(refreshToken, { chain, used: false }); return { accessToken, refreshToken, tokenType: "Bearer", expiresIn: 900, deviceId: chain.registration }; };
  const json = (res, code, value) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const error = (res, status, code) => json(res, status, { error: { code, message: "Synthetic Quantum failure", fields: {}, requestId: randomUUID() } });
  const body = async req => { const parts = []; for await (const part of req) parts.push(part); return Buffer.concat(parts); };
  const server = createServer((req, res) => { void (async () => {
    const url = new URL(req.url, "http://127.0.0.1"), path = url.pathname, method = req.method;
    if (path === "/v1/oauth/token" && method === "POST") {
      const input = JSON.parse((await body(req)).toString()); if (input.appId !== "vault") return error(res, 400, "invalid_request");
      if (input.grantType === "authorization_code") {
        credentials.push(input.codeVerifier);
        const issued = codes.get(input.code); codes.delete(input.code);
        if (!issued || issued.until < Date.now() || issued.redirect !== input.redirectUri || createHash("sha256").update(input.codeVerifier).digest("base64url") !== issued.challenge) return error(res, 400, "invalid_grant");
        return json(res, 200, pair({ account: account(issued.email), computer: issued.computer, registration: randomUUID(), revoked: false }));
      }
      if (input.grantType === "refresh_token") {
        counters.refresh++; const previous = refresh.get(input.refreshToken);
        if (!previous) return error(res, 400, "invalid_grant");
        if (previous.used) previous.chain.revoked = true;
        if (previous.used || previous.chain.revoked || previous.chain.account.refuseRefresh) return error(res, 400, "invalid_grant");
        previous.used = true; return json(res, 200, pair(previous.chain));
      }
      return error(res, 400, "invalid_request");
    }
    const raw = String(req.headers.authorization ?? "").replace(/^Bearer /, ""), token = access.get(raw);
    if (!token || token.expired || token.chain.revoked) return error(res, 401, "unauthorized");
    const chain = token.chain, owner = chain.account; requests.push({ method, path, computer: chain.computer });
    if (path === "/v1/oauth/revoke" && method === "POST") { chain.revoked = true; counters.revoke++; return json(res, 200, { success: true }); }
    if (path === "/v1/me" && method === "GET") return json(res, 200, { email: owner.email });
    if (path === "/v1/usage" && method === "GET") { counters.usage++; return json(res, 200, { poolBytes: 100000000, usedBytes: [...owner.datasets.values()].reduce((sum, dataset) => sum + [...dataset.values()].reduce((size, row) => size + row.bytes.length, 0), 0) }); }
    if (controls.unavailable) return error(res, 503, "storage_unavailable");
    if (controls.busy > 0) { controls.busy--; counters.busy++; res.setHeader("Retry-After", "0.01"); return error(res, 429, "rate_limited"); }
    if (!owner.plan) return error(res, 403, "sync_plan_required");
    if (path === "/v1/datasets" && method === "GET") {
      const all = [...owner.datasets.keys()].sort().filter(id => !url.searchParams.get("after") || id > url.searchParams.get("after")), page = all.slice(0, Math.min(2, Number(url.searchParams.get("limit") ?? 1000)));
      return json(res, 200, { datasets: page.map(id => ({ id, appId: "vault", createdAt: new Date(0).toISOString() })), after: all.length > page.length ? page.at(-1) : null });
    }
    const match = /^\/v1\/datasets\/([^/]+)(?:\/objects(?:\/(.*))?)?$/.exec(path);
    if (!match) return error(res, 404, "not_found"); const id = decodeURIComponent(match[1]);
    if (!path.includes("/objects") && method === "PUT") { const exists = owner.datasets.has(id); if (!exists) owner.datasets.set(id, new Map()); if (controls.postCreateListingFailure > 0) { controls.postCreateListingFailure--; owner.failListing = true; } if (controls.lostDatasetResponse > 0) { controls.lostDatasetResponse--; return res.destroy(); } return json(res, exists ? 200 : 201, { id, appId: "vault", createdAt: new Date(0).toISOString() }); }
    const dataset = owner.datasets.get(id); if (!dataset) return error(res, 404, "not_found");
    if (match[2] === undefined && method === "GET") {
      if (owner.failListing) { owner.failListing = false; return error(res, 503, "storage_unavailable"); }
      const prefix = url.searchParams.get("prefix") ?? "", after = url.searchParams.get("after"), all = [...dataset.keys()].sort().filter(name => name.startsWith(prefix) && (!after || name > after)), page = all.slice(0, Math.min(2, Number(url.searchParams.get("limit") ?? 1000)));
      if (after) counters.pages++; return json(res, 200, { objects: page.map(path => { const row = dataset.get(path); return { path, size: row.bytes.length, sha256: digest(row.bytes), createdAt: new Date(0).toISOString() }; }), after: all.length > page.length ? page.at(-1) : null });
    }
    const name = decodeURIComponent(match[2] ?? ""), previous = dataset.get(name);
    if (["PUT", "DELETE"].includes(method) && name.startsWith("writers/") && name.split("/")[1] !== chain.computer) { counters.foreign++; return error(res, 403, "writer_forbidden"); }
    if (method === "GET") { if (!previous) return error(res, 404, "not_found"); res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": previous.bytes.length, "X-Content-SHA256": controls.badHash ? "0".repeat(64) : digest(previous.bytes) }); return res.end(previous.bytes); }
    if (method === "PUT") {
      const bytes = await body(req); if (req.headers["content-type"] !== "application/octet-stream" || Number(req.headers["content-length"]) !== bytes.length || req.headers["x-content-sha256"] !== digest(bytes)) return error(res, 400, "invalid_request");
      if (controls.objectWriteFailure > 0) { controls.objectWriteFailure--; return error(res, 503, "storage_unavailable"); }
      if (bytes.length > (name.includes("/blobs/") ? 64 * 1024 : 8 * 1024 * 1024)) return error(res, 413, "object_too_large");
      if (previous) return previous.bytes.equals(bytes) ? json(res, 200, { success: true }) : error(res, 409, "object_conflict");
      if (owner.full) return error(res, 409, "pool_exceeded");
      const own = [...dataset.keys()].filter(path => path.startsWith(`writers/${chain.computer}/`)).map(path => path.split("/")[2]); if (name.startsWith("writers/") && !own.includes(name.split("/")[2]) && new Set(own).size >= 64) return error(res, 409, "writer_limit_exceeded");
      dataset.set(name, { bytes: Buffer.from(bytes) }); return json(res, 201, { success: true });
    }
    if (method === "DELETE") { if (!previous) return error(res, 404, "not_found"); dataset.delete(name); return json(res, 200, { success: true }); }
    return error(res, 404, "not_found");
  })().catch(() => { if (!res.headersSent) error(res, 500, "storage_unavailable"); else res.destroy(); }); });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const api = `http://127.0.0.1:${server.address().port}`;
  return {
    api, account, counters, controls, requests, credentials,
    issue(url, email) { counters.signin++; const authorize = new URL(url), redirect = authorize.searchParams.get("redirectUri"), challenge = authorize.searchParams.get("codeChallenge"), computer = authorize.searchParams.get("computerId"), code = opaque(); assert.equal(authorize.origin, api); assert.equal(authorize.pathname, "/authorize"); assert.equal(authorize.searchParams.get("appId"), "vault"); assert.equal(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/callback$/.test(redirect), true); assert.equal(/^[A-Za-z0-9_-]{43}$/.test(challenge), true); assert.equal(Boolean(computer), true); assert.equal((authorize.searchParams.get("deviceName") ?? "").length <= 128, true); codes.set(code, { email, redirect, challenge, computer, until: Date.now() + 60000 }); const callback = new URL(redirect); callback.searchParams.set("code", code); return { callback, computer }; },
    expire(email) { for (const token of access.values()) if (token.chain.account.email === email) token.expired = true; },
    bearer(computer) { return [...access].findLast(([, token]) => token.chain.computer === computer && !token.expired && !token.chain.revoked)?.[0]; },
    async close() { server.closeAllConnections(); await new Promise(done => server.close(done)); },
  };
}

const quantum = await fakeQuantum();
async function signIn(v, email = "synthetic@cosmic.invalid", language = "en") {
  await v.api.settings.set({ ...await v.api.settings.get(), language });
  const started = await v.api.sync.quantum.signIn(quantum.api, quantum.api), issued = quantum.issue(started.url, email), wrong = new URL(issued.callback); wrong.pathname = "/unrelated"; wrong.search = "";
  assert.equal((await fetch(wrong)).status, 404); const response = await fetch(issued.callback), html = await response.text(); assert.equal(response.ok, true); assert.equal(html.includes(language === "es" ? "Vault inició sesión. Se puede cerrar esta ventana." : "Vault is signed in. This window can be closed."), true); assert.deepEqual(await v.api.sync.quantum.wait(started.id), { account: email }); checks += 4;
  return issued.computer;
}

try {
  stage = "sign-in and encrypted setup";
  const a = await make("a"), b = await make("b"), kit = await a.api.create(password), entry = newEntry("note"); entry.title = "synthetic-private-Quantum-title"; entry.note = "synthetic-private-Quantum-note"; hidden.push(entry.title, entry.note, kit.recovery);
  const chunkId = randomUUID(), chunk = Buffer.from("synthetic-private-Quantum-attachment"); entry.files = [{ id: randomUUID(), name: "synthetic-private-Quantum-file", type: "application/octet-stream", size: chunk.length, chunks: [chunkId] }]; hidden.push(chunk.toString(), entry.files[0].name);
  await a.service.vault.store.putChunk(chunkId, await encrypt(key(a), Uint8Array.from(chunk), `chunk:${chunkId}`)); await a.api.entries.save(entry, 0);
  await reject(() => a.api.sync.setupQuantum(), "sync_signin_required"); checks++;
  const computerA = await signIn(a), storedA = await secret(a); assert.equal(storedA.deviceId === computerA, true); assert.equal(typeof storedA.refreshToken === "string", true); assert.equal(Object.hasOwn(storedA, "accessToken"), false); if (process.platform !== "win32") assert.equal((await stat(join(a.home, "secrets", "quantum.json"))).mode & 0o777, 0o600); checks += 3;
  await a.api.sync.setupQuantum(); const headerA = await state(a), statusA = await a.api.sync.status(); assert.equal(headerA.format, 2); assert.equal(headerA.origin, "quantum"); assert.equal(headerA.folder, ""); assert.equal(headerA.deviceId === computerA, true); assert.deepEqual(headerA.quantum, { api: quantum.api, site: quantum.api, account: "synthetic@cosmic.invalid" }); assert.equal(statusA.origin, "quantum"); assert.equal(statusA.account, "synthetic@cosmic.invalid"); assert.equal(statusA.storage.pool, 100000000); assert.equal(Number.isSafeInteger(statusA.storage.used), true); checks += 9;
  const usageCalls = quantum.counters.usage; await a.api.sync.status(); await a.api.sync.status(); assert.equal(quantum.counters.usage, usageCalls); checks++;
  const computerB = await signIn(b); assert.notEqual(computerA, computerB); await b.api.sync.joinQuantum({ password }); await equal(a, b); const opened = await decrypt(key(b), await b.service.vault.store.getChunk(chunkId), `chunk:${chunkId}`); assert.equal(Buffer.from(opened).equals(chunk), true); opened.fill(0); chunk.fill(0); checks += 2;
  assert.equal(quantum.counters.pages > 0, true); checks++;
  const change = async (v, note) => { const row = await v.api.entries.get(entry.id); row.entry.note = note; hidden.push(note); await v.api.entries.save(row.entry, row.version); };
  await change(a, "synthetic-private-Quantum-edited"); await sync(a); await sync(b); await equal(a, b);
  const remote = quantum.account("synthetic@cosmic.invalid").datasets.get(headerA.datasetId); for (const row of remote.values()) for (const value of hidden) assert.equal(row.bytes.includes(Buffer.from(value)), false); checks++;

  stage = "writer scope and immutable objects";
  const ownPath = [...remote.keys()].find(path => path.startsWith(`writers/${computerA}/`)), bearer = quantum.bearer(computerB), sample = Buffer.from("synthetic-write-scope"), beforeForeign = quantum.counters.foreign;
  const refused = await fetch(`${quantum.api}/v1/datasets/${headerA.datasetId}/objects/${ownPath}`, { method: "PUT", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/octet-stream", "Content-Length": String(sample.length), "X-Content-SHA256": digest(sample) }, body: sample }); assert.equal(refused.status, 403); assert.equal((await refused.json()).error.code, "writer_forbidden"); assert.equal(quantum.counters.foreign, beforeForeign + 1); checks += 3;
  const transport = new QuantumTransport(b.service.sync.quantum, quantum.api, headerA.datasetId, `${computerB}/${(await state(b)).generationId}`), requestCount = quantum.requests.length;
  await reject(() => transport.write(ownPath, "synthetic-refused-write"), "invalid"); await reject(() => transport.remove(ownPath), "invalid"); assert.equal(quantum.requests.length, requestCount); checks += 3;
  const foreignAfterProbe = quantum.counters.foreign; await sync(a); await sync(b); assert.equal(quantum.counters.foreign, foreignAfterProbe); assert.equal(quantum.requests.slice(requestCount).filter(row => ["PUT", "DELETE"].includes(row.method) && row.path.includes("/objects/writers/")).every(row => decodeURIComponent(row.path).split("/objects/writers/")[1].split("/")[0] === row.computer), true); checks += 2;
  const conflict = await fetch(`${quantum.api}/v1/datasets/${headerA.datasetId}/objects/${ownPath}`, { method: "PUT", headers: { Authorization: `Bearer ${quantum.bearer(computerA)}`, "Content-Type": "application/octet-stream", "Content-Length": String(sample.length), "X-Content-SHA256": digest(sample) }, body: sample }); assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error.code, "object_conflict"); sample.fill(0); checks += 2;

  stage = "transport authentication, bounds and retries";
  const ownTransport = new QuantumTransport(a.service.sync.quantum, quantum.api, headerA.datasetId, `${computerA}/${headerA.generationId}`), existing = remote.get(ownPath).bytes.toString(); assert.equal(await ownTransport.write(ownPath, existing), false); await reject(() => ownTransport.write(ownPath, "synthetic-conflict"), "conflict"); await reject(() => ownTransport.read(ownPath, 1), "limited"); checks += 3;
  quantum.controls.badHash = true; try { await reject(() => transport.read(ownPath), "invalid"); } finally { quantum.controls.badHash = false; } checks++;
  const malformed = `writers/${computerA}/${headerA.generationId}/probes/${randomUUID()}.vsync`; remote.set(malformed, { bytes: Buffer.from([0xc3, 0x28]) }); try { await reject(() => ownTransport.read(malformed), "invalid"); } finally { await ownTransport.remove(malformed); } await ownTransport.remove(malformed); checks += 2;
  const absent = new QuantumTransport(a.service.sync.quantum, quantum.api, randomUUID(), `${computerA}/${headerA.generationId}`); assert.deepEqual(await absent.list("", true), []); await reject(() => absent.list(""), "ENOENT"); checks += 2;
  const busyBefore = quantum.counters.busy; quantum.controls.busy = 1; assert.equal(await transport.read(ownPath) === existing, true); assert.equal(quantum.counters.busy, busyBefore + 1); quantum.controls.busy = 2; await reject(() => transport.read(ownPath), "sync_busy"); checks += 3;
  quantum.controls.unavailable = true; try { await reject(() => transport.list(""), "sync_unavailable"); } finally { quantum.controls.unavailable = false; } checks++;

  stage = "refresh rotation and refusal";
  const beforeRefresh = quantum.counters.refresh, previousRefresh = (await secret(a)).refreshToken; quantum.expire("synthetic@cosmic.invalid"); await sync(a); assert.equal(quantum.counters.refresh, beforeRefresh + 1); assert.equal((await secret(a)).refreshToken !== previousRefresh, true); checks += 2;
  quantum.account("synthetic@cosmic.invalid").refuseRefresh = true; quantum.expire("synthetic@cosmic.invalid"); await reject(() => sync(a), "sync_signin_required"); assert.equal((await a.api.sync.status()).failure.cause, "sync_signin_required"); let refusedState; try { refusedState = await secret(a); } catch {} assert.equal(Boolean(refusedState?.refreshToken), false); checks += 3;
  quantum.account("synthetic@cosmic.invalid").refuseRefresh = false; assert.equal(await signIn(a), computerA); await sync(a); await sync(b); await equal(a, b);

  stage = "plan and storage failures";
  quantum.account("synthetic@cosmic.invalid").plan = false; await reject(() => sync(a), "sync_plan_required"); assert.equal((await a.api.sync.status()).failure.cause, "sync_plan_required"); checks += 2;
  quantum.account("synthetic@cosmic.invalid").plan = true; await sync(a); quantum.account("synthetic@cosmic.invalid").full = true; await change(a, "synthetic-private-Quantum-full"); await reject(() => sync(a), "sync_storage_full"); assert.equal((await a.api.sync.status()).failure.cause, "sync_storage_full"); checks += 2;
  quantum.account("synthetic@cosmic.invalid").full = false; await sync(a); await sync(b); await equal(a, b);

  stage = "restored generation retains signed-in computer";
  const beforeGeneration = await state(a), signinCount = quantum.counters.signin; assert.equal(beforeGeneration.sequence > 0, true); await a.api.close(); await a.service.shutdown(); await writeFile(join(a.home, "sync", "state.json"), JSON.stringify({ ...beforeGeneration, sequence: beforeGeneration.sequence - 1 }));
  a.service = await startService({ home: a.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(a.service); a.api = await connect({ home: a.home, app: { id: "vault-app", name: "Synthetic Quantum app", kind: "cosmic" }, tokens: tokens() }); clients.push(a.api); await a.api.unlock(password); await sync(a); const afterGeneration = await state(a); assert.notEqual(afterGeneration.generationId, beforeGeneration.generationId); assert.equal(afterGeneration.deviceId, computerA); assert.equal((await secret(a)).deviceId, computerA); assert.equal(quantum.counters.signin, signinCount); checks += 5;
  await change(a, "synthetic-private-rebuilt-generation"); await sync(a); await sync(b); await equal(a, b);

  stage = "dataset discovery and recovery";
  const duplicate = await make("duplicate"); await duplicate.api.create(password); await signIn(duplicate); await reject(() => duplicate.api.sync.setupQuantum(), "sync_dataset_exists"); checks++;
  const recovered = await make("recovered"); await signIn(recovered); await recovered.api.sync.joinQuantum({ recovery: kit.recovery }); await equal(a, recovered);
  const empty = await make("empty"); await signIn(empty, "empty@cosmic.invalid"); await reject(() => empty.api.sync.joinQuantum({ password }), "sync_dataset"); checks++;
  quantum.account("empty@cosmic.invalid").datasets.set(randomUUID(), new Map()); quantum.account("empty@cosmic.invalid").datasets.set(randomUUID(), new Map()); await reject(() => empty.api.sync.joinQuantum({ password }), "sync_dataset"); checks++;

  stage = "durable Quantum setup retry";
  for (const failure of ["lostDatasetResponse", "postCreateListingFailure"]) {
    const retry = await make(`retry-${failure}`), email = `${failure.toLowerCase()}@cosmic.invalid`, retryEntry = newEntry("note"); retryEntry.title = `synthetic-private-retry-${failure}`; hidden.push(retryEntry.title); await retry.api.create(password); await retry.api.entries.save(retryEntry, 0); await signIn(retry, email); quantum.controls[failure] = 1;
    await reject(() => retry.api.sync.setupQuantum(), "sync_unavailable"); const intent = JSON.parse(await readFile(join(retry.home, "sync", "quantum-setup.json"), "utf8")); assert.equal(quantum.account(email).datasets.size, 1); assert.equal(quantum.account(email).datasets.has(intent.datasetId), true); assert.equal((await retry.api.sync.status()).configured, false); checks += 4;
    if (failure === "lostDatasetResponse") { await retry.api.sync.quantum.signOut(); assert.equal(await signIn(retry, email), intent.deviceId); checks++; }
    await retry.api.close(); await retry.service.shutdown(); retry.service = await startService({ home: retry.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(retry.service); retry.api = await connect({ home: retry.home, app: { id: "vault-app", name: "Synthetic Quantum retry app", kind: "cosmic" }, tokens: tokens() }); clients.push(retry.api); await retry.api.unlock(password); await retry.api.sync.setupQuantum(); assert.equal((await state(retry)).datasetId, intent.datasetId); assert.equal(quantum.account(email).datasets.size, 1); assert.equal((await retry.api.entries.get(retryEntry.id)).entry.title === retryEntry.title, true); await assert.rejects(() => readFile(join(retry.home, "sync", "quantum-setup.json"))); checks += 4;
    await retry.api.close(); await retry.service.shutdown();
  }

  stage = "account change after failed setup";
  const changedAccount = await make("changed-account"), changedEntry = newEntry("note"), previousAccount = "previous-setup@cosmic.invalid", nextAccount = "next-setup@cosmic.invalid"; changedEntry.title = "synthetic-private-account-change-title"; changedEntry.note = "synthetic-private-account-change-note"; hidden.push(changedEntry.title, changedEntry.note); await changedAccount.api.create(password); await changedAccount.api.entries.save(changedEntry, 0); await signIn(changedAccount, previousAccount); quantum.controls.objectWriteFailure = 1;
  await reject(() => changedAccount.api.sync.setupQuantum(), "sync_unavailable"); const previousIntent = JSON.parse(await readFile(join(changedAccount.home, "sync", "quantum-setup.json"), "utf8")), previousDatasets = [...quantum.account(previousAccount).datasets.keys()], previousObjects = [...quantum.account(previousAccount).datasets.get(previousIntent.datasetId)].map(([path, row]) => [path, digest(row.bytes)]); assert.equal((await readdir(join(changedAccount.home, "sync", "outbox"))).length, 1); assert.equal((await changedAccount.api.sync.status()).configured, false); checks += 3;
  await changedAccount.api.sync.quantum.signOut(); await signIn(changedAccount, nextAccount); await changedAccount.api.sync.setupQuantum(); const changedState = await state(changedAccount); assert.equal(changedState.quantum.account, nextAccount); assert.notEqual(changedState.datasetId, previousIntent.datasetId); assert.equal(quantum.account(nextAccount).datasets.has(changedState.datasetId), true); assert.deepEqual((await changedAccount.api.entries.get(changedEntry.id)).entry, changedEntry); assert.deepEqual(await readdir(join(changedAccount.home, "sync", "outbox")), []); await assert.rejects(() => readFile(join(changedAccount.home, "sync", "quantum-setup.json"))); assert.deepEqual([...quantum.account(previousAccount).datasets.keys()], previousDatasets); assert.deepEqual([...quantum.account(previousAccount).datasets.get(previousIntent.datasetId)].map(([path, row]) => [path, digest(row.bytes)]), previousObjects); checks += 8;
  await changedAccount.api.close(); await changedAccount.service.shutdown();

  stage = "folder migration and Quantum switch";
  const switched = await make("switch"), switchPeer = await make("switch-peer"), switchJoin = await make("switch-join"), folder = join(scratch, "shared"), switchEntry = newEntry("note"); switchEntry.title = "synthetic-private-switch-title"; hidden.push(switchEntry.title); await switched.api.create(password); await switched.api.entries.save(switchEntry, 0); await switched.api.sync.setup(folder); await switchPeer.api.sync.join(folder, { password });
  const folderHeader = await state(switched), legacy = { ...folderHeader, format: 1 }; delete legacy.origin; delete legacy.quantum; await writeFile(join(switched.home, "sync", "state.json"), JSON.stringify(legacy)); await switched.api.close(); await switched.service.shutdown(); switched.service = await startService({ home: switched.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(switched.service); switched.api = await connect({ home: switched.home, app: { id: "vault-app", name: "Synthetic Quantum app", kind: "cosmic" }, tokens: tokens() }); clients.push(switched.api); assert.equal((await switched.api.sync.status()).origin, "folder"); await switched.api.unlock(password); await sync(switched); assert.equal((await state(switched)).format, 2); assert.equal((await state(switched)).quantum, null); checks += 3;
  const kept = new Map(); for (const path of await files(folder)) kept.set(path, digest(await readFile(path)));
  await switched.api.settings.set({ ...await switched.api.settings.get(), language: "es" }); await signIn(switched, "switch@cosmic.invalid", "es"); quantum.controls.objectWriteFailure = 1; await reject(() => switched.api.sync.switchToQuantum(), "sync_unavailable"); assert.equal((await switched.api.sync.status()).configured, false); const switchIntent = JSON.parse(await readFile(join(switched.home, "sync", "quantum-setup.json"), "utf8")); assert.equal((await readdir(join(switched.home, "sync", "outbox"))).length, 1); checks += 3;
  await switched.api.sync.setupQuantum(); assert.equal((await state(switched)).datasetId, switchIntent.datasetId); assert.equal(quantum.account("switch@cosmic.invalid").datasets.size, 1); assert.deepEqual(await readdir(join(switched.home, "sync", "outbox")), []); assert.equal((await switched.api.sync.status()).origin, "quantum"); for (const [path, hash] of kept) assert.equal(digest(await readFile(path)), hash); assert.equal((await switched.api.entries.get(switchEntry.id)).entry.title === switchEntry.title, true); checks += 6;
  const switchLocal = await switchPeer.api.entries.get(switchEntry.id), switchRemote = await switched.api.entries.get(switchEntry.id), localOnly = newEntry("note"), remoteOnly = newEntry("note"); switchLocal.entry.note = "synthetic-private-switch-local-edit"; switchRemote.entry.title = "synthetic-private-switch-remote-title"; switchRemote.entry.note = "synthetic-private-switch-remote-edit"; localOnly.title = "synthetic-private-switch-local-only"; remoteOnly.title = "synthetic-private-switch-remote-only"; hidden.push(switchLocal.entry.note, switchRemote.entry.title, switchRemote.entry.note, localOnly.title, remoteOnly.title); await switchPeer.api.entries.save(switchLocal.entry, switchLocal.version); await switchPeer.api.entries.save(localOnly, 0); await switched.api.entries.save(switchRemote.entry, switchRemote.version); await switched.api.entries.save(remoteOnly, 0); await sync(switched);
  await signIn(switchPeer, "switch@cosmic.invalid"); quantum.controls.objectWriteFailure = 1; await reject(() => switchPeer.api.sync.switchToQuantum(), "sync_unavailable"); assert.equal((await switchPeer.api.sync.status()).configured, false); assert.equal((await readdir(join(switchPeer.home, "sync", "outbox"))).length, 1); assert.equal(JSON.parse(await readFile(join(switchPeer.home, "sync", "quantum-switch.json"), "utf8")).origin, "folder"); checks += 4;
  await switchPeer.api.close(); await switchPeer.service.shutdown(); switchPeer.service = await startService({ home: switchPeer.home, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(switchPeer.service); switchPeer.api = await connect({ home: switchPeer.home, app: { id: "vault-app", name: "Synthetic Quantum switch retry app", kind: "cosmic" }, tokens: tokens() }); clients.push(switchPeer.api); await switchPeer.api.unlock(password); await switchPeer.api.sync.switchToQuantum(); await assert.rejects(() => readFile(join(switchPeer.home, "sync", "quantum-switch.json"))); assert.deepEqual(await readdir(join(switchPeer.home, "sync", "outbox")), []); await sync(switched); await equal(switched, switchPeer); assert.equal((await switched.api.entries.get(switchEntry.id)).entry.note === switchLocal.entry.note, true); assert.equal((await switched.api.entries.get(localOnly.id)).entry.title === localOnly.title, true); assert.equal((await switchPeer.api.entries.get(remoteOnly.id)).entry.title === remoteOnly.title, true); checks += 5;
  const remoteDevice = (await state(switched)).deviceId, switchConflict = (await switchPeer.api.sync.conflicts()).find(row => row.title === switchRemote.entry.title && row.deviceId === remoteDevice); assert.equal(Boolean(switchConflict), true); await switchPeer.api.sync.restore(switchConflict.id); assert.equal((await switchPeer.api.entries.get(switchEntry.id)).entry.note === switchRemote.entry.note, true); await sync(switchPeer); await sync(switched); await equal(switched, switchPeer); checks += 2;
  await signIn(switchJoin, "switch@cosmic.invalid"); await switchJoin.api.sync.joinQuantum({ password }); await equal(switched, switchJoin);

  stage = "copied device binding and sign-out";
  const copiedHome = join(scratch, "copied"); await cp(a.home, copiedHome, { recursive: true }); assert.equal(dirname(copiedHome), scratch); await rm(join(copiedHome, "run"), { recursive: true }); const copiedService = await startService({ home: copiedHome, now: () => now, idleMs: 1e12, presenceMs: 1e12 }); services.push(copiedService); const copiedApi = await connect({ home: copiedHome, app: { id: "vault-app", name: "Synthetic copied Quantum app", kind: "cosmic" }, tokens: tokens() }); clients.push(copiedApi); await copiedApi.unlock(password); await reject(() => copiedApi.sync.now(), "sync_signin_required"); assert.notEqual((await state({ home: copiedHome })).deviceId, computerA); assert.equal((await secret({ home: copiedHome })).refreshToken, null); checks += 3;
  await reject(() => a.api.sync.quantum.signOut(), "sync_configured"); checks++; const removeHeader = await state(recovered); remote.set(`writers/${removeHeader.deviceId}/${randomUUID()}/probes/${randomUUID()}.vsync`, { bytes: Buffer.from(remote.get(ownPath).bytes) }); await recovered.api.sync.leave(true); assert.equal([...remote.keys()].some(path => path.startsWith(`writers/${removeHeader.deviceId}/`)), false); assert.equal([...remote.keys()].some(path => path.startsWith(`writers/${computerA}/`)), true); checks += 2;
  const revokes = quantum.counters.revoke; await recovered.api.sync.quantum.signOut(); await assert.rejects(() => readFile(join(recovered.home, "secrets", "quantum.json"))); assert.equal(quantum.counters.revoke, revokes + 1); checks += 2;

  stage = "secret-free sync and logs";
  for (const v of [a, b, switched, switchPeer]) for (const path of [...await files(join(v.home, "sync")), ...await files(join(v.home, "logs"))]) { const content = await readFile(path, "utf8"); for (const value of [...hidden, ...quantum.credentials]) assert.equal(content.includes(value), false); } checks++;
  for (const email of ["synthetic@cosmic.invalid", "switch@cosmic.invalid"]) for (const dataset of quantum.account(email).datasets.values()) for (const row of dataset.values()) for (const value of hidden) assert.equal(row.bytes.includes(Buffer.from(value)), false); checks++;
  console.log(`Vault Quantum sync: ${checks} checks passed.`);
} catch (error) { console.error(`Vault Quantum sync failed at ${stage}: ${typeof error?.code === "string" && /^[A-Za-z_]{1,40}$/.test(error.code) ? error.code : "assertion"}.`); if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*quantum(?:\.test\.mjs|\.ts):\d+:\d+/.test(line)).join("\n")); throw new Error("Quantum sync service check failed"); }
finally { for (const api of clients) await api.close().catch(() => undefined); for (const service of services) await service.shutdown(); await quantum.close(); assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); }
