"use strict";
// Drives the real Vault app, window and all, against a real service from this checkout: first run, lock, unlock, an unlock prompt, Windows Hello,
// an agent's run request, a permission request and the recovery key, asserting the screens and the service state and saving a screenshot of each
// screen in the dark and the light theme under build/screens.
//
// Run it with the Electron binary, after `npm run build`:
//   $env:ELECTRON_OVERRIDE_DIST_PATH = "<folder of Electron 44.5.1>"; & "$env:ELECTRON_OVERRIDE_DIST_PATH\electron.exe" packages\app\test\smoke.cjs
//
// Everything is synthetic and lives in one temporary folder: the vault home, the browser's data and the files the app saves. The home is created here,
// whatever VAULT_HOME says, and the test guard refuses any access to the default Cosmic folders. Windows Hello is a stand-in for the native helper (nobody is
// there to touch a sensor), and the system dialogs are replaced by functions that answer with files in the temporary folder.
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
let checks = 0, shots = 0, step = "start";
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "match", "doesNotMatch", "ok"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
// For values that are never secret (sizes, names), so that a failure says what it found.
const plain = (label, actual, expected) => { checks++; if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} is ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`); };
const say = text => { step = text; console.log(`  ${text}`); };

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
for (const name of ["minimize", "maximize", "unmaximize", "close"]) BrowserWindow.prototype[name] = function control() { controls.push(name); };

const saved = { kit: path.join(scratch, "kit.txt"), backup: path.join(scratch, "backup.vault"), printed: 0 };
const { prepare } = require(path.join(root, "packages", "app", "dist", "main", "app.js"));
// Started the way the service starts it when a prompt waits and nobody is there.
const launch = prepare({ env: process.env, argv: ["--prompts"], platform: {
  saveFile: async () => saved.kit, openFile: async () => saved.backup,
  print: async () => { saved.printed++; return { ok: true }; },
} });
if (!launch) { console.error("Another Vault app already runs on this home."); app.exit(1); }

const password = randomBytes(24).toString("base64"), changed = randomBytes(24).toString("base64"), wrong = randomBytes(24).toString("base64"), canary = randomBytes(24).toString("base64");
const backupPassword = randomBytes(24).toString("base64");
let running, service, manager, settings = { idleMinutes: 15, lockWithLastApp: false, language: "en", theme: "dark" };

// ---- driving the page --------------------------------------------------------------------------------------------------------------------------------------
const page = () => running.window.webContents;
const evaluate = code => page().executeJavaScript(code, true);
const poll = async (what, work, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) { let value; try { value = await work(); } catch { value = undefined; } if (value) return value; if (Date.now() > end) throw new Error(`Timed out waiting for ${what} (${step})`); await wait(40); }
};
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
/** The screen as it is, in the dark theme and then the light one; `quiet` changes the theme in the page, for a moment when the service cannot answer. */
const shoot = async (name, quiet = false) => {
  for (const mode of ["dark", "light"]) { if (quiet) await theme(mode); else await setting({ theme: mode }); await capture(`${name}-${mode}`); }
  if (quiet) await theme("dark"); else await setting({ theme: "dark" });
};
const keyOnScreen = () => evaluate('[...document.querySelectorAll(".keybox .line")].map(line => line.textContent).join("-")');
const unlocked = async () => (await manager.status()).unlocked;

async function main() {
  const { connect } = await import(pathToFileURL(path.join(root, "packages", "client", "dist", "index.js")).href);
  const { startService } = await import(pathToFileURL(path.join(root, "packages", "service", "dist", "service", "src", "server.js")).href);
  const core = await import(pathToFileURL(path.join(root, "packages", "core", "dist", "index.js")).href);
  const { recoveryKit } = await import(pathToFileURL(path.join(root, "packages", "client", "dist", "index.js")).href);
  const tokens = () => { let value; return { async get() { return value; }, async set(token) { value = token; } }; };
  const as = (id, name, kind = "app") => connect({ home, app: { id, name, kind }, tokens: tokens(), heartbeatMs: 2000 });
  fs.mkdirSync(scratch, { recursive: true });

  say("starting the service and the app");
  service = await startService({ home, prompts: { waitMs: 1000 } });
  manager = await as("vault-cli", "Vault CLI", "cosmic");
  await manager.settings.set(settings);
  const entry = core.newEntry("login"); entry.title = "Northwind Mail"; entry.fields = [{ id: "username", name: "Username", secret: false, value: "alex.rivera" }, { id: "password", name: "Password", secret: true, value: canary }, { id: "website", name: "Website", secret: false, value: "https://northwind.example" }];
  const made = await core.createEnvelope(backupPassword);
  fs.writeFileSync(saved.backup, JSON.stringify({ format: "vault-backup", version: 1, envelope: made.state, sealed: await core.encryptJson(made.key, { entries: [entry], chunks: [] }, "backup") }));
  running = await launch();
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
  check.deepEqual(await evaluate("Object.keys(window.vault).sort()"), ["allowImport", "allowImportWithHello", "approveRun", "approveRunWithHello", "chooseBackup", "close", "create", "dismissPrompt", "finishSetup", "interact", "lock", "minimize", "onState", "printRecoverySheet", "recover", "restoreBackup", "retry", "saveRecoverySheet", "state", "toggleMaximize", "unlock", "unlockWithHello"]);
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

  say("the recovery sheet: saved once, never over a file, printed, and the checkbox gates Open Vault");
  await click("Save recovery sheet"); await showing("Recovery sheet saved.");
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
  await evaluate("document.querySelector('.checkbox input').click()"); await click("Open Vault"); await showing("Your vault is empty");
  check.equal(fs.existsSync(path.join(home, "secrets", "hello.json")), false);
  await manager.lock(); await running.link.refresh(); await showing("Vault is locked");
  check.equal(await evaluate("[...document.querySelectorAll('button')].some(item => item.textContent.trim() === 'Windows Hello')"), false);
  await wait(1100); await type("password", password, undefined); await click("Unlock"); await showing("That password is not right.");
  await wait(1100); await type("password", changed); await click("Unlock"); await showing("Your vault is empty");

  say("the window controls ask the window, and the page raised no errors");
  await click("Minimize"); await click("Maximize"); await click("Close"); await poll("the window calls", async () => controls.join() === "minimize,maximize,close");
  const ignorable = /Failed to load resource|ERR_BLOCKED_BY_CLIENT/;
  check.deepEqual(problems.filter(message => !ignorable.test(message)), []);

  say("quitting leaves the service");
  await running.stop(); await manager.close().catch(() => undefined);
  for (const api of [asker, other, agent]) await api.close().catch(() => undefined);
  await service.shutdown();
  console.log(`Vault app smoke: ${checks} checks passed, ${shots} screenshots in ${path.relative(root, screens)}.`);
}

const watchdog = setTimeout(() => { console.error(`Vault app smoke timed out at "${step}".`); finish(2); }, 240000);
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
  finish(1);
});
