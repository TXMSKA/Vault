import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import "../../../test/guard.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as vault from "../dist/index.js";
import { runHelper } from "../../client/dist/helper.js";

const parent = resolve(tmpdir()); await mkdir(parent, { recursive: true, mode: 0o700 });
const scratch = await mkdtemp(join(parent, "shared-"));
let checks = 0, stage = "setup";
let started = performance.now();
function timing(next) {
  console.log(`Vault shared stage ${stage}: ${((performance.now() - started) / 1000).toFixed(3)} s.`);
  stage = next; started = performance.now();
}
const payload = (size = 48) => ({ iv: randomBytes(12).toString("base64"), data: randomBytes(size).toString("base64") });
const code = expected => error => error instanceof vault.VaultError && error.code === expected && error.message === expected;
const reject = (operation, expected) => assert.rejects(operation, code(expected));
const password = () => randomBytes(30).toString("base64");
const worker = fileURLToPath(new URL("./writer.mjs", import.meta.url));
const children = new Set();
const wait = ms => new Promise(done => setTimeout(done, ms));
function child(folder, mode, entry = "", chunk = "") {
  const signal = join(scratch, `signal-${randomUUID()}`);
  const process = spawn(globalThis.process.execPath, [worker, folder, mode, entry, chunk, signal], { stdio: "inherit", windowsHide: true });
  let ended = false;
  const closed = new Promise(done => process.once("close", done)), record = { process, closed }; children.add(record);
  const finished = new Promise((done, fail) => {
    const timer = setTimeout(() => { process.kill(); fail(new vault.VaultError("unavailable")); }, 30000); timer.unref();
    process.once("error", fail);
    // close follows release of the child handle and inherited stdio, including on Windows.
    process.once("close", async status => {
      ended = true; clearTimeout(timer); children.delete(record);
      if (status !== 0) { fail(new vault.VaultError("unavailable")); return; }
      try { const result = mode === "claim" ? await readFile(`${signal}.result`, "utf8") : "done"; done({ claimed: result === "claimed" }); }
      catch { fail(new vault.VaultError("unavailable")); }
    });
  });
  finished.catch(() => undefined);
  const ready = mode === "abandon" ? Promise.resolve() : (async () => {
    const deadline = Date.now() + 15000;
    while (true) {
      if (ended) throw new vault.VaultError("unavailable");
      try { await access(`${signal}.ready`); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Date.now() > deadline) throw new vault.VaultError("unavailable"); await wait(10);
    }
  })();
  ready.catch(() => undefined);
  return { process, finished, ready, signal, closed };
}
async function together(folder, mode, entry, chunk) {
  const a = child(folder, mode, entry, chunk), b = child(folder, mode, entry, chunk);
  await Promise.all([a.ready, b.ready]); await Promise.all([writeFile(`${a.signal}.start`, "start"), writeFile(`${b.signal}.start`, "start")]);
  return Promise.all([a.finished, b.finished]);
}
async function fixture(folder, kind, count, value) {
  await mkdir(folder, { mode: 0o700 });
  // Quota fixtures are sealed synthetic rows; they never use the default machine store.
  for (let start = 0; start < count; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - start) }, () => {
      const id = randomUUID(), row = kind === "entry" ? { ...value, id } : value;
      return writeFile(join(folder, `${kind}-${id}.json`), JSON.stringify({ version: 1, value: row }), { mode: 0o600 });
    }));
  }
}
try {
  timing("store operations");
  const folder = join(scratch, "vault"), store = new vault.FileVaultStore(folder), other = new vault.FileVaultStore(folder);
  assert.deepEqual(await store.envelope(), { state: null, version: 0 });
  const master = password(), initial = await vault.createEnvelope(master);
  assert.deepEqual(await store.create(initial.state), { version: 1 });
  await reject(() => other.create(initial.state), "conflict");
  await reject(() => other.replace(initial.state, 2), "conflict");
  const current = await other.envelope(); assert.deepEqual(current.state, initial.state); assert.equal(current.version, 1); checks += 5;

  const entry = vault.newEntry("login"); entry.title = randomBytes(32).toString("hex"); entry.fields[1].value = password();
  const encrypted = await vault.encryptJson(initial.key, entry, `entry:${entry.id}`);
  assert.deepEqual(await store.save(entry.id, encrypted, 0, []), { version: 1 });
  const upper = vault.newEntry("note"); upper.id = upper.id.toUpperCase(); upper.note = password();
  const upperSeal = await vault.encryptJson(initial.key, upper, `entry:${upper.id}`); await store.save(upper.id, upperSeal, 0, []);
  const upperRow = (await other.entries()).find(row => row.id === upper.id);
  assert.deepEqual(await vault.decryptJson(initial.key, upperRow.sealed, `entry:${upperRow.id}`), upper);
  await reject(() => other.save(upper.id.toLowerCase(), upperSeal, 0, []), "conflict"); await store.remove(upper.id, 1); checks += 2;
  await reject(() => other.save(entry.id, encrypted, 0, []), "conflict");
  assert.deepEqual(await other.save(entry.id, encrypted, 1, []), { version: 2 });
  await reject(() => store.save(entry.id, encrypted, 1, []), "conflict");
  await reject(() => store.remove(entry.id, 1), "conflict"); checks += 5;

  const chunk = randomUUID(), second = randomUUID();
  const chunkSeal = await vault.encrypt(initial.key, randomBytes(vault.CHUNK_BYTES), `chunk:${chunk}`);
  await store.putChunk(chunk, chunkSeal); assert.deepEqual(await other.getChunk(chunk), chunkSeal);
  await reject(() => store.putChunk(chunk, payload()), "conflict");
  await store.save(entry.id, encrypted, 2, [chunk]);
  await reject(() => store.save(second, payload(), 0, [chunk]), "conflict");
  await reject(() => store.removeChunk(chunk), "conflict");
  await reject(() => store.save(second, payload(), 0, [randomUUID()]), "invalid");
  await store.save(entry.id, encrypted, 3, []); await reject(() => store.getChunk(chunk), "not_found");
  const removal = randomUUID(); await store.putChunk(removal, payload()); await store.save(second, payload(), 0, [removal]);
  await store.remove(second, 1); await reject(() => store.getChunk(removal), "not_found");
  await reject(() => store.remove(second, 1), "not_found"); await store.removeChunk(randomUUID()); checks += 9;

  const staged = new vault.FileVaultStore(join(scratch, "staged")), stagedEntry = randomUUID(), stagedChunk = randomUUID(); let escaped;
  await staged.staged(async tx => {
    escaped = tx; await tx.create(initial.state); await tx.putChunk(stagedChunk, payload()); await tx.save(stagedEntry, payload(), 0, [stagedChunk]);
    await reject(() => tx.save(stagedEntry, payload(), 0, []), "conflict"); await reject(() => tx.save(randomUUID(), payload(), 0, [stagedChunk]), "conflict");
    await tx.save(stagedEntry, payload(), 1, [stagedChunk]); assert.equal((await tx.entries())[0].version, 2); await tx.replace(initial.state, 1); await tx.remove(stagedEntry, 2);
    await reject(() => tx.getChunk(stagedChunk), "not_found");
  });
  assert.deepEqual(await staged.entries(), []); assert.equal((await staged.envelope()).version, 2); await reject(() => escaped.entries(), "invalid"); checks += 6;

  timing("validation and limits");
  for (const bad of ["../escape", "bad", randomUUID().replace(/-/g, ""), "00000000-0000-0000-0000-000000000000"]) await reject(async () => store.save(bad, payload(), 0, []), "invalid");
  for (const bad of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, "0"]) await reject(async () => store.save(randomUUID(), payload(), bad, []), "invalid");
  for (const bad of [{ ...payload(), iv: "invalid" }, payload(15), payload(220001), { ...payload(), extra: true }, { ...payload(), data: "AA" }, null]) await reject(async () => store.save(randomUUID(), bad, 0, []), "invalid");
  for (const bad of [{ ...initial.state, iterations: 1 }, { ...initial.state, masterHash: "invalid" }, { ...initial.state, format: 2 }, { ...initial.state, extra: true }, { ...initial.state, master: payload(47) }]) await reject(async () => store.replace(bad, 1), "invalid");
  await reject(async () => store.save(randomUUID(), payload(), 0, [chunk, chunk.toUpperCase()]), "invalid");
  await reject(async () => store.save(randomUUID(), payload(), 0, Array.from({ length: 2561 }, randomUUID)), "invalid");
  await reject(async () => store.putChunk(randomUUID(), payload(32785)), "invalid");
  const edge = randomUUID(); await store.save(edge, payload(220000), 0, []); await store.remove(edge, 1);
  const edgeChunk = randomUUID(); await store.putChunk(edgeChunk, payload(32784)); await store.removeChunk(edgeChunk); checks += 25;
  assert.equal(vault.MAX_ENTRIES, 4096);
  timing("entry quota fixture");
  const quotaFolder = join(scratch, "entry-quota"); await fixture(quotaFolder, "entry", vault.MAX_ENTRIES - 1, { sealed: payload(), chunks: [] });
  timing("entry quota operations");
  const quota = new vault.FileVaultStore(quotaFolder); await quota.save(randomUUID(), payload(), 0, []);
  assert.equal((await quota.entries()).length, 4096);
  await reject(() => quota.save(randomUUID(), payload(), 0, []), "limited");
  const quotaRows = await quota.entries(); await quota.save(quotaRows[0].id, payload(), 1, []);
  await quota.remove(quotaRows[1].id, 1); await quota.save(randomUUID(), payload(), 0, []); assert.equal((await quota.entries()).length, 4096);
  timing("chunk quota fixture");
  const chunkFolder = join(scratch, "chunk-quota"); await fixture(chunkFolder, "chunk", 6400, payload());
  timing("chunk quota operations");
  const chunkQuota = new vault.FileVaultStore(chunkFolder); await reject(() => chunkQuota.putChunk(randomUUID(), payload()), "limited");
  const name = (await readdir(chunkFolder)).find(name => name.startsWith("chunk-")); await chunkQuota.removeChunk(name.slice(6, -5)); await chunkQuota.putChunk(randomUUID(), payload()); checks += 7;
  timing("maximum chunk claims");
  const maximum = randomUUID(), maxClaims = (await readdir(chunkFolder)).filter(name => name.startsWith("chunk-")).slice(0, 2560).map(name => name.slice(6, -5));
  await chunkQuota.save(maximum, payload(220000), 0, maxClaims);
  assert.equal((await chunkQuota.entries())[0].chunks.length, 2560); await chunkQuota.remove(maximum, 1); checks++;

  timing("unlock and recovery");
  let now = 10000; const logs = [], memory = new vault.VaultMemory(() => now, null);
  const auth = vault.createVaultUnlock(store, { clock: () => now, memory, logger: vault.createLogger(record => logs.push(record), () => now) });
  const key = await auth.unlock(master); const row = (await other.entries()).find(row => row.id === entry.id);
  assert.deepEqual(await vault.decryptJson(key, row.sealed, `entry:${entry.id}`), entry); assert.equal(key.extractable, false);
  auth.lock(); const bad = password(); await reject(() => auth.unlock(bad), "locked");
  await reject(() => vault.createVaultUnlock(other, { clock: () => now }).unlock(master), "limited"); checks++;
  await reject(() => auth.unlock(master), "limited"); now += 1000;
  await reject(() => auth.unlock(bad), "locked"); now += 1000; await reject(() => auth.unlock(master), "limited"); now += 1000;
  await auth.unlock(master); auth.lock();
  const replacement = password(), recovered = await auth.recover(initial.recovery, replacement); assert.equal(recovered.version, 2);
  assert.deepEqual(await vault.decryptJson(recovered.key, row.sealed, `entry:${entry.id}`), entry);
  auth.lock(); await reject(() => auth.unlock(master), "locked"); now += 1000; await reject(() => auth.recover(initial.recovery, password()), "locked"); now += 2000;
  await auth.unlock(replacement); auth.lock();
  const newAuth = vault.createVaultUnlock(other, { clock: () => now }); const again = await newAuth.recover(recovered.recovery, password()); assert.equal(again.version, 3);
  await reject(() => store.replace(initial.state, 2), "conflict");
  assert.equal(logs.some(record => record.event === "unlock_limited"), true); assert.equal(JSON.stringify(logs).includes(master), false); checks += 13;
  const allFiles = await readdir(folder);
  for (const name of allFiles.filter(name => name.endsWith(".json"))) {
    const contents = await readFile(join(folder, name), "utf8");
    for (const secret of [master, replacement, initial.recovery, entry.title, entry.fields[1].value]) assert.equal(contents.includes(secret), false);
  }
  if (process.platform !== "win32") {
    assert.equal((await stat(folder)).mode & 0o777, 0o700);
    for (const name of allFiles) assert.equal((await stat(join(folder, name))).mode & 0o777, 0o600);
    await chmod(folder, 0o755); await store.entries(); assert.equal((await stat(folder)).mode & 0o777, 0o700);
    await chmod(join(folder, "envelope.json"), 0o644); await store.envelope(); assert.equal((await stat(join(folder, "envelope.json"))).mode & 0o777, 0o600);
    const target = join(scratch, "target"); await mkdir(target); const link = join(scratch, "link"); await symlink(target, link);
    await reject(() => new vault.FileVaultStore(link).entries(), "unavailable");
  }
  checks += 2;

  timing("memory policy and cancellation");
  for (const idle of [null, 50]) {
    const mem = new vault.VaultMemory(() => now, idle), ticket = mem.ticket(); mem.open(initial.key, ticket); now += 500;
    assert.equal(mem.expired(), idle !== null); assert.equal(mem.touch(), idle === null);
    if (idle === null) assert.equal(mem.get(ticket), initial.key); else assert.throws(() => mem.get(ticket), /locked/);
    mem.lock(); assert.equal(mem.open(initial.key, ticket), false); assert.throws(() => mem.get(mem.ticket()), /locked/);
  }
  for (const idle of [-1, NaN, Infinity, 0.5]) assert.throws(() => new vault.VaultMemory(Date.now, idle), /invalid/);
  const cancelStore = new vault.FileVaultStore(join(scratch, "cancel")); await cancelStore.create(initial.state);
  const pendingAuth = vault.createVaultUnlock(cancelStore); const interrupted = pendingAuth.unlock(master); pendingAuth.lock();
  await reject(() => interrupted, "locked"); assert.throws(() => pendingAuth.memory.get(pendingAuth.memory.ticket()), /locked/); checks += 16;

  timing("two processes");
  const concurrentFolder = join(scratch, "concurrent"), concurrent = new vault.FileVaultStore(concurrentFolder);
  await concurrent.create(initial.state); const counter = randomUUID(); await concurrent.save(counter, payload(), 0, []);
  await together(concurrentFolder, "write", counter);
  const rows = await concurrent.entries(); assert.equal(rows.length, 25); assert.equal(rows.find(row => row.id === counter).version, 41);
  const claimChunk = randomUUID(); await concurrent.putChunk(claimChunk, payload());
  const claims = await together(concurrentFolder, "claim", "", claimChunk); assert.equal(claims.filter(row => row.claimed).length, 1);
  assert.equal((await concurrent.entries()).filter(row => row.chunks.includes(claimChunk)).length, 1); checks += 4;

  timing("lock recovery and failures");
  const abandoned = child(concurrentFolder, "abandon"); await abandoned.finished;
  await together(concurrentFolder, "write", counter); assert.equal((await concurrent.entries()).find(row => row.id === counter).version, 81);
  await writeFile(join(concurrentFolder, ".lock"), JSON.stringify({ pid: process.pid, token: randomUUID(), time: 0 }), { mode: 0o600 });
  await reject(() => new vault.FileVaultStore(concurrentFolder, { lockTimeoutMs: 80, staleLockMs: 1 }).save(randomUUID(), payload(), 0, []), "unavailable");
  await unlink(join(concurrentFolder, ".lock"));
  const corruptFolder = join(scratch, "corrupt"); await mkdir(corruptFolder); await writeFile(join(corruptFolder, "envelope.json"), "null");
  await reject(() => new vault.FileVaultStore(corruptFolder).envelope(), "invalid");
  await writeFile(join(corruptFolder, "envelope.json"), "{"); await reject(() => new vault.FileVaultStore(corruptFolder).envelope(), "unavailable");
  const blocked = join(scratch, "blocked"); await writeFile(blocked, randomBytes(16));
  await reject(() => new vault.FileVaultStore(blocked).entries(), "unavailable"); checks += 5;

  timing("logger and Hello availability");
  const records = [], log = vault.createLogger(record => records.push(record)); const secret = password();
  log("sample", { password: secret, recoveryPhrase: secret, accessToken: secret, key: secret, harmless: secret, body: { nested: secret }, object: { nested: secret }, error: new Error(secret), outcome: "denied", count: 2 });
  assert.equal(JSON.stringify(records).includes(secret), false); assert.equal(records[0].fields.outcome, "denied"); assert.equal(records[0].fields.count, 2);
  assert.equal(records[0].fields.error, "unavailable");
  log("sample", { [secret]: "private", securityCode: secret, license: secret }); assert.equal(JSON.stringify(records).includes(secret), false);
  assert.throws(() => vault.createLogger(() => { throw new Error(secret); })("sample"), code("unavailable")); checks += 2;
  const available = await vault.helloAvailable(runHelper); assert.equal(typeof available, "boolean");
  // The runner is injected: a stub shows what the core asks for, and that any refusal or failure leaves password unlock as the only path.
  const asked = [], stub = result => async (verb, request) => { asked.push([verb, request]); if (result instanceof Error) throw result; return result; };
  assert.equal(await vault.helloAvailable(stub({ available: true })), process.platform === "win32");
  assert.equal(await vault.helloAvailable(stub({ available: false })), false); assert.equal(await vault.helloAvailable(stub(new Error("synthetic"))), false);
  assert.deepEqual(asked, process.platform === "win32" ? [["hello-available", {}], ["hello-available", {}], ["hello-available", {}]] : []); checks += 4;
  if (process.platform === "win32") { assert.equal(available, (await runHelper("hello-available", {})).available); checks++; }
  let wrapped = { version: 1, blob: randomBytes(32).toString("base64") }, touched = false;
  const hello = vault.createHelloAdapter(store, { protect() { touched = true; throw new Error("unused"); }, unprotect() { touched = true; throw new Error("unused"); } },
    { async read() { return wrapped; }, async write(value) { wrapped = value; }, async remove() { wrapped = null; } }, memory, runHelper);
  await hello.disable(); assert.equal(wrapped, null); assert.equal(touched, false); checks += 7;
  console.log(`Vault shared base: ${checks} checks passed; Hello availability: ${available}.`);
} catch (error) {
  const kind = error instanceof vault.VaultError ? error.code : error?.name === "AssertionError" ? "assertion" : "unexpected error";
  console.error(`Vault shared base failed at ${stage}: ${kind}.`);
  if (kind === "unexpected error") console.error(`Failure type: ${error?.code === "EACCES" ? "permission" : error?.code === "EPERM" ? "permission" : error?.name || "unknown"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => line.trim().startsWith("at ")).join("\n"));
  throw new Error("shared base check failed");
} finally {
  timing("cleanup");
  const running = [...children];
  for (const { process } of running) process.kill();
  await Promise.all(running.map(({ closed }) => closed));
  // Only the verified child of the repository's test scratch folder is removed.
  assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  timing("done");
}
