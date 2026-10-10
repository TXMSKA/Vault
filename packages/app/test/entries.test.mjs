import "../../../test/guard.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { newEntry } from "vault-core";
import { createClipboard, CLIPBOARD_MS } from "../dist/main/clipboard.js";
import { createEntries, detailOf, merge, summarize, viewOf, UNDO_MS } from "../dist/main/entries.js";
import { dataFolder, SERVICE_FOLDERS } from "../dist/main/paths.js";
import { DEFAULTS, IDLE_MINUTES, isSettings, LANGUAGES, THEMES, toService } from "../dist/main/settings.js";
import { base32, hotp, parseKey, totp } from "../dist/main/totp.js";
import { createTour } from "../dist/main/tour.js";
import { SHAPES, accepts } from "../dist/main/validate.js";
import { IDLE_CHOICES, LANGUAGE_CHOICES, THEME_CHOICES, withChoice } from "../dist/renderer/choices.js";
import { counts as entryCounts, FILTERS, visible } from "../dist/renderer/filter.js";
import { alphabets, clampLength, DEFAULT_GENERATOR, generate, LENGTH_MAX, LENGTH_MIN, LOWER, NUMBERS, randomBelow, SYMBOLS, UPPER } from "../dist/renderer/generator.js";
import { codeGroups, initial } from "../dist/renderer/text.js";
import { en, es } from "../dist/renderer/i18n.js";
import { counts } from "./units.test.mjs";

// The entries side of the app: what the window may see of an entry, one-time codes, the clipboard, the generator, the settings and the tour.
// Every value is synthetic and every folder is a temporary one.
const check = Object.fromEntries(["equal", "notEqual", "deepEqual", "match", "doesNotMatch", "ok", "rejects"].map(name => [name, (...args) => { counts.checks++; return assert[name](...args); }]));
const wait = ms => new Promise(done => setTimeout(done, ms));
const scratch = await mkdtemp(join(resolve(tmpdir()), "app-entries-"));
const canary = randomBytes(18).toString("base64"), note = `private-note-${randomBytes(9).toString("hex")}`, secret32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", recoveryCode = `recovery-${randomBytes(9).toString("hex")}`;
const login = (title = "Northwind Mail", stamp = "2026-10-09T12:00:00.000Z") => {
  const entry = newEntry("login"); entry.title = title; entry.updatedAt = stamp; entry.note = note; entry.totp = secret32; entry.recovery = [{ value: recoveryCode, used: false }];
  entry.fields = [{ id: "username", name: "Username", secret: false, value: "alex.rivera" }, { id: "password", name: "Password", secret: true, value: canary }, { id: "website", name: "Website", secret: false, value: "https://northwind.example/login" }];
  return entry;
};
const secrets = [canary, note, secret32, recoveryCode];
const clean = (value, label) => { const text = JSON.stringify(value); for (const hidden of secrets) check.equal(text.includes(hidden), false, label); };
try {
  // ---- what the window may see: no secret value in a row or an open entry ---------------------------------------------------------------------
  {
    const entry = login(), view = viewOf(entry, 3), row = summarize(entry, 3);
    clean(view, "view"); clean(row, "row");
    check.deepEqual(view.fields.map(field => [field.id, field.secret, field.filled, field.value]), [["username", false, true, "alex.rivera"], ["password", true, true, null], ["website", false, true, "https://northwind.example/login"]]);
    check.deepEqual([view.note, view.totp, view.files, view.version], [{ filled: true }, true, [], 3]);
    check.deepEqual(row, { id: entry.id, kind: "login", title: "Northwind Mail", favorite: false, version: 3, updatedAt: "2026-10-09T12:00:00.000Z", detail: "alex.rivera", count: 0, search: "northwind mail\nalex.rivera\nhttps://northwind.example/login" });
    // A field is secret as its own flag says, whatever its name; an empty secret field says it holds nothing.
    const odd = newEntry("custom"); odd.title = "Gate"; odd.fields = [{ id: "a", name: "Code", secret: false, value: "public-1234" }, { id: "b", name: "Pin", secret: true, value: "hidden-5678" }, { id: "c", name: "Empty", secret: true, value: "" }];
    const shown = viewOf(odd, 1);
    check.deepEqual(shown.fields.map(field => [field.value, field.filled]), [["public-1234", true], [null, true], [null, false]]); check.equal(JSON.stringify([shown, summarize(odd, 1)]).includes("hidden-5678"), false); check.equal(summarize(odd, 1).search.includes("public-1234"), true);
    check.deepEqual([summarize(odd, 1).count, detailOf(odd)], [3, ""]);
    // A username kept secret by its flag is not a username to show; the card shows its bank, never the digits that end its number.
    const hiddenName = login(); hiddenName.fields[0].secret = true; check.equal(detailOf(hiddenName), "northwind.example");
    const card = newEntry("card"); card.title = "Atlas Card"; card.fields = [{ id: "bank", name: "", secret: false, value: "Riverbank" }, { id: "number", name: "", secret: true, value: "4111 1111 1111 zz48" }]; card.fields.push({ id: "holder", name: "", secret: false, value: "A. Rivera" });
    check.equal(detailOf(card), "Riverbank"); clean(summarize(card, 1), "card"); check.equal(JSON.stringify([viewOf(card, 1), summarize(card, 1)]).includes("zz48"), false);
    card.fields[0].value = " "; check.equal(detailOf(card), "A. Rivera");
    const document = newEntry("doc"); document.files = [{ id: newEntry("doc").id, name: "Lease contract.pdf", type: "application/pdf", size: 84000, chunks: ["chunk-zz-marker"] }];
    check.deepEqual([detailOf(document), summarize(document, 1).count, viewOf(document, 1).files], ["PDF", 1, [{ id: document.files[0].id, name: "Lease contract.pdf", type: "application/pdf", size: 84000 }]]); check.equal(JSON.stringify(viewOf(document, 1)).includes("chunk-zz-marker"), false);
    document.files[0].name = "README"; check.equal(detailOf(document), "");
    const project = newEntry("env"); project.title = "sprout"; project.fields = [{ id: "DATABASE_URL", name: "DATABASE_URL", secret: true, value: canary }, { id: "DEBUG", name: "DEBUG", secret: true, value: "1" }];
    check.equal(JSON.stringify([viewOf(project, 1), summarize(project, 1)]).includes(canary), false); check.deepEqual([summarize(project, 1).count, viewOf(project, 1).fields.map(field => field.id)], [2, ["DATABASE_URL", "DEBUG"]]);
    check.equal(detailOf(login()), "alex.rivera"); const noName = login(); noName.fields[0].value = ""; check.equal(detailOf(noName), "northwind.example"); noName.fields[2].value = "not a url"; check.equal(detailOf(noName), "not a url");
    check.equal(summarize({ ...login(), title: "x".repeat(2000), fields: [{ id: "u", name: "", secret: false, value: "y".repeat(5000) }] }, 1).search.length, 600);
  }

  // ---- what a save keeps: a secret the window never held, the note, the key, the files and the recovery codes ---------------------------------------
  {
    const old = login(); old.files = [{ id: newEntry("doc").id, name: "a.txt", type: "text/plain", size: 1, chunks: ["c1"] }]; old.fields.push({ id: "bank", name: "Bank", secret: false, value: "Riverbank" });
    const input = { id: old.id, kind: "login", title: "Northwind Mail 2", favorite: true, fields: [{ id: "username", name: "Username", secret: false, value: "new.name" }, { id: "password", name: "Password", secret: true }, { id: "website", name: "Website", secret: false, value: "" }] };
    const next = merge(old, input, "2026-10-10T00:00:00.000Z");
    check.deepEqual(next.fields.map(field => [field.id, field.value]), [["username", "new.name"], ["password", canary], ["website", ""], ["bank", "Riverbank"]]);
    check.deepEqual([next.title, next.favorite, next.note, next.totp, next.updatedAt, next.recovery, next.files], ["Northwind Mail 2", true, note, secret32, "2026-10-10T00:00:00.000Z", old.recovery, old.files]);
    check.notEqual(next.recovery, old.recovery); check.notEqual(next.files[0].chunks, old.files[0].chunks);
    // A value sent replaces the one kept, and the note and key follow when they are sent.
    const replaced = merge(old, { ...input, fields: [{ id: "password", name: "Password", secret: true, value: "new-value" }], note: "", totp: "" }, "2026-10-10T00:00:00.000Z");
    check.deepEqual([replaced.fields.find(field => field.id === "password").value, replaced.note, replaced.totp], ["new-value", "", ""]);
    // A custom or environment entry has exactly the fields it was sent; the others also keep what was not mentioned.
    const custom = newEntry("custom"); custom.fields = [{ id: "one", name: "One", secret: true, value: "v1" }, { id: "two", name: "Two", secret: false, value: "v2" }];
    check.deepEqual(merge(custom, { id: custom.id, kind: "custom", title: "T", favorite: false, fields: [{ id: "two", name: "Two", secret: false, value: "v2b" }] }, "2026-10-10T00:00:00.000Z").fields, [{ id: "two", name: "Two", secret: false, value: "v2b" }]);
    check.deepEqual(merge(undefined, { id: custom.id, kind: "custom", title: "T", favorite: false, fields: [{ id: "x", name: "X", secret: true }] }, "2026-10-10T00:00:00.000Z"), { id: custom.id, kind: "custom", title: "T", favorite: false, fields: [{ id: "x", name: "X", secret: true, value: "" }], note: "", totp: "", recovery: [], files: [], updatedAt: "2026-10-10T00:00:00.000Z" });
  }

  // ---- one-time codes: RFC 4226 and RFC 6238, and the keys people store -------------------------------------------------------------------------
  {
    const ascii = Buffer.from("12345678901234567890");
    check.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(counter => hotp(ascii, counter)), ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]);
    for (const [seconds, code] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]]) {
      check.equal(hotp(ascii, Math.floor(seconds / 30), 8), code, `RFC 6238 at ${seconds}`); check.equal(totp(ascii, seconds * 1000).code, code.slice(2), `six digits at ${seconds}`);
    }
    check.deepEqual([totp(ascii, 59000).remaining, totp(ascii, 60000).remaining, totp(ascii, 89999).remaining, totp(ascii, 0).remaining, totp(ascii, 30000).remaining], [1, 30, 1, 30, 30]);
    check.equal(totp(ascii, 59999).code, totp(ascii, 30000).code); check.notEqual(totp(ascii, 60000).code, totp(ascii, 59999).code);
    check.equal(base32(secret32).toString(), "12345678901234567890"); check.equal(base32("gezd gnbv-GY3TQOJQ GEZDGNBVGY3TQOJQ====").toString(), "12345678901234567890");
    for (const bad of ["", "   ", "0189", "GEZD!", "ÁBC", "a b c 1"]) check.equal(base32(bad), undefined, bad);
    check.equal(parseKey(` ${secret32.toLowerCase()} `).toString(), "12345678901234567890");
    const address = (query, label = "Northwind:alex") => `otpauth://totp/${label}?${query}`;
    check.equal(parseKey(address(`secret=${secret32}&issuer=Northwind`)).toString(), "12345678901234567890");
    check.equal(parseKey(address(`secret=${secret32}&algorithm=SHA1&digits=6&period=30`)).toString(), "12345678901234567890");
    for (const query of [`secret=${secret32}&algorithm=SHA256`, `secret=${secret32}&digits=8`, `secret=${secret32}&period=60`, "issuer=x", "secret=", "secret=0189"]) check.equal(parseKey(address(query)), undefined, query);
    check.equal(parseKey(`otpauth://hotp/x?secret=${secret32}`), undefined); check.equal(parseKey("otpauth://"), undefined); check.equal(parseKey(`https://x.example/?secret=${secret32}`), undefined);
    check.equal(codeGroups("284913"), "284 913"); check.equal(codeGroups("12"), "12");
  }

  // ---- the clipboard: a copied value is cleared when its time is up, but only if it is still there ------------------------------------------------
  {
    const timers = () => { const set = new Map(); let next = 1; return { set, api: { set(run, ms) { set.set(next, { run, ms }); return next++; }, clear(id) { set.delete(id); } } }; };
    const port = () => { const state = { text: "mine", writes: [], clears: 0, broken: false }; return { state, port: { async readText() { if (state.broken) throw new Error("x"); return state.text; }, async writeText(text) { state.text = text; state.writes.push(text); }, clear() { state.clears++; state.text = ""; } } }; };
    check.equal(CLIPBOARD_MS, 30000);
    {
      const clock = timers(), board = port(), clip = createClipboard(board.port, { timers: clock.api });
      await clip.copy("first"); check.deepEqual([board.state.text, clock.set.size, [...clock.set.values()][0].ms, clip.pending()], ["first", 1, 30000, true]);
      [...clock.set.values()][0].run(); await wait(5); check.deepEqual([board.state.text, board.state.clears, clip.pending()], ["", 1, false]);
    }
    {
      // Something else was copied meanwhile: it is not touched.
      const clock = timers(), board = port(), clip = createClipboard(board.port, { timers: clock.api });
      await clip.copy("first"); board.state.text = "something the person copied"; [...clock.set.values()][0].run(); await wait(5);
      check.deepEqual([board.state.text, board.state.clears], ["something the person copied", 0]);
    }
    {
      // A newer copy takes over the timer; the first one never clears the second, even when they are the same text.
      const clock = timers(), board = port(), clip = createClipboard(board.port, { timers: clock.api, ms: 1234 });
      await clip.copy("first"); const early = [...clock.set.keys()][0]; await clip.copy("second");
      check.deepEqual([clock.set.size, clock.set.has(early), [...clock.set.values()][0].ms, board.state.text], [1, false, 1234, "second"]);
      await clip.copy("second"); check.equal(clock.set.size, 1); [...clock.set.values()][0].run(); await wait(5); check.deepEqual([board.state.text, board.state.clears], ["", 1]);
    }
    {
      // Quitting clears at once under the same rule; a clipboard that cannot be read is left alone.
      const clock = timers(), board = port(), clip = createClipboard(board.port, { timers: clock.api });
      await clip.copy("kept"); await clip.flush(); check.deepEqual([board.state.text, board.state.clears, clock.set.size, clip.pending()], ["", 1, 0, false]);
      await clip.flush(); check.equal(board.state.clears, 1);
      await clip.copy("other"); board.state.text = "changed"; await clip.flush(); check.deepEqual([board.state.text, board.state.clears], ["changed", 1]);
      await clip.copy("again"); board.state.broken = true; await clip.flush(); check.equal(board.state.clears, 1);
    }
    {
      // With the real timer: a short time, as the test option of the main process sets it.
      const board = port(), clip = createClipboard(board.port, { ms: 40 });
      await clip.copy("brief"); check.equal(board.state.text, "brief"); await wait(200); check.deepEqual([board.state.text, board.state.clears], ["", 1]);
    }
  }

  // ---- the controller: lists and views without secrets, reveal and copy fetch again, saves use the version --------------------------------------------
  {
    const rows = new Map(), seen = { calls: [] }, shut = []; let locked = false, now = Date.parse("2026-10-09T12:00:00.000Z");
    const gate = () => { if (locked) throw { code: "locked" }; };
    const client = { entries: {
      list: async () => { gate(); seen.calls.push("list"); return [...rows.values()].map(row => structuredClone(row)); },
      get: async id => { gate(); seen.calls.push("get"); const row = rows.get(id); if (!row) throw { code: "not_found" }; return structuredClone(row); },
      save: async (entry, expected) => { gate(); seen.calls.push("save"); const row = rows.get(entry.id); if ((row?.version ?? 0) !== expected) throw { code: "conflict" }; rows.set(entry.id, { entry: structuredClone(entry), version: expected + 1 }); return { version: expected + 1 }; },
      remove: async (id, expected) => { gate(); seen.calls.push("remove"); const row = rows.get(id); if (!row) throw { code: "not_found" }; if (row.version !== expected) throw { code: "conflict" }; rows.delete(id); return { ok: true }; },
    } };
    const board = { text: "", clears: 0 }, opened = [];
    const clipboard = createClipboard({ readText: async () => board.text, writeText: async text => { board.text = text; }, clear() { board.clears++; board.text = ""; } }, { ms: 10 });
    const entries = createEntries({ service: () => client, clipboard, openUrl: async url => { opened.push(url); }, now: () => now, undoMs: 80 });
    const one = login("Northwind Mail", "2026-10-09T10:00:00.000Z"), two = login("Riverbank", "2026-10-09T11:00:00.000Z");
    one.totp = secret32; two.totp = ""; rows.set(one.id, { entry: one, version: 4 }); rows.set(two.id, { entry: two, version: 1 });

    const listed = await entries.list();
    check.equal(listed.ok, true); clean(listed, "list"); check.deepEqual(listed.entries.map(row => row.title), ["Riverbank", "Northwind Mail"]); check.deepEqual(listed.entries.map(row => row.version), [1, 4]);
    // Opening answers from what the list read; nothing is asked of the service, and the view has no secret value.
    const before = seen.calls.length, opened1 = await entries.open(one.id);
    check.equal(seen.calls.length, before); clean(opened1, "open"); check.equal(opened1.entry.version, 4); check.equal(opened1.entry.fields.find(field => field.id === "password").value, null);
    check.deepEqual(await entries.open("00000000-0000-4000-8000-000000000000"), { ok: false, code: "not_found" });
    // Reveal and copy ask the service again, for that one value.
    const getsBefore = seen.calls.filter(call => call === "get").length;
    check.deepEqual(await entries.reveal(one.id, "f:password"), { ok: true, value: canary }); check.deepEqual(await entries.reveal(one.id, "f:username"), { ok: true, value: "alex.rivera" }); check.deepEqual(await entries.reveal(one.id, "note"), { ok: true, value: note });
    check.equal(seen.calls.filter(call => call === "get").length, getsBefore + 3);
    for (const part of ["f:nothing", "f:", "totp", "f:totp", "", "password"]) check.deepEqual(await entries.reveal(one.id, part), { ok: false, code: "not_found" }, part);
    const blank = login(); blank.note = ""; blank.fields[1].value = ""; rows.set(blank.id, { entry: blank, version: 1 });
    check.deepEqual(await entries.reveal(blank.id, "note"), { ok: false, code: "not_found" }); check.deepEqual(await entries.reveal(blank.id, "f:password"), { ok: false, code: "not_found" }); rows.delete(blank.id);
    const copied = await entries.copy(one.id, "f:password");
    check.deepEqual(copied, { ok: true }); check.equal(board.text, canary); clean(copied, "copy"); await wait(120); check.deepEqual([board.text, board.clears], ["", 1]);
    // The code is made here from the stored key; only the code and its seconds come out.
    now = 59000; const code = await entries.code(one.id);
    check.deepEqual(code, { ok: true, code: totp(Buffer.from("12345678901234567890"), 59000).code, remaining: 1 }); clean(code, "code"); check.equal(code.code, "287082");
    check.deepEqual(await entries.copyCode(one.id), { ok: true }); check.equal(board.text, "287082");
    check.deepEqual(await entries.code(two.id), { ok: false, code: "not_found" }); check.deepEqual(await entries.copyCode(two.id), { ok: false, code: "not_found" });
    const badKey = login(); badKey.totp = "this is not base32!"; rows.set(badKey.id, { entry: badKey, version: 1 }); check.deepEqual(await entries.code(badKey.id), { ok: false, code: "invalid_code_key" }); rows.delete(badKey.id);
    now = Date.parse("2026-10-09T12:00:00.000Z");
    // Only a web address opens; the address comes from the entry, never from the window.
    check.deepEqual(await entries.openSite(one.id), { ok: true }); check.deepEqual(opened, ["https://northwind.example/login"]);
    for (const site of ["javascript:alert(1)", "file:///c:/windows/win.ini", "ftp://x.example", "https://user:pw@x.example/", "not a url", ""]) { const odd = login(); odd.fields[2].value = site; rows.set(odd.id, { entry: odd, version: 1 }); check.deepEqual(await entries.openSite(odd.id), { ok: false, code: "invalid" }, site); rows.delete(odd.id); }
    check.equal(opened.length, 1);
    // A favourite changes that and nothing else.
    check.deepEqual(await entries.favorite(one.id, true), { ok: true, version: 5 }); check.deepEqual([rows.get(one.id).entry.favorite, rows.get(one.id).entry.updatedAt, rows.get(one.id).entry.fields[1].value], [true, "2026-10-09T10:00:00.000Z", canary]);
    check.deepEqual(await entries.favorite(one.id, true), { ok: true, version: 5 });

    // Saving: a new entry, then changes against the version that was seen.
    const created = { id: "5c1f0e3a-8a39-4b6d-9d57-3a1f2d6b7c10", kind: "note", title: "Home Wi-Fi", favorite: false, fields: [], note: "network and key" };
    check.deepEqual(await entries.save(created, 0), { ok: true, version: 1 }); check.equal(rows.get(created.id).entry.note, "network and key"); check.equal(rows.get(created.id).entry.updatedAt, "2026-10-09T12:00:00.000Z");
    check.deepEqual(await entries.save(created, 0), { ok: false, code: "conflict" });
    const edit = { id: one.id, kind: "login", title: "Northwind Mail", favorite: true, fields: [{ id: "username", name: "Username", secret: false, value: "alex.r" }, { id: "password", name: "Password", secret: true }, { id: "website", name: "Website", secret: false, value: "https://northwind.example" }] };
    check.deepEqual(await entries.save(edit, 4), { ok: false, code: "conflict" }); check.equal(rows.get(one.id).entry.fields[0].value, "alex.rivera");
    check.deepEqual(await entries.save({ ...edit, kind: "card" }, 5), { ok: false, code: "invalid" });
    check.deepEqual(await entries.save(edit, 5), { ok: true, version: 6 }); const saved = rows.get(one.id).entry;
    check.deepEqual([saved.fields[0].value, saved.fields[1].value, saved.note, saved.totp, saved.recovery[0].value, saved.updatedAt], ["alex.r", canary, note, secret32, recoveryCode, "2026-10-09T12:00:00.000Z"]);
    check.deepEqual(await entries.save({ ...edit, id: "00000000-0000-4000-8000-000000000001" }, 3), { ok: false, code: "not_found" });
    // Two environments never share a project name.
    const projectA = { id: "0a1f0e3a-8a39-4b6d-9d57-3a1f2d6b7c11", kind: "env", title: "sprout", favorite: false, fields: [{ id: "TOKEN", name: "TOKEN", secret: true, value: "1234" }] };
    check.deepEqual(await entries.save(projectA, 0), { ok: true, version: 1 }); await entries.list();
    check.deepEqual(await entries.save({ ...projectA, id: "0a1f0e3a-8a39-4b6d-9d57-3a1f2d6b7c12" }, 0), { ok: false, code: "project_taken" }); check.equal(rows.has("0a1f0e3a-8a39-4b6d-9d57-3a1f2d6b7c12"), false);
    check.deepEqual(await entries.save({ ...projectA, title: "sprout 2" }, 1), { ok: true, version: 2 });

    // Deleting keeps the entry for a while, whole, so that it can come back; a document's files go with it and cannot.
    check.deepEqual(await entries.remove(one.id, 5), { ok: false, code: "conflict" }); check.equal(rows.has(one.id), true);
    check.deepEqual(await entries.remove(one.id, 6), { ok: true, undo: true }); check.equal(rows.has(one.id), false);
    check.deepEqual(await entries.undo(two.id), { ok: false, code: "not_found" });
    check.deepEqual(await entries.undo(one.id), { ok: true }); check.deepEqual([rows.get(one.id).entry.fields[1].value, rows.get(one.id).entry.totp, rows.get(one.id).version], [canary, secret32, 1]);
    check.deepEqual(await entries.undo(one.id), { ok: false, code: "not_found" });
    check.deepEqual(await entries.remove(one.id, 1), { ok: true, undo: true }); await wait(160); check.deepEqual(await entries.undo(one.id), { ok: false, code: "not_found" });
    rows.set(one.id, { entry: one, version: 1 });
    check.deepEqual(await entries.remove(one.id, 1), { ok: true, undo: true }); entries.forget(); check.deepEqual(await entries.undo(one.id), { ok: false, code: "not_found" });
    const withFiles = newEntry("doc"); withFiles.title = "Lease"; withFiles.files = [{ id: newEntry("doc").id, name: "lease.pdf", type: "application/pdf", size: 9, chunks: ["c1"] }]; rows.set(withFiles.id, { entry: withFiles, version: 2 });
    check.deepEqual(await entries.remove(withFiles.id, 2), { ok: true, undo: false }); check.deepEqual(await entries.undo(withFiles.id), { ok: false, code: "not_found" });
    check.equal(UNDO_MS > 9000, true);

    // A vault that locks answers locked, and with no service there is nothing to ask.
    locked = true; for (const result of [await entries.list(), await entries.reveal(two.id, "note"), await entries.save(created, 1), await entries.remove(two.id, 1)]) check.deepEqual(result, { ok: false, code: "locked" });
    const alone = createEntries({ service: () => undefined, clipboard, openUrl: async () => undefined }); check.deepEqual(await alone.list(), { ok: false, code: "unavailable" });
    const odd = createEntries({ service: () => ({ entries: { list: async () => { throw new Error("secret detail"); } } }), clipboard, openUrl: async () => undefined }); check.deepEqual(await odd.list(), { ok: false, code: "unavailable" });
    void shut;
  }

  // ---- the bridge accepts exactly what the entries calls take ---------------------------------------------------------------------------------------
  {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e", entry = { id, kind: "login", title: "Northwind Mail", favorite: false, fields: [{ id: "username", name: "Username", secret: false, value: "alex" }, { id: "password", name: "", secret: true }], note: "n", totp: "t" };
    check.equal(accepts("entries", undefined), true); check.equal(accepts("entries", {}), false);
    for (const call of ["entryOpen", "entryCode", "entryCopyCode", "entryOpenSite", "entryUndo"]) { check.equal(accepts(call, { id }), true); check.equal(accepts(call, { id: "x" }), false); check.equal(accepts(call, { id, extra: 1 }), false); check.equal(accepts(call, {}), false); }
    for (const call of ["entryReveal", "entryCopy"]) {
      for (const part of ["note", "f:password", "f:A", `f:${"x".repeat(100)}`]) check.equal(accepts(call, { id, part }), true, part);
      for (const part of ["", "f:", "f", "name", "note ", "F:password", `f:${"x".repeat(101)}`, "f:a\0b", 5, null, ["note"]]) check.equal(accepts(call, { id, part }), false, String(part));
      check.equal(accepts(call, { id }), false); check.equal(accepts(call, { part: "note" }), false); check.equal(accepts(call, { id, part: "note", extra: 1 }), false);
    }
    check.equal(accepts("entryFavorite", { id, favorite: true }), true); check.equal(accepts("entryFavorite", { id, favorite: "yes" }), false); check.equal(accepts("entryFavorite", { id }), false);
    for (const call of ["entryRemove"]) { check.equal(accepts(call, { id, expected: 3 }), true); for (const expected of [-1, 1.5, "3", null, Infinity, 2 ** 60]) check.equal(accepts(call, { id, expected }), false, String(expected)); }
    check.equal(accepts("entrySave", { entry, expected: 0 }), true); check.equal(accepts("entrySave", { entry, expected: 7 }), true); check.equal(accepts("entrySave", { entry }), false); check.equal(accepts("entrySave", { entry, expected: 0, extra: 1 }), false);
    const bad = patch => accepts("entrySave", { entry: { ...entry, ...patch }, expected: 1 });
    check.equal(bad({ note: undefined, totp: undefined }), true); check.equal(bad({ note: "x".repeat(32000) }), true); check.equal(bad({ note: "x".repeat(32001) }), false); check.equal(bad({ totp: "x".repeat(8193) }), false); check.equal(bad({ title: "x".repeat(501) }), false); check.equal(bad({ title: "" }), true);
    check.equal(bad({ kind: "folder" }), false); check.equal(bad({ id: "not-an-id" }), false); check.equal(bad({ favorite: 1 }), false); check.equal(bad({ extra: 1 }), false); check.equal(bad({ fields: "none" }), false); check.equal(bad({ fields: Array.from({ length: 101 }, (_, n) => ({ id: `f${n}`, name: "", secret: false, value: "" })) }), false);
    check.equal(bad({ fields: Array.from({ length: 100 }, (_, n) => ({ id: `f${n}`, name: "", secret: false, value: "" })) }), true);
    for (const field of [{ id: "", name: "", secret: false }, { id: "a".repeat(101), name: "", secret: false }, { id: "a", name: "n".repeat(101), secret: false }, { id: "a", name: "", secret: "no" }, { id: "a", name: "", secret: false, value: 5 }, { id: "a", name: "", secret: false, value: "x".repeat(32001) }, { id: "a", name: "" }, { id: "a", name: "", secret: false, extra: 1 }, "a", null, []]) check.equal(bad({ fields: [field] }), false, JSON.stringify(field));
    check.equal(bad({ fields: [{ id: "a", name: "", secret: true }] }), true); check.equal(bad({ title: "a\0b" }), false);
    check.equal(accepts("entrySave", { entry: Object.create({ ...entry }), expected: 0 }), false); check.equal(accepts("entrySave", { entry: [entry], expected: 0 }), false);
    const settings = { idleMinutes: 15, lockWithLastApp: false, language: "es", theme: "light" };
    check.equal(accepts("saveSettings", settings), true); check.equal(accepts("saveSettings", { ...settings, extra: 1 }), false); check.equal(accepts("saveSettings", { ...settings, idleMinutes: 3 }), false); check.equal(accepts("saveSettings", { ...settings, theme: "blue" }), false); check.equal(accepts("saveSettings", { ...settings, lockWithLastApp: "yes" }), false); check.equal(accepts("saveSettings", { idleMinutes: 15 }), false); check.equal(accepts("saveSettings", undefined), false); check.equal(accepts("saveSettings", [settings]), false);
    check.equal(accepts("enableHello", { password: "x" }), true); check.equal(accepts("enableHello", { password: "" }), false); check.equal(accepts("enableHello", { password: "x".repeat(129) }), false); check.equal(accepts("enableHello", {}), false);
    for (const call of ["disableHello", "dismissTour", "cancelClose", "confirmClose"]) { check.equal(accepts(call, undefined), true); check.equal(accepts(call, {}), false); check.equal(accepts(call, { password: "x" }), false); }
    check.equal(Object.keys(SHAPES).length, 38);
  }

  // ---- the settings the window offers are the ones the service takes ------------------------------------------------------------------------------------
  {
    check.deepEqual([...IDLE_CHOICES], [...IDLE_MINUTES]); check.deepEqual([...LANGUAGE_CHOICES], [...LANGUAGES]); check.deepEqual([...THEME_CHOICES], [...THEMES]);
    check.deepEqual([...IDLE_MINUTES], [1, 5, 15, 30, 60, 240]); check.equal(DEFAULTS.idleMinutes, 5); check.equal(DEFAULTS.lockWithLastApp, true);
    for (const idleMinutes of IDLE_CHOICES) for (const language of LANGUAGE_CHOICES) for (const theme of THEME_CHOICES) for (const lockWithLastApp of [true, false]) { const value = { idleMinutes, lockWithLastApp, language, theme }; check.equal(isSettings(value), true); check.equal(accepts("saveSettings", value), true); }
    // One choice changes one value, whatever else the settings object carried; the service gets exactly four keys.
    const start = { idleMinutes: 5, lockWithLastApp: true, language: "system", theme: "system" };
    check.deepEqual(withChoice(start, "idleMinutes", 240), { ...start, idleMinutes: 240 }); check.deepEqual(withChoice(start, "language", "es"), { ...start, language: "es" }); check.deepEqual(withChoice(start, "theme", "light"), { ...start, theme: "light" }); check.deepEqual(withChoice(start, "lockWithLastApp", false), { ...start, lockWithLastApp: false });
    check.deepEqual(withChoice({ ...start, extra: 1 }, "theme", "dark"), { ...start, theme: "dark" }); check.deepEqual(start, { idleMinutes: 5, lockWithLastApp: true, language: "system", theme: "system" });
    check.deepEqual(toService({ ...start, extra: 1, theme: "dark" }), { ...start, theme: "dark" }); check.deepEqual(Object.keys(toService({ ...start, extra: 1 })).sort(), ["idleMinutes", "language", "lockWithLastApp", "theme"]);
    for (const wrong of [{ ...start, idleMinutes: 2 }, { ...start, idleMinutes: "5" }, { ...start, language: "fr" }, { ...start, theme: "auto" }, { ...start, lockWithLastApp: 1 }, { idleMinutes: 5 }, { ...start, extra: 1 }, [], null, "x", Object.create(start)]) check.equal(isSettings(wrong), false);
    // Every choice has words in both languages.
    for (const dictionary of [en, es]) {
      for (const minutes of IDLE_CHOICES) check.ok(dictionary.idleChoice(minutes).length > 0); for (const code of LANGUAGE_CHOICES) check.ok(dictionary.languageChoice(code).length > 0); for (const code of THEME_CHOICES) check.ok(dictionary.themeChoice(code).length > 0);
    }
    check.deepEqual(IDLE_CHOICES.map(minutes => en.idleChoice(minutes)), ["1 minute", "5 minutes", "15 minutes", "30 minutes", "1 hour", "4 hours"]); check.deepEqual(IDLE_CHOICES.map(minutes => es.idleChoice(minutes)), ["1 minuto", "5 minutos", "15 minutos", "30 minutos", "1 hora", "4 horas"]);
    check.deepEqual(LANGUAGE_CHOICES.map(code => en.languageChoice(code)), ["System", "English", "Español"]); check.deepEqual(THEME_CHOICES.map(code => es.themeChoice(code)), ["Sistema", "Oscuro", "Claro"]);
  }

  // ---- the generator: its length, its switches, and fair random numbers ---------------------------------------------------------------------------------------
  {
    check.deepEqual(DEFAULT_GENERATOR, { length: 20, symbols: true, numbers: true, uppercase: true }); check.deepEqual([LENGTH_MIN, LENGTH_MAX], [8, 64]);
    check.deepEqual([clampLength(20), clampLength(3), clampLength(500), clampLength(7.6), clampLength(Number.NaN), clampLength(Infinity), clampLength(-5)], [20, 8, 64, 8, 20, 20, 8]);
    const has = (text, set) => [...text].some(char => set.includes(char));
    for (const symbols of [true, false]) for (const numbers of [true, false]) for (const uppercase of [true, false]) {
      const options = { length: 24, symbols, numbers, uppercase }, allowed = alphabets(options).join("");
      for (let i = 0; i < 25; i++) {
        const password = generate(options);
        check.equal(password.length, 24); check.equal([...password].every(char => allowed.includes(char)), true); check.equal(has(password, LOWER), true);
        check.equal(has(password, UPPER), uppercase); check.equal(has(password, NUMBERS), numbers); check.equal(has(password, SYMBOLS), symbols);
      }
    }
    check.deepEqual(alphabets({ length: 20, symbols: false, numbers: false, uppercase: false }), [LOWER]);
    for (const length of [8, 9, 20, 33, 64]) check.equal(generate({ ...DEFAULT_GENERATOR, length }).length, length);
    check.equal(generate({ ...DEFAULT_GENERATOR, length: 1 }).length, 8); check.equal(generate({ ...DEFAULT_GENERATOR, length: 1000 }).length, 64); check.equal(generate(DEFAULT_GENERATOR).length, 20);
    check.equal(new Set(Array.from({ length: 50 }, () => generate(DEFAULT_GENERATOR))).size, 50);
    // With a stand-in for the random numbers the result is what the algorithm says: one of each set, the rest from all of them, then a shuffle.
    check.equal(generate({ length: 8, symbols: false, numbers: false, uppercase: false }, () => 0), "aaaaaaaa");
    check.equal(generate({ length: 8, symbols: true, numbers: true, uppercase: true }, limit => limit - 1).length, 8);
    const asked = []; generate({ length: 8, symbols: false, numbers: true, uppercase: false }, limit => { asked.push(limit); return 0; });
    check.deepEqual(asked.slice(0, 2), [26, 10]); check.equal(asked.slice(2, 8).every(limit => limit === 36), true); check.deepEqual(asked.slice(8), [8, 7, 6, 5, 4, 3, 2]);
    const draws = new Array(6).fill(0); for (let i = 0; i < 6000; i++) draws[randomBelow(6)]++;
    check.equal(draws.every(count => count > 850 && count < 1150), true); check.equal(randomBelow(1), 0);
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 33]) assert.throws(() => randomBelow(bad), RangeError); counts.checks += 5;
  }

  // ---- the list: what a search and a filter show, and what the menu counts --------------------------------------------------------------------------------
  {
    const row = (title, kind, extra = {}) => ({ id: title, kind, title, favorite: false, version: 1, updatedAt: "", detail: "", count: 0, search: title.toLowerCase(), ...extra });
    const list = [row("Northwind Mail", "login", { favorite: true, search: "northwind mail\nalex.rivera@northwind.example" }), row("Northside Gym", "login", { search: "northside gym\nalex.rivera" }), row("Atlas Card", "card"), row("Home Wi-Fi", "note", { favorite: true }), row("Sprout", "env")];
    check.deepEqual(visible(list, "all", "").map(entry => entry.title), list.map(entry => entry.title));
    check.deepEqual(visible(list, "favourites", "").map(entry => entry.title), ["Northwind Mail", "Home Wi-Fi"]); check.deepEqual(visible(list, "card", "").map(entry => entry.title), ["Atlas Card"]); check.deepEqual(visible(list, "doc", ""), []);
    // A search looks through every entry, whatever the filter, over names, usernames and websites, word by word.
    check.deepEqual(visible(list, "card", "north").map(entry => entry.title), ["Northwind Mail", "Northside Gym"]); check.deepEqual(visible(list, "all", "  NORTH  alex.rivera@ ").map(entry => entry.title), ["Northwind Mail"]); check.deepEqual(visible(list, "all", "zzz"), []);
    check.deepEqual(visible(list, "env", "   ").map(entry => entry.title), ["Sprout"]);
    const number = entryCounts(list); check.deepEqual(number, { all: 5, favourites: 2, login: 2, card: 1, doc: 0, note: 1, key: 0, env: 1, custom: 0 }); check.deepEqual(Object.keys(number), [...FILTERS]);
    check.deepEqual([initial("northwind"), initial("  élan"), initial(""), initial("😀 smile"), initial("ß")], ["N", "É", "?", "😀", "SS"]);
  }

  // ---- the first-open tips: dismissed once, kept in the app's own folder ----------------------------------------------------------------------------------
  {
    const folder = join(scratch, "home", "app"), tips = createTour(folder);
    await tips.load(); check.equal(tips.pending(), true); await tips.dismiss(); check.equal(tips.pending(), false);
    check.equal(JSON.parse(await readFile(join(folder, "tour.json"), "utf8")).dismissed, true);
    const again = createTour(folder); check.equal(again.pending(), true); await again.load(); check.equal(again.pending(), false);
    await writeFile(join(folder, "tour.json"), "not json"); const broken = createTour(folder); await broken.load(); check.equal(broken.pending(), true);
    await writeFile(join(folder, "tour.json"), JSON.stringify({ dismissed: "yes" })); await broken.load(); check.equal(broken.pending(), true);
    await writeFile(join(folder, "tour.json"), JSON.stringify([true])); await broken.load(); check.equal(broken.pending(), true);
    // A folder that cannot be written still counts for this run.
    await writeFile(join(scratch, "file"), "x"); const stuck = createTour(join(scratch, "file", "app")); await stuck.load(); await stuck.dismiss(); check.equal(stuck.pending(), false);
    // The app's folder is inside the home, beside the service's own and not one of them.
    const home = join(scratch, "vault-home");
    check.equal(dataFolder(home), join(home, "app")); check.equal(dirname(dataFolder(home)), home); check.equal(SERVICE_FOLDERS.includes("app"), false);
    check.deepEqual([...SERVICE_FOLDERS].sort(), ["bin", "logs", "run", "secrets", "store", "sync"]);
    await mkdir(dataFolder(home), { recursive: true }); await rm(home, { recursive: true, force: true });
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
