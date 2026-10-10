import type { AppState, SettingsView } from "../shared/api.js";
import { IDLE_CHOICES, LANGUAGE_CHOICES, THEME_CHOICES, withChoice } from "./choices.ts";
import { div, h } from "./dom.ts";
import { icon } from "./icons.ts";
import { closePopovers, openMenu, opened } from "./menu.ts";
import { dialogBox } from "./overlays.ts";
import { busy, button, field, iconButton, notice, reason } from "./parts.ts";
import { session } from "./session.ts";
import { bridge, view } from "./ui.ts";
import type { Context } from "./ui.ts";
/** Windows Hello needs the master password once, in the board's dialog; it is typed here and goes to the service, nowhere else. */
function askPassword({ t }: Context): Promise<boolean> {
  return new Promise(done => {
    const password = field({ label: t.masterPassword, name: "password", mono: true, secret: true, reveal: true, autocomplete: "current-password", t }), slot = div("slot");
    const finish = (answer: boolean) => { view.modal(undefined); done(answer); };
    const { root, dialog } = dialogBox({ title: t.helloOnTitle, onescape: () => finish(false) }, [h("p", { class: "lead" }, t.helloOnBody), password.root, slot],
      [button(t.cancel, { onclick: () => finish(false) }), button(t.turnOn, { primary: true, type: "submit" })]);
    dialog.addEventListener("submit", async () => {
      const typed = password.input.value; password.error(); slot.replaceChildren();
      if (!typed) { password.input.focus(); return; }
      const result = await busy(dialog, () => bridge.enableHello({ password: typed }));
      if (result.ok) { password.input.value = ""; finish(true); await view.sync(); return; }
      password.input.value = ""; password.input.focus();
      if (result.code === "locked") password.error(t.passwordWrong); else slot.replaceChildren(notice("circleAlert", result.code === "unavailable" ? t.helloUnavailable : reason(t, result.code), "error"));
    });
    view.modal(root); queueMicrotask(() => password.input.focus());
  });
}
/** The settings page of the board: every choice is saved the moment it is made, and the window follows what the service answers. */
export function settingsScreen(context: Context): HTMLElement {
  const { state, t } = context;
  let current: SettingsView = state.settings;
  const status = div("slot");
  async function change<K extends keyof SettingsView>(key: K, value: SettingsView[K], undo: () => void) {
    status.replaceChildren(); const next = withChoice(current, key, value), before = current; current = next;
    const result = await bridge.saveSettings(next);
    if (!result.ok) { current = before; undo(); status.replaceChildren(notice("circleAlert", reason(t, result.code), "error")); return; }
    await view.sync();
  }
  const follow: ((state: AppState) => void)[] = [];
  function select<K extends "idleMinutes" | "language" | "theme">(key: K, label: string, choices: readonly SettingsView[K][], name: (value: SettingsView[K]) => string): HTMLElement {
    const text = h("span", { class: "grow" }, name(current[key])), button = h("button", { class: "select", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": `${label}: ${name(current[key])}` }, text, icon("chevronDown", 16));
    // A change made somewhere else (the command line, say) shows here without drawing the page again.
    follow.push(next => { text.textContent = name(next.settings[key]); button.setAttribute("aria-label", `${label}: ${name(next.settings[key])}`); });
    button.addEventListener("click", () => {
      if (opened(button)) { closePopovers(); return; }
      openMenu(button, choices.map(choice => ({ label: name(choice), on: choice === current[key], run: () => {
        const before = current[key]; text.textContent = name(choice); button.setAttribute("aria-label", `${label}: ${name(choice)}`);
        void change(key, choice, () => { text.textContent = name(before); button.setAttribute("aria-label", `${label}: ${name(before)}`); });
      } })), { width: 180, align: "right", choose: true, label });
    });
    return button;
  }
  function toggle(label: string, on: boolean, disabled: boolean, flip: (on: boolean) => void): HTMLButtonElement {
    const knob = h("button", { class: `toggle${on ? " on" : ""}`, type: "button", role: "switch", "aria-checked": String(on), "aria-label": label, disabled }, div("knob"));
    // The switch is what the page says it is, so an answer that turns it back (a cancelled dialog) leaves the next press right.
    knob.addEventListener("click", () => { const value = knob.getAttribute("aria-checked") !== "true"; knob.classList.toggle("on", value); knob.setAttribute("aria-checked", String(value)); flip(value); });
    return knob;
  }
  const setting = (title: string, line: string, control: HTMLElement, extra?: HTMLElement) => div("setting", div("scopy", h("strong", { class: "strong" }, title), h("span", { class: "line" }, line), extra), control);
  const lastApp = toggle(t.lastAppTitle, current.lockWithLastApp, false, on => { void change("lockWithLastApp", on, () => { lastApp.classList.toggle("on", !on); lastApp.setAttribute("aria-checked", String(!on)); }); });
  const hello: HTMLButtonElement = toggle(t.hello, state.hello, !state.hello && !state.helloAvailable, on => {
    const back = () => { hello.classList.toggle("on", !on); hello.setAttribute("aria-checked", String(!on)); };
    if (on) void askPassword(context).then(done => { if (!done) back(); });
    else void bridge.disableHello().then(async result => { if (!result.ok) { back(); status.replaceChildren(notice("circleAlert", reason(context.t, result.code), "error")); } await view.sync(); });
  });
  const set = (node: HTMLElement, on: boolean) => { node.classList.toggle("on", on); node.setAttribute("aria-checked", String(on)); };
  const unset = h("span", { class: "line" }, t.helloUnset);
  follow.push(next => { current = next.settings; set(lastApp, next.settings.lockWithLastApp); set(hello, next.hello); hello.disabled = !next.hello && !next.helloAvailable; unset.hidden = next.hello || next.helloAvailable; });
  view.watch(next => { for (const update of follow) update(next); });
  const back = iconButton("arrowLeft", t.backToList, () => { session.page = "list"; view.redraw(); }, 18);
  return div("view page", div("sectionhead", back, h("h1", { class: "h h18" }, t.settingsTitle)),
    div("settings",
      setting(t.idleTitle, t.idleLine, select("idleMinutes", t.idleTitle, IDLE_CHOICES, t.idleChoice)),
      setting(t.lastAppTitle, t.lastAppLine, lastApp),
      setting(t.hello, t.helloLine, hello, unset),
      setting(t.languageTitle, t.languageLine, select("language", t.languageTitle, LANGUAGE_CHOICES, t.languageChoice)),
      setting(t.themeTitle, t.themeLine, select("theme", t.themeTitle, THEME_CHOICES, t.themeChoice)),
      setting(t.syncTitle, t.syncLine, h("span", { class: "dim sync" }, t.comingLater)),
      status));
}
