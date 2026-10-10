import "../../../test/guard.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CHECK_EVERY_MS, FEED, FIRST_CHECK_MS, configureUpdater, createUpdates, updateText, updatesEnabled } from "../dist/main/update.js";
import { counts } from "./units.test.mjs";

// The update decisions, without Electron: updates run only in an installed copy, only from the releases and never to a pre-release or an older version,
// they are checked 10 seconds after the start and every 6 hours, and a downloaded update is installed only when the person says so.
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "match", "doesNotMatch", "ok"].map(name => [name, (...args) => { counts.checks++; return assert[name](...args); }]));
const settle = () => new Promise(done => setImmediate(done));
const clock = () => {
  const list = [];
  return { list, after: (run, ms) => { const timer = { run, ms, kind: "after", cleared: false }; list.push(timer); return timer; }, every: (run, ms) => { const timer = { run, ms, kind: "every", cleared: false }; list.push(timer); return timer; }, clear: timer => { timer.cleared = true; } };
};
const fake = () => {
  const handlers = {}, updater = {
    autoDownload: false, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true, feed: undefined, checks: 0, installs: [], failing: false, handlers,
    setFeedURL(feed) { this.feed = feed; }, on(event, listener) { handlers[event] = listener; },
    async checkForUpdates() { this.checks++; if (this.failing) throw new Error("offline"); },
    quitAndInstall(silent, runAfter) { this.installs.push([silent, runAfter]); },
  };
  return updater;
};
const open = (overrides = {}) => {
  const updater = fake(), timers = clock(), asked = []; let language = "en", answer = "later";
  const updates = createUpdates({ updater: async () => updater, packaged: true, language: () => language, ask: async text => { asked.push(text); if (answer === "throw") throw new Error("no dialog"); return answer; }, timers, ...overrides });
  return { updater, timers, asked, updates, say: value => { answer = value; }, speak: value => { language = value; } };
};

// ---- who updates: an installed copy only ------------------------------------------------------------------------------------------------------------
check.equal(updatesEnabled({ packaged: true }), true); check.equal(updatesEnabled({ packaged: true, disabled: false }), true);
check.equal(updatesEnabled({ packaged: false }), false); check.equal(updatesEnabled({ packaged: false, disabled: false }), false);
check.equal(updatesEnabled({ packaged: true, disabled: true }), false); check.equal(updatesEnabled({ packaged: false, disabled: true }), false);
{
  let loaded = 0;
  for (const options of [{ packaged: false }, { packaged: true, disabled: true }]) {
    const { timers, updates } = open({ ...options, updater: async () => { loaded++; return fake(); } });
    check.equal(await updates.start(), false); check.equal(timers.list.length, 0); updates.stop();
  }
  check.equal(loaded, 0); // electron-updater is not even loaded
}

// ---- what the updater is told ---------------------------------------------------------------------------------------------------------------------
check.deepEqual({ ...FEED }, { provider: "github", owner: "TXMSKA", repo: "Vault" });
check.equal(FIRST_CHECK_MS, 10000); check.equal(CHECK_EVERY_MS, 6 * 60 * 60 * 1000);
{
  const { updater, timers, updates } = open();
  check.equal(await updates.start(), true);
  check.deepEqual(updater.feed, FEED); check.equal(updater.autoDownload, true); check.equal(updater.autoInstallOnAppQuit, false); check.equal(updater.allowPrerelease, false); check.equal(updater.allowDowngrade, false);
  check.equal(await updates.start(), true); check.equal(timers.list.length, 1); // a second start changes nothing
  check.deepEqual(timers.list.map(timer => [timer.kind, timer.ms]), [["after", 10000]]); check.equal(updater.checks, 0);
  timers.list[0].run(); await settle();
  check.equal(updater.checks, 1); check.deepEqual(timers.list.map(timer => [timer.kind, timer.ms]), [["after", 10000], ["every", 21600000]]);
  timers.list[1].run(); timers.list[1].run(); await settle(); check.equal(updater.checks, 3);
  updater.failing = true; timers.list[1].run(); await settle(); check.equal(updater.checks, 4); // a failed check (offline) is not an error anyone sees
  updater.handlers.error(new Error("offline")); // nor is an error the updater reports
  updates.stop(); check.deepEqual(timers.list.map(timer => timer.cleared), [false, true]); check.equal(await updates.start(), false); // the first timer had run; only the repeating one is left to clear
  const early = open(); await early.updates.start(); early.updates.stop(); check.equal(early.timers.list[0].cleared, true);
  const direct = fake(); configureUpdater(direct); check.deepEqual([direct.autoDownload, direct.autoInstallOnAppQuit, direct.allowPrerelease, direct.allowDowngrade], [true, false, false, false]);
}
{
  const broken = open({ updater: async () => { throw new Error("no updater"); } });
  check.equal(await broken.updates.start(), false); check.equal(broken.timers.list.length, 0);
}

// ---- a downloaded update: asked once per version in a run, installed only on the answer ------------------------------------------------------------
{
  const { updater, asked, updates, say, speak } = open();
  await updates.start();
  say("later"); updater.handlers["update-downloaded"]({ version: "0.2.0" }); await settle();
  check.equal(asked.length, 1); check.deepEqual(updater.installs, []); // later: nothing installs, and nothing installs when Vault quits (autoInstallOnAppQuit is off)
  updater.handlers["update-downloaded"]({ version: "0.2.0" }); await settle(); check.equal(asked.length, 1); // the same version is not asked again in this run
  say("install"); speak("es"); updater.handlers["update-downloaded"]({ version: "0.2.1" }); await settle();
  check.equal(asked.length, 2); check.deepEqual(updater.installs, [[true, true]]); // quit, install silently, open again
  check.equal(asked[1].install, "Instalar ahora"); check.equal(asked[0].install, "Install now");
  updater.handlers["update-downloaded"]({ version: "0.2.1" }); await settle(); check.equal(asked.length, 2); check.equal(updater.installs.length, 1);
}
{
  // While the question is open, another update does not stack a second one.
  let release; const gate = new Promise(done => { release = done; });
  const { updater, asked, updates } = open({ ask: async text => { asked.push(text); await gate; return "later"; } });
  await updates.start(); updater.handlers["update-downloaded"]({ version: "1.0.0" }); updater.handlers["update-downloaded"]({ version: "1.0.1" }); await settle();
  check.equal(asked.length, 1); release(); await settle();
}
{
  const { updater, asked, updates, say } = open();
  await updates.start(); say("throw"); updater.handlers["update-downloaded"]({ version: "0.3.0" }); await settle();
  check.equal(asked.length, 1); check.deepEqual(updater.installs, []); // a dialog that cannot show installs nothing
  updater.handlers["update-downloaded"](undefined); await settle(); // an event without a version is asked about without one
  check.equal(asked.length, 2); check.doesNotMatch(asked[1].message, /undefined/);
}

// ---- the question: impersonal, in both languages, with the version only when it is a version -------------------------------------------------------------
const english = updateText("en", "0.2.0"), spanish = updateText("es", "0.2.0");
check.deepEqual(english, { message: "A new version of Vault is ready: 0.2.0", detail: "The version is already downloaded. Installing it closes Vault and opens it again. If later is chosen, the question comes back the next time Vault starts.", install: "Install now", later: "Later" });
check.deepEqual(spanish, { message: "Hay una versión nueva de Vault: 0.2.0", detail: "La versión ya está descargada. Al instalarla, Vault se cierra y se vuelve a abrir. Si se elige más tarde, la pregunta vuelve en el próximo inicio de Vault.", install: "Instalar ahora", later: "Más tarde" });
for (const version of ["", "latest", "1.0", "<b>x</b>", "1.2.3\nInstall", "1.2.3-" + "a".repeat(40), "https://example.com/x", "v1.2.3"]) { check.equal(updateText("en", version).message, "A new version of Vault is ready"); check.equal(updateText("es", version).message, "Hay una versión nueva de Vault"); }
check.equal(updateText("en", "1.2.3-rc.1").message, "A new version of Vault is ready: 1.2.3-rc.1");
for (const text of [...Object.values(english), ...Object.values(spanish)]) check.doesNotMatch(text, /—|–/);
for (const text of Object.values(spanish)) {
  check.doesNotMatch(text, /\b(vos|tu|tus|ti|contigo|sos|tenés|podés|querés|tené|elegí|escribí|guardá|ingresá|usá|abrí|confirmá|intentá|esperá|cerrá|probá|volvé|elegís|escribís|usás|ingresás|guardás|intentás|confirmás|abrís|verificá|revisá|hacé|ponés|te|le|les)\b/i);
  check.ok(!/\b\w+(?:á|í)\b(?=[.,:;]?\s|$)/.test(text.replace(/\b(está|aquí|así|sí|vía)\b/gi, "")), text);
}
for (const text of Object.values(english)) check.doesNotMatch(text, /\b(you|your|we|our)\b/i);

// ---- the files that make these decisions real ------------------------------------------------------------------------------------------------------
const config = await readFile(new URL("../electron-builder.yml", import.meta.url), "utf8"), main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8"), app = await readFile(new URL("../src/main/app.ts", import.meta.url), "utf8");
check.match(config, /^publish:\r?\n  provider: github\r?\n  owner: TXMSKA\r?\n  repo: Vault\r?$/m); check.equal(FEED.owner, "TXMSKA"); check.equal(FEED.repo, "Vault");
check.match(config, /^appId: com\.txmska\.vault$/m); check.match(app, /setAppUserModelId\("com\.txmska\.vault"\)/);
for (const line of ["oneClick: false", "perMachine: false", "allowElevation: false", "createDesktopShortcut: false", "createStartMenuShortcut: true", "deleteAppDataOnUninstall: false", "artifactName: Vault-Setup-x64.exe", "asar: true", "productName: Vault"]) check.match(config, new RegExp(`^\\s*${line}\\r?$`, "m"), line);
check.doesNotMatch(main, /noUpdates/); check.match(main, /start\(\)\.catch/); // production never turns the update check off
check.doesNotMatch(app, /noUpdates: true|noUpdates = true/); // the app itself sets it nowhere
