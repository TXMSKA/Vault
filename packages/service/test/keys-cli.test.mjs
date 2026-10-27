import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { connect, findService, VaultClientError } from "../../client/src/index.ts";
import { main } from "../../cli/src/main.ts";
const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-keys-cli-")), calls = [], lines = [], timeouts = [], previous = { VAULT_HOME: process.env.VAULT_HOME, LC_ALL: process.env.LC_ALL }, originalTimeout = AbortSignal.timeout;
const entry = "bb9c8dba-b09f-48bd-adba-c49970774c3d", id = "f6aeb6d1-730a-4a01-aa1c-a955bb05671b", password = "synthetic-master-password", synthetic = ["synthetic-service-key-one", "synthetic-service-key-two", "synthetic-other-secret"], listed = { id: entry, label: "Work" }, usage = [{ entry, app: "lyra", lastRead: new Date().toISOString() }];
const prompt = { id, kind: "key", app: { id: "lyra", name: "Lyra" }, summary: { entry, label: "Work" }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
const keyEntry = (title, apps) => ({ version: 1, entry: { id: entry, kind: "apikey", title, fields: [{ id: "key", value: synthetic[0], secret: true }, ...apps === undefined ? [] : [{ id: "apps", value: apps, secret: false }]], note: synthetic[2] } });
let entries = [keyEntry("Work\nLabel", " lyra, local-app "), keyEntry("Default", undefined), keyEntry("Stopped", ""), { version: 1, entry: { id: "other", kind: "note", title: synthetic[2], fields: [] } }], value = synthetic[0], failure, locked = false, checks = 0, stage = "arguments", client;
const io = { isTTY: () => false, async ask() { throw new Error("unexpected_test_input"); }, write(value) { lines.push(value); }, error(value) { lines.push(value); }, out(value) { lines.push(value); }, err(value) { lines.push(value); } };
const server = createServer(async (request, response) => {
  const parts = []; for await (const bytes of request) parts.push(bytes); const body = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : undefined;
  calls.push({ method: request.method, path: request.url, body }); let result = { ok: true };
  if (request.url === "/v1/health") result = { ok: true, pid: process.pid };
  else if (request.url === "/v1/entries") result = entries;
  else if (request.url === "/v1/keys") result = [listed];
  else if (request.url === "/v1/keys/read") result = { key: value };
  else if (request.url === "/v1/keys/usage") result = usage;
  else if (request.url === "/v1/prompts") result = [prompt];
  if (failure && request.url === "/v1/keys/read") { response.statusCode = 403; result = { error: { code: failure.code, fields: { prompt: failure.prompt }, message: synthetic[2] } }; }
  if (locked && request.url === "/v1/entries") { response.statusCode = 403; result = { error: { code: "locked" } }; }
  response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
});
const command = async args => { lines.length = 0; return main(args, io); };
try {
  process.env.VAULT_HOME = scratch; process.env.LC_ALL = "en";
  for (const args of [["keys", "extra"], ["keys", "--reveal"], ["keys", "--terminal"]]) { assert.equal(await command(args), 2); checks++; }
  assert.equal(calls.length, 0); checks++;
  await new Promise(done => server.listen(0, "127.0.0.1", done)); await mkdir(join(scratch, "run")); await mkdir(join(scratch, "secrets", "clients"), { recursive: true });
  await writeFile(join(scratch, "run", "service.json"), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, serviceVersion: "0.1.0", startedAt: new Date().toISOString() })); await writeFile(join(scratch, "secrets", "clients", "vault-cli.token"), "s".repeat(43), { mode: 0o600 });
  stage = "discovery and client routes";
  assert.equal((await findService(scratch)).serviceVersion, "0.1.0"); assert.deepEqual(calls.map(call => call.path), ["/v1/health"]); checks += 2;
  client = await connect({ home: scratch, app: { id: "lyra", name: "Lyra", kind: "cosmic" }, tokens: { async get() { return "s".repeat(43); }, async set() { throw new Error("unexpected_registration"); } } });
  assert.deepEqual(await client.keys.list(), [listed]); assert.equal(calls.at(-1).method, "GET"); assert.equal(calls.at(-1).body, undefined); checks += 3;
  for (const next of synthetic.slice(0, 2)) { value = next; assert.deepEqual(await client.keys.read(entry), { key: next }); assert.deepEqual(calls.at(-1), { method: "POST", path: "/v1/keys/read", body: { id: entry } }); checks += 2; }
  assert.deepEqual(await client.keys.usage(), usage); assert.deepEqual(await client.prompts.list(), [prompt]); checks += 2;
  await client.keys.approve(id, password); assert.deepEqual(calls.at(-1), { method: "POST", path: "/v1/keys/approve", body: { id, password } }); checks++;
  AbortSignal.timeout = milliseconds => { timeouts.push(milliseconds); return originalTimeout(milliseconds); };
  await client.keys.approveWithHello(id, "123"); assert.deepEqual(calls.at(-1), { method: "POST", path: "/v1/keys/approve/hello", body: { hwnd: "123", id } }); assert.equal(timeouts.at(-1), 130000); checks += 2;
  await client.keys.revoke("lyra", entry); assert.deepEqual(calls.at(-1), { method: "POST", path: "/v1/keys/revoke", body: { app: "lyra", entry } }); checks++;
  const before = calls.length;
  await assert.rejects(() => client.keys.approve("invalid", password), error => error instanceof VaultClientError && error.code === "invalid"); await assert.rejects(() => client.keys.approveWithHello("invalid", "123"), error => error.code === "invalid"); await assert.rejects(() => client.keys.revoke("invalid app", entry), error => error.code === "invalid"); assert.equal(calls.length, before); checks += 4;
  stage = "approval error metadata";
  failure = { code: "key_approval_required", prompt: id };
  await assert.rejects(() => client.keys.read(entry), error => error instanceof VaultClientError && error.code === "key_approval_required" && error.prompt === id && error.message === "key_approval_required" && !JSON.stringify(error).includes(synthetic[2])); checks++;
  failure.prompt = synthetic[2]; await assert.rejects(() => client.keys.read(entry), error => error.code === "key_approval_required" && error.prompt === undefined); checks++;
  for (const code of ["locked", "not_found", "forbidden"]) { failure = { code, prompt: id }; await assert.rejects(() => client.keys.read(entry), error => error.code === code && error.prompt === undefined); checks++; }
  failure = undefined;
  stage = "CLI metadata only";
  const start = calls.length; assert.equal(await command(["keys"]), 0); assert.deepEqual(lines, ["Work\\u000aLabel | lyra, local-app", "Default | -", "Stopped | -"]); assert.equal(synthetic.some(secret => lines.join("\n").includes(secret)), false); assert.equal(calls.slice(start).some(call => call.path.startsWith("/v1/keys/read") || call.path === "/v1/keys"), false); checks += 4;
  entries = []; assert.equal(await command(["keys"]), 0); assert.deepEqual(lines, ["No API keys."]); checks += 2;
  process.env.LC_ALL = "es"; assert.equal(await command(["keys"]), 0); assert.deepEqual(lines, ["No hay claves de API."]); assert.equal(await command(["help"]), 0); assert.equal(lines[0].includes("vault keys: listar los nombres y las apps autorizadas"), true); checks += 4;
  locked = true; assert.equal(await command(["keys"]), 1); assert.equal(lines.length, 1); assert.equal(lines[0].includes("vault unlock"), true); checks += 3;
  console.log(`Keys client and CLI: ${checks} checks passed.`);
} catch { console.error(`Keys client and CLI failed at ${stage}.`); throw new Error("keys client and CLI check failed"); }
finally { if (client) await client.close(); AbortSignal.timeout = originalTimeout; for (const [name, saved] of Object.entries(previous)) if (saved === undefined) delete process.env[name]; else process.env[name] = saved; await new Promise(done => server.close(done)); assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); }
