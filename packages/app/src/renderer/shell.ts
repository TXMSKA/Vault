import { div, h } from "./dom.ts";
import { appIcon, icon, mark } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { button, heading } from "./parts.ts";
import { bridge } from "./ui.ts";
import type { Context } from "./ui.ts";

/** The title bar: the app mark and name, Lock and the menu while the vault is open (not at setup, and not while locked), then minimise, maximise and close. */
export function titleBar({ state, t }: Context, open: boolean): HTMLElement {
  const control = (glyph: IconName, size: number, label: string, action: () => Promise<void>, className = "") => h("button", { class: `wc ${className}`, type: "button", "aria-label": label, title: label, onclick: () => { void action(); } }, icon(glyph, size));
  return h("header", { class: "titlebar" },
    appIcon(20), h("span", { class: "name" }, "Vault"), div("fill"),
    open && div("tools",
      h("button", { class: "tool", type: "button", "aria-label": t.lockNow, title: t.lockNow, onclick: () => { void bridge.lock(); } }, icon("lock", 14), h("span", {}, t.lock)),
      h("button", { class: "tool icon-only", type: "button", "aria-label": t.menu, title: t.menu, disabled: true }, icon("ellipsis", 16))),
    div("controls", control("minus", 14, t.minimize, bridge.minimize), control("square", 12, state.maximized ? t.restore : t.maximize, bridge.toggleMaximize), control("x", 14, t.close, bridge.close, "close")));
}

/** The list, until it is built: the empty list of the board, with its controls at rest. */
export function emptyList({ t }: Context): HTMLElement {
  const search = h("input", { type: "text", placeholder: t.search, "aria-label": t.search, disabled: true });
  return div("main",
    div("list", div("listtop", div("search", icon("search", 16), search), h("button", { class: "add", type: "button", "aria-label": t.addEntry, title: t.addEntry, disabled: true }, icon("plus", 18, 2.4)))),
    div("detail", div("empty", mark(40, "soft"), heading(t.emptyTitle, 18), h("p", { class: "ui14 center" }, t.emptyBody), div("actions gap", button(t.import, { glyph: "download", disabled: true }), button(t.addEntry, { primary: true, glyph: "plus", disabled: true })))));
}

/** Before the first answer of the service: only the mark. */
export const starting = (): HTMLElement => div("view", mark(40, "soft"));

/** Vault cannot be reached: the service did not start, or Vault is not installed. */
export function outOfReach({ state, t }: Context, retry: () => void): HTMLElement {
  return div("view", div("card w360 center", div("heads center", heading(t.outTitle, 20), h("p", { class: "ui14" }, state.problem === "not_installed" ? t.notInstalledBody : t.outBody)), button(t.tryAgain, { primary: true, onclick: retry })));
}
