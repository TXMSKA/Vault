import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import "../../../test/guard.mjs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import assert from "node:assert/strict";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
const parent = resolve(tmpdir()); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, "run-")), previousHome = process.env.VAULT_HOME;
process.env.VAULT_HOME = scratch;
const started = performance.now();
async function timed(name, operation) {
  const start = performance.now();
  try { return await operation(); }
  finally { console.log(`Vault stage ${name}: ${((performance.now() - start) / 1000).toFixed(3)} s.`); }
}
try {
  await timed("crypto, model and memory", () => import("./vault.test.mjs"));
  await timed("file store regressions", () => import("./file-store.test.mjs"));
  await timed("shared base", () => import("./shared.test.mjs"));
  await timed("sync packages", () => import("./sync.test.mjs"));
} catch (error) {
  // Assertion output can contain the synthetic secrets under test.
  console.error(`Vault tests failed: ${error?.name === "AssertionError" ? "assertion" : "unexpected error"}.`);
  process.exitCode = 1;
} finally {
  if (previousHome === undefined) delete process.env.VAULT_HOME; else process.env.VAULT_HOME = previousHome;
  assert.equal(dirname(scratch), parent); await timed("cleanup", () => rm(scratch, { recursive: true, force: true }));
  console.log(`Vault total: ${((performance.now() - started) / 1000).toFixed(3)} s.`);
}
