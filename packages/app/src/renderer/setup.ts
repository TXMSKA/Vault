import { div, h } from "./dom.ts";
import { appIcon, mark } from "./icons.ts";
import { busy, button, centred, checkbox, choice, field, heading, lead, notice, reason } from "./parts.ts";
import { keyLines } from "./text.ts";
import { bridge, flow, go, view } from "./ui.ts";
import type { Context } from "./ui.ts";

/** The first open on a computer with no vault: create one, or restore an encrypted backup. */
export function welcome({ t }: Context): HTMLElement {
  const options = (["create", "restore"] as const).map(value => choice("start", value, value === "create" ? t.createChoice : t.restoreChoice, value === "create" ? t.createChoiceLine : t.restoreChoiceLine, flow.chosen === value, () => {
    flow.chosen = value; for (const other of options) other.root.classList.toggle("on", other.input.checked);
  }));
  const next = button(t.continue, { primary: true, type: "submit" });
  const root = centred(460, div("intro", appIcon(56), div("heads", heading(t.welcomeTitle, 24), lead(t.welcomeBody))), div("choices", ...options.map(option => option.root)), div("actions", div("fill"), next));
  root.querySelector("form")!.addEventListener("submit", () => go(() => { flow.first = flow.chosen; }));
  queueMicrotask(() => (options.find(option => option.input.checked) ?? options[0]).input.focus());
  return root;
}

/** Two fields, 15 to 128 characters, typed twice. */
export function create({ t }: Context): HTMLElement {
  const password = field({ label: t.masterPassword, name: "password", mono: true, secret: true, reveal: true, hint: t.passwordRange, autocomplete: "new-password", t });
  const repeat = field({ label: t.repeatIt, name: "repeat", mono: true, secret: true, autocomplete: "new-password", t });
  const failure = div("slot");
  const submit = button(t.createButton, { primary: true, type: "submit" });
  const root = centred(400, div("heads", heading(t.createTitle, 22), lead(t.createBody)), password.root, repeat.root, notice("info", t.createNotice), failure, div("actions", button(t.back, { onclick: () => go(() => { flow.first = "welcome"; }) }), div("fill"), submit));
  root.querySelector("form")!.addEventListener("submit", async () => {
    const first = password.input.value, second = repeat.input.value;
    password.error(); repeat.error(); failure.replaceChildren();
    if (first.length < 15 || first.length > 128) { password.error(t.passwordShort); password.input.focus(); return; }
    if (first !== second) { repeat.error(t.passwordMismatch); repeat.input.focus(); return; }
    const result = await busy(root, () => bridge.create({ password: first }));
    if (!result.ok) { failure.replaceChildren(notice("circleAlert", reason(t, result.code), "error")); password.input.focus(); await view.sync(); return; }
    password.input.value = ""; repeat.input.value = "";
    go(() => { flow.setup = { recovery: result.recovery, restored: true }; }); await view.sync();
  });
  queueMicrotask(() => password.input.focus());
  return root;
}

/** The key is shown once. Save writes the plain-text kit, Print the sheet; as the board says, Open Vault stays available and the checkbox only reminds. */
export function recoveryKey({ state, t }: Context): HTMLElement {
  const setup = flow.setup!, status = div("slot");
  view.sheet(sheet({ state, t }, setup.recovery));
  const open = button(t.openVault, { primary: true, onclick: async () => {
    open.disabled = true; await bridge.finishSetup(); go(() => { flow.setup = undefined; }); await view.sync();
  } });
  const saved = checkbox(t.sheetChecked, false, () => undefined);
  const say = (tone: "soft" | "error", text: string) => status.replaceChildren(notice(tone === "error" ? "circleAlert" : "check", text, tone === "error" ? "error" : "primary"));
  const save = button(t.saveSheet, { glyph: "download", onclick: async () => {
    status.replaceChildren(); const result = await bridge.saveRecoverySheet();
    if (result.ok) say("soft", t.sheetSaved); else if (result.code !== "cancelled") say("error", result.code === "exists" ? t.sheetExists : t.sheetSaveFailed);
  } });
  const print = button(t.printSheet, { glyph: "fileText", onclick: async () => {
    status.replaceChildren(); const result = await bridge.printRecoverySheet();
    if (!result.ok && result.code !== "cancelled") say("error", t.sheetPrintFailed);
  } });
  const keys = div("keybox selectable", ...keyLines(setup.recovery).map(line => div("line", line)));
  keys.setAttribute("role", "group"); keys.setAttribute("aria-label", t.sheetKey);
  return centred(460, div("heads", heading(t.recoveryTitle, 22), lead(t.recoveryBody)), !setup.restored && notice("circleAlert", t.notRestored, "error"), keys, div("actions gap", save, print), status, saved.root, div("actions", div("fill"), open));
}

/** The recovery sheet as printed: an A4 page in print colours, not the app's theme. Shown on paper only. */
function sheet({ state, t }: Context, recovery: string): HTMLElement {
  const date = new Date().toLocaleDateString(state.language === "es" ? "es" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
  return div("page",
    div("page-head", mark(36, "ink"), h("div", { class: "page-title" }, t.sheetTitle)),
    h("p", { class: "page-line" }, t.sheetMade(date, state.computer)),
    div("page-key", div("page-label", t.sheetKey), ...keyLines(recovery).map(line => div("page-code", line))),
    div("page-block", div("page-label dark", t.sheetUseTitle), h("p", { class: "page-line" }, t.sheetUse)),
    div("page-block", div("page-label dark", t.sheetKeepTitle), h("p", { class: "page-line" }, t.sheetKeep)),
    div("page-fill"), div("page-rule"), h("p", { class: "page-line small" }, t.sheetFoot));
}

/** Choose a backup and type its password. The restored vault keeps that password and gets a new recovery key. */
export function restore({ t }: Context): HTMLElement {
  let chosen: string | undefined;
  const file = field({ name: "file", glyph: "fileArchive", placeholder: t.noFile, readonly: true, t, grow: true });
  file.input.setAttribute("aria-label", t.backupFile);
  const password = field({ label: t.backupPassword, name: "backup-password", mono: true, secret: true, reveal: true, autocomplete: "off", t });
  const failure = div("slot");
  const choose = button(t.choose, { onclick: async () => {
    file.error(); const result = await bridge.chooseBackup();
    if (result.ok) { chosen = result.name; file.input.value = result.name; file.input.classList.add("chosen"); password.input.focus(); }
    else if (result.code !== "cancelled") file.error(result.code === "invalid_backup" ? t.backupInvalid : reason(t, result.code));
  } });
  const root = centred(420, div("heads", heading(t.restoreTitle, 22), lead(t.restoreBody)), div("fg", h("label", { class: "label" }, t.backupFile), div("pick", file.root, choose)), password.root, notice("info", t.restoreNotice), failure,
    div("actions", button(t.back, { onclick: () => go(() => { flow.first = "welcome"; }) }), div("fill"), button(t.restoreButton, { primary: true, type: "submit" })));
  root.querySelector("form")!.addEventListener("submit", async () => {
    file.error(); password.error(); failure.replaceChildren();
    if (!chosen) { file.error(t.backupFirst); return; }
    const typed = password.input.value;
    if (typed.length < 15 || typed.length > 128) { password.error(t.backupWrong); password.input.focus(); return; }
    const result = await busy(root, () => bridge.restoreBackup({ password: typed }));
    if (!result.ok) {
      if (result.code === "wrong_backup_password") password.error(t.backupWrong);
      else if (result.code === "no_backup") file.error(t.backupFirst);
      else failure.replaceChildren(notice("circleAlert", reason(t, result.code), "error"));
      password.input.focus(); await view.sync(); return;
    }
    password.input.value = "";
    go(() => { flow.setup = { recovery: result.recovery, restored: result.restored }; }); await view.sync();
  });
  return root;
}
