import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import "../../../test/guard.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { FileVaultStore, VaultError } from "../dist/index.js";

const parent = resolve(tmpdir()); await fs.mkdir(parent, { recursive: true });
const scratch = await fs.mkdtemp(join(parent, "locks-"));
const deadPid = 2147483647, owner = () => ({ pid: deadPid, token: randomUUID(), time: 0 });
const code = expected => error => error instanceof VaultError && error.code === expected;
const failure = code => Object.assign(new Error(code), { code });
let checks = 0, stage = "failed publication", started = performance.now();
function timing(next) {
  console.log(`Vault file store stage ${stage}: ${((performance.now() - started) / 1000).toFixed(3)} s.`);
  stage = next; started = performance.now();
}
async function withFs(name, replacement, operation) {
  const original = fs[name]; fs[name] = (...args) => replacement(original, ...args); syncBuiltinESMExports();
  try { return await operation(); }
  finally { fs[name] = original; syncBuiltinESMExports(); }
}
async function retries(operation) {
  // Fault counts exercise the retry boundaries without random sleeps or dependence on Windows timer resolution.
  mock.timers.enable({ apis: ["setTimeout"] }); let finished = false;
  const pending = operation().finally(() => { finished = true; }); pending.catch(() => undefined);
  try {
    while (!finished) { mock.timers.tick(20); await setImmediate(); }
    return await pending;
  } finally { mock.timers.reset(); }
}
try {
  assert.throws(() => process.kill(deadPid, 0), error => error.code === "ESRCH");
  const folder = join(scratch, "publication"), store = new FileVaultStore(folder);
  await withFs("open", async (original, path, ...args) => {
    const file = await original(path, ...args);
    if (dirname(path) === folder && path.includes(".tmp-")) file.writeFile = async () => { throw failure("EIO"); };
    return file;
  }, () => assert.rejects(() => store.entries(), code("unavailable")));
  assert.deepEqual(await fs.readdir(folder), []);
  await withFs("link", async (original, from, to) => {
    if (to === join(folder, ".lock")) {
      const published = JSON.parse(await fs.readFile(from, "utf8"));
      assert.equal(published.pid, process.pid); assert.equal(typeof published.token, "string");
    }
    return original(from, to);
  }, async () => assert.deepEqual(await store.entries(), [])); checks += 3;

  timing("abandoned reaper and competing recovery");
  const recovery = join(scratch, "recovery"); await fs.mkdir(recovery);
  const previous = owner(), guard = owner();
  await fs.writeFile(join(recovery, ".lock"), JSON.stringify(previous));
  await fs.writeFile(join(recovery, `.reap-${previous.token}`), JSON.stringify(guard));
  const first = new FileVaultStore(recovery, { staleLockMs: 1 }), second = new FileVaultStore(recovery, { staleLockMs: 1 });
  assert.deepEqual(await Promise.all([first.entries(), second.entries()]), [[], []]);
  assert.deepEqual(await fs.readdir(recovery), []); checks += 2;

  timing("replacement owner protection");
  const replacement = join(scratch, "replacement"); await fs.mkdir(replacement);
  const abandoned = owner(), live = { ...owner(), pid: process.pid };
  await fs.writeFile(join(replacement, ".lock"), JSON.stringify(abandoned));
  let changed = false;
  await withFs("link", async (original, from, to) => {
    await original(from, to);
    if (to === join(replacement, `.reap-${abandoned.token}`) && !changed) {
      changed = true; await fs.unlink(join(replacement, ".lock"));
      await fs.writeFile(join(replacement, ".lock"), JSON.stringify(live));
    }
  }, () => assert.rejects(() => new FileVaultStore(replacement, { lockTimeoutMs: 150, staleLockMs: 1 }).entries(), code("unavailable")));
  assert.equal(changed, true);
  assert.equal(JSON.parse(await fs.readFile(join(replacement, ".lock"), "utf8")).token, live.token); checks += 3;

  timing("failed inventory drains readers");
  const inventory = join(scratch, "inventory"); await fs.mkdir(inventory);
  const ids = Array.from({ length: 16 }, randomUUID).sort();
  for (const id of ids) {
    const sealed = { iv: randomBytes(12).toString("base64"), data: randomBytes(48).toString("base64") };
    await fs.writeFile(join(inventory, `entry-${id}.json`), JSON.stringify(id === ids[0] ? null : { version: 1, value: { id, sealed, chunks: [] } }));
  }
  let readers = 0;
  await withFs("open", async (original, path, ...args) => {
    const file = await original(path, ...args);
    if (dirname(path) === inventory && path.includes("entry-")) {
      readers++; const close = file.close.bind(file);
      file.close = async () => {
        if (path !== join(inventory, `entry-${ids[0]}.json`)) await new Promise(done => setTimeout(done, 30));
        try { await close(); } finally { readers--; }
      };
    }
    return file;
  }, async () => {
    await assert.rejects(() => new FileVaultStore(inventory).entries(), code("invalid"));
    assert.equal(readers, 0);
    await assert.rejects(() => fs.access(join(inventory, ".lock")), error => error.code === "ENOENT");
  }); checks += 3;

  timing("slow reader keeps pool moving");
  const moving = join(scratch, "moving"); await fs.mkdir(moving);
  const names = Array.from({ length: 33 }, randomUUID).sort().map(id => `entry-${id}.json`);
  for (const name of names) {
    const id = name.slice(6, -5), sealed = { iv: randomBytes(12).toString("base64"), data: randomBytes(48).toString("base64") };
    await fs.writeFile(join(moving, name), JSON.stringify({ version: 1, value: { id, sealed, chunks: [] } }));
  }
  let unblock, expired = false, advanced = false;
  const blocked = new Promise(done => { unblock = done; });
  const timer = setTimeout(() => { expired = true; unblock(); }, 2500);
  try {
    await withFs("open", async (original, path, ...args) => {
      const file = await original(path, ...args);
      if (path === join(moving, names[0])) {
        const close = file.close.bind(file); file.close = async () => { await blocked; await close(); };
      }
      if (path === join(moving, names.at(-1))) { advanced = true; unblock(); }
      return file;
    }, async () => assert.equal((await new FileVaultStore(moving).entries()).length, names.length));
    assert.equal(advanced, true); assert.equal(expired, false); checks += 3;
  } finally { clearTimeout(timer); unblock(); }

  timing("Windows delete-pending observation");
  if (process.platform === "win32") {
    for (const denied of ["EPERM", "EACCES", "EBUSY"]) {
      const pending = join(scratch, denied); await fs.mkdir(pending);
      const path = join(pending, ".lock"); await fs.writeFile(path, JSON.stringify(live));
      let attempts = 0;
      // Keep denial beyond one observation's retry budget, then complete the owner's deletion.
      await retries(() => withFs("open", async (original, name, ...args) => {
        if (name === path && typeof args[0] === "number" && attempts < 51) {
          if (++attempts === 51) await fs.unlink(path);
          throw failure(denied);
        }
        return original(name, ...args);
      }, async () => assert.deepEqual(await new FileVaultStore(pending).entries(), [])));
      assert.equal(attempts, 51); assert.deepEqual(await fs.readdir(pending), []); checks += 3;
    }
  }
  timing("Windows release observation and deletion");
  if (process.platform === "win32") {
    for (const denied of ["EPERM", "EACCES", "EBUSY"]) {
      const release = join(scratch, `release-${denied}`), path = join(release, ".lock");
      let reads = 0, deletes = 0;
      // The operation acquired its lock without reading it; these failures occur only during release.
      await retries(() => withFs("open", async (original, name, ...args) => {
        if (name === path && typeof args[0] === "number" && reads++ < 51) throw failure(denied);
        return original(name, ...args);
      }, () => withFs("unlink", async (original, name) => {
        if (name === path && deletes++ < 51) throw failure(denied);
        return original(name);
      }, async () => assert.deepEqual(await new FileVaultStore(release).entries(), []))));
      assert.equal(reads, 52); assert.equal(deletes, 52); assert.deepEqual(await fs.readdir(release), []); checks += 4;
    }
  }
  console.log(`Vault file store: ${checks} checks passed.`);
} catch (error) {
  console.error(`Vault file store failed at ${stage}: ${error instanceof VaultError ? error.code : error?.name === "AssertionError" ? "assertion" : "unavailable"}.`);
  throw new Error("file store check failed");
} finally {
  timing("cleanup");
  assert.equal(dirname(scratch), parent); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  timing("done");
}
