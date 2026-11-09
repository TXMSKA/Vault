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
  const vault = { memory: { ticket: () => 0, get() { throw new Error("locked"); } } };
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
  console.log(`Vault acceptance: ${checks} checks passed.`);
} catch (error) {
  console.error(`Vault acceptance failed at ${stage}: ${error instanceof ServiceError ? error.code : "assertion"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*acceptance\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  throw new Error("acceptance check failed");
} finally { assert.equal(resolve(scratch).startsWith(parent), true); await rm(scratch, { recursive: true, force: true }); }
