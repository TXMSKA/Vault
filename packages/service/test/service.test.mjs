import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, open, stat } from "node:fs/promises";
import { join, resolve, dirname, parse, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import http from "node:http";
import { startService } from "../src/server.ts";
import { routes, validateRoutes } from "../src/routes.ts";
import { csv, parseImport } from "../src/imports.ts";
import { xml } from "../src/xml.ts";
import { dpapi } from "../src/hello.ts";
import { Lifecycle, DISCONNECTED_MS } from "../src/lifecycle.ts";
import { Redactor, MASK } from "../src/redact.ts";
import { dotenv } from "../src/dotenv.ts";
import { Apps } from "../src/secrets.ts";
import { defaultRoots } from "../../../test/guard.mjs";
import { resolveHome } from "../../client/src/paths.ts";
import { runHelper, runHelperSync } from "../../client/src/helper.ts";
import { privateDirectory, privateFile } from "../../client/src/private.ts";
import { foregroundWindow } from "../../cli/src/window.ts";
import { layout, uninstall } from "../../cli/src/install.ts";
import { connect, ensureRunning, findService, VaultClientError, readCapped } from "../../client/dist/index.js";
import { newEntry, encrypt, decrypt, FileVaultStore, defaultVaultFolder, VaultMemory, helloAvailable } from "vault-core";
import { main } from "../../cli/src/main.ts";

const parent = resolve(tmpdir()); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, "service-")), home = join(scratch, "home");
const originalHome = process.env.VAULT_HOME; process.env.VAULT_HOME = home;
await import("./privacy-fixture.mjs");
const services = [], clients = [], detached = new Set(); let checks = 0, stage = "setup", now = 10000, dpapiFailure = false, aclFailure = false;
const password = randomBytes(30).toString("base64"), nextPassword = randomBytes(30).toString("base64"), canary = randomBytes(30).toString("base64"), backupPassword = randomBytes(30).toString("base64");
const rejects = (operation, code) => assert.rejects(operation, error => error instanceof VaultClientError && error.code === code);
const wait = ms => new Promise(done => setTimeout(done, ms));
const memoryTokens = () => { let value; return { async get() { return value; }, async set(token) { value = token; } }; };
const app = async (id, kind = "cosmic", target = home) => { const api = await connect({ home: target, app: { id, name: "Synthetic app", kind }, tokens: memoryTokens() }); clients.push(api); return api; };
function entry(kind, site = "https://one.example/login") {
  const value = newEntry(kind); value.title = kind === "env" ? "synthetic-project" : "Synthetic";
  if (kind === "login") { value.fields.find(field => field.id === "website").value = site; value.fields.find(field => field.id === "username").value = "synthetic-user"; value.fields.find(field => field.id === "password").value = canary; }
  if (kind === "env") value.fields = [{ id: "VAULT_SYNTHETIC_VALUE", name: "Synthetic variable", secret: true, value: canary }];
  return value;
}
function tokenStore() { let token; return { async get() { return token; }, async set(value) { token = value; }, token: () => token }; }
async function probe(service, route, { method = "GET", auth, body, headers = {} } = {}) {
  return new Promise((done, fail) => {
    const request = http.request({ hostname: "127.0.0.1", port: service.port, path: route, method, headers: { ...(auth ? { Authorization: auth } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, response => {
      let content = ""; response.on("data", chunk => { content += chunk; }); response.on("end", () => {
        try { done({ status: response.statusCode, value: JSON.parse(content), headers: new Headers(Object.entries(response.headers).map(([name, value]) => [name, String(value)])) }); } catch (error) { fail(error); }
      });
    });
    request.on("error", fail); request.setTimeout(10000, () => request.destroy(new Error("timeout"))); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function tree(folder) {
  let contents = "";
  for (const item of await readdir(folder, { withFileTypes: true })) { const path = join(folder, item.name); contents += item.isDirectory() ? await tree(path) : await readFile(path, "utf8"); }
  return contents;
}
try {
  stage = "test home guard";
  assert.equal(resolveHome(), home); assert.equal(defaultVaultFolder(), join(home, "store"));
  assert.throws(() => resolveHome({}), error => error.code === "test_default_root");
  delete process.env.VAULT_HOME; assert.throws(() => defaultVaultFolder()); process.env.VAULT_HOME = home;
  for (const root of defaultRoots) {
    assert.throws(() => mkdir(join(root, "apps", "Vault")), /test_default_root/);
    await assert.rejects(() => new FileVaultStore(join(root, "vault")).envelope());
  }
  checks += 6;
  stage = "DPAPI synthetic round trip";
  if (process.platform === "win32") {
    const bytes = randomBytes(32); let protectedBytes, opened;
    try {
      protectedBytes = await dpapi(bytes); opened = await dpapi(protectedBytes, true);
      assert.equal(Buffer.from(opened).equals(bytes), true); assert.equal(Buffer.from(protectedBytes).equals(bytes), false);
      assert.equal(bytes.length, 32); checks += 3;
    } catch { dpapiFailure = true; }
    finally { bytes.fill(0); protectedBytes?.fill(0); opened?.fill(0); }
  } else await assert.rejects(() => dpapi(randomBytes(32)));
  if (process.platform === "win32") { await assert.rejects(() => dpapi(randomBytes(32), true)); await assert.rejects(() => dpapi(new Uint8Array(0))); checks += 2; }

  stage = "no shell in sources";
  {
    const packages = fileURLToPath(new URL("../../", import.meta.url)), found = [], seen = [];
    const walk = async folder => { for (const item of await readdir(folder, { withFileTypes: true })) { const path = join(folder, item.name); if (item.isDirectory()) await walk(path); else { seen.push(path); if (/powershell/i.test(await readFile(path, "utf8"))) found.push(path); } } };
    for (const item of await readdir(packages, { withFileTypes: true })) if (item.isDirectory()) await walk(join(packages, item.name, "src"));
    assert.deepEqual(found, []); assert.equal(seen.some(path => path.endsWith("vault-helper.cs")), true); assert.equal(seen.some(path => path.endsWith("helper.ts")), true); checks += 3;
  }

  stage = "helper runner output and time limits";
  {
    const fakeUrl = pathToFileURL(fileURLToPath(new URL("./fake-helper.mjs", import.meta.url))).href, names = ["VAULT_HELPER", "NODE_OPTIONS", "VAULT_FAKE_HELPER", "VAULT_FAKE_LOG"];
    // A copy of node stands in for the helper: --import answers, then exits before node looks for its script. An undefined value removes the variable.
    const fake = async (mode, operation, extra = {}) => {
      const saved = names.map(name => process.env[name]), values = { VAULT_HELPER: process.execPath, NODE_OPTIONS: `--import=${fakeUrl}`, VAULT_FAKE_HELPER: mode, ...extra };
      for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
      try { return await operation(); } finally { names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); }
    };
    const refused = code => error => error?.name === "VaultClientError" && error.code === code;
    const record = join(scratch, "fake-record.json"), request = { data: Buffer.from(canary).toString("base64") };
    assert.deepEqual(await fake("ok", () => runHelper("hello-available", {})), { available: true });
    assert.deepEqual(await fake("ok", () => runHelperSync("hello-available", {})), { available: true }); checks += 2;
    // user-path-remove has the same request and answer shape as user-path-add; the stand-in answers, so the user Path is never touched.
    assert.deepEqual(await fake("ok", () => runHelper("user-path-remove", { path: "C:\\synthetic" })), { changed: false }); checks++;
    for (const mode of ["garbage", "extra", "type", "two-lines", "no-newline", "empty", "array", "nonzero", "huge", "proto", "unknown"]) { await fake(mode, () => assert.rejects(() => runHelper("hello-available", {}), refused("unavailable"))); checks++; }
    for (const mode of ["garbage", "extra", "nonzero", "huge"]) { await fake(mode, () => assert.throws(() => runHelperSync("hello-available", {}), refused("unavailable"))); checks++; }
    const hang = join(scratch, "fake-hang.pid"), started = Date.now();
    for (const call of [() => assert.rejects(() => runHelper("hello-available", {}, { timeout: 1500 }), refused("unavailable")), () => assert.throws(() => runHelperSync("hello-available", {}, { timeout: 1500 }), refused("unavailable"))]) {
      await fake("hang", call, { VAULT_FAKE_LOG: hang });
      const pid = Number(await readFile(hang, "utf8").catch(() => "0")); let alive = pid > 0;
      for (let i = 0; i < 100 && alive; i++) { try { process.kill(pid, 0); await wait(50); } catch { alive = false; } }
      assert.equal(alive, false); await rm(hang, { force: true }); checks += 2;
    }
    assert.equal(Date.now() - started < 20000, true); checks++;
    // The values travel on stdin only: the helper sees the verb alone as its argument and the request in its input.
    await fake("record", async () => { assert.deepEqual(await runHelper("dpapi-protect", request), { data: "AAAA" }); }, { VAULT_FAKE_LOG: record });
    const observed = JSON.parse(await readFile(record, "utf8"));
    assert.equal(observed.verb, "dpapi-protect"); assert.deepEqual(observed.args, []); assert.equal(observed.input, `${JSON.stringify(request)}\n`);
    assert.equal(observed.environment.includes(request.data), false); assert.equal(observed.environment.includes(canary), false); checks += 5;
    for (const [verb, bad] of [["hello-available", { extra: "1" }], ["dpapi-protect", {}], ["dpapi-protect", { data: "!" }], ["dpapi-protect", { data: "AAAA", extra: "1" }], ["dpapi-protect", { data: 5 }], ["protect-folder", { path: "relative" }], ["check-file", { path: "C:\\a\u0000b" }], ["user-path-add", { path: "relative" }], ["user-path-remove", {}], ["user-path-remove", { path: "relative" }], ["user-path-remove", { path: "C:\\a\u0000b" }], ["user-path-remove", { path: "C:\\a", extra: "1" }], ["nonsense", {}]]) { await fake("ok", () => assert.rejects(() => runHelper(verb, bad), refused("invalid"))); checks++; }
    await fake("ok", () => assert.rejects(() => runHelper("hello-available", {}, { timeout: 0 }), refused("invalid"))); checks++;
    // Where the helper is: VAULT_HELPER first, then the install record, then the build beside this checkout.
    await fake("ok", () => assert.rejects(() => runHelper("hello-available", {}), refused("invalid")), { VAULT_HELPER: "relative.exe" }); checks++;
    const recordHome = join(scratch, "record-home"), installFile = join(recordHome, "install.json"), write = helper => writeFile(installFile, JSON.stringify({ version: 1, command: process.execPath, args: [], helper })), missing = join(scratch, "missing-helper.exe");
    await mkdir(recordHome); process.env.VAULT_HOME = recordHome;
    try {
      await write(missing); await fake("record", () => runHelper("hello-available", {}), { VAULT_FAKE_LOG: record }); assert.equal(JSON.parse(await readFile(record, "utf8")).verb, "hello-available"); await rm(record); checks++;
      await write(process.execPath); await fake("record", () => runHelper("hello-available", {}), { VAULT_HELPER: undefined, VAULT_FAKE_LOG: record }); assert.equal(JSON.parse(await readFile(record, "utf8")).verb, "hello-available"); checks++;
      for (const bad of [5, null, "", "relative.exe"]) { await write(bad); await fake("ok", () => assert.rejects(() => runHelper("hello-available", {}), refused("invalid_install")), { VAULT_HELPER: undefined }); checks++; }
      if (process.platform === "win32") { await write(missing); await fake("ok", async () => assert.equal(typeof (await runHelper("hello-available", {})).available, "boolean"), { VAULT_HELPER: undefined, NODE_OPTIONS: undefined }); checks++; }
    } finally { process.env.VAULT_HOME = home; }
    // A caller's own home wins over the resolved one, as connect's home option does.
    await write("relative.exe"); await fake("ok", () => assert.rejects(() => runHelper("hello-available", {}, { home: recordHome }), refused("invalid_install")), { VAULT_HELPER: undefined }); checks++;
  }

  if (process.platform === "win32") {
    stage = "native helper";
    const exe = fileURLToPath(new URL("../../helper/bin/vault-helper.exe", import.meta.url)), raw = (args, input) => spawnSync(exe, args, { input, windowsHide: true });
    const availability = await runHelper("hello-available", {}); assert.equal(typeof availability.available, "boolean"); assert.equal(await helloAvailable(runHelper), availability.available); checks += 2;
    // A locked or detached desktop has no foreground window, so a refusal is as valid as a handle.
    try { assert.match(await foregroundWindow(), /^[1-9][0-9]{0,18}$/); } catch (error) { assert.equal(error?.code, "unavailable"); } checks++;
    const refusals = [
      [[], "{}\n"], [["bogus"], "{}\n"], [["Hello-Available"], "{}\n"], [["hello-available", "extra"], "{}\n"], [["hello-available", "hello-available"], "{}\n"],
      [["hello-available"], '{"extra":"1"}\n'], [["hello-available"], "[]\n"], [["hello-available"], "{}\n{}\n"], [["hello-available"], "{} x\n"], [["hello-available"], ""],
      [["dpapi-protect"], '{"data":"!!!!"}\n'], [["dpapi-protect"], '{"data":"AAAA","data":"AAAA"}\n'], [["dpapi-protect"], '{"data":"AAAA","other":"AAAA"}\n'], [["dpapi-protect"], '{"data":1}\n'],
      [["dpapi-protect"], `{"data":"${"A".repeat(70000)}"}\n`], [["dpapi-unprotect"], '{"data":"AAAA"}\n'],
      // Both Path verbs refuse these before they open the registry; a path that passed would change the real user Path, so none does.
      ...["user-path-add", "user-path-remove"].flatMap(verb => [[[verb], '{"path":"relative"}\n'], [[verb], "{}\n"], [[verb], '{"path":"C:\\\\a","extra":"1"}\n'], [[verb], '{"path":"C:\\\\a;b"}\n'], [[verb], '{"path":"\\\\\\\\server\\\\share"}\n'], [[verb], '{"path":"C:\\\\a\\\\..\\\\b"}\n'], [[verb], '{"path":"C:\\\\a\\u0001"}\n']]),
      [["protect-folder"], '{"path":"relative"}\n'], [["protect-folder"],`{"path":${JSON.stringify(join(parent, "missing-helper-folder"))}}\n`], [["check-file"], `{"path":${JSON.stringify(parent)}}\n`],
    ];
    for (const [args, input] of refusals) { const result = raw(args, input); assert.equal(result.status !== 0 && result.stdout.length === 0, true); checks++; }
    const sealedRaw = raw(["dpapi-protect"], '{"data":"AAAA"}\n'); assert.equal(sealedRaw.status, 0); assert.match(sealedRaw.stdout.toString(), /^\{"data":"[A-Za-z0-9+/]+=*"\}\n$/); assert.equal(sealedRaw.stderr.length, 0); checks += 3;

    stage = "real ACL on a temporary folder";
    const aclRoot = await mkdtemp(join(parent, "helper-")), icacls = join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), unsafe = error => error?.code === "unsafe_location";
    try {
      const wide = join(aclRoot, "wide.txt"), narrow = join(aclRoot, "narrow.txt");
      execFileSync(icacls, [aclRoot, "/grant", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true, stdio: "ignore" });
      await writeFile(wide, "synthetic"); assert.throws(() => privateFile(wide), unsafe);
      privateDirectory(aclRoot); privateFile(wide);
      await writeFile(narrow, "synthetic"); privateFile(narrow);
      execFileSync(icacls, [narrow, "/grant", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" }); assert.throws(() => privateFile(narrow), unsafe);
      assert.throws(() => runHelperSync("protect-folder", { path: join(aclRoot, "missing") }), error => error?.code === "unavailable"); checks += 6;
    } catch { aclFailure = true; }
    finally { await rm(aclRoot, { recursive: true, force: true }); }
  }
  stage = "request boundaries";
  const service = await startService({ home, now: () => now, idleMs: 5000, presenceMs: 60000 }); services.push(service);
  assert.equal(service.server.address().address, "127.0.0.1");
  assert.throws(() => validateRoutes([{ ...routes[0], access: undefined }])); checks += 2;
  for (const route of routes) {
    const path = route.path.replace("{id}", "synthetic-app");
    const result = await probe(service, path, { method: route.method, ...(route.method === "GET" ? {} : { body: {} }) });
    assert.equal(result.status, route.access === "public" ? 200 : 401); checks++;
  }
  for (const origin of ["https://foreign.example", "null", "http://127.0.0.1"]) { const result = await probe(service, "/v1/health", { headers: { Origin: origin } }); assert.equal(result.status, 403); assert.equal(result.headers.has("access-control-allow-origin"), false); checks++; }
  assert.equal((await probe(service, "/v1/health", { headers: { Host: "foreign.example" } })).status, 421);
  assert.equal((await probe(service, "/v1/health", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await probe(service, "/v1/missing")).status, 404);
  assert.equal((await probe(service, "/v1/health", { method: "POST", body: {} })).status, 405); checks += 4;
  const error = await probe(service, "/v1/status");
  assert.equal(error.headers.get("cache-control"), "no-store"); assert.equal(error.headers.get("x-content-type-options"), "nosniff"); assert.match(error.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.deepEqual(Object.keys(error.value.error).sort(), ["code", "fields", "message", "requestId"]); checks += 4;

  stage = "registration and grants";
  const cliTokens = tokenStore(), cli = await connect({ home, app: { id: "vault-cli", name: "Synthetic CLI", kind: "cosmic" }, tokens: cliTokens }); clients.push(cli);
  const horizon = await app("horizon"), nova = await app("nova"), nebula = await app("nebula");
  const unknown = await app("synthetic-app", "app"), agent = await app("synthetic-agent", "agent"), lyra = await app("lyra", "app");
  await rejects(() => unknown.status(), "pending"); await cli.apps.allow("synthetic-app"); await unknown.present(); assert.equal((await unknown.status()).created, false);
  await cli.apps.allow("synthetic-agent"); await rejects(() => agent.status(), "forbidden"); await rejects(() => agent.entries.list(), "forbidden"); await rejects(() => cli.apps.allow("lyra"), "forbidden");
  await cli.apps.revoke("synthetic-app"); await rejects(() => unknown.status(), "revoked"); checks += 5;
  const hashFile = await readFile(join(home, "secrets", "apps.json"), "utf8"); assert.equal(hashFile.includes(cliTokens.token()), false); checks++;
  const badToken = await probe(service, "/v1/status", { auth: `Bearer ${randomBytes(32).toString("base64url")}` }); assert.equal(badToken.status, 401); checks++;
  const bootstrap = await readFile(join(home, "secrets", "bootstrap.key"), "utf8");
  assert.equal((await probe(service, "/v1/apps/register", { method: "POST", auth: `Bootstrap ${bootstrap}`, body: { id: "pretender", name: "Synthetic", kind: "cosmic" } })).status, 400);
  await rejects(() => horizon.apps.list(), "forbidden");
  const limitedTokens = tokenStore(), limited = await connect({ home, app: { id: "limited-app", name: "Synthetic", kind: "app" }, tokens: limitedTokens }); clients.push(limited); await cli.apps.allow("limited-app"); await limited.present();
  for (const route of routes.filter(route => route.access === "manage")) { assert.equal((await probe(service, route.path.replace("{id}", "limited-app"), { method: route.method, auth: `Bearer ${limitedTokens.token()}`, ...(route.method === "GET" ? {} : { body: {} }) })).status, 403); checks++; }
  const auth = `Bearer ${cliTokens.token()}`;
  assert.equal((await probe(service, "/v1/status?actor=nebula", { auth })).status, 400);
  assert.equal((await probe(service, "/v1/lock", { auth, method: "POST", body: { actor: "nebula" } })).status, 400);
  assert.equal((await probe(service, "/v1/lock", { auth, method: "POST", headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await probe(service, "/v1/lock", { auth, method: "POST", body: { oversized: "x".repeat(256 * 1024) } })).status, 413); checks += 5;

  stage = "shared key and kinds";
  const created = await cli.create(password); assert.equal((await nebula.status()).unlocked, true); await cli.lock(); await horizon.unlock(password); assert.equal((await cli.status()).unlocked, true); checks += 2;
  const one = entry("login"), http = entry("login", "http://one.example"), subdomain = entry("login", "https://sub.one.example"), port = entry("login", "https://one.example:8443"), other = entry("login", "https://two.example");
  const environment = entry("env"), note = entry("note");
  for (const value of [one, http, subdomain, port, other, environment, note]) await cli.entries.save(value, 0);
  const siteRows = await horizon.logins("https://one.example/path"); assert.equal(siteRows.length, 1); assert.equal(siteRows[0].entry.id, one.id);
  assert.equal((await horizon.logins("http://one.example")).length, 1); assert.equal((await horizon.logins("https://one.example:8443")).length, 1);
  await rejects(() => horizon.logins("file:///synthetic"), "invalid"); await rejects(() => horizon.entries.list(), "forbidden"); await rejects(() => horizon.environment(environment.title), "not_found");
  const novaRows = await nova.entries.list(); assert.equal(novaRows.length, 1); assert.equal(novaRows[0].entry.kind, "env"); await rejects(() => nova.logins("https://one.example"), "not_found");
  for (const [actor, value] of [[horizon, environment], [nova, one]]) {
    await rejects(() => actor.entries.get(value.id), "not_found");
    await rejects(() => actor.entries.save(value, 1), "not_found"); await rejects(() => actor.entries.remove(value.id, 1), "not_found");
    const missing = { ...value, id: randomUUID() };
    await rejects(() => actor.entries.get(missing.id), "not_found");
    await rejects(() => actor.entries.save(missing, 1), "not_found"); await rejects(() => actor.entries.remove(missing.id, 1), "not_found");
  }
  const changed = structuredClone(one); changed.kind = "env"; changed.fields = []; await rejects(() => nova.entries.save(changed, 1), "not_found");
  const malformedHidden = { id: one.id, kind: "env" }; await rejects(() => nova.entries.save(malformedHidden, -1), "not_found");
  await rejects(() => nova.entries.remove(one.id, -1), "not_found");
  await rejects(() => horizon.entries.get(one.id), "not_found");
  assert.equal((await nova.entries.get(environment.id)).entry.id, environment.id); checks += 12;
  const publicEnv = structuredClone(environment); publicEnv.fields[0].secret = false; await rejects(() => nova.entries.save(publicEnv, 1), "invalid"); checks += 15;
  await horizon.entries.save(one, 1); await horizon.entries.remove(other.id, 1); assert.equal((await nebula.entries.list()).length, 6); checks += 2;

  stage = "idle and departure locking";
  now += 5000; service.lifecycle.check(); assert.equal((await cli.status()).unlocked, false); await rejects(() => nebula.entries.list(), "locked");
  await nebula.unlock(password); now += 60000; service.lifecycle.check(); assert.equal((await cli.status()).unlocked, false); assert.equal(service.lifecycle.presences.size, 0);
  await cli.present(); await horizon.present(); await cli.unlock(password);
  await horizon.close(); assert.equal((await cli.status()).unlocked, true); await cli.close(); assert.equal(service.lifecycle.presences.size, 0);
  const observer = await app("vault-app"); assert.equal((await observer.status()).unlocked, false); await observer.unlock(password); checks += 7;

  stage = "recovery";
  const recovered = await observer.recover(created.recovery, nextPassword); await observer.lock();
  await rejects(() => observer.unlock(password), "locked"); now += 1000; await observer.unlock(nextPassword);
  assert.equal((await observer.entries.list()).some(row => row.entry.id === one.id), true);
  await observer.lock(); await rejects(() => observer.recover(created.recovery, password), "locked"); now += 1000; await observer.unlock(nextPassword); assert.equal(typeof recovered.recovery, "string");
  await rejects(() => observer.hello.unlock("0"), "invalid"); await rejects(() => observer.hello.unlock("1"), "not_found"); checks += 6;

  stage = "all import formats";
  const fixture = (header, row) => `${header}\r\n${row}\r\n${row}\r\n`;
  const files = [
    ["chrome", fixture("name,url,username,password,note", `Synthetic,https://chrome.example,u,${canary},notes`)],
    ["edge", fixture("name,url,username,password", `Synthetic,https://edge.example,u,${canary}`)],
    ["firefox", fixture('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"', `https://firefox.example,u,${canary},,,synthetic,1,1,1`)],
    ["bitwarden", fixture("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp", `,0,login,Synthetic,notes,,0,https://bitwarden-csv.example,u,${canary},`)],
    ["bitwarden", JSON.stringify({ encrypted: false, items: [{ type: 1, name: "Synthetic", notes: "", login: { uris: [{ uri: "https://bitwarden-json.example" }], username: "u", password: canary } }, { type: 1, name: "Synthetic", login: { uris: [{ uri: "https://bitwarden-json.example" }], username: "u", password: canary } }, { type: 2, name: "Synthetic note" }] })],
    ["1password", fixture("Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes", `Synthetic,https://onepassword.example,u,${canary},,false,false,,notes`)],
    ["keepass", fixture('"Account","Login Name","Password","Web Site","Comments"', `Synthetic,u,${canary},https://keepass.example,notes`)],
    ["keepass", fixture('"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"', `Synthetic,Synthetic,u,${canary},https://keepassxc.example,notes,,0,1,1`)],
  ];
  for (let i = 0; i < files.length; i++) { const [format, content] = files[i], filename = join(scratch, `synthetic-${i}.txt`); await writeFile(filename, content, { mode: 0o600 }); const count = await observer.import(format, await readCapped(filename)); assert.equal(count.imported, 1); assert.equal(count.duplicates, 1); assert.equal(count.skipped, i === 4 ? 1 : 0); checks += 3; }
  const importer = await app("horizon"), beforeGranted = (await observer.entries.list()).length, loginFile = `name,url,username,password\r\nSynthetic,https://horizon-import.example,u,${canary}\r\n`;
  await rejects(() => importer.import("chrome", loginFile), "permission_required"); assert.equal((await observer.entries.list()).length, beforeGranted); assert.deepEqual((await importer.apps.self()).permissions, []);
  await rejects(() => importer.permissions.importWithPassword(password), "locked"); now += 1000; await rejects(() => importer.permissions.importWithHello("1"), "not_found"); assert.deepEqual((await importer.apps.self()).permissions, []);
  await rejects(() => agent.permissions.importWithPassword(nextPassword), "forbidden"); await rejects(() => agent.apps.self(), "forbidden"); checks += 8;
  assert.deepEqual((await importer.permissions.importWithPassword(nextPassword)).permissions, ["import"]); assert.deepEqual((await importer.apps.self()).permissions, ["import"]); assert.deepEqual((await observer.apps.list()).find(row => row.id === "horizon").permissions, ["import"]);
  assert.equal((await importer.import("chrome", loginFile)).imported, 1); assert.equal((await observer.entries.list()).length, beforeGranted + 1);
  const mixed = JSON.stringify({ encrypted: false, items: [{ type: 1, name: "Synthetic", login: { uris: [{ uri: "https://horizon-mixed.example" }], username: "u", password: canary } }, { type: 2, name: "Synthetic note" }] });
  assert.deepEqual(await importer.import("bitwarden", mixed), { imported: 1, duplicates: 0, skipped: 1 }); assert.equal((await observer.entries.list()).filter(row => row.entry.kind === "note").length, 1);
  await rejects(() => nova.import("chrome", loginFile.replace("horizon-import", "nova-import")), "permission_required"); await nova.present(); await nova.permissions.importWithPassword(nextPassword);
  await rejects(() => nova.import("chrome", loginFile.replace("horizon-import", "nova-import")), "not_found"); assert.equal((await observer.entries.list()).length, beforeGranted + 2); checks += 10;
  const fresh = new Apps(home); await fresh.load(); assert.deepEqual(fresh.list().find(row => row.id === "horizon").permissions, ["import"]); assert.deepEqual(fresh.list().find(row => row.id === "synthetic-agent").permissions, []);
  const stored = JSON.parse(await readFile(join(home, "secrets", "apps.json"), "utf8")), horizonRow = stored.find(row => row.app.id === "horizon"), agentRow = stored.find(row => row.app.id === "synthetic-agent");
  const loadFrom = async (name, rows) => { const target = join(scratch, name); await mkdir(join(target, "secrets"), { recursive: true }); await writeFile(join(target, "secrets", "apps.json"), JSON.stringify(rows)); const apps = new Apps(target); await apps.load(); return apps; };
  const { permissions: dropped, ...legacyApp } = horizonRow.app; assert.deepEqual(dropped, ["import"]);
  assert.deepEqual((await loadFrom("legacy-home", [{ ...horizonRow, app: legacyApp }])).list()[0].permissions, []);
  for (const [name, row] of [["duplicate", { ...horizonRow, app: { ...horizonRow.app, permissions: ["import", "import"] } }], ["unknown", { ...horizonRow, app: { ...horizonRow.app, permissions: ["export"] } }], ["not-array", { ...horizonRow, app: { ...horizonRow.app, permissions: "import" } }], ["agent", { ...agentRow, app: { ...agentRow.app, permissions: ["import"] } }]]) { await assert.rejects(() => loadFrom(`bad-${name}-home`, [row])); checks++; }
  await observer.apps.revoke("horizon"); assert.deepEqual((await observer.apps.list()).find(row => row.id === "horizon").permissions, []); await rejects(() => importer.apps.self(), "revoked");
  await observer.apps.allow("horizon"); await importer.present(); assert.deepEqual((await importer.apps.self()).permissions, []); await rejects(() => importer.import("chrome", loginFile.replace("horizon-import", "horizon-again")), "permission_required");
  assert.deepEqual((await importer.permissions.importWithPassword(nextPassword)).permissions, ["import"]); checks += 9;
  assert.deepEqual(csv('a,b\r\n"quoted,cell","line\nwith ""quotes"""\r\n'), [["a", "b"], ["quoted,cell", 'line\nwith "quotes"']]);
  for (const malformed of ['a,b\n"open,x', 'a,b\n"closed"x,y', 'a,b\nx"quote,y']) assert.throws(() => csv(malformed));
  await rejects(() => observer.import("chrome", "name,url,username,password\nshort,row"), "invalid");
  const oversized = join(scratch, "oversized"); await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1)); await assert.rejects(() => readCapped(oversized)); checks += 6;
  stage = "KeePass XML";
  const xmlEntry = (site, secret = canary) => `<Entry><String><Key>Title</Key><Value>Synthetic &amp; &#x41;</Value></String><String><Key>URL</Key><Value>${site}</Value></String><String><Key>UserName</Key><Value>u</Value></String><String><Key>Password</Key><Value ProtectInMemory="True">${secret}</Value></String><String><Key>Notes</Key><Value><![CDATA[<synthetic>]]></Value></String><History><Entry><String><Key>Password</Key><Value>old</Value></String></Entry></History></Entry>`;
  const xmlFile = `<?xml version="1.0" encoding="utf-8"?><KeePassFile><Meta/><Root><Group><Name>Synthetic</Name><Group>${xmlEntry("https://xml.example")}${xmlEntry("https://xml.example")}</Group></Group><DeletedObjects/></Root></KeePassFile>`;
  const xmlPath = join(scratch, "synthetic.xml"); await writeFile(xmlPath, xmlFile, { mode: 0o600 });
  const xmlCount = await observer.import("keepass", await readCapped(xmlPath)); assert.deepEqual(xmlCount, { imported: 1, duplicates: 1, skipped: 0 });
  const parsedXml = parseImport("keepass", xmlFile); assert.equal(parsedXml.entries.length, 2);
  assert.equal(parsedXml.entries[0].fields.find(field => field.id === "password").value === canary, true);
  assert.equal(parsedXml.entries[0].title === "Synthetic & A", true);
  assert.equal(parsedXml.entries[0].note === "<synthetic>", true);
  assert.equal(xml("<root a='&quot;'>&lt;&gt;&amp;&apos;&#65;</root>").text === "<>&'A", true);
  const beforeMalformed = (await observer.entries.list()).length;
  for (const malformed of [
    `<!DOCTYPE KeePassFile [<!ENTITY injected SYSTEM "file:///unread">]>${xmlFile}`,
    `<!DOCTYPE KeePassFile SYSTEM "https://unread.example">${xmlFile}`,
    xmlFile.replace(canary, "&unknown;"), xmlFile.replace(canary, "&#0;"), xmlFile.replace(canary, "&#x110000;"),
    xmlFile.replace(canary, "unescaped &"), xmlFile.replace("</Root>", "</Wrong>"), `${xmlFile}<extra/>`,
    xmlFile.replace('ProtectInMemory="True"', 'Protected="True"'), xmlFile.replace('ProtectInMemory="True"', 'a="1" a="2"'),
    xmlFile.replace("<Key>Password</Key>", "<Key>UserName</Key>"), xmlFile.replace("<Value>u</Value>", "<Value><nested/></Value>"),
    xmlFile.replace("encoding=\"utf-8\"", "encoding=\"utf-16\""), xmlFile.replace("<Meta/>", "<?unknown instruction?>"),
    xmlFile.replace("<?xml", "<?XML"), `${xmlFile}\u00a0`, `${xmlFile}&#32;`, xmlFile.replace("<Meta/>", "<Meta a='x'\u00a0b='y'/>"),
    `${xmlFile.slice(0, -1)}`, "<KeePassFile><Root/></KeePassFile>",
  ]) { await rejects(() => observer.import("keepass", malformed), "invalid"); checks++; }
  await rejects(() => observer.import("keepass", "<KeePassFile>" + "x".repeat(8 * 1024 * 1024)), "invalid");
  assert.throws(() => xml("<a>".repeat(65) + "</a>".repeat(65)), error => error.code === "too_large");
  assert.throws(() => xml("<a>" + "x".repeat(32001) + "</a>"), error => error.code === "too_large");
  assert.throws(() => xml("<a>" + "<b/>".repeat(200000) + "</a>"), error => error.code === "too_large");
  assert.equal((await observer.entries.list()).length, beforeMalformed); checks += 11;

  stage = "encrypted backup round trip";
  const attached = entry("doc"), chunk = randomUUID(), bytes = randomBytes(256); attached.files = [{ id: randomUUID(), name: "Synthetic", type: "application/octet-stream", size: bytes.length, chunks: [chunk] }];
  const sourceKey = service.vault.memory.get(service.vault.memory.ticket()); await service.vault.store.putChunk(chunk, await encrypt(sourceKey, Uint8Array.from(bytes), `chunk:${chunk}`)); await observer.entries.save(attached, 0);
  const backup = await observer.export(backupPassword); assert.equal(JSON.stringify(backup).includes(canary), false); assert.equal(JSON.stringify(backup).includes(nextPassword), false);
  const backupPath = join(scratch, "backup.json"); await writeFile(backupPath, JSON.stringify(backup), { mode: 0o600 });
  const destinationHome = join(scratch, "restore-home"), destination = await startService({ home: destinationHome }); services.push(destination); const destinationClient = await app("vault-cli", "cosmic", destinationHome); await destinationClient.create(password);
  const before = await observer.entries.list(), count = await destinationClient.restore(JSON.parse(await readCapped(backupPath)), backupPassword); assert.equal(count.imported, before.length);
  const after = await destinationClient.entries.list(); assert.equal(after.length, before.length); assert.equal(after.find(row => row.entry.id === one.id).entry.fields.find(field => field.id === "password").value, canary);
  const restoredChunk = after.find(row => row.entry.id === attached.id).entry.files[0].chunks[0], destinationKey = destination.vault.memory.get(destination.vault.memory.ticket());
  const restoredBytes = await decrypt(destinationKey, await destination.vault.store.getChunk(restoredChunk), `chunk:${restoredChunk}`); assert.deepEqual(Buffer.from(restoredBytes), bytes); restoredBytes.fill(0); bytes.fill(0);
  assert.equal((await destinationClient.restore(backup, backupPassword)).duplicates, before.length);
  const tampered = structuredClone(backup); tampered.sealed.data = `${tampered.sealed.data[0] === "A" ? "B" : "A"}${tampered.sealed.data.slice(1)}`; await assert.rejects(() => destinationClient.restore(tampered, backupPassword)); checks += 8;

  stage = "CLI and argument-array run";
  // The CLI follows the machine's locale; the English answers below must not depend on it.
  process.env.LC_ALL = "en";
  const output = [], errors = [], prompts = [], io = { isTTY: () => true, async ask() { return prompts.shift(); }, write(value) { output.push(value); }, error(value) { errors.push(value); }, out(value) { output.push(value); }, err(value) { errors.push(value); } };
  const resultFile = join(scratch, "child-result.json"), childPath = join(scratch, "child.mjs");
  const childCode = "import fs from 'node:fs'; const good = !!process.env.VAULT_SYNTHETIC_VALUE && process.argv[3] === 'literal;$(echo forbidden)&'; fs.writeFileSync(process.argv[2],JSON.stringify({good,hasValue:!!process.env.VAULT_SYNTHETIC_VALUE}));";
  await writeFile(childPath, childCode);
  const runArgs = ["run", "--project", "synthetic-project", "--", process.execPath, childPath, resultFile];
  // Without a terminal a run is an agent's request, so it reaches the service; a reveal still needs a terminal.
  for (const [command, expected] of [[runArgs, "Run vault dev-install first"], [["get", one.id, "password", "--reveal"], "A terminal is required"]]) {
    const stdinPath = join(scratch, `stdin-${randomUUID()}`), stdoutPath = join(scratch, `stdout-${randomUUID()}`), stderrPath = join(scratch, `stderr-${randomUUID()}`);
    await writeFile(stdinPath, "", { mode: 0o600 });
    const handles = [await open(stdinPath, "r"), await open(stdoutPath, "wx", 0o600), await open(stderrPath, "wx", 0o600)];
    try {
      // Regular file input proves non-TTY refusal without Windows sandbox pipe creation.
      const child = spawn(process.execPath, ["--import", new URL("../../../test/guard.mjs", import.meta.url).href, fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)), ...command], { windowsHide: true, stdio: handles.map(file => file.fd), env: { ...process.env, VAULT_HOME: join(scratch, "unattended"), LC_ALL: "en" } });
      detached.add(child.pid);
      const status = await new Promise((done, fail) => { child.once("error", fail); child.once("exit", done); }); detached.delete(child.pid);
      const stdout = await readFile(stdoutPath, "utf8"), stderr = await readFile(stderrPath, "utf8");
      assert.equal(status, 1); assert.equal(stdout.length, 0); assert.equal(stderr.includes(expected), true);
      assert.equal(stderr.includes(canary), false); checks += 4;
    } finally { for (const handle of handles) await handle.close(); }
  }
  const noTerminal = { ...io, isTTY: () => false, async ask() { throw new Error("unexpected_prompt"); } };
  assert.equal(await main(runArgs, noTerminal), 1); assert.equal(errors.some(line => line.includes("vault apps allow agent")), true);
  assert.equal(await main(["get", one.id, "password", "--reveal"], noTerminal), 1);
  assert.equal(await main(["get", one.id, "password"], noTerminal), 0);
  assert.equal(output.join().includes(canary), false); output.length = 0;
  prompts.push("no"); assert.equal(await main(["get", one.id, "password", "--reveal"], io), 1);
  await assert.rejects(() => readFile(resultFile)); errors.length = 0;
  prompts.push("yes"); assert.equal(await main(["get", one.id, "password", "--reveal"], io), 0);
  assert.equal(output.length, 1); assert.equal(output[0] === canary, true); output.length = 0;
  prompts.push("yes"); assert.equal(await main(["get", one.id, "--reveal"], io), 0);
  assert.equal(output.length, 1); assert.equal(output[0] === canary, true); output.length = 0; checks += 3;
  for (const answer of ["s", " Y "]) { prompts.push(answer); assert.equal(await main(["get", one.id, "password", "--reveal"], io), 0); assert.equal(output.length, 1); assert.equal(output[0] === canary, true); output.length = 0; checks += 3; }
  prompts.push("n"); assert.equal(await main(["get", one.id, "password", "--reveal"], io), 1); assert.equal(output.length, 0); errors.length = 0; checks += 2;
  const previousLocale = process.env.LC_ALL;
  try {
    process.env.LC_ALL = "es"; prompts.push("sí");
    assert.equal(await main(["get", one.id, "password", "--reveal"], io), 0);
    assert.equal(output.length, 1); assert.equal(output[0] === canary, true); output.length = 0; checks += 3;
  } finally { if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale; }
  assert.equal(output.join().includes(canary), false);
  const kitPath = join(scratch, "kit.txt"); process.env.VAULT_HOME = join(scratch, "cli-home"); const kitService = await startService({ home: process.env.VAULT_HOME }); services.push(kitService);
  prompts.push(password, password); assert.equal(await main(["create", "--kit", kitPath], io), 0); assert.match(await readFile(kitPath, "utf8"), /Recovery kit/);
  const savedRecovery = (await readFile(kitPath, "utf8")).split("\n")[4]; assert.equal(output.join().includes(savedRecovery), false);
  assert.equal((await kitService.vault.store.envelope()).version, 1);
  process.env.VAULT_HOME = home; checks += 19;

  stage = "agent runs: access";
  {
    let shift = 0;
    const runHome = join(scratch, "run-home"), runner = await startService({ home: runHome, now: () => Date.now() + shift, runs: { commandMs: 3000 } }); services.push(runner);
    const tom = await connect({ home: runHome, app: { id: "vault-app", name: "Synthetic app", kind: "cosmic" }, tokens: memoryTokens() }); clients.push(tom);
    await tom.create(password);
    const project = entry("env"); project.fields.push({ id: "VAULT_SYNTHETIC_SHORT", name: "Short", secret: true, value: "abc" }); await tom.entries.save(project, 0);
    const agentApi = await connect({ home: runHome, app: { id: "claude-code", name: "Claude Code", kind: "agent" }, tokens: memoryTokens() }); clients.push(agentApi);
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => /^[^=\0]{1,256}$/.test(name) && typeof value === "string" && value.length <= 32768));
    const ask = (commands, name = "synthetic-project", env = environment) => ({ project: name, commands, cwd: scratch, env });
    const marker = name => join(scratch, `marker-${name}.json`), printer = join(scratch, "printer.mjs"), seen = [];
    await writeFile(printer, [
      'import fs from "node:fs"; const v = process.env.VAULT_SYNTHETIC_VALUE ?? "", line = String.fromCharCode(10);',
      'fs.writeFileSync(process.argv[2], JSON.stringify({ hasValue: v.length > 0, literal: process.argv[3] ?? null }));',
      'process.stdout.write("whole:" + v + line + "url:" + encodeURIComponent(v) + line + "base64:" + Buffer.from(v).toString("base64") + line + "json:" + JSON.stringify({ v }) + line);',
      'process.stderr.write("error:" + v + line); process.stdout.write("split:" + v.slice(0, 7));',
      'setTimeout(() => process.stdout.write(v.slice(7) + line + "short:" + process.env.VAULT_SYNTHETIC_SHORT + line), 300);',
    ].join("\n"));
    const settle = async (api, id) => {
      let after = 0, text = "";
      for (let i = 0; i < 300; i++) {
        const progress = await api.runs.get(id, after); seen.push(JSON.stringify(progress));
        text += progress.chunks.map(chunk => chunk.text).join(""); after = progress.next;
        if (!progress.more && !["pending", "running"].includes(progress.status)) return { progress, text };
        await wait(500);
      }
      throw new Error("run_timeout");
    };
    const pendingFrom = async appId => { for (let i = 0; i < 100; i++) { const found = (await tom.runs.list()).find(row => row.status === "pending" && row.app.id === appId); if (found) return found; await wait(100); } throw new Error("no_request"); };
    await rejects(() => agentApi.runs.submit(ask([[process.execPath, printer, marker("pending")]])), "pending");
    await tom.apps.allow("claude-code"); checks++;
    for (const call of [() => agentApi.status(), () => agentApi.entries.list(), () => agentApi.environment("synthetic-project"), () => agentApi.runs.list(), () => agentApi.runs.approve(randomUUID(), password), () => agentApi.unlock(password), () => agentApi.listLogins()]) { await rejects(call, "forbidden"); checks++; }
    const horizonRuns = await app("horizon", "cosmic", runHome); await rejects(() => horizonRuns.runs.submit(ask([[process.execPath, "-e", ""]])), "not_found");
    await rejects(() => tom.environment("synthetic-project"), "not_found");
    const novaRuns = await app("nova", "cosmic", runHome); assert.equal((await novaRuns.environment("synthetic-project")).VAULT_SYNTHETIC_VALUE === canary, true);
    for (const malformed of [ask([]), ask([[]]), ask([[" "]]), ask([["node", "a\u001bb"]]), { ...ask([["node"]]), cwd: "relative" }, ask([["node"]], ""), ask([["node"]], "synthetic-project", { "A=B": "x" })]) await rejects(() => agentApi.runs.submit(malformed), "invalid");
    checks += 10;

    stage = "agent runs: approval";
    const first = await agentApi.runs.submit(ask([[process.execPath, printer, marker("first"), "literal;$(echo forbidden)&"]]));
    const before = await agentApi.runs.get(first.id); assert.equal(before.status, "pending"); assert.equal(before.chunks.length, 0);
    await wait(300); await assert.rejects(() => readFile(marker("first")));
    const waiting = await tom.runs.list(), summary = waiting.find(row => row.id === first.id);
    assert.equal(summary.app.name, "Claude Code"); assert.deepEqual(summary.short, ["VAULT_SYNTHETIC_SHORT"]); assert.equal(summary.commands[0].at(-1), "literal;$(echo forbidden)&");
    assert.equal(JSON.stringify(waiting).includes(canary), false); checks += 7;
    await tom.runs.approve(first.id, password);
    const ran = await settle(agentApi, first.id);
    assert.equal(ran.progress.status, "done"); assert.equal(ran.progress.commands[0].exit, 0);
    assert.deepEqual(JSON.parse(await readFile(marker("first"), "utf8")), { hasValue: true, literal: "literal;$(echo forbidden)&" });
    for (const form of [canary, encodeURIComponent(canary), Buffer.from(canary).toString("base64"), Buffer.from(canary).toString("base64").replace(/=+$/, "")]) assert.equal(ran.text.includes(form), false);
    for (const shown of [`whole:${MASK}`, `url:${MASK}`, `base64:${MASK}`, `split:${MASK}`, `error:${MASK}`, "short:abc"]) assert.equal(ran.text.includes(shown), true);
    assert.equal(seen.some(response => response.includes(canary)), false);
    await rejects(() => tom.runs.approve(first.id, password), "not_pending"); checks += 15;

    stage = "agent runs: refused, rejected and missing";
    const wrong = await agentApi.runs.submit(ask([[process.execPath, printer, marker("wrong")]]));
    await rejects(() => tom.runs.approve(wrong.id, nextPassword), "locked"); assert.equal((await agentApi.runs.get(wrong.id)).status, "pending"); shift += 2000;
    await rejects(() => tom.runs.approveWithHello(wrong.id, "1"), "not_found"); assert.equal((await agentApi.runs.get(wrong.id)).status, "pending");
    await tom.runs.reject(wrong.id); assert.equal((await agentApi.runs.get(wrong.id)).status, "rejected");
    await rejects(() => tom.runs.approve(wrong.id, password), "not_pending"); await wait(300); await assert.rejects(() => readFile(marker("wrong")));
    const missing = await agentApi.runs.submit(ask([[process.execPath, printer, marker("missing")]], "synthetic-missing"));
    assert.equal((await tom.runs.list()).find(row => row.id === missing.id).problem, "missing");
    await rejects(() => tom.runs.approve(missing.id, password), "not_found"); const missed = await agentApi.runs.get(missing.id);
    assert.equal(missed.status, "failed"); assert.equal(missed.reason, "not_found"); await assert.rejects(() => readFile(marker("missing")));
    const others = await tom.runs.submit(ask([[process.execPath, "-e", ""]])); await rejects(() => agentApi.runs.get(others.id), "not_found"); await tom.runs.reject(others.id);
    await rejects(() => tom.runs.approve(randomUUID(), password), "not_found"); await rejects(() => agentApi.runs.get("synthetic"), "invalid"); checks += 15;

    stage = "agent runs: failing, timed out and stopped";
    const failing = await agentApi.runs.submit(ask([[process.execPath, "-e", "process.exit(3)"], [process.execPath, printer, marker("skipped")]]));
    await tom.runs.approve(failing.id, password); const failed = (await settle(agentApi, failing.id)).progress;
    assert.equal(failed.status, "failed"); assert.equal(failed.commands[0].exit, 3); assert.equal(failed.commands[1].status, "skipped"); await assert.rejects(() => readFile(marker("skipped")));
    const slow = await agentApi.runs.submit(ask([[process.execPath, "-e", "setTimeout(() => {}, 20000)"]]));
    await tom.runs.approve(slow.id, password); const timed = (await settle(agentApi, slow.id)).progress;
    assert.equal(timed.status, "failed"); assert.equal(timed.commands[0].reason, "timeout");
    const stopping = await agentApi.runs.submit(ask([[process.execPath, "-e", "setTimeout(() => {}, 20000)"], [process.execPath, printer, marker("after-stop")]]));
    await tom.runs.approve(stopping.id, password); await wait(300); await tom.runs.reject(stopping.id);
    const stopped = (await settle(agentApi, stopping.id)).progress;
    assert.equal(stopped.status, "stopped"); assert.equal(stopped.commands[0].status, "stopped"); assert.equal(stopped.commands[1].status, "skipped"); await assert.rejects(() => readFile(marker("after-stop")));
    const absent = await agentApi.runs.submit(ask([["vault-synthetic-missing-command"]])); await tom.runs.approve(absent.id, password);
    assert.equal((await settle(agentApi, absent.id)).progress.commands[0].reason, process.platform === "win32" ? "not_found" : "not_started"); checks += 11;
    if (process.platform === "win32") {
      stage = "agent runs: Windows batch files";
      const argsPrinter = join(scratch, "args.mjs"), shim = join(scratch, "synthetic-args.cmd"), pathName = Object.keys(environment).find(name => name.toLowerCase() === "path") ?? "Path";
      await writeFile(argsPrinter, "process.stdout.write(JSON.stringify(process.argv.slice(2)));"); await writeFile(shim, `@"${process.execPath}" "${argsPrinter}" %*\r\n`);
      const found = await agentApi.runs.submit(ask([["synthetic-args", "plain", "two words", "end\\"]], "synthetic-project", { ...environment, [pathName]: `${scratch};${environment[pathName] ?? ""}` }));
      await tom.runs.approve(found.id, password); const shown = await settle(agentApi, found.id);
      assert.equal(shown.progress.status, "done"); assert.deepEqual(JSON.parse(shown.text), ["plain", "two words", "end\\"]);
      const unsafe = await agentApi.runs.submit(ask([[shim, "a&echo injected"]])); await tom.runs.approve(unsafe.id, password);
      assert.equal((await settle(agentApi, unsafe.id)).progress.commands[0].reason, "unsafe_argument"); checks += 3;
    }

    stage = "redaction across pieces and .env parsing";
    const secret = "synthetic-secret-value", redactor = new Redactor([secret, "abc"]), text = `before ${secret} after abc`;
    for (let cut = 0; cut <= text.length; cut++) { const stream = redactor.stream(); assert.equal(stream.push(text.slice(0, cut)) + stream.push(text.slice(cut)) + stream.end(), `before ${MASK} after abc`); checks++; }
    { const stream = redactor.stream(); let out = ""; for (const char of text) out += stream.push(char); assert.equal(out + stream.end(), `before ${MASK} after abc`); checks++; }
    assert.equal(new Redactor([]).all(text), text);
    const parsed = dotenv(`${String.fromCharCode(0xfeff)}# comment\nexport FIRST=one\nSECOND = "two words" # note\nTHIRD='single # kept'\nFOURTH="line\\nbreak"\nMULTI="first\nsecond"\nUNQUOTED=value # comment\nbad-name=x\nnovalue\n\nEMPTY=\nOPEN="never closed\nFIRST=again\n`);
    assert.deepEqual(parsed.variables, [["FIRST", "again"], ["SECOND", "two words"], ["THIRD", "single # kept"], ["FOURTH", "line\nbreak"], ["MULTI", "first\nsecond"], ["UNQUOTED", "value"], ["EMPTY", ""]]);
    assert.equal(parsed.skipped, 3); assert.throws(() => dotenv(Array.from({ length: 101 }, (_, i) => `NAME_${i}=x`).join("\n")), error => error.code === "limited"); checks += 4;

    stage = ".env import";
    process.env.VAULT_HOME = runHome;
    const lines = [], answers = [], tty = { isTTY: () => true, async ask() { return answers.shift(); }, write(value) { lines.push(value); }, error(value) { lines.push(value); }, out(value) { lines.push(value); }, err(value) { lines.push(value); } };
    const agentLines = [], agentStream = [], agentIo = { isTTY: () => false, async ask() { throw new Error("unexpected_prompt"); }, write(value) { agentLines.push(value); }, error(value) { agentLines.push(value); }, out(value) { agentStream.push(value); }, err(value) { agentStream.push(value); } };
    const envPath = join(scratch, "synthetic.env"), importArgs = ["import", envPath, "--from", "dotenv", "--project", "dotenv-project"];
    await writeFile(envPath, `DOTENV_FIRST=${canary}\nDOTENV_SHORT=abc\n`);
    answers.push("no"); assert.equal(await main(importArgs, tty), 0); assert.equal((await readFile(envPath, "utf8")).includes(canary), true);
    assert.deepEqual(await novaRuns.environment("dotenv-project"), { DOTENV_FIRST: canary, DOTENV_SHORT: "abc" });
    await writeFile(envPath, `DOTENV_FIRST=${backupPassword}\nDOTENV_NEW=added\n`);
    answers.push("yes"); assert.equal(await main(importArgs, tty), 0); await assert.rejects(() => readFile(envPath));
    assert.deepEqual(await novaRuns.environment("dotenv-project"), { DOTENV_FIRST: backupPassword, DOTENV_SHORT: "abc", DOTENV_NEW: "added" });
    assert.equal(lines.some(line => line.includes("1 new, 1 changed, 0 the same, 1 kept from before")), true);
    await writeFile(envPath, "DOTENV_LATER=x\n"); assert.equal(await main(importArgs, agentIo), 0); assert.equal(await readFile(envPath, "utf8"), "DOTENV_LATER=x\n");
    assert.equal([...lines, ...agentLines].join("\n").includes(canary), false); checks += 8;

    stage = "agent runs through the command line";
    const running = main(["run", "--agent", "claude-code", "--project", "synthetic-project", "--", process.execPath, printer, marker("cli")], agentIo);
    const request = await pendingFrom("claude-code"); await assert.rejects(() => readFile(marker("cli")));
    await tom.runs.approve(request.id, password); assert.equal(await running, 0);
    assert.equal(agentStream.join("").includes(canary), false); assert.equal(agentStream.join("").includes(`whole:${MASK}`), true);
    assert.equal(agentLines.some(line => line.includes("vault approve")), true); assert.equal(JSON.parse(await readFile(marker("cli"), "utf8")).hasValue, true);
    const queued = main(["run", "--agent", "claude-code", "--project", "synthetic-project", "--", process.execPath, printer, marker("approved")], agentIo);
    await pendingFrom("claude-code"); answers.push("yes", password); assert.equal(await main(["approve"], tty), 0); assert.equal(await queued, 0);
    assert.equal(lines.some(line => line.startsWith("Claude Code asks to run 1 command with the values of \"synthetic-project\".")), true);
    assert.equal(lines.some(line => line.startsWith("Shown as they are in the output, shorter than 4 characters: VAULT_SYNTHETIC_SHORT")), true);
    assert.equal(lines.some(line => line.startsWith("Approved.")), true); assert.equal(JSON.parse(await readFile(marker("approved"), "utf8")).hasValue, true);
    const refused = main(["run", "--agent", "claude-code", "--project", "synthetic-project", "--", process.execPath, printer, marker("refused")], agentIo);
    const refusedRequest = await pendingFrom("claude-code"); assert.equal(await main(["reject", refusedRequest.id], tty), 0); assert.equal(await refused, 1);
    assert.equal(agentLines.some(line => line.startsWith("The request was rejected.")), true); await assert.rejects(() => readFile(marker("refused")));
    assert.equal(await main(["approve"], agentIo), 1);
    for (const args of [["run", "--project", "synthetic-project"], ["run", "--project", "synthetic-project", "--batch", "f.json", "--", "node"], ["run", "--attach", randomUUID(), "--project", "synthetic-project"], ["run", "--agent", "Bad Id", "--project", "synthetic-project", "--", "node"]]) assert.equal(await main(args, tty), 2);
    answers.push(password); lines.length = 0;
    assert.equal(await main(["run", "--project", "synthetic-project", "--", process.execPath, printer, marker("person"), "literal;$(echo forbidden)&"], tty), 0);
    assert.deepEqual(JSON.parse(await readFile(marker("person"), "utf8")), { hasValue: true, literal: "literal;$(echo forbidden)&" }); assert.equal(lines.join("").includes(canary), false);
    const batchFile = join(scratch, "batch.json"); await writeFile(batchFile, JSON.stringify([[process.execPath, "-e", "process.stdout.write('one')"], [process.execPath, "-e", "process.stdout.write('two')"]]));
    answers.push(password); lines.length = 0; assert.equal(await main(["run", "--project", "synthetic-project", "--batch", batchFile], tty), 0); assert.equal(lines.join("").includes("onetwo"), true);
    assert.equal(agentStream.join("").includes(canary) || agentLines.join("").includes(canary), false); checks += 22;

    stage = "expired run";
    const later = await connect({ home: runHome, app: { id: "codex", name: "Codex", kind: "agent" }, tokens: memoryTokens() }); clients.push(later); await tom.apps.allow("codex");
    const late = await later.runs.submit(ask([[process.execPath, printer, marker("late")]])); shift += 10 * 60 * 1000;
    assert.equal((await later.runs.get(late.id)).status, "expired"); await tom.present(); await rejects(() => tom.runs.approve(late.id, password), "expired");
    await wait(300); await assert.rejects(() => readFile(marker("late")));
    const runLogs = await readFile(join(runHome, "logs", "events.jsonl"), "utf8"), runStore = await tree(join(runHome, "store"));
    for (const hidden of [canary, password, backupPassword]) { assert.equal(runLogs.includes(hidden), false); assert.equal(runStore.includes(hidden), false); }
    assert.equal(runLogs.includes("run_approve"), true); assert.equal(runLogs.includes("run_request"), true);
    process.env.VAULT_HOME = home; checks += 11;
  }

  stage = "bounded rate and secret-free records";
  now += 60000; let limitedResponse;
  for (let i = 0; i < 242; i++) { const value = await probe(service, "/v1/health", { headers: { "X-Forwarded-For": `192.0.2.${i % 200}` } }); if (value.status === 429) { limitedResponse = value; break; } assert.equal(value.status, 200); }
  assert.equal(limitedResponse?.status, 429); assert.equal(limitedResponse.headers.get("retry-after"), "60");
  const persisted = await tree(join(home, "store")), logs = await readFile(join(home, "logs", "events.jsonl"), "utf8");
  for (const secret of [password, nextPassword, canary, created.recovery, recovered.recovery, cliTokens.token(), bootstrap]) { assert.equal(persisted.includes(secret), false); assert.equal(logs.includes(secret), false); }
  assert.equal(logs.includes("rate_limited"), true); assert.equal(logs.includes("browser_refused"), true); checks += 15;

  stage = "discovery and detached startup";
  const discoveryHome = join(scratch, "discovery"); process.env.VAULT_HOME = discoveryHome;
  assert.equal(await main(["dev-install"], io), 0); assert.equal(await findService(discoveryHome), undefined);
  // With VAULT_HOME set the launcher is written but the user Path is left alone.
  { const launcher = await readFile(join(discoveryHome, "bin", process.platform === "win32" ? "vault.cmd" : "vault"), "utf8"); assert.equal(launcher.includes(join("cli", "src", "main.ts")), true); assert.equal(launcher.includes(process.execPath), true); checks += 2; }
  {
    const installPath = join(discoveryHome, "install.json"), install = JSON.parse(await readFile(installPath, "utf8"));
    // dev-install records the helper where there is one, and a malformed field stops startup as a malformed command does.
    if (process.platform === "win32") { assert.equal(install.helper, fileURLToPath(new URL("../../helper/bin/vault-helper.exe", import.meta.url))); assert.equal((await stat(install.helper)).isFile(), true); } else assert.equal(install.helper, undefined);
    for (const bad of [5, null, "", "relative.exe"]) { await writeFile(installPath, JSON.stringify({ ...install, helper: bad })); await rejects(() => ensureRunning(discoveryHome), "invalid_install"); }
    checks += 5;
    // The optional app is held to the same rule as the helper. An absolute path is accepted, and the service then starts as it would without one.
    for (const bad of [5, null, "", "relative.exe"]) { await writeFile(installPath, JSON.stringify({ ...install, app: bad })); await rejects(() => ensureRunning(discoveryHome), "invalid_install"); }
    install.app = process.execPath; checks += 4;
    install.args.unshift("--import", new URL("./privacy-fixture.mjs", import.meta.url).href);
    await writeFile(installPath, JSON.stringify(install));
  }
  stage = "initial detached startup";
  const [first, second] = await Promise.all([ensureRunning(discoveryHome), ensureRunning(discoveryHome)]); assert.equal(first.pid, second.pid); assert.notEqual(first.pid, process.pid); detached.add(first.pid);
  const discovered = await app("vault-cli", "cosmic", discoveryHome); assert.equal((await discovered.status()).created, false); assert.equal((await findService(discoveryHome)).port, first.port);
  await discovered.close(); process.kill(first.pid); for (let i = 0; i < 100; i++) { try { process.kill(first.pid, 0); await wait(50); } catch { detached.delete(first.pid); break; } }
  assert.equal(detached.has(first.pid), false);
  // A new process takes over a dead lease and starts locked with the same hashed grant.
  stage = "dead lease startup";
  const restarted = await ensureRunning(discoveryHome); detached.add(restarted.pid); assert.notEqual(restarted.pid, first.pid); const restartedClient = await app("vault-app", "cosmic", discoveryHome); assert.equal((await restartedClient.status()).unlocked, false); checks += 9;
  stage = "installed layout";
  {
    // The staging script lays out a copy of Node, the compiled JavaScript, the helper and the licence. None of it is TypeScript or a development dependency.
    const staged = join(scratch, "stage"), installHome = join(scratch, "installed"), win = process.platform === "win32", installPath = join(installHome, "install.json");
    const nodeExe = join(staged, win ? "node.exe" : "node"), cliJs = join(staged, "lib", "cli", "src", "main.js"), serviceJs = join(staged, "lib", "service", "src", "main.js"), helperExe = join(staged, "lib", "helper", "bin", "vault-helper.exe");
    const built = spawnSync(process.execPath, [fileURLToPath(new URL("../../../scripts/stage.mjs", import.meta.url)), staged], { windowsHide: true, encoding: "utf8" });
    assert.equal(built.status, 0);
    const names = [], walk = async folder => { for (const item of await readdir(folder, { withFileTypes: true })) { const path = join(folder, item.name); if (item.isDirectory()) await walk(path); else names.push(relative(staged, path).split(sep).join("/")); } };
    await walk(staged);
    for (const needed of [win ? "node.exe" : "node", "LICENSE", "README.md", "lib/package.json", "lib/cli/src/main.js", "lib/service/src/main.js", "lib/client/src/index.js", "lib/node_modules/vault-core/package.json", "lib/node_modules/vault-core/dist/index.js"]) assert.equal(names.includes(needed), true);
    assert.equal(names.some(name => name.endsWith(".ts")), false); assert.equal(names.some(name => /(^|\/)(typescript|@types|undici-types)\//.test(name)), false);
    assert.equal((await stat(nodeExe)).size, (await stat(process.execPath)).size); checks += 13;
    if (win) { assert.equal((await stat(helperExe)).size, (await stat(fileURLToPath(new URL("../../helper/bin/vault-helper.exe", import.meta.url)))).size); checks++; }
    // A development checkout is not an installed copy, and the installed one is found from where it sits.
    assert.equal(layout(), undefined);
    assert.deepEqual(layout(pathToFileURL(join(staged, "lib", "cli", "src", "install.js")).href), { root: staged, node: nodeExe, cli: cliJs, service: serviceJs, ...win ? { helper: helperExe } : {} }); checks += 2;
    // The installed copy runs as a person would run it: its own Node on its own CLI, from another folder, with no terminal. Only the ACL step is answered by the test fixture.
    const fixture = new URL("./privacy-fixture.mjs", import.meta.url).href, bin = join(installHome, "bin"), launcherPath = join(bin, win ? "vault.cmd" : "vault");
    const installed = (args, extra = {}) => spawnSync(nodeExe, ["--import", fixture, cliJs, ...args], { cwd: scratch, windowsHide: true, encoding: "utf8", input: "", env: { ...process.env, VAULT_HOME: installHome, LC_ALL: "en", ...extra } });
    const record = async () => JSON.parse(await readFile(installPath, "utf8"));
    let result = installed(["status"]); assert.equal(result.status, 0); assert.equal(result.stdout.trim(), "Vault is stopped."); checks += 2;

    const previousHome = process.env.VAULT_HOME, previousLocale = process.env.LC_ALL; process.env.VAULT_HOME = installHome; prompts.length = 0;
    try {
      errors.length = 0; assert.equal(await main(["install"], io), 1); assert.deepEqual(errors, ["Run vault install from an installed copy of Vault."]);
      process.env.LC_ALL = "es"; errors.length = 0; assert.equal(await main(["install"], io), 1); assert.deepEqual(errors, ["vault install se ejecuta desde una copia instalada de Vault."]); process.env.LC_ALL = "en";
      for (const args of [["install", "x"], ["install", "--app"], ["install", "--app", "a", "b"], ["uninstall", "--keep"], ["uninstall", "--remove-data", "x"]]) assert.equal(await main(args, io), 2);
      await assert.rejects(() => stat(installHome)); checks += 10;

      stage = "installed layout: install";
      result = installed(["install"]); assert.equal(result.status, 0); assert.equal(result.stdout, `Vault is installed. Add ${bin} to PATH to use vault.\n`);
      assert.deepEqual(await record(), { version: 1, command: nodeExe, args: [serviceJs], ...win ? { helper: helperExe } : {} });
      assert.equal(await readFile(launcherPath, "utf8"), win ? `@setlocal & set "VAULT_LAUNCHER=1" & "${nodeExe}" "${cliJs}" %*\r\n` : `#!/bin/sh\nexec '${nodeExe}' '${cliJs}' "$@"\n`); checks += 4;
      // The app is recorded when it is named or sits beside the installed copy, and only when it is a file.
      result = installed(["install", "--app", join(scratch, "missing-app.exe")]); assert.equal(result.status, 2); assert.equal((await record()).app, undefined);
      result = installed(["install", "--app", nodeExe]); assert.equal(result.status, 0); assert.equal((await record()).app, nodeExe);
      if (win) { const beside = join(staged, "Vault.exe"); await writeFile(beside, "synthetic"); result = installed(["install"]); assert.equal(result.status, 0); assert.equal((await record()).app, beside); await rm(beside); checks += 2; }
      result = installed(["install"]); assert.equal(result.status, 0); assert.equal((await record()).app, undefined); checks += 6;

      stage = "installed layout: service";
      // The recorded command starts the installed service, which resolves vault-core from the installed copy.
      const entry = await record(); entry.args.unshift("--import", fixture); await writeFile(installPath, JSON.stringify(entry));
      const running = await ensureRunning(installHome); detached.add(running.pid); assert.equal((await findService(installHome)).pid, running.pid);
      result = installed(["status"]); assert.equal(result.status, 0); assert.equal(result.stdout.trim(), "Vault is not created."); assert.equal((await findService(installHome)).pid, running.pid); checks += 4;
      result = installed(["uninstall", "--remove-data"]); assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.equal(result.stderr.includes("A terminal is required"), true);
      assert.equal((await findService(installHome)).pid, running.pid); await stat(bin); await stat(installPath); checks += 6;

      stage = "installed layout: uninstall";
      result = installed(["uninstall"]); assert.equal(result.status, 0); assert.equal(result.stdout, `Vault is uninstalled. Your data was kept.\nRemove ${bin} from PATH if you added it.\n`);
      await assert.rejects(() => stat(bin)); await assert.rejects(() => stat(installPath)); await stat(join(installHome, "store")); await stat(join(installHome, "secrets", "bootstrap.key"));
      assert.equal(await findService(installHome), undefined); let alive = true; for (let i = 0; i < 100 && alive; i++) { try { process.kill(running.pid, 0); await wait(50); } catch { alive = false; } }
      assert.equal(alive, false); detached.delete(running.pid);
      result = installed(["uninstall"]); assert.equal(result.status, 0); checks += 9;

      stage = "installed layout: remove the data";
      const asked = [], asking = { ...io, async ask(label) { asked.push(label); return prompts.shift(); } };
      errors.length = 0; prompts.push("delete"); assert.equal(await main(["uninstall", "--remove-data"], asking), 1); assert.deepEqual(errors, ["Cancelled."]); await stat(installHome);
      assert.equal(asked[0], `This deletes ${installHome}, with your vault and all its data, for good. Type DELETE to continue: `);
      process.env.LC_ALL = "es"; errors.length = 0; prompts.push("DELETE"); assert.equal(await main(["uninstall", "--remove-data"], asking), 1); assert.deepEqual(errors, ["Cancelado."]); await stat(installHome);
      assert.equal(asked[1], `Esto borra ${installHome}, con la bóveda y todos sus datos, para siempre. Para seguir, escribir BORRAR: `); process.env.LC_ALL = "en";
      output.length = 0; prompts.push(" DELETE "); assert.equal(await main(["uninstall", "--remove-data"], asking), 0); assert.deepEqual(output, ["Vault is uninstalled and its data deleted.", `Remove ${bin} from PATH if you added it.`]); await assert.rejects(() => stat(installHome));
      result = installed(["install"]); assert.equal(result.status, 0); await stat(installPath);
      process.env.LC_ALL = "es"; output.length = 0; prompts.push("BORRAR"); assert.equal(await main(["uninstall", "--remove-data"], asking), 0); assert.equal(output[0], "Se desinstaló Vault y se borraron sus datos."); await assert.rejects(() => stat(installHome)); process.env.LC_ALL = "en";
      assert.equal(asked.length, 4); assert.equal(prompts.length, 0); await assert.rejects(() => uninstall(parse(scratch).root, true), error => error?.code === "invalid"); checks += 19;
    } finally { process.env.VAULT_HOME = previousHome; if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale; }
  }
  stage = "locked disconnected shutdown";
  let clock = 0;
  const idleHome = join(scratch, "idle-home"), idle = await startService({ home: idleHome, now: () => clock }); services.push(idle);
  clock = DISCONNECTED_MS - 1; await idle.checkLifecycle(); assert.equal(idle.server.listening, true);
  const session = randomUUID(); idle.lifecycle.present("synthetic", session);
  clock += 30000; idle.lifecycle.present("synthetic", session); await idle.checkLifecycle(); assert.equal(idle.server.listening, true);
  idle.lifecycle.leave("synthetic", session);
  clock += DISCONNECTED_MS - 1; await idle.checkLifecycle(); assert.equal(idle.server.listening, true);
  clock++; await idle.checkLifecycle(); assert.equal(idle.server.listening, false);
  await assert.rejects(() => readFile(join(idleHome, "run", "service.json")));
  await assert.rejects(() => readFile(join(idleHome, "run", "service.lock")));
  let expiryClock = 0; const memory = new VaultMemory(() => expiryClock, null), leases = new Lifecycle(memory, () => expiryClock, 100);
  memory.open(sourceKey, memory.ticket()); expiryClock = DISCONNECTED_MS; assert.equal(leases.shouldExit(), false);
  leases.present("synthetic", randomUUID()); expiryClock += 100 + DISCONNECTED_MS - 1; assert.equal(leases.shouldExit(), false);
  expiryClock++; assert.equal(leases.shouldExit(), true);
  checks += 9;
  stage = "horizon hold and login list";
  {
    let held = 0;
    const holdHome = join(scratch, "hold-home"), keeper = await startService({ home: holdHome, now: () => held, idleMs: 5000, presenceMs: 60000 }); services.push(keeper);
    const step = async ms => { for (let spent = 0; spent < ms; spent += 1000) { held += 1000; keeper.lifecycle.check(); } };
    const open = () => { try { keeper.vault.memory.get(keeper.vault.memory.ticket()); return true; } catch { return false; } };
    const horizonTokens = tokenStore(), horizonApp = await connect({ home: holdHome, app: { id: "horizon", name: "Synthetic app", kind: "cosmic" }, tokens: horizonTokens }); clients.push(horizonApp);
    const admin = await app("vault-cli", "cosmic", holdHome); await admin.create(password);
    const loginA = entry("login"), loginB = entry("login", "https://two.example"), secretEnv = entry("env"), secretNote = entry("note");
    loginA.title = "First login"; loginA.note = "synthetic-note"; loginA.totp = "synthetic-totp"; loginB.title = "Second login"; loginB.fields.find(field => field.id === "username").value = "other-user";
    loginA.fields.push({ id: "extra", name: "Extra", value: "synthetic-extra", secret: true });
    for (const value of [loginA, loginB, secretEnv, secretNote]) await admin.entries.save(value, 0);
    const novaApp = await app("nova", "cosmic", holdHome);
    const listed = await horizonApp.listLogins(), byId = new Map(listed.map(row => [row.id, row]));
    assert.equal(listed.length, 2); assert.deepEqual(Object.keys(listed[0]).sort(), ["id", "title", "username", "version", "website"]);
    assert.deepEqual(byId.get(loginA.id), { id: loginA.id, version: 1, title: "First login", username: "synthetic-user", website: "https://one.example/login" });
    assert.equal(byId.get(loginB.id).username, "other-user"); assert.equal(byId.has(secretEnv.id) || byId.has(secretNote.id), false);
    for (const hidden of [canary, "synthetic-note", "synthetic-totp", "synthetic-extra"]) assert.equal(JSON.stringify(listed).includes(hidden), false);
    assert.equal((await admin.listLogins()).length, 2); assert.equal((await horizonApp.logins("https://one.example")).length, 1); checks += 11;
    const read = await horizonApp.getLogin(loginA.id.toUpperCase());
    assert.equal(read.version, 1); assert.equal(read.entry.fields.find(field => field.id === "password").value, canary); assert.equal(read.entry.note, "synthetic-note");
    await rejects(() => horizonApp.getLogin(secretEnv.id), "not_found"); await rejects(() => horizonApp.getLogin(secretNote.id), "not_found");
    await rejects(() => horizonApp.getLogin(randomUUID()), "not_found"); await rejects(() => admin.getLogin(secretEnv.id), "not_found"); await rejects(() => horizonApp.getLogin("synthetic"), "invalid");
    await rejects(() => novaApp.listLogins(), "not_found"); await rejects(() => novaApp.getLogin(loginA.id), "not_found"); await rejects(() => novaApp.getLogin(secretEnv.id), "not_found");
    const horizonAuth = `Bearer ${horizonTokens.token()}`;
    assert.equal((await probe(keeper, "/v1/logins/all?site=one", { auth: horizonAuth })).status, 400); assert.equal((await probe(keeper, "/v1/logins/get", { auth: horizonAuth })).status, 400);
    assert.equal((await probe(keeper, "/v1/apps/present", { method: "POST", auth: horizonAuth, body: { session: randomUUID(), hold: true } })).status, 400); checks += 14;

    stage = "horizon hold";
    await admin.close(); assert.equal(keeper.lifecycle.presences.size, 2); await step(30000); assert.equal(open(), true); assert.equal((await horizonApp.listLogins()).length, 2); checks += 3;
    await novaApp.close(); await step(10000); assert.equal(open(), true);
    await horizonApp.close(); assert.equal(open(), false); assert.equal(keeper.lifecycle.presences.size, 0); checks += 3;
    const expiring = await app("horizon", "cosmic", holdHome); await expiring.unlock(password); assert.equal(open(), true);
    await step(59000); assert.equal(open(), true); assert.equal(keeper.lifecycle.presences.size, 1);
    await step(1000); assert.equal(open(), false); assert.equal(keeper.lifecycle.presences.size, 0); await rejects(() => expiring.listLogins(), "locked"); checks += 6;
    const alone = await app("nova", "cosmic", holdHome); await alone.unlock(password); await step(4000); assert.equal(open(), true);
    await step(1000); assert.equal(open(), false); assert.equal(keeper.lifecycle.presences.size, 1); checks += 3;
    const leaving = await app("horizon", "cosmic", holdHome); await alone.unlock(password); await step(10000); assert.equal(open(), true);
    await leaving.close(); assert.equal(open(), true); await step(4000); assert.equal(open(), true); await step(1000); assert.equal(open(), false); checks += 4;
    let tick = 0; const frozen = new VaultMemory(() => tick, 100), holder = new Lifecycle(frozen, () => tick, 60000);
    frozen.open(sourceKey, frozen.ticket()); holder.present("horizon", randomUUID()); tick = 100; holder.check();
    assert.equal(frozen.touch(), false); assert.throws(() => frozen.get(frozen.ticket())); tick = 120; holder.check(); assert.throws(() => frozen.get(frozen.ticket())); checks += 3;
  }
  console.log(`Vault service: ${checks} checks passed.`);
  // Run the other regressions even when this OS refuses DPAPI, but never count a skip as success.
  if (dpapiFailure) { stage = "DPAPI synthetic round trip"; throw new Error("dpapi_round_trip_failed"); }
  if (aclFailure) { stage = "real ACL on a temporary folder"; throw new Error("acl_failed"); }
} catch (error) {
  const cause = ["locked", "unavailable", "busy", "rate_limited", "limited", "not_found", "conflict", "invalid", "internal", "expired", "not_pending"].includes(error?.code) ? error.code : error?.name === "AssertionError" ? "assertion" : "operation";
  console.error(`Vault service check failed at ${stage}: ${cause}.`); throw error;
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  for (const service of services) await service.shutdown();
  for (const pid of detached) { try { process.kill(pid); } catch {} }
  await wait(200);
  if (originalHome === undefined) delete process.env.VAULT_HOME; else process.env.VAULT_HOME = originalHome;
  assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true });
}
