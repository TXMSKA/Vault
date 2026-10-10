"use strict";
// Drives the real Vault app, window and all, against a real service from this checkout: first run, the tips, the warning before the window closes over an
// unsaved recovery key, lock, unlock, an unlock prompt, Windows Hello, an agent's run request, a permission request and the recovery key, then an entry of
// every kind (added, searched, filtered, opened, revealed, copied, edited, deleted and put back), the menu and the settings, asserting the screens and the
// service state and saving a screenshot of each screen in the dark and the light theme under build/screens.
//
// Run it with the Electron binary, after `npm run build`:
//   $env:ELECTRON_OVERRIDE_DIST_PATH = "<folder of Electron 44.5.1>"; & "$env:ELECTRON_OVERRIDE_DIST_PATH\electron.exe" packages\app\test\smoke.cjs
//
// Everything is synthetic and lives in one temporary folder: the vault home (the browser's data is inside it) and the files the app saves. The home is created
// here, whatever VAULT_HOME says, and the test guard refuses any access to the default Cosmic folders. Windows Hello is a stand-in for the native helper
// (nobody is there to touch a sensor), the system dialogs, the clipboard and the browser are replaced by stand-ins that answer in memory, and the 30 seconds
// a copied value stays on the clipboard are shortened through the main process's test-only option, so that no test touches the person's own clipboard.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { tmpdir } = require("node:os");
const { PassThrough, Writable } = require("node:stream");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..", "..", "..");
delete process.env.ELECTRON_RUN_AS_NODE;
require(path.join(root, "test", "guard.mjs"));
const scratch = fs.mkdtempSync(path.join(path.resolve(tmpdir()), "app-smoke-")), home = path.join(scratch, "home"), screens = path.join(root, "build", "screens");
process.env.VAULT_HOME = home;
fs.mkdirSync(screens, { recursive: true });
for (const name of fs.readdirSync(screens)) if (name.endsWith(".png") || name.endsWith(".pdf")) fs.rmSync(path.join(screens, name));
const wait = ms => new Promise(done => setTimeout(done, ms));
let checks = 0, shots = 0, step = "start"; const phases = [], started = Date.now();
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "match", "doesNotMatch", "ok"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
// For values that are never secret (sizes, names), so that a failure says what it found.
const plain = (label, actual, expected) => { checks++; if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`); };
const say = text => { step = text; console.log(`  ${text}`); };
// How long this process's event loop was held up at the worst, for a failure to be told apart from a busy machine.
let lag = { worst: 0, at: "" }, tick = Date.now();
setInterval(() => { const now = Date.now(), late = now - tick - 250; tick = now; if (late > lag.worst) lag = { worst: late, at: step }; }, 250).unref();

// ---- the native helper, as a stand-in: ACLs always fine, Windows Hello available and verified after a delay -----------------------------------------------
const hello = { delay: 0, verified: 0 };
const answers = {
  "protect-folder": async () => '{"ok":true}\n', "check-file": async () => '{"ok":true}\n', "hello-available": async () => '{"available":true}\n',
  "hello-verify": async () => { await wait(hello.delay); hello.verified++; return '{"result":"Verified"}\n'; },
  "dpapi-protect": async request => `${JSON.stringify({ data: request.data })}\n`, "dpapi-unprotect": async request => `${JSON.stringify({ data: request.data })}\n`,
};
const isHelper = file => path.basename(String(file)).toLowerCase() === "vault-helper.exe";
const spawn = childProcess.spawn, spawnSync = childProcess.spawnSync;
childProcess.spawn = (file, args = [], options = {}) => {
  if (!isHelper(file)) return spawn(file, args, options);
  const child = new EventEmitter(), stdout = new PassThrough(); let input = "";
  child.stdin = new Writable({ write(chunk, _encoding, done) { input += chunk; done(); }, final(done) { done(); void respond(); } });
  child.stdout = stdout; child.kill = () => true;
  async function respond() {
    try { const output = await answers[args[0]](JSON.parse(input)); stdout.end(output); setImmediate(() => child.emit("close", 0)); }
    catch { child.emit("error", new Error("The stand-in helper has no answer for this call.")); }
  }
  return child;
};
childProcess.spawnSync = (file, args = [], options = {}) => {
  if (!isHelper(file) || !["protect-folder", "check-file"].includes(args[0])) return spawnSync(file, args, options);
  const stdout = Buffer.from('{"ok":true}\n');
  return { pid: 0, status: 0, signal: null, output: [null, stdout, null], stdout, stderr: Buffer.alloc(0) };
};
require("node:module").syncBuiltinESMExports();
// The window is shown but fully transparent, out of the way of the mouse and the taskbar, and it never takes the keyboard while it is looked at.
BrowserWindow.prototype.show = function show() { this.setOpacity(0); this.setIgnoreMouseEvents(true); this.setSkipTaskbar(true); this.showInactive(); };
BrowserWindow.prototype.focus = function focus() {};
// The title bar's controls are checked by what they ask of the window, not by moving the user's screen.
const controls = [];
for (const name of ["minimize", "maximize", "unmaximize"]) BrowserWindow.prototype[name] = function control() { controls.push(name); };
// Closing asks the window's own guard first, as Electron does, and then only notes that it would have closed.
BrowserWindow.prototype.close = function close() {
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  this.emit("close", event); controls.push(event.defaultPrevented ? "close-asked" : "close");
};

const saved = { kit: path.join(scratch, "kit.txt"), backup: path.join(scratch, "backup.vault"), printed: 0 };
const { prepare } = require(path.join(root, "packages", "app", "dist", "main", "app.js"));
// The clipboard and the browser are in memory here: what was copied, how often it was cleared, and which addresses were asked for.
const board = { text: "", writes: 0, clears: 0 }, opened = [], CLIPBOARD_MS = 1200;
// Started the way the service starts it when a prompt waits and nobody is there.
const launch = prepare({ env: process.env, argv: ["--prompts"], clipboardMs: CLIPBOARD_MS, platform: {
  saveFile: async () => saved.kit, openFile: async () => saved.backup,
  print: async () => { saved.printed++; return { ok: true }; },
  clipboard: { readText: async () => board.text, writeText: async text => { board.text = text; board.writes++; }, clear: () => { board.text = ""; board.clears++; } },
  openUrl: async url => { opened.push(url); },
} });
if (!launch) { console.error("Another Vault app already runs on this home."); app.exit(1); }

const password = randomBytes(24).toString("base64"), changed = randomBytes(24).toString("base64"), wrong = randomBytes(24).toString("base64"), canary = randomBytes(24).toString("base64");
const backupPassword = randomBytes(24).toString("base64");
let running, service, manager, settings = { idleMinutes: 15, lockWithLastApp: false, language: "en", theme: "dark" };

// ---- driving the page --------------------------------------------------------------------------------------------------------------------------------------
const page = () => running.window.webContents;
// A page that stops answering is a failure with a name, not a wait for ever.
const evaluate = code => Promise.race([page().executeJavaScript(code, true), new Promise((_, fail) => setTimeout(() => fail(new Error(`The page did not answer: ${String(code).slice(0, 80)}`)), 60000).unref())]);
// On a machine that is busy with other work, the service in this process can miss a second, and the window then says Vault is out of reach until its next try;
// waiting presses Try again for the person, as a person would.
const poll = async (what, work, ms = 60000, gap = 40) => {
  const end = Date.now() + ms;
  for (;;) {
    let value; try { value = await work(); } catch { value = undefined; } if (value) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${what} (${step})`);
    if (running && running.link.snapshot().phase === "unavailable") running.link.retry();
    await wait(gap);
  }
};
// Waiting on the service itself is gentle: it answers each app 240 calls a minute and all of them 600, and a wait that asked every 40 ms would use them up.
const settle = (what, work, ms) => poll(what, work, ms, 400);
const text = () => evaluate("document.body.innerText");
const showing = (...parts) => poll(`the screen with "${parts[0]}"`, async () => { const now = await text(); return parts.every(part => now.includes(part)); });
const gone = part => poll(`"${part}" to go`, async () => !(await text()).includes(part));
const click = (label, scope = "document") => poll(`the button "${label}"`, () => evaluate(`(() => {
  const buttons = [...${scope}.querySelectorAll("button")].filter(item => item.textContent.trim() === ${JSON.stringify(label)} || item.getAttribute("aria-label") === ${JSON.stringify(label)});
  const button = buttons.find(item => !item.disabled); if (!button) return false; button.click(); return true; })()`));
const type = (name, value, scope = "document") => poll(`the field ${name}`, () => evaluate(`(() => {
  const input = ${scope}.querySelector('input[name="${name}"]'); if (!input) return false; input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`));
const dialog = 'document.querySelector(".dialog")';
const frame = () => evaluate("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
const capture = async name => {
  await frame(); await wait(120);
  const image = await page().capturePage(); fs.writeFileSync(path.join(screens, `${name}.png`), image.toPNG()); shots++;
  check.ok(image.getSize().width >= 920 && image.getSize().height >= 640, `${name} is the size of the window`);
};
const theme = value => evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(value)}`);
const setting = async patch => {
  settings = { ...settings, ...patch }; await manager.settings.set(settings); await running.link.refresh(true);
  if (patch.theme) await poll(`theme ${patch.theme}`, async () => (await evaluate("document.documentElement.dataset.theme")) === patch.theme);
  if (patch.language) await poll(`language ${patch.language}`, async () => (await evaluate("document.documentElement.lang")) === patch.language);
};
/**
 * The screen as it is, in the dark theme and then the light one. `quiet` changes the theme in the page alone, for a moment when the service cannot answer and
 * to spare the app's 240 calls a minute, which the many screens of this check would otherwise use up.
 */
const shoot = async (name, quiet = true) => {
  for (const mode of ["dark", "light"]) { if (quiet) await theme(mode); else await setting({ theme: mode }); await capture(`${name}-${mode}`); }
  if (quiet) await theme("dark"); else await setting({ theme: "dark" });
};
const keyOnScreen = () => evaluate('[...document.querySelectorAll(".keybox .line")].map(line => line.textContent).join("-")');
const unlocked = async () => (await manager.status()).unlocked;
const listShown = () => poll("the list", () => evaluate("!!document.querySelector('.main .search input')"));
const exists = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const count = selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const read = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const set = (selector, value, index = 0) => poll(`the control ${selector}`, () => evaluate(`(() => { const node = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!node) return false; node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`));
const pick = label => poll(`the menu item ${label}`, () => evaluate(`(() => { const item = [...document.querySelectorAll(".popover .menu-item")].find(node => node.querySelector(".name")?.textContent === ${JSON.stringify(label)}); if (!item || item.getAttribute("aria-disabled") === "true") return false; item.click(); return true; })()`));
const press = (selector, label) => poll(`${selector} "${label}"`, () => evaluate(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!node) return false; node.click(); return true; })()`));
const rowsText = () => evaluate(`[...document.querySelectorAll(".erow")].map(row => [row.querySelector(".rname").textContent, row.querySelector(".rsub").textContent])`);
const entryNow = () => evaluate(`document.querySelector(".entry .titles .h")?.textContent ?? null`);
const rowOf = async title => (await manager.entries.list()).find(row => row.entry.title === title);
const choose = async title => {
  await poll(`the row ${title}`, () => evaluate(`(() => { const row = [...document.querySelectorAll(".erow")].find(item => item.querySelector(".rname").textContent === ${JSON.stringify(title)}); if (!row) return false; row.click(); return true; })()`));
  await poll(`${title} open`, async () => (await entryNow()) === title);
};
const addKind = async kind => { await click("Add an entry"); await pick(kind); };

async function main() {
  const { connect } = await import(pathToFileURL(path.join(root, "packages", "client", "dist", "index.js")).href);
  const { startService } = await import(pathToFileURL(path.join(root, "packages", "service", "dist", "service", "src", "server.js")).href);
  const core = await import(pathToFileURL(path.join(root, "packages", "core", "dist", "index.js")).href);
  const { recoveryKit } = await import(pathToFileURL(path.join(root, "packages", "client", "dist", "index.js")).href);
  const tokens = () => { let value; return { async get() { return value; }, async set(token) { value = token; } }; };
  // The service runs in this process, beside the page being driven, so on a busy machine its health check can miss its second; connecting asks again.
  const as = async (id, name, kind = "app") => {
    for (let attempt = 0; ; attempt++) {
      try { return await connect({ home, app: { id, name, kind }, tokens: tokens(), heartbeatMs: 2000 }); }
      catch (error) { if (attempt >= 4) throw error; await wait(750); }
    }
  };
  fs.mkdirSync(scratch, { recursive: true });

  say("starting the service and the app");
  service = await startService({ home, prompts: { waitMs: 4000 } });
  manager = await as("vault-cli", "Vault CLI", "cosmic");
  await manager.settings.set(settings);
  const entry = core.newEntry("login"); entry.title = "Northwind Mail"; entry.fields = [{ id: "username", name: "Username", secret: false, value: "alex.rivera" }, { id: "password", name: "Password", secret: true, value: canary }, { id: "website", name: "Website", secret: false, value: "https://northwind.example" }];
  const made = await core.createEnvelope(backupPassword);
  fs.writeFileSync(saved.backup, JSON.stringify({ format: "vault-backup", version: 1, envelope: made.state, sealed: await core.encryptJson(made.key, { entries: [entry], chunks: [] }, "backup") }));
  running = await launch();
  running.link.onChange(snapshot => { if (snapshot.phase !== phases.at(-1)?.[1]) phases.push([Date.now() - started, snapshot.phase, step]); });
  const problems = [];
  page().on("console-message", event => { if (event.level === "error" || event.level === "warning") problems.push(event.message); });
  page().on("render-process-gone", () => problems.push("The page process is gone."));
  page().on("did-fail-load", () => problems.push("The page failed to load."));
  await showing("Welcome to Vault", "Create a new vault", "Restore a backup");
  const asker = await as("field-notes", "Field Notes"); await manager.apps.allow("field-notes"); await asker.present();

  say("started for prompts only: hidden until a prompt arrives, then forward and kept open by a touch");
  await wait(1500); plain("the window before any prompt", running.window.isVisible(), false);
  const first = await asker.prompts.unlock("First start");
  await poll("the window to come forward", async () => running.window.isVisible());
  check.equal((await text()).includes("asks to unlock"), false);
  // A person touching the window is what keeps a start for prompts open past its 30 seconds; the idle close itself is tested in units.
  for (const type of ["mouseDown", "mouseUp"]) page().sendInputEvent({ type, x: 100, y: 400, button: "left", clickCount: 1 });

  say("the window and the page are locked down");
  const win = running.window, wc = page();
  plain("the content size", win.getContentSize(), [920, 640]); plain("the minimum size", win.getMinimumSize(), [920, 640]); plain("the menu bar", win.isMenuBarVisible(), false);
  check.equal(wc.getURL(), "app://vault/"); check.equal(win.getTitle(), "Vault");
  check.deepEqual(await evaluate("[typeof require, typeof process, typeof module, typeof Buffer, typeof ipcRenderer, typeof window.electron]"), ["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
  check.deepEqual(await evaluate("Object.keys(window.vault).sort()"), ["allowImport", "allowImportWithHello", "approveRun", "approveRunWithHello", "cancelClose", "chooseBackup", "close", "confirmClose", "create", "disableHello", "dismissPrompt", "dismissTour", "enableHello", "entries", "entryCode", "entryCopy", "entryCopyCode", "entryFavorite", "entryOpen", "entryOpenSite", "entryRemove", "entryReveal", "entrySave", "entryUndo", "finishSetup", "interact", "lock", "minimize", "onState", "printRecoverySheet", "recover", "restoreBackup", "retry", "saveRecoverySheet", "saveSettings", "state", "toggleMaximize", "unlock", "unlockWithHello"]);
  check.equal(await evaluate("Object.isFrozen(window.vault)"), true);
  check.equal(await evaluate("(() => { try { window.vault.create = () => 0; } catch {} return typeof window.vault.create; })()"), "function");
  check.equal(await evaluate("typeof window.vault.invoke"), "undefined");
  check.deepEqual(await evaluate("window.vault.create({ password: 'short' })"), { ok: false, code: "invalid" });
  check.deepEqual(await evaluate("window.vault.unlock({ password: 'x', extra: 1 })"), { ok: false, code: "invalid" });
  check.deepEqual(await evaluate("window.vault.dismissPrompt({ id: '../..' })"), { ok: false, code: "invalid" });
  check.deepEqual(await evaluate("window.vault.create(null)"), { ok: false, code: "invalid" });
  check.equal(await evaluate("document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]') !== null"), true);
  check.equal(await evaluate("window.open('https://example.com') === null"), true);
  check.equal(await evaluate("fetch('https://example.com').then(() => 'reached', () => 'refused')"), "refused");
  check.equal(await evaluate("fetch('app://vault/index.html').then(() => 'reached', () => 'refused')"), "refused");
  check.equal(await evaluate("new Promise(done => { const script = document.createElement('script'); script.textContent = 'window.injected = true'; script.onerror = () => done('refused'); document.head.append(script); setTimeout(() => done(String(window.injected === true)), 100); })"), "false");
  await evaluate("location.href = 'https://example.com/'"); await wait(400);
  check.equal(wc.getURL(), "app://vault/");
  await evaluate("location.href = 'app://vault/../../package.json'"); await wait(400);
  check.equal(wc.getURL(), "app://vault/");
  check.equal(await evaluate("Promise.all([...document.fonts].map(face => face.load().then(() => face.status))).then(list => list.sort().join())"), "loaded,loaded,loaded");
  check.equal(await evaluate("document.fonts.check('600 24px \"Vault Space Grotesk\"') && document.fonts.check('14px \"Vault Inter\"') && document.fonts.check('14px \"Vault Mono\"')"), true);
  const permissionAnswer = await new Promise(done => { const timer = setTimeout(() => done("no answer"), 1500); evaluate("navigator.permissions.query({ name: 'geolocation' }).then(status => status.state)").then(state => { clearTimeout(timer); done(state); }, () => done("refused")); });
  check.ok(["denied", "refused", "no answer"].includes(permissionAnswer), permissionAnswer);
  problems.length = 0;

  say("the browser's own files are inside the vault home, in a folder of their own");
  check.equal(app.getPath("userData").toLowerCase(), path.join(home, "app").toLowerCase());
  await poll("the browser's folder", async () => fs.existsSync(path.join(home, "app")));
  check.equal(fs.existsSync(`${home}-app`), false); check.equal(fs.existsSync(path.join(scratch, "home-app")), false);

  say("welcome, in both themes and in Spanish");
  check.equal(await evaluate("window.getComputedStyle(document.body).backgroundColor"), "rgb(22, 26, 32)");
  await shoot("welcome");
  await setting({ language: "es" }); await showing("Bienvenido a Vault", "Crear una bóveda nueva", "Continuar"); await capture("welcome-es-dark"); await setting({ language: "en" }); await showing("Welcome to Vault");

  say("restore a backup: the screen, a wrong password, and back");
  await evaluate("document.querySelector('input[type=radio][value=restore]').click()");
  check.equal(await evaluate("document.querySelector('.choice.on .strong').textContent"), "Restore a backup");
  await click("Continue"); await showing("Choose a Vault backup and type the password it was made with.");
  await click("Restore"); await showing("Choose a backup file first.");
  await click("Choose"); await poll("the chosen file", async () => (await evaluate("document.querySelector('input[name=file]').value")) === "backup.vault");
  await type("backup-password", backupPassword); await shoot("restore");
  await type("backup-password", wrong); await click("Restore"); await showing("That backup password is not right.");
  check.equal((await manager.status()).created, false);
  await shoot("restore-error");
  await click("Back"); await showing("Welcome to Vault");

  say("create a vault: not the same, then the same");
  await evaluate("document.querySelector('input[type=radio][value=create]').click()");
  await click("Continue"); await showing("Choose a master password", "15 to 128 characters.");
  await type("password", password); await type("repeat", `${password}x`); await click("Create vault"); await showing("The two passwords are not the same.");
  check.equal((await manager.status()).created, false);
  await shoot("create-mismatch");
  await click("Back"); await click("Continue"); await type("password", "short"); await type("repeat", "short"); await click("Create vault"); await showing("Use 15 to 128 characters.");
  await type("password", password); await type("repeat", password); await shoot("create");
  await click("Create vault");
  await showing("Your recovery key", "Save recovery sheet");
  const key = await keyOnScreen();
  check.match(key, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  check.equal((await manager.status()).created, true); check.equal(await unlocked(), true);
  check.deepEqual(await asker.prompts.wait(first.id), { state: "done" });
  check.equal(await evaluate("document.querySelectorAll('.titlebar .tool').length"), 0);
  await shoot("recovery-key");

  say("closing the window over a recovery key that was not saved asks first: Go back, Escape and Close anyway");
  controls.length = 0;
  await click("Close"); await showing("Close without saving the recovery key?", "The recovery key is shown only once. Without it, a forgotten master password cannot be recovered.", "Go back", "Close anyway");
  plain("the window calls", controls, ["close-asked"]); check.equal(running.window.isDestroyed(), false); check.equal(await evaluate("document.getElementById('screen').hasAttribute('inert')"), true);
  check.equal(await evaluate("document.querySelector('#modal .dialog').getAttribute('role') + document.querySelector('#modal .dialog').getAttribute('aria-modal')"), "dialogtrue");
  check.equal((await running.compose()).closing, true);
  await shoot("close-warning", true);
  await click("Go back", "document.querySelector('#modal')"); await gone("Close without saving the recovery key?"); check.equal((await running.compose()).closing, false); check.equal(await evaluate("document.getElementById('screen').hasAttribute('inert')"), false);
  await click("Close"); await showing("Close without saving the recovery key?");
  await evaluate("document.querySelector('#modal .scrim').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await gone("Close without saving the recovery key?");
  plain("the window calls", controls, ["close-asked", "close-asked"]);
  controls.length = 0; await click("Close"); await showing("Close without saving the recovery key?"); await click("Close anyway", "document.querySelector('#modal')"); await gone("Close without saving the recovery key?");
  await poll("the close the person confirmed", async () => controls.join() === "close-asked,close");
  check.equal(await evaluate("!!document.querySelector('.keybox')"), true);

  say("the recovery sheet: saved once, never over a file, printed, and the checkbox gates Open Vault");
  await click("Save recovery sheet"); await showing("Recovery sheet saved.");
  // Saved, so the window closes without asking.
  controls.length = 0; await click("Close"); await poll("the close", async () => controls.join() === "close"); check.equal(await exists("#modal .dialog"), false); controls.length = 0;
  check.equal(fs.readFileSync(saved.kit, "utf8"), recoveryKit(key.replace(/-/g, "").match(/.{4}/g).join(" - ")));
  check.match(fs.readFileSync(saved.kit, "utf8"), /Recovery key \/ Clave de recuperación:\n[A-HJ-NP-Z2-9]{4}( - [A-HJ-NP-Z2-9]{4}){5}\n/);
  const before = fs.readFileSync(saved.kit, "utf8");
  await click("Save recovery sheet"); await showing("That file already exists. Choose another name."); check.equal(fs.readFileSync(saved.kit, "utf8"), before);
  await click("Print"); await poll("the print call", async () => saved.printed === 1);
  const pdf = await page().printToPDF({ pageSize: "A4", printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(path.join(screens, "recovery-sheet.pdf"), pdf);
  // The same page as paper shows it, for a look: the print media on screen, the A4 page clipped.
  const inspector = page().debugger; inspector.attach("1.3");
  try {
    await inspector.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
    const sheet = await inspector.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 794, height: 1123, scale: 1 } });
    fs.writeFileSync(path.join(screens, "recovery-sheet.png"), Buffer.from(sheet.data, "base64")); shots++;
    await inspector.sendCommand("Emulation.setEmulatedMedia", { media: "" });
  } finally { inspector.detach(); }
  check.equal(pdf.subarray(0, 5).toString(), "%PDF-"); check.equal((pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length, 1);
  // The board keeps Open Vault available; the checkbox only reminds.
  check.equal(await evaluate("[...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Open Vault').disabled"), false);
  check.equal(await evaluate("!!document.querySelector('.keybox')"), true);
  await evaluate("document.querySelector('.checkbox input').click()");
  check.equal(await evaluate("[...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Open Vault').disabled"), false);
  await click("Open Vault"); await showing("Your vault is empty", "Import", "Add an entry");
  check.equal(await evaluate("!!document.querySelector('.sheet, .page')"), false);
  check.equal(await evaluate("document.querySelectorAll('.titlebar .tool').length"), 2);
  check.equal(await evaluate("document.querySelector('.empty button[disabled]').title"), "In the command line for now: vault import");

  say("the tips show once after the first open, two cards, and the dismissal is kept in the app's own folder");
  await showing("Welcome to Vault", "1 of 2", "Add or import", "Add an entry with +. To bring passwords from a browser, use vault import in the command line for now.", "Copy, then it clears", "One unlock for every app", "Got it", "More");
  check.equal((await running.compose()).tour, true); check.equal(fs.existsSync(path.join(home, "app", "tour.json")), false);
  await shoot("tour", true);
  await click("More"); await showing("A few more things", "2 of 2", "Lock in the title bar closes Vault for every app. It also locks itself when idle.", "Recovery key", "Done"); await shoot("tour-more", true);
  await click("Done"); await gone("A few more things");
  await poll("the dismissal kept", async () => fs.existsSync(path.join(home, "app", "tour.json"))); plain("the file", JSON.parse(fs.readFileSync(path.join(home, "app", "tour.json"), "utf8")), { dismissed: true });
  check.equal((await running.compose()).tour, false);
  await shoot("empty");

  say("lock from the title bar, a wrong password, the right one");
  await click("Lock Vault now"); await showing("Vault is locked", "Use recovery key");
  check.equal(await unlocked(), false);
  check.equal(await evaluate("document.querySelectorAll('.titlebar .tool').length"), 0);
  check.equal(await evaluate("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'Windows Hello')"), false);
  await shoot("locked");
  await type("password", wrong); await click("Unlock"); await showing("That password is not right. Try again or use the recovery key.");
  check.equal(await evaluate("document.querySelector('.input.error') !== null"), true); check.equal(await unlocked(), false);
  await shoot("locked-error");
  await wait(1100);
  await type("password", password); await click("Unlock"); await showing("Your vault is empty"); check.equal(await unlocked(), true);

  say("an app asks for an unlock: its name and id, its reason, Cancel, then the password");
  await manager.lock(); await running.link.refresh(); await showing("Vault is locked");
  const ticket = await asker.prompts.unlock("Open the notes");
  await showing("Field Notes (field-notes) asks to unlock Vault.", "Reason given: Open the notes");
  check.equal(await evaluate("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'Cancel')"), true);
  await shoot("locked-prompt");
  await click("Cancel"); await gone("asks to unlock Vault"); check.deepEqual(await asker.prompts.wait(ticket.id), { state: "cancelled" });
  const again = await asker.prompts.unlock("Open the notes"); await showing("Field Notes (field-notes) asks to unlock Vault.");
  await wait(1100); await type("password", password); await click("Unlock"); await showing("Your vault is empty");
  check.deepEqual(await asker.prompts.wait(again.id), { state: "done" }); check.equal(await unlocked(), true);

  say("Windows Hello: waiting, then unlocked");
  await manager.hello.enable(password); await running.link.refresh();
  await manager.lock(); await running.link.refresh(); await showing("Vault is locked", "Windows Hello");
  await shoot("locked-hello");
  hello.delay = 6000; const verified = hello.verified;
  await click("Windows Hello"); await showing("Waiting for Windows Hello", "Confirm it is you in the Windows Security window.");
  await shoot("hello", true);
  await showing("Your vault is empty"); check.equal(hello.verified, verified + 1); check.equal(await unlocked(), true); hello.delay = 0;
  // Cancel stops waiting; the late answer of the helper still opens the vault, and the window follows it.
  await manager.lock(); await running.link.refresh(); await showing("Windows Hello");
  hello.delay = 1500; await click("Windows Hello"); await showing("Waiting for Windows Hello"); await click("Cancel"); await showing("Vault is locked");
  await showing("Your vault is empty"); hello.delay = 0;

  say("an agent asks to run commands: the request, Reject, then Approve with Windows Hello and with the password");
  const project = core.newEntry("env"); project.title = "sprout";
  project.fields = [{ id: "DATABASE_URL", name: "DATABASE_URL", secret: true, value: canary }, { id: "API_TOKEN", name: "API_TOKEN", secret: true, value: `${canary}-token` }, { id: "DEBUG", name: "DEBUG", secret: true, value: "1" }];
  await manager.entries.save(project, 0);
  const agent = await as("claude-code", "Claude Code", "agent"); await manager.apps.allow("claude-code");
  const environment = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", SystemRoot: process.env.SystemRoot };
  const folder = path.join(scratch, "sprout"); fs.mkdirSync(folder);
  const submit = async (cwd, commands, name = "sprout") => (await agent.runs.submit({ project: name, cwd, commands, env: environment })).id;
  let id = await submit("C:\\Users\\alex\\code\\sprout", [["npx", "prisma", "migrate", "deploy"], ["npm", "run", "db:seed"]]);
  await showing("Claude Code wants to run 2 commands", "sprout", "C:\\Users\\alex\\code\\sprout", "npx prisma migrate deploy", "npm run db:seed");
  const asked = await text();
  check.ok(asked.includes("They get sprout's values. Vault hides the values in what the commands print, but a command, or a script it runs, can still save them elsewhere."));
  check.ok(asked.includes("DEBUG is shorter than 4 characters, so it shows as it is in the output."));
  check.match(asked, /Expires in (9|10) minutes\. Approving covers these two commands only\./);
  check.equal(await evaluate(`!!${dialog}.querySelector("button .icon")`), true);
  check.equal(await evaluate(`${dialog}.getAttribute("role") + ${dialog}.getAttribute("aria-modal")`), "dialogtrue");
  check.equal(await evaluate("document.getElementById('screen').hasAttribute('inert')"), true);
  check.equal(asked.includes(canary), false);
  await shoot("run-request");
  await click("Use master password", dialog); await showing("Use Windows Hello", "Master password");
  await type("password", "", dialog); await shoot("run-password");
  await click("Use Windows Hello"); await showing("Use master password");
  await click("Reject"); await gone("wants to run"); check.equal((await agent.runs.get(id)).status, "rejected");
  check.equal(await evaluate("document.getElementById('screen').hasAttribute('inert')"), false);
  // Approve with Windows Hello: the commands run with the project's values and print them masked.
  id = await submit(folder, [["cmd.exe", "/c", "echo", "synthetic output"], ["cmd.exe", "/c", "echo %DATABASE_URL%"]]);
  await showing("wants to run 2 commands", "synthetic output"); const verifiedRun = hello.verified;
  await click("Approve", dialog);
  let progress = await poll("the run to finish", async () => { const now = await agent.runs.get(id); return ["done", "failed"].includes(now.status) ? now : undefined; });
  check.equal(progress.status, "done"); check.equal(hello.verified, verifiedRun + 1);
  const printed = progress.chunks.map(chunk => chunk.text).join("");
  check.ok(printed.includes("synthetic output")); check.equal(printed.includes(canary), false); check.ok(printed.includes("*"));
  await gone("wants to run");
  // Approve with the master password.
  id = await submit(folder, [["cmd.exe", "/c", "echo", "second output"]]);
  await showing("wants to run 1 command", "Approving covers this command only."); check.deepEqual(await evaluate(`${dialog}.querySelector(".fact .value").textContent`), "sprout");
  await click("Use master password", dialog); await type("password", wrong, dialog); await click("Approve", dialog); await showing("That password is not right.");
  check.equal((await agent.runs.get(id)).status, "pending");
  await wait(1100); await type("password", password, dialog); await click("Approve", dialog);
  progress = await poll("the second run to finish", async () => { const now = await agent.runs.get(id); return ["done", "failed"].includes(now.status) ? now : undefined; });
  check.equal(progress.status, "done"); check.ok(progress.chunks.map(chunk => chunk.text).join("").includes("second output"));
  await gone("wants to run");
  // A project that is not in Vault is said so before anything is approved.
  id = await submit(folder, [["cmd.exe", "/c", "echo", "x"]], "absent");
  await showing('"absent" is not in Vault, so approving fails.'); await click("Reject"); await gone("wants to run");

  say("an app asks to import passwords: Deny, then Allow with Windows Hello and with the password");
  const permit = await asker.permissions.request();
  await showing("Field Notes asks to import passwords", "Field Notes (field-notes)");
  check.ok((await text()).includes("Allowing it lets Field Notes add passwords to Vault until its access is revoked."));
  await shoot("permission-request");
  await click("Use master password", dialog); await showing("Use Windows Hello"); await shoot("permission-password");
  await click("Deny"); await gone("asks to import passwords"); check.deepEqual(await asker.prompts.wait(permit.id), { state: "cancelled" }); check.deepEqual((await asker.apps.self()).permissions, []);
  const second = await asker.permissions.request(); await showing("Field Notes asks to import passwords");
  const verifiedPermit = hello.verified; await click("Allow", dialog);
  await gone("asks to import passwords"); check.deepEqual((await asker.apps.self()).permissions, ["import"]); check.equal(hello.verified, verifiedPermit + 1); check.deepEqual(await asker.prompts.wait(second.id), { state: "done" });
  const other = await as("other-app", "Other App"); await manager.apps.allow("other-app"); await other.present();
  await other.permissions.request(); await showing("Other App asks to import passwords");
  await click("Use master password", dialog); await type("password", wrong, dialog); await click("Allow", dialog); await showing("That password is not right.");
  check.deepEqual((await other.apps.self()).permissions, []);
  await wait(1100); await type("password", password, dialog); await click("Allow", dialog); await gone("asks to import passwords"); check.deepEqual((await other.apps.self()).permissions, ["import"]);

  say("the recovery key replaces the master password, then the new key is shown");
  await manager.lock(); await running.link.refresh(); await showing("Vault is locked");
  await click("Use recovery key"); await showing("Use the recovery key", "New master password", "Windows Hello turns off and a new recovery key replaces this one.");
  await type("recovery", key); await type("new-password", changed); await type("repeat", changed); await shoot("recovery-unlock");
  await type("repeat", `${changed}x`); await click("Unlock"); await showing("The two passwords are not the same.");
  await type("repeat", changed);
  await type("recovery", "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF"); await click("Unlock"); await showing("That recovery key is not right.");
  await wait(1100); await type("recovery", key); await click("Unlock");
  await showing("Your recovery key"); const renewed = await keyOnScreen(); check.notEqual(renewed, key); check.equal(await unlocked(), true);
  say("a recovery key that was only printed counts as safe: closing asks until then");
  controls.length = 0; await click("Close"); await showing("Close without saving the recovery key?"); plain("the window calls", controls, ["close-asked"]);
  await click("Go back", "document.querySelector('#modal')"); await gone("Close without saving the recovery key?");
  const printsBefore = saved.printed; await click("Print"); await poll("the second print call", async () => saved.printed === printsBefore + 1);
  controls.length = 0; await click("Close"); await poll("the close", async () => controls.join() === "close"); check.equal(await exists("#modal .dialog"), false); controls.length = 0;
  await evaluate("document.querySelector('.checkbox input').click()"); await click("Open Vault"); await listShown();
  check.equal(fs.existsSync(path.join(home, "secrets", "hello.json")), false);
  await manager.lock(); await running.link.refresh(); await showing("Vault is locked");
  check.equal(await evaluate("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'Windows Hello')"), false);
  await wait(1100); await type("password", password, undefined); await click("Unlock"); await showing("That password is not right.");
  await wait(1100); await type("password", changed); await click("Unlock"); await listShown();

  say("the vault is open on its list: the agent's project is there, and nothing a window is sent holds a secret value");
  const { totp } = await import(pathToFileURL(path.join(root, "packages", "app", "dist", "main", "totp.js")).href);
  const ids = () => evaluate("[...document.querySelectorAll('.erow')].map(row => row.dataset.id)");
  await poll("the project in the list", async () => (await count(".erow")) === 1);
  plain("the first row", await rowsText(), [["sprout", "Environment, 3 values"]]);
  check.equal(await entryNow(), "sprout"); check.equal((await text()).includes(canary), false);
  {
    const wire = await evaluate("Promise.all([window.vault.entries(), window.vault.entryOpen({ id: document.querySelector('.erow').dataset.id })]).then(JSON.stringify)");
    check.equal(wire.includes(canary), false); check.equal(wire.includes(`${canary}-token`), false); check.equal(wire.includes("DATABASE_URL"), true);
  }
  // Every value below is synthetic; none may ever reach a list or an open entry.
  const loginName = "alex.rivera", cardNumber = `4111-${randomBytes(6).toString("hex")}`, cardCode = `cvc${randomBytes(3).toString("hex")}`, keyText = `-----BEGIN SYNTHETIC KEY-----\n${randomBytes(24).toString("hex")}\n-----END SYNTHETIC KEY-----`;
  const passphrase = `phrase-${randomBytes(8).toString("hex")}`, envValue = `env-${randomBytes(9).toString("hex")}`, spare = `spare-${randomBytes(6).toString("hex")}`, gate = `gate-${randomBytes(4).toString("hex")}`;
  const leaseNote = `lease-note-${randomBytes(6).toString("hex")}`, wifiText = `wifi-${randomBytes(8).toString("hex")}`, totpKey = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  say("the kinds menu offers the seven kinds, each with what it is for");
  await click("Add an entry");
  await showing("Login", "A website or app account", "Card", "A payment card", "Document", "A file, kept encrypted", "Note", "Private text", "Key", "An SSH or API key", "Environment", "Values a project loads in the terminal", "Custom", "Fields you name yourself");
  check.equal(await count(".popover .menu-item"), 7); await shoot("add-open", true);

  say("a login: the generator's length and switches, then Save");
  await pick("Login"); await showing("New login", "Name", "Username", "Password", "Website", "One-time code key");
  check.equal(await exists(".popover"), false);
  await set('input[name="title"]', "Northwind Mail"); await set('input[name="username"]', loginName);
  await shoot("add-login", true);
  await click("Generate a password"); await poll("the generator", () => exists(".generator"));
  const previewNow = () => read(".generator .preview");
  check.match(await previewNow(), /^[A-Za-z0-9!@#$%^&*\-_=+?]{20}$/); check.equal(await read(".generator .strong:not(.label)") !== null, true);
  await shoot("generator", true);
  await press(".generator .checkbox", "Symbols"); check.match(await previewNow(), /^[A-Za-z0-9]{20}$/);
  await press(".generator .checkbox", "Numbers"); check.match(await previewNow(), /^[A-Za-z]{20}$/);
  await press(".generator .checkbox", "Uppercase"); check.match(await previewNow(), /^[a-z]{20}$/);
  await set(".generator .slider", "12"); check.match(await previewNow(), /^[a-z]{12}$/); check.equal(await evaluate("[...document.querySelectorAll('.generator .strong')].some(node => node.textContent === '12')"), true);
  await press(".generator .checkbox", "Symbols"); await press(".generator .checkbox", "Numbers"); await press(".generator .checkbox", "Uppercase"); await set(".generator .slider", "30");
  const previous = await previewNow(); check.match(previous, /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*\-_=+?])[A-Za-z0-9!@#$%^&*\-_=+?]{30}$/);
  await click("Make another"); check.notEqual(await previewNow(), previous);
  const generated = await previewNow(); await click("Use this password"); await poll("the generator to close", async () => !(await exists(".generator")));
  check.equal(await evaluate("document.querySelector('input[name=password]').value"), generated); check.equal(await evaluate("document.querySelector('input[name=password]').type"), "text");
  await set('input[name="website"]', "https://northwind.example"); await set('input[name="totp"]', totpKey);
  await click("Save"); await poll("the new login", async () => (await entryNow()) === "Northwind Mail");
  {
    const row = await rowOf("Northwind Mail");
    plain("the login's fields", row.entry.fields.map(field => [field.id, field.secret, field.value]), [["username", false, loginName], ["password", true, generated], ["website", false, "https://northwind.example"]]);
    plain("the login's key", [row.entry.totp, row.entry.kind, row.version, row.entry.favorite], [totpKey, "login", 1, false]);
  }

  say("a card, a document, a note, a key, an environment and a custom entry");
  await addKind("Card"); await showing("New card", "Cardholder", "Number", "Expires", "Security code");
  await set('input[name="title"]', "Atlas Card"); await set('input[name="holder"]', "A. Rivera"); await set('input[name="number"]', cardNumber); await set('input[name="expiry"]', "09/29"); await set('input[name="securityCode"]', cardCode);
  await shoot("add-card", true); await click("Save"); await poll("the card", async () => (await entryNow()) === "Atlas Card");
  plain("the card's fields", (await rowOf("Atlas Card")).entry.fields.map(field => [field.id, field.secret, field.value]), [["holder", false, "A. Rivera"], ["number", true, cardNumber], ["expiry", false, "09/29"], ["securityCode", true, cardCode]]);

  await addKind("Document"); await showing("New document", "Note"); await set('input[name="title"]', "Lease contract"); await set('textarea[name="note"]', leaseNote);
  await shoot("add-document", true); await click("Save"); await poll("the document", async () => (await entryNow()) === "Lease contract");
  plain("the document", [(await rowOf("Lease contract")).entry.kind, (await rowOf("Lease contract")).entry.note, (await rowOf("Lease contract")).entry.fields, (await rowOf("Lease contract")).entry.files], ["doc", leaseNote, [], []]);

  await addKind("Note"); await showing("New note", "Text"); await set('input[name="title"]', "Home Wi-Fi"); await set('textarea[name="note"]', wifiText);
  await shoot("add-note", true); await click("Save"); await poll("the note", async () => (await entryNow()) === "Home Wi-Fi");
  plain("the note", [(await rowOf("Home Wi-Fi")).entry.kind, (await rowOf("Home Wi-Fi")).entry.note], ["note", wifiText]);

  await addKind("Key"); await showing("New key", "Key", "Passphrase"); await set('input[name="title"]', "Build server"); await set('textarea[name="key"]', keyText); await set('input[name="passphrase"]', passphrase);
  await shoot("add-key", true); await click("Save"); await poll("the key", async () => (await entryNow()) === "Build server");
  plain("the key's fields", (await rowOf("Build server")).entry.fields.map(field => [field.id, field.secret, field.value]), [["key", true, keyText], ["passphrase", true, passphrase]]);

  // A project name that is taken is said under its field, and a variable's name must be one.
  await addKind("Environment"); await showing("New environment", "The name a run asks for: vault run --project sprout.", "Values");
  await set('input[name="title"]', "sprout"); await set('input[name="field-name"]', "API_URL", 0); await set('input[name="field-value"]', envValue, 0); await click("Save");
  await showing("There is already an environment named sprout."); check.equal(await evaluate("document.querySelector('.input.error') !== null"), true);
  await set('input[name="title"]', "forge"); await press(".small", "Add value"); await poll("the second value", async () => (await count('input[name="field-name"]')) === 2);
  await set('input[name="field-name"]', "bad-name", 1); await set('input[name="field-value"]', envValue, 1); await shoot("add-env", true); await click("Save"); await showing("bad-name is not a valid name.");
  await set('input[name="field-name"]', "API_URL", 1); await click("Save"); await showing("API_URL appears twice.");
  await set('input[name="field-name"]', "API_TOKEN", 1); await click("Save"); await poll("the environment", async () => (await entryNow()) === "forge");
  plain("the environment's fields", (await rowOf("forge")).entry.fields.map(field => [field.id, field.secret, field.value]), [["API_URL", true, envValue], ["API_TOKEN", true, envValue]]);

  await addKind("Custom"); await showing("New custom entry", "Fields"); await set('input[name="title"]', "Gate code");
  await set('input[name="field-name"]', "Code", 0); await set('input[name="field-value"]', gate, 0); await click("Hidden"); await poll("the field shown", async () => (await evaluate("document.querySelector('input[name=field-value]').type")) === "text");
  await press(".small", "Add field"); await poll("the second field", async () => (await count('input[name="field-name"]')) === 2);
  await set('input[name="field-name"]', "Spare", 1); await set('input[name="field-value"]', spare, 1); await shoot("add-custom", true); await click("Save"); await poll("the custom entry", async () => (await entryNow()) === "Gate code");
  plain("the custom fields", (await rowOf("Gate code")).entry.fields.map(field => [field.name, field.secret, field.value]), [["Code", false, gate], ["Spare", true, spare]]);

  say("the list has one row for each, newest first, and no secret value has crossed to the window");
  plain("the rows", await rowsText(), [["Gate code", "Custom, 2 fields"], ["forge", "Environment, 2 values"], ["Build server", "Key"], ["Home Wi-Fi", "Note"], ["Lease contract", "Document"], ["Atlas Card", "Card, A. Rivera"], ["Northwind Mail", loginName], ["sprout", "Environment, 3 values"]]);
  {
    const wire = await evaluate(`(async () => { const list = await window.vault.entries(); if (!list.ok) throw new Error("entries " + list.code); const opened = await Promise.all(list.entries.map(item => window.vault.entryOpen({ id: item.id }))); return JSON.stringify([list, opened]); })()`);
    for (const hidden of [generated, cardNumber, cardCode, keyText, passphrase, envValue, spare, leaseNote, wifiText, totpKey, canary, `${canary}-token`]) check.equal(wire.includes(hidden), false);
    for (const shown of [loginName, gate, "A. Rivera", "https://northwind.example"]) check.equal(wire.includes(shown), true);
    const page = await evaluate("document.documentElement.outerHTML + document.body.innerText"); for (const hidden of [generated, cardNumber, keyText, envValue, spare]) check.equal(page.includes(hidden), false);
  }

  say("search shows results as they are typed, over names, usernames and websites");
  await set('input[name="search"]', "northwind"); plain("the results", await rowsText(), [["Northwind Mail", loginName]]);
  check.equal(await read(".filter span"), "Results"); check.equal(await read(".filterrow .count"), "1"); check.equal(await evaluate("document.querySelector('.search .clear').hidden"), false);
  await shoot("search", true);
  await set('input[name="search"]', "ALEX.rivera"); check.equal(await count(".erow"), 1); await set('input[name="search"]', "northwind.example"); check.equal(await count(".erow"), 1);
  await set('input[name="search"]', "a. riv"); check.equal(await count(".erow"), 1); await set('input[name="search"]', "zzz"); check.equal(await count(".erow"), 0); await showing("No entries match.");
  await click("Clear the search"); check.equal(await evaluate("document.querySelector('input[name=search]').value"), ""); check.equal(await count(".erow"), 8); check.equal(await read(".filter span"), "All entries");

  say("the kind filter shows its counts, favourites first");
  await click("Show: All entries"); await poll("the filter menu", () => exists(".popover .menu-item"));
  plain("the filter lines", await evaluate("[...document.querySelectorAll('.popover .menu-item')].map(node => [node.querySelector('.name').textContent, node.querySelector('.hint').textContent, node.getAttribute('aria-checked')])"),
    [["All entries", "8", "true"], ["Favourites", "0", "false"], ["Logins", "1", "false"], ["Cards", "1", "false"], ["Documents", "1", "false"], ["Notes", "1", "false"], ["Keys", "1", "false"], ["Environment", "2", "false"], ["Custom", "1", "false"]]);
  await shoot("filter-open", true); await pick("Environment"); plain("the environments", (await rowsText()).map(row => row[0]), ["forge", "sprout"]); check.equal(await read(".filter span"), "Environment"); check.equal(await read(".filterrow .count"), "2");
  await click("Show: Environment"); await pick("Logins"); plain("the logins", (await rowsText()).map(row => row[0]), ["Northwind Mail"]);
  await choose("Northwind Mail"); await click("Add to favourites"); await settle("the favourite", async () => (await rowOf("Northwind Mail")).entry.favorite === true);
  check.equal(await evaluate("document.querySelector('.entry .head .ib').getAttribute('aria-pressed')"), "true"); check.equal(await evaluate("document.querySelector('.entry .head .ib').getAttribute('aria-label')"), "Remove from favourites");
  await click("Show: Logins"); check.equal(await evaluate("[...document.querySelectorAll('.popover .menu-item')].find(node => node.querySelector('.name').textContent === 'Favourites').querySelector('.hint').textContent"), "1");
  await pick("Favourites"); plain("the favourites", (await rowsText()).map(row => row[0]), ["Northwind Mail"]);
  await click("Show: Favourites"); await pick("All entries"); check.equal(await count(".erow"), 8);

  say("an open entry shows its fields hidden; its one-time code counts down");
  await choose("Northwind Mail"); {
    const shown = await text();
    for (const part of ["Username", loginName, "Password", "••••••••••••••", "One-time code", "Website", "https://northwind.example", "Edit", "Copied values clear from the clipboard after 30 seconds."]) check.equal(shown.includes(part), true, part);
    check.equal(shown.includes(generated), false);
  }
  await poll("the code", async () => /^\d{3} \d{3}$/.test(await read(".value.accent") ?? ""));
  {
    const key = Buffer.from("12345678901234567890"), shownCode = (await read(".value.accent")).replace(" ", ""), moment = Date.now();
    check.ok([totp(key, moment).code, totp(key, moment - 30000).code, totp(key, moment + 30000).code].includes(shownCode), "the code is the key's current one");
    const seconds = Number((await read(".seconds")).replace(" s", "")); check.ok(seconds >= 0 && seconds <= 30, `seconds ${seconds}`);
    await poll("the seconds to move", async () => Number((await read(".seconds")).replace(" s", "")) !== seconds, 8000);
  }
  await shoot("list", true);

  say("reveal shows one value until the entry closes; copy puts it on the clipboard and clears it when the time is up, only if it is still there");
  await click("Reveal"); await poll("the revealed password", async () => (await evaluate("document.querySelector('.entry .frow:nth-child(2) .value').textContent")) === generated);
  check.equal(await evaluate("[...document.querySelectorAll('.entry button')].some(node => node.getAttribute('aria-label') === 'Hide' && node.getAttribute('aria-pressed') === 'true')"), true);
  const written = board.writes; await click("Copy password");
  await showing("Password copied. It clears in 30 seconds."); check.equal(board.text, generated); check.equal(board.writes, written + 1);
  await shoot("revealed", true);
  await poll("the clipboard to clear", async () => board.text === "", 10000); check.ok(board.clears >= 1);
  const cleared = board.clears; await click("Copy username"); await poll("the username copied", async () => board.text === loginName); board.text = "something the person copied";
  await wait(CLIPBOARD_MS + 700); check.equal(board.text, "something the person copied"); check.equal(board.clears, cleared);
  await click("Copy one-time code"); await poll("the code copied", async () => /^\d{6}$/.test(board.text)); await poll("the code to clear", async () => board.text === "", 10000);
  await click("Hide"); await poll("the value hidden again", async () => (await evaluate("document.querySelector('.entry .frow:nth-child(2) .value').textContent")) === "••••••••••••••");
  await click("Open website"); await poll("the website", async () => opened.length === 1); plain("the opened address", opened, ["https://northwind.example/"]);
  await choose("Build server"); await click("Reveal"); await poll("the key", async () => (await evaluate("document.querySelector('.value.block')?.textContent")) === keyText); await click("Copy key"); await poll("the key copied", async () => board.text === keyText);
  await choose("Home Wi-Fi"); await click("Reveal"); await poll("the text", async () => (await evaluate("document.querySelector('.value.block')?.textContent")) === wifiText);
  await choose("Gate code"); check.equal((await text()).includes(gate), true); check.equal((await text()).includes(spare), false);
  await choose("forge"); {
    const shown = await text(); check.equal(shown.includes("API_URL") && shown.includes("API_TOKEN"), true); check.equal(shown.includes(envValue), false);
  }
  await wait(CLIPBOARD_MS + 300);

  say("editing keeps every secret that was not typed again, and saves against the version that was seen");
  await choose("Northwind Mail"); const original = await rowOf("Northwind Mail");
  await click("Edit"); await showing("Unchanged. Type to replace it.", "Delete entry", "Cancel", "Save");
  check.deepEqual(await evaluate("[document.querySelector('input[name=password]').value, document.querySelector('input[name=password]').placeholder, document.querySelector('input[name=username]').value, document.querySelector('input[name=totp]').value]"), ["", "••••••••", loginName, ""]);
  await shoot("edit", true);
  await click("Reveal"); await poll("the stored password", async () => (await evaluate("document.querySelector('input[name=password]').value")) === generated);
  await set('input[name="username"]', "alex.r"); await click("Save"); await poll("the saved edit", async () => (await text()).includes("alex.r") && !(await exists("form.formpane")));
  {
    const row = await rowOf("Northwind Mail");
    plain("the edited login", [row.entry.fields[0].value, row.entry.fields[1].value, row.entry.totp, row.version, row.entry.favorite], ["alex.r", generated, totpKey, original.version + 1, true]);
    check.ok(row.entry.updatedAt > original.entry.updatedAt);
  }
  // Another app changes the entry while the form is open: saving says so, and nothing is overwritten.
  await click("Edit"); await set('input[name="username"]', "must not be saved");
  { const now = await rowOf("Northwind Mail"); await manager.entries.save({ ...now.entry, note: "changed elsewhere" }, now.version); }
  await click("Save"); await showing("This entry was changed somewhere else. Reload it to see the latest version.", "Reload"); await shoot("edit-conflict", true);
  check.equal((await rowOf("Northwind Mail")).entry.fields[0].value, "alex.r");
  await click("Reload"); await poll("the entry again", async () => (await text()).includes("alex.r") && !(await exists("form.formpane")));
  check.equal((await rowOf("Northwind Mail")).entry.note, "changed elsewhere");

  say("leaving a form with changes asks first");
  await choose("Build server"); await click("Edit"); await set('input[name="title"]', "Build server 2");
  await evaluate("[...document.querySelectorAll('.erow')].find(row => row.querySelector('.rname').textContent === 'Home Wi-Fi').click()");
  await showing("Discard the changes?", "Nothing has been saved yet."); await shoot("discard", true);
  await click("Keep editing", "document.querySelector('#modal')"); await gone("Discard the changes?"); check.equal(await exists("form.formpane"), true);
  await evaluate("[...document.querySelectorAll('.erow')].find(row => row.querySelector('.rname').textContent === 'Home Wi-Fi').click()");
  await showing("Discard the changes?"); await click("Discard", "document.querySelector('#modal')"); await poll("the note", async () => (await entryNow()) === "Home Wi-Fi");
  check.equal((await rowOf("Build server")).entry.title, "Build server");

  say("deleting removes the entry at once and offers Undo while the toast is up");
  await choose("Atlas Card"); const atlas = await rowOf("Atlas Card");
  await click("Edit"); await click("Delete entry"); await showing("Atlas Card deleted.", "Undo"); await settle("the card gone", async () => !(await rowOf("Atlas Card")));
  check.equal(await count(".erow"), 7); await showing("Choose an entry to see it."); await shoot("deleted", true);
  await click("Undo"); await settle("the card back", async () => !!(await rowOf("Atlas Card"))); await settle("the row back", async () => (await count(".erow")) === 8);
  { const back = await rowOf("Atlas Card"); plain("the restored card", [back.entry.id, back.entry.fields.map(field => field.value), back.version], [atlas.entry.id, atlas.entry.fields.map(field => field.value), 1]); }
  check.equal(await exists(".toast"), false);
  // A document's files go when it does and cannot come back, so that is asked first and no Undo is offered.
  {
    const bytes = randomBytes(40), chunk = crypto.randomUUID(), { key: dataKey } = service.vault.key();
    await service.vault.store.putChunk(chunk, await core.encrypt(dataKey, Uint8Array.from(bytes), `chunk:${chunk}`));
    const filed = core.newEntry("doc"); filed.title = "Passport scan"; filed.files = [{ id: crypto.randomUUID(), name: "passport.pdf", type: "application/pdf", size: 40, chunks: [chunk] }]; await manager.entries.save(filed, 0);
    await evaluate("window.dispatchEvent(new Event('focus'))"); await poll("the new row", async () => (await count(".erow")) === 9);
    await choose("Passport scan"); await showing("passport.pdf", "40 B"); check.deepEqual(await rowsText().then(rows => rows.find(row => row[0] === "Passport scan")), ["Passport scan", "Document, PDF"]);
    await shoot("doc-files", true);
    await click("Edit"); await click("Delete entry"); await showing("Delete Passport scan?", "Its files are deleted with it and cannot be restored."); await shoot("delete-files", true);
    await click("Cancel", "document.querySelector('#modal')"); await gone("Delete Passport scan?"); check.equal(!!(await rowOf("Passport scan")), true);
    await click("Delete entry"); await click("Delete", "document.querySelector('#modal')"); await settle("the document gone", async () => !(await rowOf("Passport scan")));
    await showing("Passport scan deleted."); check.equal(await exists(".toast-action"), false);
    await assert.rejects(() => service.vault.store.getChunk(chunk)); checks++;
  }
  await poll("the list again", async () => (await count(".erow")) === 8);

  say("the menu: Apps, Import and Export say where they are; Settings and the tips work");
  await click("Menu"); await poll("the menu", () => exists(".popover .menu-item"));
  await showing("Apps", "In the command line for now: vault apps", "Import", "In the command line for now: vault import", "Export", "In the command line for now: vault export", "Settings", "Locking, Windows Hello, language, theme", "Show the tips again", "The first-open tour");
  plain("the menu lines", await evaluate("[...document.querySelectorAll('.popover .menu-item')].map(node => [node.querySelector('.name').textContent, node.getAttribute('aria-disabled')])"),
    [["Apps", "true"], ["Import", "true"], ["Export", "true"], ["Settings", null], ["Show the tips again", null]]);
  await evaluate("[...document.querySelectorAll('.popover .menu-item')][0].click()"); check.equal(await exists(".popover"), true); check.equal(await exists(".main"), true);
  await shoot("menu-open", true);
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await poll("the menu to close", async () => !(await exists(".popover")));
  await click("Menu"); await pick("Show the tips again"); await showing("Welcome to Vault", "1 of 2", "Add or import"); await click("Got it"); await gone("Welcome to Vault");

  say("the settings: each choice is saved when it is made and applied at once");
  await click("Menu"); await pick("Settings"); await showing("Settings", "Lock after idle", "Lock when the last app closes", "Windows Hello", "Language", "Theme", "Sync", "Encrypted sync through a cloud folder you choose.", "Coming later");
  check.equal(await exists(".main"), false);
  plain("the controls", await evaluate("[...document.querySelectorAll('.select, .toggle')].map(node => node.getAttribute('aria-label') + '|' + (node.getAttribute('aria-checked') ?? ''))"),
    ["Lock after idle: 15 minutes|", "Lock when the last app closes|false", "Windows Hello|false", "Language: English|", "Theme: Dark|"]);
  const resync = async () => { settings = await manager.settings.get(); };
  await shoot("settings", true);
  await click("Lock after idle: 15 minutes"); await showing("1 minute", "5 minutes", "30 minutes", "1 hour", "4 hours"); check.equal(await count(".popover .menu-item"), 6); await shoot("idle-open", true);
  await pick("30 minutes"); await settle("the idle time", async () => (await manager.settings.get()).idleMinutes === 30); check.equal(service.vault.memory.idle, 30 * 60000); await resync();
  check.equal(await evaluate("document.querySelector('.select').getAttribute('aria-label')"), "Lock after idle: 30 minutes");
  await click("Lock when the last app closes"); await settle("the last-app rule", async () => (await manager.settings.get()).lockWithLastApp === true); check.equal(service.lifecycle.lockWithLastApp, true); await resync();
  await click("Language: English"); await showing("System", "English", "Español"); await shoot("language-open", true); await pick("Español");
  await poll("Spanish", async () => (await evaluate("document.documentElement.lang")) === "es"); await showing("Ajustes", "Bloquear por inactividad", "Tema", "Idioma", "Próximamente");
  check.equal((await manager.settings.get()).language, "es"); await resync(); await capture("settings-es-dark");
  await click("Idioma: Español"); await showing("Sistema"); await pick("English"); await poll("English", async () => (await evaluate("document.documentElement.lang")) === "en"); await showing("Lock after idle"); await resync();
  await click("Theme: Dark"); await showing("System", "Dark", "Light"); await shoot("theme-open", true); await pick("Light");
  await settle("the light theme", async () => (await evaluate("document.documentElement.dataset.theme")) === "light"); check.equal((await manager.settings.get()).theme, "light");
  await click("Theme: Light"); await pick("System"); await settle("the system setting", async () => (await manager.settings.get()).theme === "system");
  await click("Theme: System"); await pick("Dark"); await poll("dark again", async () => (await evaluate("document.documentElement.dataset.theme")) === "dark"); await resync();
  plain("the settings kept", await manager.settings.get(), { idleMinutes: 30, lockWithLastApp: true, language: "en", theme: "dark" });
  await click("Lock when the last app closes"); await settle("the last-app rule off", async () => (await manager.settings.get()).lockWithLastApp === false); await resync();

  say("Windows Hello is turned on with the master password, in the board's dialog, and off with one press");
  await poll("Hello to be available", async () => evaluate("window.vault.state().then(state => state.helloAvailable)"));
  await poll("the switch to be usable", async () => (await evaluate("document.querySelector('[aria-label=\"Windows Hello\"]').disabled")) === false); check.equal(fs.existsSync(path.join(home, "secrets", "hello.json")), false);
  await click("Windows Hello"); await showing("Turn on Windows Hello", "Type the master password once. After that, Windows Hello can unlock Vault.");
  check.equal(await evaluate("document.getElementById('screen').hasAttribute('inert')"), true);
  await click("Cancel", "document.querySelector('#modal')"); await gone("Turn on Windows Hello"); check.equal(await evaluate("document.querySelector('[aria-label=\"Windows Hello\"]').getAttribute('aria-checked')"), "false");
  await click("Windows Hello"); await showing("Turn on Windows Hello"); await type("password", wrong, "document.querySelector('#modal')"); await click("Turn on", "document.querySelector('#modal')"); await showing("That password is not right.");
  check.equal(fs.existsSync(path.join(home, "secrets", "hello.json")), false); await shoot("hello-password", true);
  await wait(1100); await type("password", changed, "document.querySelector('#modal')"); await click("Turn on", "document.querySelector('#modal')");
  await gone("Turn on Windows Hello"); await poll("Hello on", async () => fs.existsSync(path.join(home, "secrets", "hello.json")));
  await poll("the switch on", async () => (await evaluate("document.querySelector('[aria-label=\"Windows Hello\"]').getAttribute('aria-checked')")) === "true");
  await click("Windows Hello"); await poll("Hello off", async () => !fs.existsSync(path.join(home, "secrets", "hello.json")));
  await poll("the switch off", async () => (await evaluate("document.querySelector('[aria-label=\"Windows Hello\"]').getAttribute('aria-checked')")) === "false");
  await click("Back to the list"); await listShown(); await showing("Choose an entry to see it.");
  await wait(CLIPBOARD_MS + 300);

  say("the window controls ask the window, and the page raised no errors");
  controls.length = 0; await click("Minimize"); await click("Maximize"); await click("Close"); await poll("the window calls", async () => controls.join() === "minimize,maximize,close");
  const ignorable = /Failed to load resource|ERR_BLOCKED_BY_CLIENT/;
  check.deepEqual(problems.filter(message => !ignorable.test(message)), []);

  say("quitting leaves the service");
  await running.stop(); await manager.close().catch(() => undefined);
  for (const api of [asker, other, agent]) await api.close().catch(() => undefined);
  await service.shutdown();
  console.log(`Vault app smoke: ${checks} checks passed, ${shots} screenshots in ${path.relative(root, screens)}.`);
}

const watchdog = setTimeout(() => { console.error(`Vault app smoke timed out at "${step}".`); finish(2); }, 900000);
// Anything that closes the app before this check is done is a failure, even a quiet one.
let finished = false; const exit = app.exit.bind(app);
app.exit = code => { if (finished) exit(code); else { console.error(`The app closed before the check finished (${step}).`); exit(3); } };
function finish(code) {
  finished = true; clearTimeout(watchdog);
  // The browser's files are held until the process ends, so a detached command removes the folder a moment after it.
  try { fs.rmSync(path.join(scratch, "home"), { recursive: true, force: true }); } catch {}
  if (process.platform === "win32" && /^[A-Za-z]:[\\/][\w .\\/-]+$/.test(scratch)) childProcess.spawn("cmd.exe", ["/d", "/s", "/c", `"ping -n 8 127.0.0.1 >nul & rmdir /s /q "${scratch}""`], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true }).unref();
  else try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  app.exit(code);
}
if (launch) main().then(() => finish(0), async error => {
  console.error(`Vault app smoke failed at "${step}": ${error && error.generatedMessage === false ? error.message : error && error.name === "AssertionError" ? (process.env.VAULT_SMOKE_VERBOSE ? error.message.slice(0, 400) : "assertion") : String(error && error.message || error).replace(/[A-Za-z0-9+/=_-]{30,}/g, "[value]")}`);
  if (error && error.stack) console.error(error.stack.split("\n").filter(line => /smoke\.cjs:\d+:\d+/.test(line)).slice(0, 4).join("\n"));
  try { if (running) fs.writeFileSync(path.join(screens, "failure.png"), (await page().capturePage()).toPNG()); } catch {}
  try { if (running) console.error((await text()).slice(0, 600)); } catch {}
  // What the service logged last says why a call was refused; the log holds codes and ids, never values.
  try {
    const rows = fs.readFileSync(path.join(home, "logs", "events.jsonl"), "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)), tally = {};
    for (const row of rows) { const key = `${row.fields?.actor}:${row.fields?.outcome}`; tally[key] = (tally[key] ?? 0) + 1; }
    console.error(JSON.stringify(tally));
  } catch {}
  try { if (running) console.error(JSON.stringify({ ...running.link.snapshot(), prompt: null })); } catch {}
  try { if (running) console.error(await evaluate("JSON.stringify({ inputs: [...document.querySelectorAll('input')].map(item => [item.name, item.type, item.value.length, item.disabled]), busy: document.querySelectorAll('[aria-busy]').length, inert: [...document.querySelectorAll('[inert]')].map(node => node.id) })")); } catch {}
  console.error(`Phases of the link: ${JSON.stringify(phases)}`);
  console.error(`Worst hold-up of the event loop: ${lag.worst} ms during "${lag.at}".`);
  finish(1);
});
