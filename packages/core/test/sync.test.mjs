import "../../../test/guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEnvelope, newEntry, encryptJson, base64, sealSync, openSync, syncOperation, syncDataset, syncPatterns, syncWinner, SYNC_PACKAGE_CAP, SYNC_BLOB_CAP } from "../dist/index.js";
let checks = 0;
try {
  for (const size of [0, 256, 32768, 32769, 8 * 1024 * 1024]) { const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256); assert.equal(base64(bytes), Buffer.from(bytes).toString("base64")); checks++; }
  const { key, state } = await createEnvelope("Synthetic sync master password"), address = { datasetId: randomUUID(), deviceId: randomUUID(), generationId: randomUUID(), type: "batch", sequence: 1, packageId: randomUUID() }, entry = newEntry("note"); entry.title = "Synthetic private title"; entry.note = "Synthetic private value";
  const op = { record: "entry", id: entry.id, revision: randomUUID(), base: null, deviceId: address.deviceId, time: 10, value: { sealed: await encryptJson(key, entry, `entry:${entry.id}`), chunks: [] } }, batch = { operations: [op] }, bytes = await sealSync(key, address, batch);
  assert.deepEqual(await openSync(key, address, bytes), batch); assert.equal(bytes.includes(entry.title) || bytes.includes(entry.note), false); checks += 2;
  for (const name of ["datasetId", "deviceId", "generationId", "packageId"]) { await assert.rejects(() => openSync(key, { ...address, [name]: randomUUID() }, bytes), error => error.code === "invalid"); checks++; }
  for (const change of [{ type: "envelope" }, { sequence: 2 }]) { await assert.rejects(() => openSync(key, { ...address, ...change }, bytes)); checks++; }
  for (const input of [bytes.slice(0, -1), bytes.replace('"version":1', '"version":2'), bytes.replace('"format":"vault-sync"', '"format":"other"'), bytes.replace('"sealed":', '"extra":0,"sealed":'), "x".repeat(SYNC_PACKAGE_CAP + 1)]) { await assert.rejects(() => openSync(key, address, input)); checks++; }
  const tampered = JSON.parse(bytes); tampered.sealed.data = `${tampered.sealed.data[0] === "A" ? "B" : "A"}${tampered.sealed.data.slice(1)}`; await assert.rejects(() => openSync(key, address, JSON.stringify(tampered))); checks++;
  for (const value of [{ ...op, extra: true }, { ...op, time: -1 }, { ...op, base: "bad" }, { ...op, revision: "bad" }, { ...op, value: { ...op.value, extra: true } }, { ...op, value: { ...op.value, chunks: [randomUUID(), "bad"] } }, { ...op, record: "other" }, { ...op, value: { sealed: { iv: "bad", data: "bad" }, chunks: [] } }]) { assert.throws(() => syncOperation(value)); checks++; }
  await assert.rejects(() => sealSync(key, address, { operations: [op, op] })); await assert.rejects(() => sealSync(key, address, { operations: [], extra: true })); checks += 2;
  assert.equal(syncWinner(op, { ...op, time: 11 }).time, 11); const other = { ...op, deviceId: randomUUID(), revision: randomUUID() }; assert.equal(syncWinner(op, other), syncWinner(other, op)); checks += 2;
  const checkpoint = { records: [op], applied: { [`${address.deviceId}/${address.generationId}`]: 1 }, time: 10, part: 1, parts: 1 }, checkpointAddress = { ...address, type: "checkpoint" };
  assert.deepEqual(await openSync(key, checkpointAddress, await sealSync(key, checkpointAddress, checkpoint)), checkpoint); checks++;
  for (const value of [{ ...checkpoint, parts: 0 }, { ...checkpoint, part: 2 }, { ...checkpoint, applied: { bad: 1 } }, { ...checkpoint, applied: { [`${address.deviceId}/${address.generationId}`]: -1 } }]) { await assert.rejects(() => sealSync(key, checkpointAddress, value)); checks++; }
  const dataset = { format: "vault-sync", version: 1, datasetId: address.datasetId, createdAt: 10, envelope: state }; assert.deepEqual(syncDataset(dataset), dataset);
  for (const value of [{ ...dataset, version: 2 }, { ...dataset, extra: true }, { ...dataset, envelope: { ...state, extra: true } }]) { assert.throws(() => syncDataset(value)); checks++; }
  const name = `1-${address.packageId}.vsync`; assert.equal(syncPatterns.batch.test(name), true); for (const value of [name.replace(".vsync", "-SCOUT.vsync"), `${name}.partial`, `01-${address.packageId}.vsync`, name.toUpperCase()]) { assert.equal(syncPatterns.batch.test(value), false); checks++; }
  assert.equal(SYNC_PACKAGE_CAP, 8 * 1024 * 1024); assert.equal(SYNC_BLOB_CAP, 64 * 1024); checks += 4;
  console.log(`Vault sync core: ${checks} checks passed.`);
} catch { throw new Error("sync core check failed"); }
