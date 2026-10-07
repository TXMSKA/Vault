import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, open } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import { startService } from "../src/server.ts";
import { routes, validateRoutes } from "../src/routes.ts";
import { csv, parseImport } from "../src/imports.ts";
import { xml } from "../src/xml.ts";
import { dpapi } from "../src/hello.ts";
import { Lifecycle, DISCONNECTED_MS } from "../src/lifecycle.ts";
import { defaultRoots } from "../../../test/guard.mjs";
import { resolveHome } from "../../client/src/paths.ts";
import { connect, ensureRunning, findService, VaultClientError, readCapped } from "../../client/dist/index.js";
import { newEntry, encrypt, decrypt, FileVaultStore, defaultVaultFolder, VaultMemory } from "vault-core";
import { main } from "../../cli/src/main.ts";

const parent = resolve(".test-tmp"); await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(join(parent, "service-")), home = join(scratch, "home");
const originalHome = process.env.VAULT_HOME; process.env.VAULT_HOME = home;
await import("./privacy-fixture.mjs");
const services = [], clients = [], detached = new Set(); let checks = 0, stage = "setup", now = 10000, dpapiFailure = false;
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
  await rejects(() => cli.apps.allow("synthetic-agent"), "forbidden"); await rejects(() => cli.apps.allow("lyra"), "forbidden");
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
  const output = [], errors = [], prompts = [], io = { isTTY: () => true, async ask() { return prompts.shift(); }, write(value) { output.push(value); }, error(value) { errors.push(value); } };
  const resultFile = join(scratch, "child-result.json"), childPath = join(scratch, "child.mjs");
  const childCode = "import fs from 'node:fs'; const good = !!process.env.VAULT_SYNTHETIC_VALUE && process.argv[3] === 'literal;$(echo forbidden)&'; fs.writeFileSync(process.argv[2],JSON.stringify({good,hasValue:!!process.env.VAULT_SYNTHETIC_VALUE}));";
  await writeFile(childPath, childCode);
  const runArgs = ["run", "--project", "synthetic-project", "--", process.execPath, childPath, resultFile];
  for (const command of [runArgs, ["get", one.id, "password", "--reveal"]]) {
    const stdinPath = join(scratch, `stdin-${randomUUID()}`), stdoutPath = join(scratch, `stdout-${randomUUID()}`), stderrPath = join(scratch, `stderr-${randomUUID()}`);
    await writeFile(stdinPath, "", { mode: 0o600 });
    const handles = [await open(stdinPath, "r"), await open(stdoutPath, "wx", 0o600), await open(stderrPath, "wx", 0o600)];
    try {
      // Regular file input proves non-TTY refusal without Windows sandbox pipe creation.
      const child = spawn(process.execPath, ["--import", new URL("../../../test/guard.mjs", import.meta.url).href, fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)), ...command], { windowsHide: true, stdio: handles.map(file => file.fd), env: { ...process.env, VAULT_HOME: join(scratch, "unattended"), LC_ALL: "en" } });
      detached.add(child.pid);
      const status = await new Promise((done, fail) => { child.once("error", fail); child.once("exit", done); }); detached.delete(child.pid);
      const stdout = await readFile(stdoutPath, "utf8"), stderr = await readFile(stderrPath, "utf8");
      assert.equal(status, 1); assert.equal(stdout.length, 0); assert.equal(stderr.includes("A terminal is required"), true);
      assert.equal(stderr.includes(canary), false); checks += 4;
    } finally { for (const handle of handles) await handle.close(); }
  }
  const noTerminal = { ...io, isTTY: () => false, async ask() { throw new Error("unexpected_prompt"); } };
  assert.equal(await main(runArgs, noTerminal), 1);
  assert.equal(await main(["get", one.id, "password", "--reveal"], noTerminal), 1);
  assert.equal(await main(["get", one.id, "password"], noTerminal), 0);
  assert.equal(output.join().includes(canary), false); output.length = 0;
  prompts.push("no"); assert.equal(await main(runArgs, io), 1);
  prompts.push("no"); assert.equal(await main(["get", one.id, "password", "--reveal"], io), 1);
  await assert.rejects(() => readFile(resultFile)); errors.length = 0;
  prompts.push("yes"); assert.equal(await main(["get", one.id, "password", "--reveal"], io), 0);
  assert.equal(output.length, 1); assert.equal(output[0] === canary, true); output.length = 0;
  prompts.push("yes"); assert.equal(await main(["get", one.id, "--reveal"], io), 0);
  assert.equal(output.length, 1); assert.equal(output[0] === canary, true); output.length = 0; checks += 3;
  const previousLocale = process.env.LC_ALL;
  try {
    process.env.LC_ALL = "es"; prompts.push("sí");
    assert.equal(await main(["get", one.id, "password", "--reveal"], io), 0);
    assert.equal(output.length, 1); assert.equal(output[0] === canary, true); output.length = 0; checks += 3;
  } finally { if (previousLocale === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previousLocale; }
  prompts.push("yes");
  assert.equal(await main(["run", "--project", "synthetic-project", "--", process.execPath, childPath, resultFile, "literal;$(echo forbidden)&"], io), 0);
  const result = JSON.parse(await readFile(resultFile, "utf8")); assert.deepEqual(result, { good: true, hasValue: true });
  assert.equal(output.join().includes(canary), false); assert.equal(errors.length, 0);
  const kitPath = join(scratch, "kit.txt"); process.env.VAULT_HOME = join(scratch, "cli-home"); const kitService = await startService({ home: process.env.VAULT_HOME }); services.push(kitService);
  prompts.push(password, password); assert.equal(await main(["create", "--kit", kitPath], io), 0); assert.match(await readFile(kitPath, "utf8"), /Recovery kit/);
  const savedRecovery = (await readFile(kitPath, "utf8")).split("\n")[4]; assert.equal(output.join().includes(savedRecovery), false);
  assert.equal((await kitService.vault.store.envelope()).version, 1);
  process.env.VAULT_HOME = home; checks += 19;

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
  {
    const installPath = join(discoveryHome, "install.json"), install = JSON.parse(await readFile(installPath, "utf8"));
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
  console.log(`Vault service: ${checks} checks passed.`);
  // Run the other regressions even when this OS refuses DPAPI, but never count a skip as success.
  if (dpapiFailure) { stage = "DPAPI synthetic round trip"; throw new Error("dpapi_round_trip_failed"); }
} catch (error) {
  console.error(`Vault service check failed at ${stage}.`); throw error;
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  for (const service of services) await service.shutdown();
  for (const pid of detached) { try { process.kill(pid); } catch {} }
  await wait(200);
  if (originalHome === undefined) delete process.env.VAULT_HOME; else process.env.VAULT_HOME = originalHome;
  assert.equal(dirname(scratch), parent); await rm(scratch, { recursive: true, force: true });
}
