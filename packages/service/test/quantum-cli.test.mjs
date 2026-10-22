import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { main } from "../../cli/src/main.ts";
import { quantumUrls, QUANTUM_DEFAULTS } from "../../cli/src/quantum.ts";
const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-quantum-cli-")), calls = [], launches = [], lines = [], answers = [], previous = Object.fromEntries(["VAULT_HOME", "VAULT_QUANTUM_API", "VAULT_QUANTUM_SITE", "LC_ALL"].map(name => [name, process.env[name]])), originalSpawn = childProcess.spawn;
const account = "synthetic@example.invalid", url = "https://cosmic.example.invalid/authorize?appId=vault", status = { configured: true, origin: "quantum", account, storage: { used: 120, pool: 1000 }, folder: null, lastSynced: null, computers: [], pending: 0, conflicts: 0, failure: null };
const io = { isTTY: () => true, async ask() { return answers.shift() ?? "no"; }, write(value) { lines.push(value); }, error(value) { lines.push(value); }, out(value) { lines.push(value); }, err(value) { lines.push(value); } };
let checks = 0, stage = "URL flags", waiting = 0, failure;
const server = createServer(async (request, response) => {
  const parts = []; for await (const bytes of request) parts.push(bytes); const body = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : undefined;
  calls.push({ method: request.method, path: request.url, body }); let result = { ok: true };
  if (request.url === "/v1/health") result = { ok: true, pid: process.pid };
  else if (request.url === "/v1/status") result = { created: true, unlocked: true, present: 1, idleMs: 1000 };
  else if (request.url === "/v1/sync/quantum/signin") { waiting = 0; result = { url, id: "synthetic-signin-id" }; }
  else if (request.url === "/v1/sync/quantum/wait") result = waiting++ ? { account } : { pending: true };
  else if (request.url === "/v1/sync") result = status;
  else if (["/v1/sync/setup", "/v1/sync/join", "/v1/sync/switch"].includes(request.url)) result = status;
  if (failure && request.url === "/v1/sync/quantum/signout") { response.statusCode = 409; result = { error: { code: failure } }; }
  response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
});
const command = async (args, input = []) => { lines.length = 0; answers.length = 0; answers.push(...input); return main(["sync", ...args], io); };
try {
  process.env.VAULT_HOME = scratch; process.env.LC_ALL = "en"; delete process.env.VAULT_QUANTUM_API; delete process.env.VAULT_QUANTUM_SITE;
  assert.deepEqual(quantumUrls([]), { api: "https://quantum.txmska.com", site: "https://cosmic.txmska.com" }); assert.deepEqual(QUANTUM_DEFAULTS, quantumUrls([])); assert.deepEqual(quantumUrls(["--api", "http://127.0.0.1:1", "--site", "http://127.0.0.1:2"]), { api: "http://127.0.0.1:1", site: "http://127.0.0.1:2" }); checks += 3;
  for (const args of [["signin", "--api"], ["signin", "--api", "https://api.example.invalid", "--api", "https://other.example.invalid"], ["signin", "--unknown", "value"], ["signin", "--api", "--site"], ["signout", "extra"], ["switch"], ["switch", "folder"], ["switch", "--quantum", "extra"], ["setup", "--quantum", "extra"], ["join", "--quantum", "--wrong"]]) { assert.equal(await command(args), 2); checks++; }
  assert.equal(calls.length, 0); checks++;
  await new Promise(done => server.listen(0, "127.0.0.1", done)); await mkdir(join(scratch, "run")); await mkdir(join(scratch, "secrets", "clients"), { recursive: true });
  await writeFile(join(scratch, "run", "service.json"), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, serviceVersion: "0.1.0", startedAt: new Date().toISOString() })); await writeFile(join(scratch, "secrets", "clients", "vault-cli.token"), "s".repeat(43), { mode: 0o600 });
  childProcess.spawn = (file, args, options) => { if (["explorer.exe", "open", "xdg-open"].includes(String(file))) { launches.push({ file, args, options }); const child = new EventEmitter(); child.unref = () => {}; return child; } return originalSpawn(file, args, options); }; syncBuiltinESMExports();
  stage = "sign-in and wait polling";
  process.env.VAULT_QUANTUM_API = "https://api.example.invalid"; process.env.VAULT_QUANTUM_SITE = "https://site.example.invalid";
  assert.equal(await command(["signin"]), 0); assert.deepEqual(calls.find(call => call.path.endsWith("/signin")).body, { api: process.env.VAULT_QUANTUM_API, site: process.env.VAULT_QUANTUM_SITE }); assert.equal(calls.filter(call => call.path.endsWith("/wait")).length, 2); assert.equal(lines.includes(url), true); assert.equal(lines.includes(`Signed in as ${account}.`), true); checks += 5;
  assert.equal(launches.length, 1); assert.equal(launches[0].file, process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open"); assert.deepEqual(launches[0].args, [url]); assert.equal(launches[0].options.shell, false); checks += 4;
  assert.equal(await command(["signin", "--site", "https://other-site.example.invalid", "--api", "https://other-api.example.invalid"]), 0); assert.deepEqual(calls.findLast(call => call.path.endsWith("/signin")).body, { api: "https://other-api.example.invalid", site: "https://other-site.example.invalid" }); checks += 2;
  stage = "Quantum setup, join and switch consent";
  for (const args of [["setup", "--quantum"], ["join", "--quantum"], ["join", "--quantum", "--recovery"], ["switch", "--quantum"]]) { const count = calls.length; assert.equal(await command(args, ["no"]), 1); assert.equal(calls.length, count); assert.equal(lines.some(line => line.includes("Cosmic account on Quantum")), true); checks += 3; }
  assert.equal(await command(["setup", "--quantum"], ["yes"]), 0); assert.deepEqual(calls.findLast(call => call.path === "/v1/sync/setup").body, { quantum: true }); checks += 2;
  for (const recovery of [false, true]) { assert.equal(await command(["join", "--quantum", ...recovery ? ["--recovery"] : []], ["yes", "synthetic-credential"]), 0); const body = calls.findLast(call => call.path === "/v1/sync/join").body; assert.deepEqual(Object.keys(body).sort(), [recovery ? "recovery" : "password", "quantum"].sort()); assert.equal(body.quantum, true); checks += 3; }
  assert.equal(await command(["switch", "--quantum"], ["yes"]), 0); assert.deepEqual(calls.findLast(call => call.path === "/v1/sync/switch").body, {}); checks += 2;
  stage = "status and localized errors";
  for (const language of ["en", "es"]) { process.env.LC_ALL = language; assert.equal(await command(["status"]), 0); assert.equal(lines.some(line => line.startsWith(language === "en" ? "Origin: quantum" : "Origen: quantum")), true); assert.equal(lines.some(line => line.includes(account)), true); assert.equal(lines.some(line => line.includes("120 / 1000 bytes")), true); checks += 4; }
  status.storage.pool = null; assert.equal(await command(["status"]), 0); assert.equal(lines.some(line => line.includes("sin límite")), true); checks += 2;
  for (const language of ["en", "es"]) { process.env.LC_ALL = language; assert.equal(await command(["setup", "--quantum"], ["no"]), 1); assert.equal(lines.some(line => line.includes(language === "en" ? "Quantum cannot read them" : "Quantum no puede leerlas")), true); checks += 2; }
  process.env.LC_ALL = "en";
  for (const code of ["sync_signin_required", "sync_plan_required", "sync_storage_full", "sync_dataset_exists", "sync_signin_failed", "sync_signin_timeout"]) { failure = code; assert.equal(await command(["signout"]), 1); assert.equal(lines.some(line => line.includes("could not complete the operation")), false); checks += 2; }
  failure = undefined; assert.equal(await command(["signout"]), 0); assert.equal(lines.includes("Signed out of Quantum."), true); checks += 2;
  console.log(`Quantum CLI: ${checks} checks passed.`);
} catch { console.error(`Quantum CLI failed at ${stage}.`); throw new Error("quantum CLI check failed"); }
finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; await new Promise(done => server.close(done)); assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); }
