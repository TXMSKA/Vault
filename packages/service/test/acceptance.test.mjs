import "../../../test/guard.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Sync } from "../src/sync.ts";
import { ServiceError } from "../src/errors.ts";

const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-acceptance-"));
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const privacy = { id: "privacy", path: "/privacy", version: "synthetic" };
let checks = 0, stage = "origin";
const check = (actual, expected) => { checks++; assert.equal(actual, expected); };
function make(site = "https://accounts.example.invalid", language = "en") {
  let clock = Date.now(), revision = 1, current = { account: "qa@example.invalid", accountId: "qa-account", api: "https://api.example.invalid", site };
  let boot = { managedSync: true, missingPolicies: [privacy], storage: { used: 0, pool: 1 } };
  const vault = { memory: { ticket: () => 0, get() { throw new Error("locked"); } }, store: { envelope: async () => ({ state: null, version: 0 }) } };
  const sync = new Sync(scratch, vault, () => clock, async () => {}, () => {}, () => language);
  const quantum = sync.quantum;
  quantum.identity = () => { if (!current) throw new ServiceError("sync_signin_required", 401); return { ...current }; };
  quantum.authRevision = () => revision;
  quantum.dropBootstrap = async () => {};
  quantum.bootstrap = async () => structuredClone(boot);
  quantum.signOut = async () => { current = null; revision++; return { ok: true }; };
  quantum.requirements = async () => ({ ids: ["privacy"], retryAfter: 0 });
  return { sync, quantum, time(n) { clock += n; } };
}
const code = async promise => { try { const value = await promise; return "account" in value ? "done" : "pending"; } catch (error) { return error.code ?? "operation"; } };

try {
  for (const [site, language, pathname] of [
    ["https://accounts.example.invalid/account", "en", "/"],
    ["https://accounts.example.invalid:8443/account", "es", "/es/"],
  ]) {
    const flow = await make(site, language).sync.acceptance("vault-app"), url = new URL(flow.url);
    check(url.origin, new URL(site).origin); check(url.pathname, pathname); check(url.search, "");
  }

  stage = "abort";
  {
    const fixture = make(), flow = await fixture.sync.acceptance("vault-app");
    let release = () => {}, upstream, settled = false;
    fixture.quantum.requirements = signal => { upstream = signal; return new Promise(resolve => { release = resolve; }); };
    const controller = new AbortController();
    const polling = fixture.sync.pollQuantum(flow.id, controller.signal).then(value => { settled = true; return value; });
    await sleep(20); controller.abort(); await sleep(100);
    check(settled, true); check(upstream.aborted, true);
    release({ ids: ["privacy"], retryAfter: 0 }); await polling; await sleep(10); fixture.time(2000);
    fixture.quantum.requirements = async () => ({ ids: ["privacy"], retryAfter: 0 });
    check(await code(fixture.sync.pollQuantum(flow.id)), "pending");
  }

  stage = "deadline";
  {
    const fixture = make(), flow = await fixture.sync.acceptance("vault-app");
    fixture.time(300000 - 80);
    let upstream;
    fixture.quantum.requirements = signal => { upstream = signal; return new Promise(() => {}); };
    const result = await Promise.race([code(fixture.sync.pollQuantum(flow.id)), sleep(500).then(() => "timeout")]);
    check(result, "expired"); check(upstream.aborted, true);
  }

  stage = "budget";
  {
    const fixture = make(), flow = await fixture.sync.acceptance("vault-app");
    let done = Promise.resolve();
    fixture.quantum.requirements = async () => { done = sleep(21050).then(() => ({ ids: ["privacy"], retryAfter: 0 })); return done; };
    const started = performance.now(), result = await code(fixture.sync.pollQuantum(flow.id)), elapsed = Math.round(performance.now() - started);
    check(result, "pending"); check(elapsed >= 19000 && elapsed <= 20500, true); await done;
  }

  stage = "join-read";
  for (const where of ["datasets", "dataset"]) {
    const fixture = make(), terms = { id: "terms", path: "/terms", version: "synthetic" }, device = "01234567-89ab-4cde-8fab-0123456789ab", datasetId = "11111111-1111-4111-8111-111111111111";
    fixture.quantum.identity = () => ({ account: "qa@example.invalid", accountId: "qa-account", api: "https://api.example.invalid", site: "https://accounts.example.invalid", deviceId: device });
    fixture.quantum.bootstrap = async () => ({ managedSync: true, missingPolicies: [terms], storage: { used: 0, pool: 1 } });
    fixture.quantum.blocked = () => ({ accountId: "qa-account", api: "https://api.example.invalid", site: "https://accounts.example.invalid", revision: 1, ids: ["privacy"] });
    fixture.quantum.datasets = async () => { if (where === "datasets") throw new ServiceError("sync_acceptance_required", 403); return [datasetId]; };
    fixture.quantum.request = async () => { throw new ServiceError("sync_acceptance_required", 403); };
    let failed = "";
    try { await fixture.sync.join(true, "synthetic-secret", false); } catch (error) { failed = error.code ?? ""; }
    check(failed, "sync_acceptance_required");
    fixture.quantum.requirements = async () => ({ ids: ["terms"], retryAfter: 0 });
    const flow = await fixture.sync.acceptance("vault-app");
    check(await code(fixture.sync.pollQuantum(flow.id)), "done");
  }

  stage = "completion-abort";
  {
    const fixture = make(), flow = await fixture.sync.acceptance("vault-app");
    let release = () => {}, entered = false, upstream;
    fixture.quantum.requirements = async () => ({ ids: [], retryAfter: 0 });
    fixture.quantum.bootstrap = (_now, signal) => { upstream = signal; entered = true; return new Promise(resolve => { release = () => resolve({ managedSync: true, missingPolicies: [], storage: { used: 0, pool: 1 } }); }); };
    const abort = new AbortController(), waiting = code(fixture.sync.pollQuantum(flow.id, abort.signal));
    for (let i = 0; i < 50 && !entered; i++) await sleep(1);
    check(entered, true); abort.abort(); const result = await waiting; release(); await sleep(20);
    let rereads = 0;
    fixture.quantum.requirements = async () => { rereads++; return { ids: ["privacy"], retryAfter: 0 }; };
    fixture.quantum.bootstrap = async () => ({ managedSync: true, missingPolicies: [privacy], storage: { used: 0, pool: 1 } });
    const resumed = await code(fixture.sync.pollQuantum(flow.id));
    check(result, "pending"); check(upstream?.aborted ?? false, true); check(resumed, "pending"); check(rereads, 1);
  }

  stage = "cadence-wake";
  for (const action of ["cancel", "replace", "stop"]) {
    const fixture = make(), flow = await fixture.sync.acceptance("vault-app");
    fixture.quantum.requirements = async () => ({ ids: ["privacy"], retryAfter: 60000 });
    check(await code(fixture.sync.pollQuantum(flow.id)), "pending");
    const started = performance.now(), waiting = code(fixture.sync.pollQuantum(flow.id));
    await sleep(20);
    if (action === "cancel") await fixture.sync.cancelAcceptance(flow.id, "vault-app");
    else if (action === "replace") await fixture.sync.acceptance("vault-app");
    else fixture.sync.stop();
    const result = await Promise.race([waiting, sleep(500).then(() => "asleep")]);
    check(result, "cancelled"); check(performance.now() - started < 500, true);
  }
  console.log(`Vault acceptance: ${checks} checks passed.`);
} catch (error) {
  console.error(`Vault acceptance failed at ${stage}: ${error instanceof ServiceError ? error.code : "assertion"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*acceptance\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  throw new Error("acceptance check failed");
} finally { assert.equal(resolve(scratch).startsWith(parent), true); await rm(scratch, { recursive: true, force: true }); }
