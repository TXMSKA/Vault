import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { startService } from "../src/server.ts";
import { connect } from "../../client/dist/index.js";
import { newEntry, encrypt, decrypt } from "vault-core";
import { fakeQuantum } from "./fake-quantum.mjs";

const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-quantum-contract-")), services = [], clients = [], password = "Synthetic contract master password", quantum = await fakeQuantum();
let checks = 0, stage = "stable identity";
const tokens = () => { let token; return { async get() { return token; }, async set(value) { token = value; } }; };
const state = async v => JSON.parse(await readFile(join(v.home, "sync", "state.json"), "utf8"));
const secret = async v => JSON.parse(await readFile(join(v.home, "secrets", "quantum.json"), "utf8"));
const reject = (run, code) => assert.rejects(run, error => error?.code === code);
const key = v => v.service.vault.memory.get(v.service.vault.memory.ticket());
const open = async v => { v.service = await startService({ home: v.home, now: () => v.clock, idleMs: 1e12, presenceMs: 1e12 }); services.push(v.service); v.api = await connect({ home: v.home, app: { id: "vault-app", name: "Synthetic Quantum contract app", kind: "cosmic" }, tokens: tokens() }); clients.push(v.api); return v; };
const make = name => open({ home: join(scratch, name), clock: Date.now() });
const close = async v => { await v.api.close(); await v.service.shutdown(); };
const restart = async v => { await close(v); await open(v); await v.api.unlock(password); };
const sync = async v => { v.clock++; return v.api.sync.now(); };
const equal = async (a, b) => { const entries = async v => (await v.api.entries.list()).map(row => row.entry).sort((a, b) => a.id.localeCompare(b.id)); assert.deepEqual(await entries(a), await entries(b)); checks++; };
const add = async (v, title) => { const entry = newEntry("note"); entry.title = `synthetic-contract-${title}`; await v.api.entries.save(entry, 0); return entry; };
const edit = async (v, entry, note) => { const row = await v.api.entries.get(entry.id); row.entry.note = `synthetic-contract-${note}`; await v.api.entries.save(row.entry, row.version); return row.entry; };
const until = async predicate => { const end = performance.now() + 15000; do { if (await predicate()) return; await new Promise(done => setTimeout(done, 100)); } while (performance.now() < end); throw new Error("synthetic_contract_timeout"); };
const signIn = async (v, email) => { const started = await v.api.sync.quantum.signIn(quantum.api, quantum.api), issued = quantum.issue(started.url, email); assert.equal((await fetch(issued.callback)).ok, true); assert.deepEqual(await v.api.sync.quantum.wait(started.id), { account: email }); v.clock = Math.max(v.clock, Date.now()); checks += 2; return issued.computer; };
const changed = (q, before, computer) => q.requests.slice(before).filter(row => row.computer === computer && row.method === "PUT");

try {
  quantum.controls.feedHoldMs = 100;
  const email = "contract@cosmic.invalid", a = await make("a"), b = await make("b"); await a.api.create(password);
  const entries = [];
  for (const kind of ["login", "card", "doc", "note", "key", "custom", "env"]) { const entry = newEntry(kind); entry.title = `synthetic-contract-${kind}`; entry.note = `synthetic-contract-note-${kind}`; entry.fields = [{ id: `SYNTHETIC_${kind.toUpperCase()}`, name: `Synthetic ${kind}`, value: `synthetic-contract-secret-${kind}`, secret: true }]; entries.push(entry); }
  const chunkId = randomUUID(), attached = Buffer.from("synthetic-contract-attachment"), document = entries.find(entry => entry.kind === "doc"); document.files = [{ id: randomUUID(), name: "synthetic-contract-file", type: "application/octet-stream", size: attached.length, chunks: [chunkId] }];
  await a.service.vault.store.putChunk(chunkId, await encrypt(key(a), Uint8Array.from(attached), `chunk:${chunkId}`)); for (const entry of entries) await a.api.entries.save(entry, 0);
  const computer = await signIn(a, email), owner = quantum.account(email); await a.api.sync.setupQuantum();
  assert.equal((await secret(a)).accountId, owner.accountId); assert.equal((await state(a)).quantum.accountId, owner.accountId); checks += 2;
  const bootstrapCalls = quantum.counters.bootstrap, usageCalls = quantum.counters.usage; await a.api.sync.status(); await a.api.sync.status(); assert.equal(quantum.counters.bootstrap, bootstrapCalls); assert.equal(quantum.counters.usage, usageCalls); checks += 2;
  const described = await fetch(`${quantum.api}/v1/bootstrap`, { headers: { Authorization: `Bearer ${quantum.bearer(computer)}` } }); const describedBody = await described.json(); assert.equal(described.status, 200); assert.equal(describedBody.syntheticMetadata, true); assert.equal((await a.api.sync.status()).origin, "quantum"); checks += 3;
  for (const required of [false, true]) { quantum.controls.registrationBetaRequired = required; const legal = await fetch(`${quantum.api}/v1/legal/requirements`, { headers: { Authorization: `Bearer ${quantum.bearer(computer)}` } }); const body = await legal.json(); assert.equal(legal.status, 200); assert.equal(body.registrationBetaRequired, required); assert.equal(body.syntheticMetadata, true); checks += 3; }
  const legalCalls = quantum.counters.legal, legalRows = () => quantum.requests.filter(row => row.path === "/v1/legal/requirements").length, legalSeen = legalRows(); assert.equal(legalCalls, 2); assert.equal(quantum.counters.keys, 0); checks += 2;
  let legalQuiet = legalSeen;

  stage = "0.2.0 Quantum fixture and email adoption";
  await close(a); const legacyState = await state(a), legacySecret = await secret(a); delete legacyState.quantum.accountId; delete legacyState.cursor; delete legacySecret.accountId; assert.equal(Object.keys(legacyState).sort().join(), "binding,checkpoint,computers,conflicts,datasetId,deviceId,failure,folder,format,generationId,index,lastSynced,operations,origin,quantum,sequence"); assert.equal(Object.keys(legacyState.quantum).sort().join(), "account,api,site"); assert.equal(Object.keys(legacySecret).sort().join(), "account,api,deviceId,refreshToken,site"); checks += 3;
  await writeFile(join(a.home, "sync", "state.json"), JSON.stringify(legacyState)); await writeFile(join(a.home, "secrets", "quantum.json"), JSON.stringify(legacySecret)); await open(a);
  assert.equal((await a.api.sync.status()).origin, "quantum"); assert.equal((await secret(a)).accountId, owner.accountId); await a.api.unlock(password); await sync(a); assert.equal((await state(a)).quantum.accountId, owner.accountId); checks += 3;
  // The profile is read with the account snapshot, once a minute, so a new address shows within that minute and not on every status read.
  const nextEmail = "contract-renamed@cosmic.invalid"; quantum.rename(email, nextEmail); assert.equal((await a.api.sync.status()).account, email); a.clock += 60001;
  assert.equal((await a.api.sync.status()).account, nextEmail); assert.equal((await secret(a)).accountId, owner.accountId); assert.equal((await state(a)).quantum.accountId, owner.accountId); await sync(a); checks += 4;

  stage = "two devices, every entry kind and attachments";
  await signIn(b, nextEmail); await b.api.sync.joinQuantum({ password }); await equal(a, b);
  const bytes = await decrypt(key(b), await b.service.vault.store.getChunk(chunkId), `chunk:${chunkId}`); assert.equal(Buffer.from(bytes).equals(attached), true); bytes.fill(0); attached.fill(0); checks++;
  for (const [i, entry] of entries.entries()) await edit(i % 2 ? b : a, entry, `edited-${entry.kind}`); await sync(a); await sync(b); await sync(a); await equal(a, b);
  for (const [i, entry] of entries.entries()) { const device = i % 2 ? a : b, row = await device.api.entries.get(entry.id); await device.api.entries.remove(entry.id, row.version); }
  await sync(a); await sync(b); await sync(a); await equal(a, b); assert.deepEqual(await a.api.entries.list(), []); assert.deepEqual(await b.api.entries.list(), []); checks += 2;

  stage = "plan loss keeps pending changes and reads";
  const planDeleted = await add(a, "plan-deleted"); await sync(a); await sync(b); owner.plan = false; const planDeleteRow = await a.api.entries.get(planDeleted.id); await a.api.entries.remove(planDeleted.id, planDeleteRow.version);
  const local = await add(a, "plan-local"); await a.api.lock(); a.service.checkSync(); owner.plan = true; const remote = await add(b, "plan-remote"); await sync(b); owner.plan = false; a.clock += 60001; await a.api.unlock(password);
  await reject(() => sync(a), "sync_plan_required"); assert.equal((await a.api.entries.get(remote.id)).entry.title, remote.title); assert.equal((await a.api.entries.get(local.id)).entry.title, local.title); assert.equal((await a.api.sync.status()).managedSync, false); assert.equal((await a.api.sync.status()).pending > 0, true); checks += 5;
  await a.api.lock(); a.service.checkSync(); owner.plan = true; const remoteAfterPending = await add(b, "plan-remote-after-pending"); await sync(b); owner.plan = false; await a.api.unlock(password);
  await reject(() => sync(a), "sync_plan_required"); assert.equal((await a.api.entries.get(remoteAfterPending.id)).entry.title, remoteAfterPending.title); assert.equal((await a.api.sync.status()).pending > 0, true); checks += 3;
  owner.plan = true; a.clock += 60001; a.service.checkSync(); await until(async () => (await a.api.sync.status()).pending === 0); await sync(b); await equal(a, b); assert.equal((await a.api.sync.status()).managedSync, true); await reject(() => b.api.entries.get(planDeleted.id), "not_found"); checks += 2;

  stage = "quota refusal keeps pending changes and reads";
  const quotaDeleted = await add(a, "pool-deleted"); await sync(a); await sync(b); owner.full = true; const quotaDeleteRow = await a.api.entries.get(quotaDeleted.id); await a.api.entries.remove(quotaDeleted.id, quotaDeleteRow.version);
  await edit(a, local, "pool-local"); await reject(() => sync(a), "sync_storage_full"); assert.equal((await a.api.sync.status()).pending > 0, true); checks += 2;
  await a.api.lock(); a.service.checkSync(); owner.full = false; const quotaRemote = await add(b, "pool-remote"); await sync(b); owner.full = true; await a.api.unlock(password); await reject(() => sync(a), "sync_storage_full"); assert.equal((await a.api.entries.get(quotaRemote.id)).entry.title, quotaRemote.title); checks += 2;
  owner.full = false; a.clock += 60001; a.service.checkSync(); await until(async () => (await a.api.sync.status()).pending === 0); await sync(b); await equal(a, b); await reject(() => b.api.entries.get(quotaDeleted.id), "not_found"); checks++;

  stage = "tampered and oversized objects apply nothing";
  const objects = owner.datasets.get((await state(a)).datasetId), storeHash = async v => { const hash = createHash("sha256"); for (const name of (await readdir(join(v.home, "store"))).sort()) hash.update(await readFile(join(v.home, "store", name))); return hash.digest("hex"); };
  // A pulse of b that was still running when it locked finishes rewriting the same store files (a `.tmp-` staging file, then the replaced files) for a moment after lock() returns; the reference hash is taken once the store has stood still and holds no staging file.
  await b.api.lock(); let still = 0, seen = ""; await until(async () => { const hash = await storeHash(b), staged = (await readdir(join(b.home, "store"))).some(name => name.startsWith(".tmp-")); still = !staged && hash === seen ? still + 1 : 0; seen = hash; return still >= 3; });
  const stateBefore = await readFile(join(b.home, "sync", "state.json"), "utf8"), hashBefore = await storeHash(b); await edit(a, local, "object-edit"); await sync(a);
  const lastBatch = [...objects.keys()].filter(path => path.startsWith(`writers/${computer}/`) && path.includes("/batches/")).sort((x, y) => Number(x.split("/").at(-1).split("-")[0]) - Number(y.split("/").at(-1).split("-")[0])).at(-1), lastBytes = objects.get(lastBatch).bytes, tampered = JSON.parse(lastBytes.toString()); tampered.sealed.data = `${tampered.sealed.data[0] === "A" ? "B" : "A"}${tampered.sealed.data.slice(1)}`;
  objects.set(lastBatch, { bytes: Buffer.from(JSON.stringify(tampered)) }); await b.api.unlock(password);
  for (const [invalid, code] of [[Buffer.from(JSON.stringify(tampered)), "invalid"], [lastBytes.subarray(0, -12), "invalid"], [Buffer.alloc(8 * 1024 * 1024 + 1, 120), "limited"]]) { objects.set(lastBatch, { bytes: invalid }); await reject(() => sync(b), code); assert.equal(await storeHash(b), hashBefore); assert.equal((await state(b)).index, JSON.parse(stateBefore).index); checks += 3; }
  objects.set(lastBatch, { bytes: lastBytes }); await sync(b); await equal(a, b);

  stage = "acceptance state and policy links";
  await edit(a, local, "acceptance-local"); owner.missingPolicies = [{ id: "terms", version: "2026-10-09", path: "/terms" }]; a.clock += 60001;
  const beforeAcceptance = quantum.requests.length; await reject(() => sync(a), "sync_acceptance_required"); const acceptance = await a.api.sync.status();
  assert.equal(acceptance.failure.cause, "sync_acceptance_required"); assert.deepEqual(acceptance.missingPolicies, [{ ...owner.missingPolicies[0], url: `${quantum.api}/terms` }]); assert.equal(acceptance.pending > 0, true); assert.equal(changed(quantum, beforeAcceptance, computer).length, 0); assert.equal(quantum.requests.slice(beforeAcceptance).some(row => row.computer === computer && row.method === "DELETE"), false); assert.equal((await a.api.entries.get(local.id)).entry.note, "synthetic-contract-acceptance-local"); assert.equal(typeof (await secret(a)).refreshToken, "string"); checks += 8;
  const beforeBeta = quantum.requests.length; owner.missingPolicies = [{ id: "beta", version: "2026-10-26", path: "/beta" }]; a.clock += 60001; await sync(a); assert.equal((await a.api.sync.status()).failure, null); assert.equal((await a.api.sync.status()).missingPolicies[0].url, `${quantum.api}/beta`); assert.equal(changed(quantum, beforeBeta, computer).length > 0, true); checks += 3;
  owner.missingPolicies = []; a.clock += 60001; b.clock += 60001; await sync(a); await sync(b); await equal(a, b); assert.deepEqual((await a.api.sync.status()).missingPolicies, []); checks++;

  stage = "privacy acceptance keeps local edits until the server reports acceptance";
  const privacy = { id: "privacy", version: "2026-11-06", path: "/privacy" }; await edit(a, local, "privacy-local"); owner.missingPolicies = [privacy]; a.clock += 60001;
  const beforePrivacy = quantum.requests.length, privacyToken = (await secret(a)).refreshToken; await reject(() => sync(a), "sync_acceptance_required"); const privacyStatus = await a.api.sync.status();
  assert.equal(privacyStatus.failure.cause, "sync_acceptance_required"); assert.deepEqual(privacyStatus.missingPolicies, [{ ...privacy, url: `${quantum.api}/privacy` }]); assert.equal(changed(quantum, beforePrivacy, computer).length, 0); assert.equal(quantum.requests.slice(beforePrivacy).some(row => row.computer === computer && row.method === "DELETE"), false); assert.equal((await a.api.entries.get(local.id)).entry.note, "synthetic-contract-privacy-local"); assert.equal((await secret(a)).refreshToken, privacyToken); assert.equal(legalRows(), legalSeen); checks += 7;
  const previousSite = process.env.VAULT_QUANTUM_SITE, savedSettings = await a.api.settings.get(); process.env.VAULT_QUANTUM_SITE = "https://other.example.invalid";
  let english, flow;
  try {
    await a.api.settings.set({ ...savedSettings, language: "en" }); english = await a.api.sync.quantum.acceptance(); const opened = new URL(english.url);
    assert.equal(opened.origin, quantum.api); assert.equal(opened.pathname, "/"); assert.equal(opened.search, ""); assert.equal(opened.href.includes("authorize"), false); checks += 4;
    await a.api.settings.set({ ...savedSettings, language: "es" }); flow = await a.api.sync.quantum.acceptance(); const spanish = new URL(flow.url);
    assert.equal(spanish.origin, quantum.api); assert.equal(spanish.pathname, "/es/"); assert.equal(spanish.search, ""); assert.equal(spanish.href.includes("authorize"), false); checks += 4;
  } finally { if (previousSite === undefined) delete process.env.VAULT_QUANTUM_SITE; else process.env.VAULT_QUANTUM_SITE = previousSite; await a.api.settings.set(savedSettings); }
  await reject(() => a.api.sync.quantum.poll(english.id), "cancelled"); checks++;
  const bound = await state(a), token = (await secret(a)).refreshToken, signins = quantum.counters.signin, beforePoll = quantum.requests.length, legalAt = legalRows();
  assert.deepEqual(await a.api.sync.quantum.poll(flow.id), { pending: true }); assert.equal(legalRows(), legalAt + 1); assert.equal(quantum.requests.slice(beforePoll).some(row => row.path === "/v1/legal/requirements" && row.computer === computer), true); checks += 3;
  assert.equal((await secret(a)).refreshToken, token); assert.equal(quantum.counters.signin, signins); assert.equal((await state(a)).quantum.accountId, bound.quantum.accountId); assert.equal((await state(a)).datasetId, bound.datasetId); assert.equal((await state(a)).cursor, bound.cursor); assert.equal((await state(a)).binding, bound.binding); assert.equal(quantum.requests.slice(beforePoll).some(row => row.method === "DELETE"), false); assert.equal((await a.api.entries.get(local.id)).entry.note, "synthetic-contract-privacy-local"); assert.equal(quantum.account("contract-privacy-other@cosmic.invalid").datasets.size, 0); checks += 9;
  await reject(() => a.api.sync.quantum.poll(flow.id, AbortSignal.timeout(200)), "cancelled"); assert.equal(legalRows(), legalAt + 1); a.clock += 2000; owner.missingPolicies = [{ ...privacy, version: "2026-11-07" }];
  assert.deepEqual(await a.api.sync.quantum.poll(flow.id), { pending: true }); assert.equal(legalRows(), legalAt + 2); assert.equal((await secret(a)).refreshToken, token); checks += 4;
  a.clock += 2000; quantum.controls.legalRetryAfter = new Date(Date.now() + 4000).toUTCString(); const dated = legalRows(); assert.deepEqual(await a.api.sync.quantum.poll(flow.id), { pending: true }); assert.equal(legalRows(), dated + 1); quantum.controls.legalRetryAfter = null; a.clock += 2000;
  await reject(() => a.api.sync.quantum.poll(flow.id, AbortSignal.timeout(200)), "cancelled"); assert.equal(legalRows(), dated + 1); a.clock += 2000; assert.deepEqual(await a.api.sync.quantum.poll(flow.id), { pending: true }); assert.equal(legalRows(), dated + 2); checks += 6;
  a.clock += 2000; let releaseBlock = () => {}; quantum.counters.legalMax = 0; const overlapAt = legalRows();
  try {
    quantum.controls.legalBlock = new Promise(resolve => { releaseBlock = resolve; }); const first = a.api.sync.quantum.poll(flow.id), second = a.api.sync.quantum.poll(flow.id);
    await until(() => quantum.counters.legalInflight === 1); await new Promise(done => setTimeout(done, 100)); assert.equal(quantum.counters.legalMax, 1); assert.equal(legalRows(), overlapAt + 1); releaseBlock();
    assert.deepEqual(await first, { pending: true }); assert.deepEqual(await second, { pending: true }); assert.equal(legalRows(), overlapAt + 1); checks += 5;
  } finally { releaseBlock(); quantum.controls.legalBlock = null; }
  a.clock += 2000; const aborting = new AbortController(); let releaseAbort = () => {};
  try {
    quantum.controls.legalBlock = new Promise(resolve => { releaseAbort = resolve; }); const aborted = a.api.sync.quantum.poll(flow.id, aborting.signal);
    await until(() => quantum.counters.legalInflight === 1); aborting.abort(); await reject(() => aborted, "cancelled"); checks++;
  } finally { releaseAbort(); quantum.controls.legalBlock = null; }
  await until(() => quantum.counters.legalInflight === 0); a.clock += 2000; assert.deepEqual(await a.api.sync.quantum.poll(flow.id), { pending: true }); assert.equal((await secret(a)).refreshToken, token); checks += 2;
  a.clock += 2000; owner.missingPolicies = [{ id: "privacy", version: "2026-11-06", path: "/privacy", extra: "synthetic" }]; assert.deepEqual(await a.api.sync.quantum.poll(flow.id), { pending: true }); assert.equal((await secret(a)).refreshToken, token); owner.missingPolicies = [privacy]; checks += 2;
  const replacement = await a.api.sync.quantum.acceptance(); await reject(() => a.api.sync.quantum.poll(flow.id), "cancelled"); await reject(() => a.api.sync.quantum.wait(randomUUID()), "sync_signin_failed");
  assert.deepEqual(await a.api.sync.quantum.cancelAcceptance(flow.id), { ok: true }); await reject(() => a.api.sync.quantum.cancelAcceptance(randomUUID()), "not_found"); checks += 4;
  const stranger = await connect({ home: a.home, app: { id: "vault-cli", name: "Synthetic Quantum contract CLI", kind: "cosmic" }, tokens: tokens() }); clients.push(stranger);
  await reject(() => stranger.sync.quantum.cancelAcceptance(replacement.id), "not_found"); assert.deepEqual(await a.api.sync.quantum.poll(replacement.id), { pending: true }); checks += 2;
  const beta = { id: "beta", version: "2026-10-26", path: "/beta" }, beforePublish = quantum.requests.length; owner.missingPolicies = [beta]; a.clock += 2000;
  assert.deepEqual(await a.api.sync.quantum.poll(replacement.id), { account: (await secret(a)).account });
  await until(() => changed(quantum, beforePublish, computer).length > 0).catch(async () => { a.clock += 60001; await sync(a); });
  const resumedStatus = await a.api.sync.status(); assert.equal(resumedStatus.failure, null); assert.equal(resumedStatus.missingPolicies.some(policy => policy.id === "beta"), true); assert.equal(resumedStatus.missingPolicies.some(policy => policy.id === "privacy" || policy.id === "terms"), false); assert.equal(changed(quantum, beforePublish, computer).length > 0, true); assert.equal((await secret(a)).refreshToken, token); checks += 6;
  owner.missingPolicies = []; a.clock += 60001; await sync(a); await edit(a, local, "authoritative-local"); owner.missingPolicies = [privacy]; await reject(() => sync(a), "sync_acceptance_required");
  const terms = { id: "terms", version: "2026-10-09", path: "/terms" }; owner.missingPolicies = [terms]; const authoritative = await a.api.sync.quantum.acceptance();
  assert.deepEqual(await a.api.sync.quantum.poll(authoritative.id), { account: (await secret(a)).account }); const afterTerms = await a.api.sync.status(); assert.equal(afterTerms.missingPolicies.some(policy => policy.id === "terms"), true); assert.equal((await secret(a)).refreshToken, token); checks += 3;
  owner.missingPolicies = [privacy]; a.clock += 60001; await reject(() => sync(a), "sync_acceptance_required"); const expiring = await a.api.sync.quantum.acceptance(); a.clock += 300001; await reject(() => a.api.sync.quantum.poll(expiring.id), "expired"); await a.api.unlock(password); checks++;
  owner.missingPolicies = [beta]; a.clock += 60001; assert.equal((await a.api.sync.status()).failure, null); await reject(() => a.api.sync.quantum.acceptance(), "invalid"); checks += 2;
  owner.missingPolicies = []; quantum.controls.legalBlock = null; quantum.controls.legalRetryAfter = null; quantum.controls.legalFailure = 0; a.clock += 60001; b.clock += 60001; await sync(a); await sync(b); await equal(a, b); assert.equal((await a.api.sync.status()).failure, null); legalQuiet = legalRows(); checks++;

  stage = "acceptance needs the current account and pending policies block the first setup";
  const absent = await make("acceptance-absent"); await absent.api.create(password); await reject(() => absent.api.sync.quantum.acceptance(), "sync_signin_required"); const absentFolder = join(scratch, "acceptance-folder"); await absent.api.sync.setup(absentFolder); await reject(() => absent.api.sync.quantum.acceptance(), "sync_signin_required"); assert.equal((await absent.api.sync.status()).origin, "folder"); checks += 3; await close(absent);
  const earlyEmail = "contract-privacy-early@cosmic.invalid", earlyOwner = quantum.account(earlyEmail), early = await make("privacy-early"); earlyOwner.missingPolicies = [privacy]; await early.api.create(password); const earlyEntry = await add(early, "early-local"); await signIn(early, earlyEmail);
  assert.equal(typeof (await secret(early)).refreshToken, "string"); assert.equal((await early.api.sync.status()).missingPolicies[0].version, privacy.version); const beforeEarly = quantum.requests.length; await reject(() => early.api.sync.setupQuantum(), "sync_acceptance_required");
  assert.equal(earlyOwner.datasets.size, 0); assert.equal(quantum.requests.slice(beforeEarly).some(row => ["PUT", "DELETE"].includes(row.method)), false); assert.equal((await early.api.entries.get(earlyEntry.id)).entry.title, earlyEntry.title); assert.equal((await early.api.sync.status()).configured, false); checks += 6;
  earlyOwner.missingPolicies = []; early.clock += 60001; await early.api.sync.setupQuantum(); assert.equal(earlyOwner.datasets.size, 1); checks++; await close(early);
  for (const [label, row] of [["path", { id: "privacy", version: "2026-11-06", path: "/\\privacy" }], ["shape", { id: "privacy", version: "2026-11-06", path: "/privacy", extra: "synthetic" }]]) { owner.missingPolicies = [row]; a.clock += 60001; const beforeBad = quantum.requests.length; const bad = await a.api.sync.status(); assert.equal(bad.failure.cause, "invalid", label); assert.equal((bad.missingPolicies ?? []).some(policy => String(policy.path).includes("\\") || policy.extra), false); assert.equal(quantum.requests.slice(beforeBad).some(row => row.computer === computer && ["PUT", "DELETE"].includes(row.method)), false); assert.equal(typeof (await secret(a)).refreshToken, "string"); checks += 4; }
  owner.missingPolicies = []; a.clock += 60001; await sync(a); assert.equal((await a.api.sync.status()).failure, null); checks++;

  stage = "device revocation preserves local content";
  await edit(a, local, "revoked-local"); quantum.revoke(computer); await reject(() => sync(a), "sync_signin_required"); assert.equal((await a.api.sync.status()).failure.cause, "sync_signin_required"); assert.equal((await a.api.entries.get(local.id)).entry.note, "synthetic-contract-revoked-local"); assert.equal((await a.api.sync.status()).pending > 0, true); await assert.rejects(() => secret(a), error => error.code === "ENOENT"); checks += 5;
  stage = "different canonical account is refused";
  await signIn(a, "contract-other-account@cosmic.invalid"); await reject(() => sync(a), "sync_signin_required"); assert.equal((await state(a)).quantum.accountId, owner.accountId); assert.equal((await a.api.entries.get(local.id)).entry.note, "synthetic-contract-revoked-local"); assert.equal(quantum.account("contract-other-account@cosmic.invalid").datasets.size, 0); checks += 4;
  await close(a); await close(b);

  stage = "0.2.0 folder fixture and failed switch";
  const folder = join(scratch, "shared"), switched = await make("switch"), peer = await make("folder-peer"); await switched.api.create(password); const kept = await add(switched, "switch-local"); await switched.api.sync.setup(folder); await peer.api.sync.join(folder, { password }); await close(switched);
  const folderFixture = await state(switched); assert.equal(folderFixture.format, 2); assert.equal(Object.keys(folderFixture).sort().join(), "binding,checkpoint,computers,conflicts,datasetId,deviceId,failure,folder,format,generationId,index,lastSynced,operations,origin,quantum,sequence"); checks++; await open(switched); const loadedFolder = await switched.api.sync.status(); assert.equal(loadedFolder.configured, true); assert.equal(loadedFolder.folder, folder); assert.deepEqual(await state(switched), folderFixture); checks += 5; await close(switched);
  const legacyFolder = { ...folderFixture, format: 1 }; delete legacyFolder.origin; delete legacyFolder.quantum; delete legacyFolder.cursor; await writeFile(join(switched.home, "sync", "state.json"), JSON.stringify(legacyFolder)); await open(switched); assert.equal((await switched.api.sync.status()).origin, "folder"); await switched.api.unlock(password); await sync(switched); assert.equal((await state(switched)).format, 2); checks += 2;
  await signIn(switched, "contract-switch@cosmic.invalid"); quantum.controls.objectWriteFailure = 1; await reject(() => switched.api.sync.switchToQuantum(), "sync_unavailable");
  assert.equal((await switched.api.sync.status()).configured, true); assert.equal((await switched.api.sync.status()).origin, "folder"); assert.equal((await state(switched)).folder, folder); checks += 4;
  await edit(switched, kept, "folder-after-switch-failure"); await sync(switched); await sync(peer); await equal(switched, peer); const intent = JSON.parse(await readFile(join(switched.home, "sync", "quantum-setup.json"), "utf8"));
  await restart(switched); assert.equal((await switched.api.sync.status()).origin, "folder"); await switched.api.sync.switchToQuantum(); assert.equal((await switched.api.sync.status()).origin, "quantum"); assert.equal((await state(switched)).datasetId, intent.datasetId); assert.equal((await switched.api.entries.get(kept.id)).entry.note, "synthetic-contract-folder-after-switch-failure"); await assert.rejects(() => readFile(join(switched.home, "sync", "quantum-switch.json"))); checks += 5;
  await close(switched); await close(peer);

  stage = "interrupted switch recovers on restart";
  const interrupted = await make("interrupted"), interruptedFolder = join(scratch, "interrupted-shared"); await interrupted.api.create(password); const interruptedEntry = await add(interrupted, "interrupted-local"); await interrupted.api.sync.setup(interruptedFolder); await signIn(interrupted, "contract-interrupted@cosmic.invalid"); await close(interrupted);
  const program = `
    await import('./test/guard.mjs'); await import('./packages/service/test/privacy-fixture.mjs');
    try {
      const { startService } = await import('./packages/service/src/server.ts'), { unlock } = await import('vault-core');
      const service = await startService({ home: process.env.QUANTUM_SWITCH_HOME, idleMs: 1e12, presenceMs: 1e12 });
      const opened = await unlock((await service.vault.store.envelope()).state, 'Synthetic contract master password'); opened.bytes.fill(0); service.vault.memory.open(opened.key, service.vault.memory.ticket());
      const fetch = globalThis.fetch; globalThis.fetch = async (url, options) => { const reply = await fetch(url, options); if (String(url).includes('/objects/') && options?.method === 'PUT' && reply.ok) process.exit(86); return reply; };
      await service.sync.switchToQuantum(); process.exit(87);
    } catch { process.exit(88); }
  `;
  const exit = await new Promise((done, fail) => { const child = spawn(process.execPath, ["--input-type=module", "-e", program], { cwd: new URL("../../../", import.meta.url), env: { ...process.env, QUANTUM_SWITCH_HOME: interrupted.home }, stdio: "ignore", windowsHide: true, signal: AbortSignal.timeout(60000) }); child.once("error", fail); child.once("exit", done); });
  assert.equal(exit, 86); await open(interrupted); assert.equal((await interrupted.api.sync.status()).origin, "folder"); await interrupted.api.unlock(password); assert.equal((await interrupted.api.entries.get(interruptedEntry.id)).entry.title, interruptedEntry.title); await interrupted.api.sync.switchToQuantum(); assert.equal((await interrupted.api.sync.status()).origin, "quantum"); assert.equal((await interrupted.api.entries.get(interruptedEntry.id)).entry.title, interruptedEntry.title); await assert.rejects(() => readFile(join(interrupted.home, "sync", "quantum-switch.json"))); checks += 6; await close(interrupted);

  stage = "capability refusal keeps local use";
  const bareEmail = "contract-no-capability@cosmic.invalid", bare = await make("no-capability"), bareOwner = quantum.account(bareEmail); bareOwner.plan = false; await bare.api.create(password); const bareEntry = await add(bare, "no-capability-local"); await signIn(bare, bareEmail);
  await reject(() => bare.api.sync.setupQuantum(), "sync_plan_required"); assert.equal((await bare.api.sync.status()).configured, false); assert.equal(bareOwner.datasets.size, 0);
  await edit(bare, bareEntry, "no-capability-edited"); const bareSecond = await add(bare, "no-capability-second"), bareRow = await bare.api.entries.get(bareSecond.id); await bare.api.entries.remove(bareSecond.id, bareRow.version); await bare.api.lock(); await bare.api.unlock(password);
  assert.equal((await bare.api.entries.get(bareEntry.id)).entry.note, "synthetic-contract-no-capability-edited"); await reject(() => bare.api.entries.get(bareSecond.id), "not_found"); checks += 5; await close(bare);

  stage = "Dawn, Dawn Lite and Insider share one artifact";
  const shapes = [];
  for (const [tier, pool] of [["dawn", 100000000], ["dawn-lite", 5000000], ["insider", null]]) {
    const tierEmail = `contract-${tier}@cosmic.invalid`, owner = quantum.account(tierEmail), first = await make(`${tier}-a`), second = await make(`${tier}-b`); owner.poolBytes = pool; await first.api.create(password);
    for (const kind of ["login", "note"]) { const entry = newEntry(kind); entry.title = `synthetic-contract-${tier}-${kind}`; await first.api.entries.save(entry, 0); }
    await signIn(first, tierEmail); await first.api.sync.setupQuantum(); await signIn(second, tierEmail); await second.api.sync.joinQuantum({ password }); await equal(first, second); assert.equal((await first.api.sync.status()).storage.pool, pool); assert.equal((await second.api.sync.status()).failure, null);
    shapes.push([...new Set([...[...owner.datasets.values()][0].keys()].map(path => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/[0-9a-f]{32,}/g, "<hash>").replace(/\d+/g, "#")))].sort()); checks += 3; await close(first); await close(second);
  }
  assert.equal(shapes[0].length > 0, true); assert.deepEqual(shapes[1], shapes[0]); assert.deepEqual(shapes[2], shapes[0]); checks += 3;

  stage = "feed pull, persisted cursor and queue responsiveness";
  quantum.controls.feedHoldMs = 25000;
  const sender = await make("feed-sender"), receiver = await make("feed-receiver"), feedEmail = "contract-feed@cosmic.invalid"; await sender.api.create(password); const feedEntry = await add(sender, "feed-original"); await signIn(sender, feedEmail); await sender.api.sync.setupQuantum(); const receiverComputer = await signIn(receiver, feedEmail); await receiver.api.sync.joinQuantum({ password });
  const receiverFeeds = () => quantum.requests.filter(row => row.computer === receiverComputer && row.path.endsWith("/changes"));
  stage = "initial feed cursor";
  receiver.clock += 60001; receiver.service.checkSync(); await until(async () => { receiver.service.checkSync(); const cursor = (await state(receiver)).cursor; return Number.isSafeInteger(cursor) && cursor > 0; }).catch(async error => { console.error(`Synthetic feed cursor: requests=${receiverFeeds().length}, held=${quantum.counters.held}, cursor=${(await state(receiver)).cursor ?? -1}, cause=${(await receiver.api.sync.status()).failure?.cause ?? "none"}.`); throw error; });
  stage = "initial held receiver feed";
  await until(() => { receiver.service.checkSync(); return quantum.pending(receiverComputer) === 1; });
  stage = "held receiver feed queue responsiveness";
  const beforeQueue = performance.now(); assert.equal((await receiver.api.entries.get(feedEntry.id)).entry.title, feedEntry.title); assert.equal(performance.now() - beforeQueue < 1000, true); checks += 2;
  const feedCount = receiverFeeds().length; for (let i = 0; i < 5; i++) receiver.service.checkSync(); await new Promise(done => setTimeout(done, 30)); assert.equal(receiverFeeds().length, feedCount); assert.equal(quantum.pending(receiverComputer), 1); checks += 2;
  const beforeChangeCursor = (await state(receiver)).cursor; await edit(sender, feedEntry, "feed-changed"); await sync(sender); await until(async () => (await receiver.api.entries.get(feedEntry.id)).entry.note === "synthetic-contract-feed-changed"); await until(async () => (await state(receiver)).cursor > beforeChangeCursor); const cursor = (await state(receiver)).cursor; assert.equal(cursor > 0, true); checks++;
  stage = "held changes request keeps credentials when privacy is missing";
  await until(() => { receiver.service.checkSync(); return quantum.pending(receiverComputer) === 1; }); const heldToken = (await secret(receiver)).refreshToken, heldBefore = quantum.requests.length, heldSignins = quantum.counters.signin;
  quantum.account(feedEmail).missingPolicies = [{ id: "privacy", version: "2026-11-06", path: "/privacy" }]; quantum.wake(); await until(async () => (await receiver.api.sync.status()).failure?.cause === "sync_acceptance_required");
  assert.equal(quantum.requests.slice(heldBefore).some(row => row.computer === receiverComputer && ["PUT", "DELETE"].includes(row.method)), false); assert.equal((await secret(receiver)).refreshToken, heldToken); assert.equal((await receiver.api.entries.get(feedEntry.id)).entry.note, "synthetic-contract-feed-changed"); assert.equal(quantum.counters.signin, heldSignins); assert.equal(legalRows(), legalQuiet); checks += 5;
  quantum.account(feedEmail).missingPolicies = []; receiver.clock += 60001; assert.equal((await receiver.api.sync.status()).failure, null); checks++; await close(sender);
  await close(receiver); const requestStart = quantum.requests.length; await open(receiver); await receiver.api.unlock(password); receiver.service.checkSync(); await until(() => quantum.requests.slice(requestStart).some(row => row.computer === receiverComputer && row.path.endsWith("/changes"))); const resumed = quantum.requests.slice(requestStart).find(row => row.computer === receiverComputer && row.path.endsWith("/changes")); assert.equal(new URL(resumed.url ?? resumed.path, quantum.api).searchParams.get("after"), String(cursor)); checks++;

  stage = "Retry-After and feed backoff";
  await receiver.api.lock(); receiver.service.checkSync(); quantum.controls.feedRetryAfter = 10; quantum.wake(); await until(() => quantum.counters.held === 0); await receiver.api.unlock(password); receiver.clock += 60001; receiver.service.checkSync(); const beforeRetry = receiverFeeds().length; await until(() => receiverFeeds().length > beforeRetry); await new Promise(done => setTimeout(done, 30)); const throttled = receiverFeeds().length;
  receiver.clock += 9999; receiver.service.checkSync(); await new Promise(done => setTimeout(done, 30)); assert.equal(receiverFeeds().length, throttled); receiver.clock++; receiver.service.checkSync(); await until(() => receiverFeeds().length > throttled); await new Promise(done => setTimeout(done, 50)); checks += 2;
  quantum.controls.feedRetryAfter = 0; quantum.controls.feedFailure = 1; receiver.clock += 60001; receiver.service.checkSync(); await until(async () => (await receiver.api.sync.status()).failure?.cause === "sync_unavailable"); const failedFeeds = receiverFeeds().length; receiver.service.checkSync(); await new Promise(done => setTimeout(done, 30)); assert.equal(receiverFeeds().length, failedFeeds); checks++;

  stage = "held feed does not prevent idle shutdown";
  receiver.clock += 60001; receiver.service.checkSync(); await until(() => { receiver.service.checkSync(); return quantum.pending(receiverComputer) === 1; }); receiver.service.lifecycle.lockWithLastApp = false; await receiver.api.close(); receiver.service.vault.memory.lock(); receiver.clock += 600001; const stopping = performance.now(); await receiver.service.checkLifecycle(); assert.equal(receiver.service.server.listening, false); assert.equal(performance.now() - stopping < 1000, true); await until(() => quantum.pending(receiverComputer) === 0); checks += 3; await close(sender);
  stage = "no legal call, key call or policy version in product code";
  assert.equal(legalRows(), legalQuiet); assert.equal(quantum.counters.keys, 0); assert.equal(quantum.requests.some(row => row.path.startsWith("/v1/keys")), false); checks += 3;
  for (const file of ["../src/quantum.ts", "../src/sync.ts", "../src/routes.ts", "../../client/src/index.ts", "../../client/src/types.ts", "../../cli/src/main.ts"]) { const source = await readFile(new URL(file, import.meta.url), "utf8"); for (const literal of ["2026-11-06", "2026-10-09", "2026-10-26", "legal/acceptances"]) assert.equal(source.includes(literal), false, file); checks++; }
  console.log(`Vault Quantum Beta contract: ${checks} checks passed.`);
} catch (error) { console.error(`Vault Quantum contract failed at ${stage}: ${typeof error?.code === "string" && /^[A-Za-z_]{1,40}$/.test(error.code) ? error.code : "assertion"}.`); if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*quantum-contract\.test\.mjs:\d+:\d+/.test(line)).join("\n")); throw new Error("Quantum contract check failed"); }
finally { for (const api of clients) await api.close().catch(() => undefined); for (const service of services) await service.shutdown(); await quantum.close(); assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); }
