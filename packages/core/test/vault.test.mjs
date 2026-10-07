// Crypto, model and memory regressions, taken from Nebula's scripts/vault.test.mjs at 0d3bf34. No store is opened.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { load } from "./loader.mjs";

const crypto = load("src/crypto"), model = load("src/model"), { VaultMemory } = load("src/memory");
let checks = 0;
const password = `Vault ${randomBytes(20).toString("hex")}`, replacement = `New ${randomBytes(20).toString("hex")}`;
const canary = randomBytes(32).toString("hex");

const initial = await crypto.createEnvelope(password);
assert.equal(initial.state.iterations, 600000); assert.equal(crypto.normalizeRecovery(initial.recovery).length, 24);
assert.equal(initial.key.extractable, false); await assert.rejects(crypto.createEnvelope("short"));
await assert.rejects(crypto.unlock(initial.state, replacement));
const opened = await crypto.unlock(initial.state, password); opened.bytes.fill(0);
assert.equal(await crypto.hashProof(opened.proof), initial.state.masterHash); checks += 6;

const entry = model.newEntry("login"); entry.title = canary; entry.fields[1].value = canary; entry.totp = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; entry.recovery = [{ value: canary, used: false }];
assert.deepEqual(entry.fields.map(field => [field.id, field.secret]), [["username", false], ["password", true], ["website", false]]);
const encrypted = await crypto.encryptJson(opened.key, entry, `entry:${entry.id}`);
assert.equal(JSON.stringify(encrypted).includes(canary), false);
assert.deepEqual(await crypto.decryptJson(opened.key, encrypted, `entry:${entry.id}`), entry);
await assert.rejects(crypto.decryptJson(opened.key, encrypted, `entry:${randomUUID()}`));
const bad = { ...encrypted, data: crypto.base64(Buffer.from(encrypted.data, "base64").map((byte, i) => i === 0 ? byte ^ 1 : byte)) };
await assert.rejects(crypto.decryptJson(opened.key, bad, `entry:${entry.id}`)); checks += 5;

// RFC 6238 Appendix B: independent published SHA1 vectors, 30 second step.
for (const [time, expected] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"]]) {
  assert.equal(await crypto.totp(`otpauth://totp/Test?secret=${entry.totp}&digits=8`, time * 1000), expected); checks++;
}
assert.throws(() => crypto.parseTotp(`otpauth://totp/Test?secret=${entry.totp}&period=60`));
for (const [algorithm, length, expected] of [["SHA256", 32, "46119246"], ["SHA512", 64, "90693936"]]) {
  const bits = Array.from(Buffer.from("1234567890".repeat(7).slice(0, length)), byte => byte.toString(2).padStart(8, "0")).join("");
  const secret = (bits.match(/.{1,5}/g) ?? []).map(group => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[parseInt(group.padEnd(5, "0"), 2)]).join("");
  assert.equal(await crypto.totp(`otpauth://totp/Test?secret=${secret}&digits=8&algorithm=${algorithm}`, 59000), expected); checks++;
}
for (let i = 0; i < 20; i++) { const value = crypto.generatePassword(32); assert.equal(value.length, 32); assert.match(value, /[A-Z]/); assert.match(value, /[0-9]/); assert.match(value, /[!@#$%&*+\-=?]/); } checks += 2;
assert.equal(model.filename("../folder\\unsafe\u0000.html"), "unsafe.html"); checks++;

const recovered = await crypto.unlock(initial.state, initial.recovery, true);
assert.equal(await crypto.hashProof(recovered.proof), initial.state.recoveryHash);
const next = await crypto.createEnvelope(replacement, recovered.bytes);
await assert.rejects(crypto.unlock(next.state, password)); await assert.rejects(crypto.unlock(next.state, initial.recovery, true));
assert.deepEqual(await crypto.decryptJson(next.key, encrypted, `entry:${entry.id}`), entry);
const second = await crypto.unlock(next.state, next.recovery, true); second.bytes.fill(0); checks += 5;

let now = Date.now();
const memory = new VaultMemory(() => now), ticket = memory.ticket(); assert.equal(memory.open(initial.key, ticket), true);
memory.lock(); assert.equal(memory.open(initial.key, ticket), false); assert.throws(() => memory.get(ticket));
const fresh = memory.ticket(); memory.open(initial.key, fresh); now += model.IDLE_MS; assert.equal(memory.touch(), false); assert.throws(() => memory.get(fresh)); checks += 5;

console.log(`Vault: ${checks} checks passed.`);
