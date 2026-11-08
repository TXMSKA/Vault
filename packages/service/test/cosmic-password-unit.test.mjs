import "./privacy-fixture.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { newEntry } from "vault-core";
import { Apps, cosmicCaller, hashToken } from "../src/secrets.ts";
import { ServiceError } from "../src/errors.ts";
import { providerOrigin } from "../src/server.ts";
import { quantumUrl } from "../src/quantum.ts";
import { selectCosmicLogin } from "../src/vault.ts";
import { cosmicSite, serviceEnv } from "../../client/src/paths.ts";
import { VaultClientError } from "../../client/src/errors.ts";

const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, "service-cosmic-unit-"));
const password = ` spaced ${randomBytes(8).toString("hex")} 密碼 `;
let checks = 0, stage = "selector";
const check = Object.fromEntries(["equal", "deepEqual", "rejects"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
const same = (actual, expected) => check.equal(actual === expected, true);
const login = (website, username, secret, kind = "login") => {
  const entry = newEntry(kind); entry.title = "Synthetic";
  const values = { website, username, password: secret, key: secret };
  for (const field of entry.fields) if (values[field.id] !== undefined) field.value = values[field.id];
  return entry;
};
const names = ["VAULT_QUANTUM_SITE", "VAULT_QUANTUM_API", "VAULT_HELPER", "NODE_OPTIONS"];
const savedEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
const restoreEnv = () => { for (const name of names) if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]; delete process.env.VAULT_SECRET; };
try {
  const origin = "https://accounts.example", email = "person@example.invalid", other = "other@example.invalid";
  const good = login(`${origin}/account`, email, password);
  same(selectCosmicLogin([], email, origin).status, "none");
  same(selectCosmicLogin([good], email, origin).password, password);
  check.equal(selectCosmicLogin([good], email, origin).status, "available");
  const reversed = login(`${origin}/login`, email, password); reversed.fields.reverse();
  same(selectCosmicLogin([reversed], email, origin).password, password);
  const crowded = selectCosmicLogin([good, login(`${origin}:443/account`, email, password)], email, origin);
  check.equal(crowded.status, "conflict"); check.equal(Object.hasOwn(crowded, "password"), false);
  check.equal(selectCosmicLogin([good, login(origin, email, "")], email, origin).status, "available");
  check.equal(selectCosmicLogin([good, login("https://user:secret@accounts.example/account", email, password)], email, origin).status, "available");
  const missing = login(origin, email, password); missing.fields = missing.fields.filter(field => field.id !== "password");
  check.equal(selectCosmicLogin([missing], email, origin).status, "none");
  check.equal(selectCosmicLogin([login(origin, email, password, "note")], email, origin).status, "none");
  check.equal(selectCosmicLogin([login(origin, `${email} `, password)], email, origin).status, "none");
  check.equal(selectCosmicLogin([good], email.toUpperCase(), origin).status, "none");
  check.equal(selectCosmicLogin([good], other, origin).status, "none");
  same(selectCosmicLogin([good, login(origin, other, "other-secret")], other, origin).password, "other-secret");
  for (const website of ["https://user:secret@accounts.example/account", "not a url", "", "http://accounts.example/account", "https://sub.accounts.example/account", "https://accounts.example:8443/account"]) check.equal(selectCosmicLogin([login(website, email, password)], email, origin).status, "none");
  check.equal(selectCosmicLogin([login("http://127.0.0.1/login", email, password)], email, "http://127.0.0.1").status, "available");
  check.equal(selectCosmicLogin([login("http://127.0.0.1:8080/login", email, password)], email, "http://127.0.0.1").status, "none");

  stage = "callers";
  const home = join(scratch, "apps"); await mkdir(join(home, "secrets"), { recursive: true });
  const apps = new Apps(home);
  for (const [id, kind, status, appKinds] of [
    ["horizon", "cosmic", "granted", ["login"]], ["nova", "cosmic", "granted", ["env"]], ["lyra", "cosmic", "granted", []],
    ["nebula", "cosmic", "granted", ["login", "card", "doc", "note", "key", "custom", "env"]], ["vault-cli", "cosmic", "granted", ["login", "card", "doc", "note", "key", "custom", "env", "apikey"]],
    ["hivem1nd", "cosmic", "granted", []],
  ]) {
    const created = await apps.register({ id, name: "Synthetic", kind });
    check.equal(created.app.status, status); check.deepEqual(created.app.kinds, appKinds); check.equal(cosmicCaller(created.app), ["horizon", "nova", "lyra", "nebula", "hivem1nd"].includes(id));
  }
  const host = apps.list().find(row => row.id === "hivem1nd"); check.deepEqual(host.permissions, []);
  const hostHash = JSON.parse(await readFile(join(home, "secrets", "apps.json"), "utf8")).find(row => row.app.id === "hivem1nd").tokenHash;
  await check.rejects(() => apps.register({ id: "hivem1nd", name: "ONEM1ND", kind: "agent" }), error => error instanceof ServiceError && error.code === "invalid");
  same(JSON.parse(await readFile(join(home, "secrets", "apps.json"), "utf8")).find(row => row.app.id === "hivem1nd").tokenHash, hostHash);
  await check.rejects(() => apps.register({ id: "onem1nd", name: "ONEM1ND", kind: "cosmic" }), error => error.code === "invalid");
  const alias = await apps.register({ id: "onem1nd", name: "ONEM1ND", kind: "app" }); check.equal(alias.app.status, "pending"); check.equal(cosmicCaller(alias.app), false);
  const prefixed = await apps.register({ id: "lyra-worker", name: "Lyra", kind: "app" }); check.equal(prefixed.app.status, "pending"); check.equal(cosmicCaller(prefixed.app), false);
  await check.rejects(() => apps.setStatus("lyra-worker", "granted"), error => error.code === "forbidden");
  const agent = await apps.register({ id: "synthetic-agent", name: "Synthetic", kind: "agent" }); check.equal(cosmicCaller(agent.app), false); check.deepEqual(agent.app.kinds, []);
  const reloaded = new Apps(home); await reloaded.load(); check.deepEqual(reloaded.list().find(row => row.id === "hivem1nd").kinds, []); check.deepEqual(reloaded.list().find(row => row.id === "horizon").kinds, ["login"]);

  stage = "legacy host";
  const tokenHash = hashToken(`legacy-${randomBytes(8).toString("hex")}`);
  const legacy = (status, kind = "app", permissions = ["import"]) => ({ app: { id: "hivem1nd", name: "ONEM1ND", kind, status, kinds: ["login", "note"], permissions }, tokenHash });
  for (const status of ["granted", "pending", "revoked"]) {
    const folder = join(scratch, `legacy-${status}`); await mkdir(join(folder, "secrets"), { recursive: true });
    await writeFile(join(folder, "secrets", "apps.json"), JSON.stringify([legacy(status)]));
    const loaded = new Apps(folder); await loaded.load(); const row = loaded.list()[0];
    check.equal(row.kind, "cosmic"); check.equal(row.status, status); check.deepEqual(row.kinds, []); check.deepEqual(row.permissions, []);
    const stored = JSON.parse(await readFile(join(folder, "secrets", "apps.json"), "utf8"))[0];
    same(stored.tokenHash, tokenHash); check.equal(stored.app.kind, "cosmic"); check.deepEqual(stored.app.permissions, []);
    const again = new Apps(folder); await again.load(); check.equal(again.list()[0].kind, "cosmic"); check.deepEqual(again.list()[0].kinds, []);
  }
  const agentFolder = join(scratch, "legacy-agent"); await mkdir(join(agentFolder, "secrets"), { recursive: true });
  const agentRow = legacy("granted", "agent", []); await writeFile(join(agentFolder, "secrets", "apps.json"), JSON.stringify([agentRow]));
  await check.rejects(() => new Apps(agentFolder).load(), error => error instanceof ServiceError && error.code === "invalid");
  const unchanged = JSON.parse(await readFile(join(agentFolder, "secrets", "apps.json"), "utf8"))[0];
  check.equal(unchanged.app.kind, "agent"); same(unchanged.tokenHash, tokenHash);

  stage = "origin";
  check.equal(providerOrigin({}), "https://cosmic.txmska.com");
  const accepted = ["https://accounts.example", "https://accounts.example/account/", "http://127.0.0.1:8443", "http://localhost:9/account", "https://accounts.example:443"];
  for (const value of accepted) { same(quantumUrl(value), cosmicSite(value)); check.equal(providerOrigin({ VAULT_QUANTUM_SITE: value }), new URL(cosmicSite(value)).origin); }
  check.equal(providerOrigin({ VAULT_QUANTUM_SITE: "https://accounts.example/account/" }), "https://accounts.example");
  check.equal(providerOrigin({ VAULT_QUANTUM_SITE: "http://127.0.0.1:8443" }) === providerOrigin({ VAULT_QUANTUM_SITE: "http://127.0.0.1:8444" }), false);
  check.equal(providerOrigin({ VAULT_QUANTUM_SITE: "https://accounts.example:443" }), "https://accounts.example");
  for (const value of ["http://accounts.example", "http://192.0.2.1", "https://user:secret@accounts.example", "https://accounts.example?x=1", "https://accounts.example#x", "https://accounts.example/path?x=1", "ftp://127.0.0.1", "", "not a url", "http://127.0.0.1:9#x"]) {
    await check.rejects(async () => { throw quantumUrl(value); }, error => error instanceof ServiceError && error.code === "invalid");
    await check.rejects(async () => { throw providerOrigin({ VAULT_QUANTUM_SITE: value }); }, error => error instanceof ServiceError && error.code === "invalid");
    check.equal((() => { try { cosmicSite(value); return false; } catch (error) { return error instanceof VaultClientError && error.code === "invalid"; } })(), true);
  }
  const secret = randomBytes(18).toString("hex");
  process.env.VAULT_QUANTUM_API = "https://api.example"; process.env.NODE_OPTIONS = "--inspect"; process.env.VAULT_HELPER = "C:\\synthetic\\helper.exe"; process.env.VAULT_SECRET = secret; process.env.VAULT_QUANTUM_SITE = "https://accounts.example/account/";
  const forwarded = serviceEnv(join(scratch, "child"));
  check.equal(forwarded.VAULT_HOME, join(scratch, "child")); check.equal(forwarded.VAULT_QUANTUM_SITE, "https://accounts.example/account");
  check.equal(Object.keys(forwarded).some(name => ["VAULT_QUANTUM_API", "NODE_OPTIONS", "VAULT_HELPER", "VAULT_SECRET"].includes(name)), false);
  check.equal(Object.values(forwarded).some(value => String(value).includes(secret)), false);
  delete process.env.VAULT_QUANTUM_SITE; check.equal(Object.hasOwn(serviceEnv(scratch), "VAULT_QUANTUM_SITE"), false);
  process.env.VAULT_QUANTUM_SITE = "http://accounts.example"; await check.rejects(async () => serviceEnv(scratch), error => error instanceof VaultClientError && error.code === "invalid");
  console.log(`Vault cosmic password unit: ${checks} checks passed.`);
} catch (error) {
  console.error(`Vault cosmic password unit failed at ${stage}: ${error instanceof ServiceError || error instanceof VaultClientError ? error.code : "assertion"}.`);
  if (error?.stack) console.error(error.stack.split("\n").filter(line => /^\s+at .*cosmic-password-unit\.test\.mjs:\d+:\d+/.test(line)).join("\n"));
  throw new Error("cosmic password unit check failed");
} finally { restoreEnv(); assert.equal(resolve(scratch).startsWith(parent), true); await rm(scratch, { recursive: true, force: true }); }
