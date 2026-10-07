import { randomBytes, randomUUID } from "node:crypto";
import "../../../test/guard.mjs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileVaultStore, VaultError } from "../dist/index.js";

const [folder, mode, entry, chunk, signal] = process.argv.slice(2), store = new FileVaultStore(folder);
const wait = ms => new Promise(done => setTimeout(done, ms));
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
const payload = () => ({ iv: randomBytes(12).toString("base64"), data: randomBytes(48).toString("base64") });
let stage = "setup";
let started = performance.now();
function timing(next) {
  console.log(`Vault writer stage ${stage}: ${((performance.now() - started) / 1000).toFixed(3)} s.`);
  stage = next; started = performance.now();
}
try {
  if (mode === "abandon") {
    await writeFile(join(folder, ".lock"), JSON.stringify({ pid: process.pid, token: randomUUID(), time: Date.now() - 60000 }), { flag: "wx", mode: 0o600 });
  } else {
    timing("ready");
    await writeFile(`${signal}.ready`, "ready");
    const deadline = Date.now() + 15000;
    while (!await exists(`${signal}.start`)) { if (Date.now() > deadline) throw new VaultError("unavailable"); await wait(10); }
    if (mode === "claim") {
      timing("claim");
      try { await store.save(randomUUID(), payload(), 0, [chunk]); await writeFile(`${signal}.result`, "claimed"); }
      catch (error) { if (!(error instanceof VaultError) || error.code !== "conflict") throw error; await writeFile(`${signal}.result`, "conflict"); }
    } else {
      timing("save");
      for (let i = 0; i < 12; i++) await store.save(randomUUID(), payload(), 0, []);
      timing("update");
      const deadline = performance.now() + 20000;
      for (let i = 0; i < 20; i++) {
        while (true) {
          if (performance.now() > deadline) throw new VaultError("unavailable");
          const row = (await store.entries()).find(row => row.id === entry);
          try { await store.save(entry, payload(), row.version, []); break; }
          catch (error) { if (!(error instanceof VaultError) || error.code !== "conflict") throw error; }
        }
      }
    }
  }
} catch (error) {
  process.exitCode = 1;
  console.error(`Vault writer failed at ${stage}: ${error instanceof VaultError ? error.code : "unavailable"}.`);
  await writeFile(`${signal}.result`, error instanceof VaultError ? error.code : "unavailable");
} finally {
  timing("done");
}
