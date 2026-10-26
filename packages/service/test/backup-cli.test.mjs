import "../../../test/guard.mjs";
import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { mkdtemp, mkdir, open, readFile, writeFile, rm } from "node:fs/promises";
import { main } from "../../cli/src/main.ts";
import { connect, readFirstLine } from "../../client/src/index.ts";
const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-backup-cli-")), calls = [], lines = [], answers = [], timeouts = [], previous = { VAULT_HOME: process.env.VAULT_HOME, LC_ALL: process.env.LC_ALL }, originalTimeout = AbortSignal.timeout;
const password = "synthetic-backup-password", legacy = { format: "vault-backup", version: 1, envelope: {}, sealed: { iv: "synthetic-iv", data: "synthetic-ciphertext" } }, header = { format: "vault-backup", version: 2, envelope: {}, counts: { entries: 3, chunks: 640 } }, counts = { imported: 3, duplicates: 1, skipped: 0 };
const io = { isTTY: () => true, async ask() { return answers.shift() ?? ""; }, write(value) { lines.push(value); }, error(value) { lines.push(value); }, out(value) { lines.push(value); }, err(value) { lines.push(value); } };
let checks = 0, stage = "arguments", client;
const server = createServer(async (request, response) => {
  const parts = []; for await (const bytes of request) parts.push(bytes); const body = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : undefined;
  calls.push({ method: request.method, path: request.url, body }); let result = { ok: true };
  try {
    if (request.url === "/v1/health") result = { ok: true, pid: process.pid };
    else if (request.url === "/v1/status") result = { created: true, unlocked: true, present: 1, idleMs: 1000 };
    else if (request.url === "/v1/export") result = legacy;
    else if (request.url === "/v1/export/file") {
      const file = await open(body.path, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(header)}\n${JSON.stringify({ end: { iv: "synthetic-iv", data: "synthetic-end" } })}\n`); } finally { await file.close(); }
      result = { entries: header.counts.entries, chunks: header.counts.chunks, bytes: (await readFile(body.path)).length };
    } else if (["/v1/restore", "/v1/restore/file"].includes(request.url)) result = counts;
  } catch { response.statusCode = 409; result = { error: { code: "conflict" } }; }
  response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
});
const command = async (args, input = []) => { lines.length = 0; answers.length = 0; answers.push(...input); return main(args, io); };
try {
  process.env.VAULT_HOME = scratch; process.env.LC_ALL = "en";
  for (const args of [["export"], ["restore"], ["export", "file", "extra"], ["restore", "file", "extra"], ["export", "file", "--terminal", "--terminal"]]) { assert.equal(await command(args), 2); checks++; }
  assert.equal(calls.length, 0); checks++;
  await new Promise(done => server.listen(0, "127.0.0.1", done)); await mkdir(join(scratch, "run")); await mkdir(join(scratch, "secrets", "clients"), { recursive: true });
  await writeFile(join(scratch, "run", "service.json"), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, serviceVersion: "0.1.0", startedAt: new Date().toISOString() })); await writeFile(join(scratch, "secrets", "clients", "vault-cli.token"), "s".repeat(43), { mode: 0o600 });
  AbortSignal.timeout = milliseconds => { timeouts.push(milliseconds); return originalTimeout(milliseconds); };
  stage = "export file route";
  const output = join(scratch, "export.vault"), argument = relative(process.cwd(), output);
  assert.equal(await command(["export", argument, "--terminal"], [password, password]), 0); assert.deepEqual(calls.findLast(call => call.path === "/v1/export/file").body, { password, path: output }); assert.deepEqual(JSON.parse(await readFirstLine(output)), header); assert.equal(calls.some(call => call.path === "/v1/export"), false); checks += 4;
  const before = await readFile(output); assert.equal(await command(["export", argument], [password, password]), 1); assert.equal(Buffer.compare(await readFile(output), before), 0); checks += 2;
  const cancelled = join(scratch, "cancelled.vault"), number = calls.filter(call => call.path === "/v1/export/file").length;
  assert.equal(await command(["export", cancelled], [password, "different-password"]), 2); assert.equal(calls.filter(call => call.path === "/v1/export/file").length, number); await assert.rejects(() => readFile(cancelled)); checks += 3;
  stage = "legacy restore";
  for (const pretty of [false, true]) {
    const filename = join(scratch, pretty ? "legacy-pretty.vault" : "legacy.vault"); await writeFile(filename, JSON.stringify(legacy, null, pretty ? 2 : undefined));
    assert.equal(await command(["restore", relative(process.cwd(), filename), "--terminal"], [password]), 0); assert.deepEqual(calls.findLast(call => call.path === "/v1/restore").body, { backup: legacy, password }); checks += 2;
  }
  stage = "streamed restore";
  const streamed = join(scratch, "streamed.vault"), file = await open(streamed, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(header)}\n`); await file.truncate(9 * 1024 * 1024); } finally { await file.close(); }
  assert.equal(await command(["restore", relative(process.cwd(), streamed)], [password]), 0); assert.deepEqual(calls.findLast(call => call.path === "/v1/restore/file").body, { password, path: streamed }); assert.equal(calls.filter(call => call.path === "/v1/restore").length, 2); checks += 3;
  const unsupported = join(scratch, "unsupported.vault"); await writeFile(unsupported, JSON.stringify({ ...header, version: 3 }));
  const restores = calls.filter(call => call.path.startsWith("/v1/restore")).length; assert.equal(await command(["restore", unsupported], [password]), 2); assert.equal(calls.filter(call => call.path.startsWith("/v1/restore")).length, restores); checks += 2;
  stage = "legacy client and long file timeouts";
  client = await connect({ home: scratch, app: { id: "vault-cli", name: "Synthetic backup CLI", kind: "cosmic" } });
  assert.deepEqual(await client.export(password), legacy); assert.deepEqual(await client.restore(legacy, password), counts); checks += 2;
  const duration = timeouts.length; await client.exportToFile(password, join(scratch, "client.vault")); await client.restoreFromFile(streamed, password); assert.deepEqual(timeouts.slice(duration), [600000, 600000]); checks++;
  console.log(`Backup CLI: ${checks} checks passed.`);
} catch { console.error(`Backup CLI failed at ${stage}.`); throw new Error("backup CLI check failed"); }
finally { if (client) await client.close(); AbortSignal.timeout = originalTimeout; for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; await new Promise(done => server.close(done)); assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); }
