import "../../../test/guard.mjs";
import "../../service/test/privacy-fixture.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEnvelope, encryptJson, newEntry } from "vault-core";
import { connect } from "../../client/dist/index.js";
import { startService } from "../../service/dist/service/src/server.js";
import { createLink, DEFAULTS, IDENTITY } from "../dist/main/link.js";
import { dataFolder, SERVICE_FOLDERS } from "../dist/main/paths.js";
import { counts } from "./units.test.mjs";

// The main process's link to the service: against the real service in this process (at the speed it has, since the service limits an app to 240 calls a minute), and against a stand-in client for what the service cannot be made to do
// on demand (errors, a service that goes away). Every value is synthetic and every home is a temporary folder named so that the ACL stand-in covers it.
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "match", "ok", "rejects"].map(name => [name, (...args) => { counts.checks++; return assert[name](...args); }]));
const scratch = await mkdtemp(join(resolve(tmpdir()), "service-app-")), services = [], clients = [], links = [];
const password = randomBytes(30).toString("base64"), wrong = randomBytes(30).toString("base64"), changed = randomBytes(30).toString("base64"), canary = randomBytes(30).toString("base64");
const wait = ms => new Promise(done => setTimeout(done, ms));
const until = async (predicate, label, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) { const value = await predicate(); if (value) return value; if (Date.now() > end) throw new assert.AssertionError({ message: `Never became true: ${label}` }); await wait(15); }
};
const tokens = () => { let value; return { async get() { return value; }, async set(token) { value = token; } }; };
const as = async (home, id, kind = "cosmic") => { const api = await connect({ home, app: { id, name: `Synthetic ${id}`, kind }, tokens: tokens(), heartbeatMs: 2000 }); clients.push(api); return api; };
const joined = async (home, manager, id, kind = "app") => { const api = await as(home, id, kind); await manager.apps.allow(id); if (kind !== "agent") await api.present(); return api; };
const begin = async name => { const home = join(scratch, name); const service = await startService({ home, prompts: { waitMs: 1000 } }); services.push(service); return { home, service }; };
const open = (home, options = {}) => {
  const link = createLink({ connect: () => connect({ home, app: IDENTITY, tokens: tokens(), heartbeatMs: 2000 }), handle: () => "1", ...options });
  links.push(link); return link;
};
const key = /^[A-HJ-NP-Z2-9]{4}( - [A-HJ-NP-Z2-9]{4}){5}$/;
process.setMaxListeners(60);
try {
  // ---- the real service ---------------------------------------------------------------------------------------------------------------------
  {
    const { home, service } = await begin("one"), arrived = [], changes = [], link = open(home);
    link.onArrival(ids => arrived.push(...ids)); link.onChange(snapshot => changes.push(snapshot.phase));
    check.equal(link.snapshot().phase, "starting"); link.start();
    await until(() => link.snapshot().phase === "ready", "ready");
    // Whether Windows Hello can be used is what the machine's helper says, so only its type is known here.
    check.equal(typeof link.snapshot().helloAvailable, "boolean");
    check.deepEqual({ ...link.snapshot(), helloAvailable: false, prompt: null }, { phase: "ready", problem: null, created: false, unlocked: false, hello: false, helloAvailable: false, settings: DEFAULTS, prompt: null, pending: 0 });
    // The app's own folder is inside the home and is not one the service made.
    const names = await readdir(home);
    check.equal(names.includes("app"), false); check.equal(names.filter(name => !name.includes(".")).every(name => SERVICE_FOLDERS.includes(name)), true); check.equal(SERVICE_FOLDERS.includes("app"), false); check.equal(dataFolder(home), join(home, "app"));
    check.equal(changes.includes("ready"), true);
    // A vault is created with the typed password; the recovery key is held for the sheet until the person is done.
    const made = await link.create(password);
    check.equal(made.ok, true); check.match(made.recovery, key); check.equal(link.recovery(), made.recovery);
    check.equal(link.snapshot().created, true); check.equal(link.snapshot().unlocked, true);
    check.equal((await link.create(password)).ok, false); check.equal(link.recovery(), made.recovery);
    // The key counts as safe once the sheet was saved or printed; a new key starts unsafe again.
    check.equal(link.secured(), false); link.secure(); check.equal(link.secured(), true);
    link.release(); check.equal(link.recovery(), undefined); check.equal(link.secured(), false);
    const manager = await as(home, "vault-cli"), asker = await joined(home, manager, "synthetic-app"), other = await joined(home, manager, "other-app"), agent = await joined(home, manager, "claude-code", "agent");

    // An unlock prompt names the app that asks, by its registered name and id; a wrong password does not answer it, the right one does.
    check.equal((await link.lock()).ok, true); check.equal(link.snapshot().unlocked, false);
    const ticket = await asker.prompts.unlock("synthetic reason");
    await until(() => link.snapshot().prompt?.id === ticket.id, "unlock prompt");
    check.deepEqual(link.snapshot().prompt, { id: ticket.id, kind: "unlock", app: { id: "synthetic-app", name: "Synthetic synthetic-app" }, reason: "synthetic reason", expiresAt: ticket.expiresAt });
    check.deepEqual(arrived, [ticket.id]);
    const missed = await link.unlock(wrong); check.deepEqual(missed, { ok: false, code: "locked" });
    check.equal((await link.unlock(password)).ok, false); // still inside the pause that follows a mistake
    await wait(1100);
    check.deepEqual(await link.unlock(password), { ok: true }); check.equal(link.snapshot().unlocked, true);
    check.deepEqual(await asker.prompts.wait(ticket.id), { state: "done" }); await until(() => link.snapshot().prompt === null, "prompt gone");
    // Windows Hello that is not set up answers a code, and nothing opens.
    await link.lock(); check.deepEqual(await link.unlockWithHello(), { ok: false, code: "not_found" }); check.equal(link.snapshot().unlocked, false);
    // Cancel turns an unlock prompt down: the app that asked hears so.
    const again = await asker.prompts.unlock("synthetic reason"); await until(() => link.snapshot().prompt?.id === again.id, "second unlock prompt");
    check.equal((await link.dismiss(again.id)).ok, true); check.equal(link.snapshot().prompt, null); check.deepEqual(await asker.prompts.wait(again.id), { state: "cancelled" });
    await wait(1100); check.equal((await link.unlock(password)).ok, true);

    // A run: the commands, project and folder as asked, the names too short to hide, and an answer from the person.
    const project = newEntry("env"); project.title = "sprout"; project.fields = [{ id: "DATABASE_URL", name: "DATABASE_URL", secret: true, value: canary }, { id: "DEBUG", name: "DEBUG", secret: true, value: "1" }];
    await manager.entries.save(project, 0);
    const folder = join(scratch, "project"); await mkdir(folder);
    const environment = { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "" };
    const ask = async (name, commands) => (await agent.runs.submit({ project: name, cwd: folder, commands, env: environment })).id;
    const show = [process.execPath, "-e", "console.log('synthetic output ' + (process.env.DATABASE_URL ? 'values' : 'none'))"];
    let id = await ask("sprout", [show, ["npm", "run", "db:seed"]]);
    await until(() => link.snapshot().prompt?.id === id, "run prompt");
    check.deepEqual(link.snapshot().prompt, { id, kind: "run", app: { id: "claude-code", name: "Synthetic claude-code" }, project: "sprout", cwd: folder, commands: [show, ["npm", "run", "db:seed"]], short: ["DEBUG"], problem: null, expiresAt: link.snapshot().prompt.expiresAt });
    check.deepEqual(await link.approveRun(id, wrong), { ok: false, code: "locked" }); check.equal(link.snapshot().prompt?.id, id);
    await wait(1100);
    check.deepEqual(await link.approveRun(id, password), { ok: true });
    const finished = await until(async () => { const progress = await agent.runs.get(id); return progress.status === "done" || progress.status === "failed" ? progress : undefined; }, "run finished");
    check.equal(finished.status === "done" || finished.commands[0].status === "done", true);
    check.ok(finished.chunks.some(chunk => chunk.text.includes("synthetic output values")));
    check.equal(JSON.stringify(finished).includes(canary), false);
    check.equal(link.snapshot().prompt, null);
    // Reject turns a run down: nothing runs. A project that is not in Vault is said so before anything is approved.
    id = await ask("sprout", [show]); await until(() => link.snapshot().prompt?.id === id, "second run prompt");
    check.equal((await link.dismiss(id)).ok, true); check.equal(link.snapshot().prompt, null); check.equal((await agent.runs.get(id)).status, "rejected");
    id = await ask("absent", [show]); await until(() => link.snapshot().prompt?.id === id, "run prompt without a project");
    check.equal(link.snapshot().prompt.problem, "missing"); check.equal((await link.dismiss(id)).ok, true);

    // An app asks to import: the permission goes to that app, as the prompt names it, and only after the password.
    const permit = await asker.permissions.request(); await until(() => link.snapshot().prompt?.id === permit.id, "permission prompt");
    check.deepEqual(link.snapshot().prompt, { id: permit.id, kind: "permission", app: { id: "synthetic-app", name: "Synthetic synthetic-app" }, permission: "import", expiresAt: permit.expiresAt });
    check.deepEqual(await link.allowImport("00000000-0000-4000-8000-00000000dead", password), { ok: false, code: "not_found" });
    check.deepEqual(await link.allowImport(permit.id, wrong), { ok: false, code: "locked" }); check.equal((await asker.apps.self()).permissions.includes("import"), false);
    await wait(1100);
    check.deepEqual(await link.allowImport(permit.id, password), { ok: true });
    check.deepEqual((await asker.apps.self()).permissions, ["import"]); check.deepEqual((await other.apps.self()).permissions, []); check.deepEqual(await asker.prompts.wait(permit.id), { state: "done" });
    await until(() => link.snapshot().prompt === null, "permission answered");
    const denied = await other.permissions.request(); await until(() => link.snapshot().prompt?.id === denied.id, "second permission prompt");
    check.equal((await link.dismiss(denied.id)).ok, true); check.deepEqual(await other.prompts.wait(denied.id), { state: "cancelled" }); check.deepEqual((await other.apps.self()).permissions, []);

    // Recovery opens the vault with a new password and gives a new key; the old password stops working.
    await link.lock(); await wait(1100);
    const recovered = await link.recover(made.recovery, changed);
    check.equal(recovered.ok, true); check.match(recovered.recovery, key); check.notEqual(recovered.recovery, made.recovery); check.equal(link.recovery(), recovered.recovery); check.equal(link.snapshot().unlocked, true); check.equal(link.secured(), false);
    await link.lock(); await wait(1100); check.deepEqual(await link.unlock(password), { ok: false, code: "locked" }); await wait(1100); check.deepEqual(await link.unlock(changed), { ok: true });
    check.deepEqual(await link.recover("AAAA-BBBB", changed), { ok: false, code: "locked" });
    // Settings follow the service; a change made elsewhere is read on the next turn.
    await manager.settings.set({ ...DEFAULTS, theme: "light", language: "es" });
    await link.refresh(true); check.equal(link.snapshot().settings.theme, "light"); check.equal(link.snapshot().settings.language, "es");
    // A choice made in the window is saved by the service first and then shown; the settings of the service are the ones that count.
    const chosen = { idleMinutes: 15, lockWithLastApp: false, language: "en", theme: "dark" };
    check.deepEqual(await link.saveSettings({ ...chosen, extra: "x" }), { ok: true }); check.deepEqual(link.snapshot().settings, chosen); check.deepEqual(await manager.settings.get(), chosen);
    check.equal(service.vault.memory.idle, 15 * 60000); check.equal(service.lifecycle.lockWithLastApp, false);
    check.deepEqual(await link.saveSettings({ ...chosen, idleMinutes: 3 }), { ok: false, code: "invalid" }); check.deepEqual(link.snapshot().settings, chosen);
    check.deepEqual(await manager.settings.set(DEFAULTS), DEFAULTS); await link.refresh(true); check.deepEqual(link.snapshot().settings, DEFAULTS);
    await link.stop(); check.equal((await service.apps.list()).length >= 5, true);
  }

  // ---- a new vault from an encrypted backup ----------------------------------------------------------------------------------------------------
  {
    const { home, service } = await begin("restore"), link = open(home), asBackup = async (word, entries) => {
      const made = await createEnvelope(word); return { format: "vault-backup", version: 1, envelope: made.state, sealed: await encryptJson(made.key, { entries, chunks: [] }, "backup") };
    };
    const login = newEntry("login"); login.title = "Northwind Mail"; login.fields = [{ id: "username", name: "Username", secret: false, value: "alex" }, { id: "password", name: "Password", secret: true, value: canary }, { id: "website", name: "Website", secret: false, value: "https://northwind.example" }];
    const backup = await asBackup(password, [login]);
    link.start(); await until(() => link.snapshot().phase === "ready", "ready");
    check.deepEqual(await link.restoreBackup(password), { ok: false, code: "no_backup" });
    link.backup.set("backup.vault", backup);
    // A mistake in the backup's password never becomes the master password: no vault is made.
    check.deepEqual(await link.restoreBackup(wrong), { ok: false, code: "wrong_backup_password" }); check.equal((await service.vault.store.envelope()).state, null); check.equal(link.snapshot().created, false);
    link.backup.set("broken.vault", { ...backup, envelope: { format: 1 } }); check.deepEqual(await link.restoreBackup(password), { ok: false, code: "wrong_backup_password" }); check.equal(link.snapshot().created, false);
    link.backup.set("backup.vault", backup);
    const restored = await link.restoreBackup(password);
    check.equal(restored.ok, true); check.equal(restored.restored, true); check.match(restored.recovery, key); check.equal(link.recovery(), restored.recovery);
    check.equal(link.snapshot().created, true); check.equal(link.snapshot().unlocked, true);
    const manager = await as(home, "vault-cli"), rows = await manager.entries.list();
    check.deepEqual(rows.map(row => row.entry.title), ["Northwind Mail"]); check.equal(rows[0].entry.fields.find(field => field.id === "password").value, canary);
    // The backup is used once, and the vault keeps the backup's password as its master password.
    check.deepEqual(await link.restoreBackup(password), { ok: false, code: "no_backup" });
    await link.lock(); await wait(1100); check.deepEqual(await link.unlock(password), { ok: true });
    await link.stop();
  }

  // ---- stand-in clients: what the service cannot be made to do on demand ------------------------------------------------------------------------
  const fake = (overrides = {}) => {
    const calls = [], record = name => (...args) => { calls.push([name, ...args]); return overrides[name]?.(...args) ?? Promise.resolve({ ok: true }); };
    const client = {
      close: async () => { calls.push(["close"]); }, settings: { get: async () => DEFAULTS, set: async value => { calls.push(["settings", value]); return value; } }, status: async () => { calls.push(["status"]); return overrides.status?.() ?? { created: true, unlocked: false, present: 1, idleMs: 0 }; },
      runs: { list: async () => [], approve: record("approve"), approveWithHello: record("approveWithHello") },
      prompts: { list: async () => { calls.push(["list"]); return overrides.list?.() ?? []; }, dismiss: record("dismiss") },
      permissions: { importWithPassword: record("importWithPassword"), importWithHello: record("importWithHello") },
      create: record("create"), restore: record("restore"), unlock: record("unlock"), hello: { unlock: record("helloUnlock"), enable: record("helloEnable"), disable: record("helloDisable") },
    };
    return { client, calls };
  };
  const slow = sleeps => ms => { sleeps.push(ms); return wait(1); };
  {
    // The prompt loop backs off on errors, up to 30 seconds, and starts over once an answer comes.
    let misses = 0; const sleeps = [], { client, calls } = fake({ list: async () => { if (misses < 8) { misses++; throw { code: "unavailable" }; } return []; } });
    const link = open("unused", { connect: async () => client, sleep: slow(sleeps) }); link.start();
    await until(() => calls.filter(call => call[0] === "list").length >= 10, "backoff");
    for (const wanted of [1000, 2000, 4000, 8000, 16000, 30000]) check.ok(sleeps.includes(wanted), `${wanted}`);
    check.equal(Math.max(...sleeps) <= 30000, true); check.equal(sleeps.filter(ms => ms === 30000).length >= 2, true);
    // Stopping ends both loops and leaves the service.
    await link.stop(); const quiet = calls.length; await wait(60);
    check.equal(calls.length, quiet); check.equal(calls.filter(call => call[0] === "close").length, 1);
  }
  {
    // Vault out of reach: the window is told why, and it comes back by itself.
    let reachable = false, attempts = 0; const { client } = fake();
    const link = open("unused", { connect: async () => { attempts++; if (!reachable) throw { code: "not_installed" }; return client; }, sleep: ms => wait(Math.min(ms, 10)) }); link.start();
    await until(() => link.snapshot().phase === "unavailable", "unavailable");
    check.equal(link.snapshot().problem, "not_installed"); check.equal(attempts >= 1, true);
    reachable = true; link.retry();
    await until(() => link.snapshot().phase === "ready", "reachable again"); check.equal(link.snapshot().problem, null);
    await link.stop();
  }
  {
    // A service that fails for other reasons: "unavailable", then ready when it answers.
    let broken = true; const { client } = fake({ status: async () => { if (broken) throw { code: "unavailable" }; return { created: true, unlocked: true, present: 1, idleMs: 0 }; } });
    const link = open("unused", { connect: async () => client, sleep: ms => wait(Math.min(ms, 10)) }); link.start();
    await until(() => link.snapshot().phase === "unavailable", "status fails"); check.equal(link.snapshot().problem, "unavailable");
    broken = false; await until(() => link.snapshot().phase === "ready" && link.snapshot().unlocked, "status answers"); await link.stop();
  }
  {
    // The permission is given to the app the prompt names; a window that names another id gets nothing.
    const id = "00000000-0000-4000-8000-000000000009", second = "00000000-0000-4000-8000-000000000010", prompt = (key, createdAt) => ({ id: key, kind: "permission", app: { id: "field-notes", name: "Field Notes" }, createdAt, expiresAt: "2026-10-09T12:05:00.000Z", summary: { permission: "import" } });
    const { client, calls } = fake({ list: async () => [prompt(id, "2026-10-09T12:00:00.000Z"), prompt(second, "2026-10-09T12:00:01.000Z")] });
    const link = open("unused", { connect: async () => client, sleep: ms => wait(Math.min(ms, 10)) }); link.start();
    await until(() => link.snapshot().prompt?.id === id, "permission prompt");
    check.deepEqual(await link.allowImport("00000000-0000-4000-8000-0000000000aa", "pw"), { ok: false, code: "not_found" }); check.equal(calls.some(call => call[0] === "importWithPassword"), false);
    check.deepEqual(await link.allowImport(id, "pw"), { ok: true }); check.deepEqual(calls.find(call => call[0] === "importWithPassword"), ["importWithPassword", "pw", "field-notes"]);
    // An answered prompt leaves the screen at once, even while the service still lists it; the next one shows.
    check.equal(link.snapshot().prompt?.id, second); await wait(60); check.equal(link.snapshot().prompt?.id, second);
    check.deepEqual(await link.allowImportWithHello(second), { ok: true }); check.deepEqual(calls.find(call => call[0] === "importWithHello"), ["importWithHello", "1", "field-notes"]); check.equal(link.snapshot().prompt, null);
    await link.stop();
  }
  {
    // Windows Hello comes from the status of the service: enabled when its wrapped key exists, available when the helper says so. A status without it means neither.
    let hello = { available: true, enabled: true };
    const { client, calls } = fake({ status: async () => ({ created: true, unlocked: false, present: 1, idleMs: 0, ...hello ? { hello } : {} }) });
    const link = open("unused", { connect: async () => client, sleep: ms => wait(Math.min(ms, 10)) }); link.start();
    await until(() => link.snapshot().phase === "ready", "ready with hello");
    check.equal(link.snapshot().hello, true); check.equal(link.snapshot().helloAvailable, true);
    hello = { available: false, enabled: true }; await link.refresh(); check.equal(link.snapshot().hello, true); check.equal(link.snapshot().helloAvailable, false);
    hello = { available: true, enabled: false }; await link.refresh(); check.equal(link.snapshot().hello, false); check.equal(link.snapshot().helloAvailable, true);
    hello = undefined; await link.refresh(); check.equal(link.snapshot().hello, false); check.equal(link.snapshot().helloAvailable, false);
    // Turning it on takes the master password and nothing else; turning it off takes nothing.
    check.deepEqual(await link.enableHello("synthetic"), { ok: true }); check.deepEqual(calls.find(call => call[0] === "helloEnable"), ["helloEnable", "synthetic"]);
    check.deepEqual(await link.disableHello(), { ok: true }); check.equal(calls.some(call => call[0] === "helloDisable"), true);
    // The settings go as the four keys, and the service's answer is what shows.
    check.deepEqual(await link.saveSettings({ ...DEFAULTS, theme: "dark" }), { ok: true }); check.deepEqual(calls.find(call => call[0] === "settings")[1], { ...DEFAULTS, theme: "dark" }); check.equal(link.snapshot().settings.theme, "dark");
    await link.stop();
  }
  {
    // A backup whose password opens it: the vault is made first with that password, then the backup is restored into it; a failed restore is reported, not hidden.
    const made = await createEnvelope(password), backup = { format: "vault-backup", version: 1, envelope: made.state, sealed: await encryptJson(made.key, { entries: [], chunks: [] }, "backup") };
    for (const failing of [false, true]) {
      const { client, calls } = fake({ create: async () => ({ recovery: "ABCD - EFGH" }), restore: async () => { if (failing) throw { code: "invalid" }; return { imported: 0, duplicates: 0, skipped: 0 }; } });
      const link = open("unused", { connect: async () => client, sleep: ms => wait(Math.min(ms, 10)) }); link.start(); await until(() => link.snapshot().phase === "ready", "ready");
      link.backup.set("backup.vault", backup);
      check.deepEqual(await link.restoreBackup(wrong), { ok: false, code: "wrong_backup_password" }); check.equal(calls.some(call => call[0] === "create"), false);
      check.deepEqual(await link.restoreBackup(password), { ok: true, recovery: "ABCD - EFGH", restored: !failing });
      check.deepEqual(calls.filter(call => ["create", "restore"].includes(call[0])).map(call => [call[0], call[1] === undefined ? call[1] : call[0] === "create" ? call[1] === password : call[1] === backup && call[2] === password]), [["create", true], ["restore", true]]);
      check.equal(link.recovery(), "ABCD - EFGH"); await link.stop();
    }
  }
} finally {
  for (const link of links) await link.stop().catch(() => undefined);
  for (const api of clients) await api.close().catch(() => undefined);
  for (const service of services) await service.shutdown().catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
}
