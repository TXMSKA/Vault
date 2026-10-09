import "../../../test/guard.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { quitWhenIdle } from "../dist/main/quit.js";
import { SHAPES, accepts } from "../dist/main/validate.js";
import { CSP, ORIGIN, resolveRequest, serve } from "../dist/main/protocol.js";
import { route, toView } from "../dist/main/prompts.js";
import { readBackup, writeKit, kitName } from "../dist/main/files.js";
import { resolveLanguage, resolveTheme } from "../dist/main/theme.js";
import { parseArgs } from "../dist/main/args.js";
import { codeOf } from "../dist/main/link.js";
import { commandLine, keyLines, minutesLeft, visible } from "../dist/renderer/text.js";
import { en, es } from "../dist/renderer/i18n.js";
import { recoveryKit } from "../../client/dist/index.js";

// The window's pure parts: what the bridge accepts, what the protocol serves, which prompt shows, the kit and the words. Every value is synthetic.
export const counts = { checks: 0 };
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "match", "doesNotMatch", "ok", "rejects"].map(name => [name, (...args) => { counts.checks++; return assert[name](...args); }]));
const scratch = await mkdtemp(join(resolve(tmpdir()), "app-units-"));
const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e", other = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const password = "synthetic-long-password-1", short = "too short";
try {
  // ---- the bridge's arguments: exactly the keys of the call, each one within its cap -------------------------------------------------------
  const bridge = ["state", "onState", "create", "chooseBackup", "restoreBackup", "unlock", "unlockWithHello", "recover", "lock", "saveRecoverySheet", "printRecoverySheet", "finishSetup", "approveRun", "approveRunWithHello", "allowImport", "allowImportWithHello", "dismissPrompt", "interact", "retry", "minimize", "toggleMaximize", "close"];
  const preload = await readFile(new URL("../dist/preload/preload.cjs", import.meta.url), "utf8");
  // The preload stands alone, so its channels are written out there and the main process knows them from SHAPES: they must be the same set.
  const named = [...preload.matchAll(/call\("([A-Za-z]+)"/g)].map(match => match[1]).sort();
  check.deepEqual(named, Object.keys(SHAPES).sort());
  for (const name of bridge) check.ok(preload.includes(`${name}:`) || preload.includes(`${name}(`), name);
  check.equal([...preload.matchAll(/ipcRenderer\.(invoke|on|removeListener|send|sendSync)\(/g)].map(match => match[1]).sort().join(), "invoke,on,removeListener");
  check.match(preload, /Object\.freeze\(bridge\)/); check.doesNotMatch(preload, /require\((?!"electron")/);
  for (const call of ["interact", "retry", "minimize", "toggleMaximize", "close", "state", "chooseBackup", "unlockWithHello", "lock", "saveRecoverySheet", "printRecoverySheet", "finishSetup"]) { check.equal(accepts(call, undefined), true); check.equal(accepts(call, {}), false); check.equal(accepts(call, null), false); check.equal(accepts(call, { password }), false); }
  check.equal(accepts("create", { password }), true); check.equal(accepts("create", { password: short }), false); check.equal(accepts("create", { password: "x".repeat(129) }), false); check.equal(accepts("create", { password: "x".repeat(128) }), true);
  check.equal(accepts("unlock", { password: "x" }), true); check.equal(accepts("unlock", { password: "" }), false); check.equal(accepts("unlock", { password: "x".repeat(129) }), false); check.equal(accepts("unlock", { password: `a${"\0"}b` }), false);
  check.equal(accepts("unlock", { password, extra: 1 }), false); check.equal(accepts("unlock", {}), false); check.equal(accepts("unlock", { pass: password }), false); check.equal(accepts("unlock", undefined), false);
  check.equal(accepts("unlock", { password: 1 }), false); check.equal(accepts("unlock", { password: ["a"] }), false); check.equal(accepts("unlock", { password: { toString: () => "a" } }), false); check.equal(accepts("unlock", [password]), false); check.equal(accepts("unlock", password), false);
  check.equal(accepts("unlock", Object.create({ password })), false); check.equal(accepts("unlock", Object.create(null)), false); check.equal(accepts("unlock", new (class { password = "x" })()), false);
  check.equal(accepts("recover", { recovery: "ABCD-EFGH", password }), true); check.equal(accepts("recover", { recovery: "", password }), false); check.equal(accepts("recover", { recovery: "x".repeat(129), password }), false); check.equal(accepts("recover", { recovery: "ABCD", password: short }), false);
  check.equal(accepts("restoreBackup", { password }), true); check.equal(accepts("restoreBackup", { password: short }), false); check.equal(accepts("restoreBackup", { file: "C:\\x.vault", password }), false);
  for (const call of ["approveRunWithHello", "approveRunWithHello", "allowImportWithHello", "dismissPrompt"]) { check.equal(accepts(call, { id: uuid }), true); check.equal(accepts(call, { id: other.toUpperCase() }), true); check.equal(accepts(call, { id: "not-an-id" }), false); check.equal(accepts(call, { id: `${uuid} ` }), false); check.equal(accepts(call, { id: uuid, password }), false); check.equal(accepts(call, {}), false); }
  for (const call of ["approveRun", "allowImport"]) { check.equal(accepts(call, { id: uuid, password }), true); check.equal(accepts(call, { id: uuid }), false); check.equal(accepts(call, { id: uuid, password: "" }), false); check.equal(accepts(call, { id: "../x", password }), false); check.equal(accepts(call, { id: uuid, password, app: "nova" }), false); }
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "", "Create", "create ", "vault:create"]) check.equal(accepts(name, undefined), false);
  check.equal(accepts(Symbol.iterator.toString(), undefined), false);

  // ---- the protocol: plain names under the app's folder, nothing else ------------------------------------------------------------------------
  const root = join(scratch, "renderer"); await mkdir(join(root, "fonts"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>x</title>"); await writeFile(join(root, "app.css"), "body{}"); await writeFile(join(root, "main.js"), "export {}"); await writeFile(join(root, "fonts", "inter.woff2"), "font"); await writeFile(join(root, "secret.txt"), "no"); await writeFile(join(scratch, "outside.html"), "outside");
  const found = address => resolveRequest(root, address);
  check.deepEqual(found(`${ORIGIN}/`), { file: join(root, "index.html"), type: "text/html; charset=utf-8" }); check.equal(found(`${ORIGIN}/index.html`).file, join(root, "index.html")); check.equal(found(`${ORIGIN}/app.css`).type, "text/css; charset=utf-8");
  check.equal(found(`${ORIGIN}/main.js`).type, "text/javascript; charset=utf-8"); check.equal(found(`${ORIGIN}/fonts/inter.woff2`).type, "font/woff2"); check.equal(found(`${ORIGIN}/fonts/inter.woff2`).file, join(root, "fonts", "inter.woff2"));
  for (const bad of [`${ORIGIN}/../outside.html`, `${ORIGIN}/fonts/../../outside.html`, `${ORIGIN}/%2e%2e/outside.html`, `${ORIGIN}/%2E%2E%2Foutside.html`, `${ORIGIN}/fonts/%2e%2e/index.html`, `${ORIGIN}/..%5Coutside.html`, `${ORIGIN}/fonts\\..\\index.html`, `${ORIGIN}/fonts//inter.woff2`, `${ORIGIN}//index.html`,
    `${ORIGIN}/./index.html`, `${ORIGIN}/fonts/./inter.woff2`, `${ORIGIN}/.hidden.html`, `${ORIGIN}/index.html?x=1`, `${ORIGIN}/index.html#x`, `${ORIGIN}/index.html?`, `${ORIGIN}:80/index.html`, `app://other/index.html`, `app://vault.evil/index.html`, `app://user@vault/index.html`, `app://vault:1/index.html`, `APP://VAULT/index.html`,
    "http://vault/index.html", "file:///index.html", `${ORIGIN}`, "app:index.html", "app:///index.html", "", "not a url", `${ORIGIN}/secret.txt`, `${ORIGIN}/secret`, `${ORIGIN}/fonts/`, `${ORIGIN}/fonts`, `${ORIGIN}/index.html/`, `${ORIGIN}/a/b/c/d/e.html`, `${ORIGIN}/index.html%00.css`, `${ORIGIN}/index.html%20`, `${ORIGIN}/ind%65x.html`,
    `${ORIGIN}/C:/Windows/win.ini`, `${ORIGIN}/c%3A/x.html`, `${ORIGIN}/index.html:stream.css`, `${ORIGIN}/a b.html`, `${ORIGIN}/${"a".repeat(65)}.html`]) check.equal(found(bad), undefined, bad);
  const served = await serve(root, { url: `${ORIGIN}/app.css`, method: "GET" });
  check.equal(served.status, 200); check.equal(await served.text(), "body{}"); check.equal(served.headers.get("content-type"), "text/css; charset=utf-8"); check.equal(served.headers.get("content-security-policy"), CSP); check.equal(served.headers.get("x-content-type-options"), "nosniff"); check.equal(served.headers.get("cache-control"), "no-store");
  for (const [request, status] of [[{ url: `${ORIGIN}/app.css`, method: "POST" }, 405], [{ url: `${ORIGIN}/app.css`, method: "HEAD" }, 405], [{ url: `${ORIGIN}/nothing.css`, method: "GET" }, 404], [{ url: `${ORIGIN}/../outside.html`, method: "GET" }, 404], [{ url: `${ORIGIN}/secret.txt`, method: "GET" }, 404]]) { const answer = await serve(root, request); check.equal(answer.status, status); check.equal(answer.headers.get("content-security-policy"), CSP); }
  try { const { symlink } = await import("node:fs/promises"); await symlink(join(scratch, "outside.html"), join(root, "link.html")); check.equal((await serve(root, { url: `${ORIGIN}/link.html`, method: "GET" })).status, 404); } catch (error) { if (error.code !== "EPERM" && error.code !== "EACCES") throw error; }
  // The policy: nothing inline, nothing remote, no frame, no form.
  for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) check.ok(CSP.includes(part), part);
  check.doesNotMatch(CSP, /unsafe|\*|data:|blob:|https?:/);
  const page = await readFile(new URL("../dist/renderer/index.html", import.meta.url), "utf8");
  check.doesNotMatch(page, /<script(?![^>]*\ssrc=)|\son\w+=|style=|javascript:/i); check.match(page, /Content-Security-Policy/); check.ok(page.includes(CSP.replace(/; frame-ancestors 'none'$/, "")));
  const css = await readFile(new URL("../dist/renderer/app.css", import.meta.url), "utf8");
  check.doesNotMatch(css, /@import|url\((?!fonts\/)|https?:\/\//);
  check.equal(parseArgs(["--prompts"]).prompts, true); check.equal(parseArgs(["C:\\app", "--prompts", "--x"]).prompts, true); check.equal(parseArgs([]).prompts, false); check.equal(parseArgs(["--prompt", "prompts"]).prompts, false);

  // ---- which prompt shows --------------------------------------------------------------------------------------------------------------------
  const app = { id: "claude-code", name: "Claude Code" };
  const unlock = (id, createdAt, reason = null) => ({ id, kind: "unlock", app, createdAt, expiresAt: "2026-10-09T12:05:00.000Z", summary: { reason } });
  const run = (id, createdAt) => ({ id, kind: "run", app, createdAt, expiresAt: "2026-10-09T12:05:00.000Z", summary: { project: "sprout", cwd: "C:\\code\\sprout", commands: [["npm", "run", "db:seed"]] } });
  const permission = (id, createdAt) => ({ id, kind: "permission", app: { id: "field-notes", name: "Field Notes" }, createdAt, expiresAt: "2026-10-09T12:05:00.000Z", summary: { permission: "import" } });
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
  const list = [permission(ids[2], "2026-10-09T12:00:03.000Z"), unlock(ids[0], "2026-10-09T12:00:01.000Z", "sync"), run(ids[1], "2026-10-09T12:00:02.000Z")];
  let routed = route(list, new Set(), { created: true, unlocked: false });
  check.equal(routed.shown.id, ids[0]); check.deepEqual(routed.fresh, [ids[0], ids[1], ids[2]]);
  routed = route(list, new Set([ids[0]]), { created: true, unlocked: false }); check.deepEqual(routed.fresh, [ids[1], ids[2]]);
  // Open vault: an unlock prompt is stale and the next one in age shows. A run waits for the person whether the vault is locked or not.
  routed = route(list, new Set(ids), { created: true, unlocked: true }); check.equal(routed.shown.id, ids[1]); check.deepEqual(routed.fresh, []);
  check.equal(route([unlock(ids[0], "2026-10-09T12:00:01.000Z")], new Set(), { created: true, unlocked: true }).shown, undefined);
  check.equal(route([], new Set(), { created: true, unlocked: false }).shown, undefined);
  // Before the vault exists nothing can be answered, but the window still comes forward for what is new.
  routed = route(list, new Set(), { created: false, unlocked: false }); check.equal(routed.shown, undefined); check.equal(routed.fresh.length, 3);
  check.equal(route(list, new Set(), { created: true, unlocked: false }).shown.id, ids[0]);
  check.deepEqual(list.map(prompt => prompt.id), [ids[2], ids[0], ids[1]]);
  // The view carries the asking app's name and id, the reason, and for a run what only the run list knows; long text is cut.
  check.deepEqual(toView(unlock(ids[0], "x", "sync"), undefined), { id: ids[0], kind: "unlock", app, reason: "sync", expiresAt: "2026-10-09T12:05:00.000Z" });
  check.equal(toView(unlock(ids[0], "x")).reason, null);
  check.deepEqual(toView(permission(ids[2], "x")), { id: ids[2], kind: "permission", app: { id: "field-notes", name: "Field Notes" }, permission: "import", expiresAt: "2026-10-09T12:05:00.000Z" });
  check.deepEqual(toView(run(ids[1], "x"), { short: ["DEBUG"], problem: "missing" }), { id: ids[1], kind: "run", app, project: "sprout", cwd: "C:\\code\\sprout", commands: [["npm", "run", "db:seed"]], short: ["DEBUG"], problem: "missing", expiresAt: "2026-10-09T12:05:00.000Z" });
  check.deepEqual([toView(run(ids[1], "x")).short, toView(run(ids[1], "x")).problem, toView(run(ids[1], "x"), { short: null }).short], [null, null, null]);
  const long = { ...run(ids[1], "x"), app: { id: "i".repeat(60), name: "n".repeat(200) }, summary: { project: "p".repeat(600), cwd: "c".repeat(5000), commands: Array.from({ length: 12 }, () => Array.from({ length: 70 }, () => "a".repeat(9000))) } };
  const cut = toView(long); check.equal(cut.app.id.length, 40); check.equal(cut.app.name.length, 120); check.equal(cut.project.length, 500); check.equal(cut.cwd.length, 4096); check.equal(cut.commands.length, 10); check.equal(cut.commands[0].length, 64); check.equal(cut.commands[0][0].length, 8192);
  check.equal(toView(unlock(ids[0], "x", "r".repeat(300))).reason.length, 120);

  // ---- a start for prompts closes itself after 30 seconds, unless somebody is there --------------------------------------------------------------
  const clock = () => { const timers = new Map(); let next = 1; return { timers, set(run, ms) { timers.set(next, { run, ms }); return next++; }, clear(id) { timers.delete(id); } }; };
  {
    const fake = clock(); let quits = 0, pending = 0; const idle = quitWhenIdle({ pending: () => pending, quit: () => { quits++; }, timers: fake });
    check.equal(fake.timers.size, 0); idle.arm(); idle.arm(); check.equal(fake.timers.size, 1); check.equal([...fake.timers.values()][0].ms, 30000);
    [...fake.timers.values()][0].run(); check.equal(quits, 1);
    // A touch before the time is up keeps it open for good; so does a prompt that waits when the time is up.
    const second = clock(); const touched = quitWhenIdle({ pending: () => 0, quit: () => { quits++; }, timers: second }); touched.arm(); touched.interact(); check.equal(second.timers.size, 0); touched.arm(); check.equal(second.timers.size, 0); check.equal(quits, 1);
    const third = clock(); pending = 1; const waiting = quitWhenIdle({ pending: () => pending, quit: () => { quits++; }, timers: third }); waiting.arm(); [...third.timers.values()][0].run(); check.equal(quits, 1);
    const late = clock(); const afterwards = quitWhenIdle({ pending: () => 0, quit: () => { quits++; }, timers: late }); afterwards.arm(); const timer = [...late.timers.values()][0]; afterwards.interact(); check.equal(late.timers.size, 0); timer.run(); check.equal(quits, 1);
  }

  // ---- the language and the theme of the window -----------------------------------------------------------------------------------------------
  check.deepEqual([resolveLanguage("system", "es-419"), resolveLanguage("system", "es"), resolveLanguage("system", "ES-ar"), resolveLanguage("system", "en-US"), resolveLanguage("system", "fr"), resolveLanguage("system", "est"), resolveLanguage("en", "es"), resolveLanguage("es", "en-US")], ["es", "es", "es", "en", "en", "en", "en", "es"]);
  check.deepEqual([resolveTheme("system", true), resolveTheme("system", false), resolveTheme("dark", false), resolveTheme("light", true)], ["dark", "light", "dark", "light"]);
  check.deepEqual([codeOf({ code: "locked" }), codeOf({ code: "unavailable" }), codeOf(new Error("x")), codeOf({ code: "Not Valid" }), codeOf({ code: 5 }), codeOf(null), codeOf(undefined), codeOf({ code: "a".repeat(60) })], ["locked", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable", "unavailable"]);

  // ---- the recovery kit: the same text as vault create --kit, saved once and never over a file ---------------------------------------------------
  const key = "ABCD - EFGH - JKLM - NPQR - STUV - WXYZ";
  const expected = `VAULT\nRecovery kit / Kit de recuperación\n\nRecovery key / Clave de recuperación:\n${key}\n\nKeep this kit offline in a safe place. It can replace your master password.\nGuardá este kit fuera de línea en un lugar seguro. Permite reemplazar la contraseña maestra.\n\nMaster password / Contraseña maestra: ______________________________\n`;
  check.equal(recoveryKit(key), expected);
  const kit = join(scratch, "kit.txt");
  check.equal(await writeKit(kit, key), "saved"); check.equal(await readFile(kit, "utf8"), expected);
  check.equal(await writeKit(kit, "SOMETHING ELSE"), "exists"); check.equal(await readFile(kit, "utf8"), expected);
  check.equal(await writeKit(join(scratch, "plain"), key), "saved"); check.equal(await readFile(join(scratch, "plain.txt"), "utf8"), expected); check.equal(await writeKit(join(scratch, "plain"), key), "exists");
  check.equal(await writeKit(join(scratch, "missing", "kit.txt"), key), "failed"); await assert.rejects(() => stat(join(scratch, "missing"))); counts.checks++;
  if (process.platform !== "win32") check.equal((await stat(kit)).mode & 0o777, 0o600);
  check.deepEqual([kitName("C:\\Users\\a\\kit"), kitName("C:\\Users\\a\\kit.TXT"), kitName("/tmp/kit.txt")], ["kit.txt", "kit.TXT", "kit.txt"]);
  // The recovery key is shown in groups of four, three to a line, whatever separators the service uses.
  check.deepEqual(keyLines(key), ["ABCD-EFGH-JKLM", "NPQR-STUV-WXYZ"]); check.deepEqual(keyLines("abcdefghjklmnpqrstuvwxyz"), ["ABCD-EFGH-JKLM", "NPQR-STUV-WXYZ"]); check.deepEqual(keyLines(""), []); check.deepEqual(keyLines("ABCDE"), ["ABCD-E"]);
  // A backup is JSON with exactly the backup's keys.
  const backup = { format: "vault-backup", version: 1, envelope: {}, sealed: { iv: "x", data: "y" } };
  for (const [name, content, ok] of [["good", JSON.stringify(backup), true], ["extra", JSON.stringify({ ...backup, extra: 1 }), false], ["missing", JSON.stringify({ format: "vault-backup", version: 1, envelope: {} }), false], ["format", JSON.stringify({ ...backup, format: "other" }), false], ["version", JSON.stringify({ ...backup, version: 2 }), false], ["array", "[]", false], ["null", "null", false], ["text", "not json", false], ["empty", "", false]]) {
    await writeFile(join(scratch, `${name}.vault`), content); const read = await readBackup(join(scratch, `${name}.vault`)); check.equal(read !== undefined, ok, name);
  }
  check.equal(await readBackup(join(scratch, "absent.vault")), undefined);

  // ---- what a request may disguise, and the words of the window ------------------------------------------------------------------------------------
  const bidi = String.fromCharCode(0x202e), zero = String.fromCharCode(0x200b), bom = String.fromCharCode(0xfeff), bell = String.fromCharCode(7), del = String.fromCharCode(0x7f), nel = String.fromCharCode(0x85), line = String.fromCharCode(0x2028);
  check.equal(visible("plain text, accents: á é ñ ü ¿"), "plain text, accents: á é ñ ü ¿");
  check.equal(visible(`a${bidi}b${zero}c${bom}d${bell}e${del}f${nel}g${line}h`), "a\\u202eb\\u200bc\\ufeffd\\u0007e\\u007ff\\u0085g\\u2028h");
  check.equal(commandLine(["npx", "prisma", "migrate", "deploy"]), "npx prisma migrate deploy"); check.equal(commandLine(["node", "-e", "console.log(1)"]), 'node -e "console.log(1)"'); check.equal(commandLine(["echo", "", "a b", 'say "hi"']), 'echo "" "a b" "say \\"hi\\""');
  check.equal(commandLine(["run", `x${bidi}y`]), "run x\\u202ey"); check.equal(commandLine(["run", `a b${bidi}`]), 'run "a b\\u202e"');
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  check.deepEqual([minutesLeft("2026-10-09T12:09:00.000Z", now), minutesLeft("2026-10-09T12:08:01.000Z", now), minutesLeft("2026-10-09T12:00:01.000Z", now), minutesLeft("2026-10-09T12:00:00.000Z", now), minutesLeft("2026-10-09T11:59:00.000Z", now)], [9, 9, 1, 0, 0]);
  // Both languages say the same things, impersonally; Spanish has no voseo or tuteo.
  check.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  for (const name of Object.keys(en)) check.equal(typeof en[name], typeof es[name], name);
  const strings = dictionary => Object.entries(dictionary).flatMap(([name, value]) => typeof value === "string" ? [[name, value]] : [[name, value("Claude Code", 2)], [name, value("sprout", 1)], [name, value(1)], [name, value("a", "b")]]);
  for (const [name, text] of strings(es)) {
    check.doesNotMatch(text, /\b(vos|tu|tus|ti|contigo|sos|tenés|podés|querés|tené|elegí|escribí|guardá|ingresá|usá|abrí|confirmá|intentá|esperá|cerrá|probá|volvé|elegís|escribís|usás|ingresás|guardás|intentás|confirmás|abrís|verificá|revisá|hacé|ponés)\b/i, name);
    check.ok(!/\b\w+(?:á|í)\b(?=[.,:;]?\s|$)/.test(text.replace(/\b(está|aquí|así|allí|ahí|colón|menú|atrás|Windows|sí|dí|vía|día|días)\b/gi, "")) || /(^| )(Cómo|Qué)\b/.test(text), `${name}: ${text}`);
  }
  for (const [name, text] of strings(en)) { check.doesNotMatch(text, /—|–/, name); check.ok(text.length > 0, name); }
  for (const [name, text] of strings(es)) check.doesNotMatch(text, /—|–/, name);
  check.equal(en.covers(2), "Approving covers these two commands only."); check.equal(es.covers(2), "Aprobar cubre solo estos dos comandos."); check.equal(en.runTitle("Claude Code", 2), "Claude Code wants to run 2 commands"); check.equal(en.runTitle("Claude Code", 1), "Claude Code wants to run 1 command");
  check.equal(en.expires(9), "Expires in 9 minutes."); check.equal(en.expires(1), "Expires in 1 minute."); check.equal(es.expires(9), "Vence en 9 minutos."); check.equal(en.permissionTitle("Field Notes"), "Field Notes asks to import passwords");
  check.equal(en.lockedAsks("Field Notes", "field-notes"), "Field Notes (field-notes) asks to unlock Vault."); check.equal(en.runShort("DEBUG", 1), "DEBUG is shorter than 4 characters, so it shows as it is in the output.");
} finally { await rm(scratch, { recursive: true, force: true }); }
