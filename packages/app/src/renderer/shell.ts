import { div, h } from "./dom.ts";
import { appIcon, icon, mark } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { closePopovers, openMenu, opened } from "./menu.ts";
import type { MenuItem } from "./menu.ts";
import { button, heading } from "./parts.ts";
import { session } from "./session.ts";
import { bridge, view } from "./ui.ts";
import type { Context } from "./ui.ts";

/** The menu of the board. Apps, Import and Export are in the command line for now, and say so; Settings and the tips work. */
function mainMenu({ t }: Context): MenuItem[] {
  return [
    { label: t.menuApps, line: t.inCommandLine("vault apps"), glyph: "layoutGrid", disabled: true },
    { label: t.menuImport, line: t.inCommandLine("vault import"), glyph: "download", disabled: true },
    { label: t.menuExport, line: t.inCommandLine("vault export"), glyph: "upload", disabled: true },
    { label: t.menuSettings, line: t.menuSettingsLine, glyph: "settings2", run: () => { session.page = "settings"; session.mode = "view"; view.redraw(); } },
    "rule",
    { label: t.menuTips, line: t.menuTipsLine, glyph: "lightbulb", run: () => { if (session.page !== "list") { session.page = "list"; session.tips = 1; view.redraw(); } else view.tips(); } },
  ];
}
/** The title bar: the app mark and name, Lock and the menu while the vault is open (not at setup, and not while locked), then minimise, maximise and close. */
export function titleBar(context: Context, open: boolean): HTMLElement {
  const { state, t } = context;
  const control = (glyph: IconName, size: number, label: string, action: () => Promise<void>, className = "") => h("button", { class: `wc ${className}`, type: "button", "aria-label": label, title: label, onclick: () => { void action(); } }, icon(glyph, size));
  const menuButton = h("button", { class: "tool icon-only", type: "button", "aria-label": t.menu, title: t.menu, "aria-haspopup": "menu", "aria-expanded": "false" }, icon("ellipsis", 16));
  menuButton.addEventListener("click", () => { if (opened(menuButton)) { closePopovers(); return; } openMenu(menuButton, mainMenu(context), { width: 320, align: "right", label: t.menu }); });
  return h("header", { class: "titlebar" },
    appIcon(20), h("span", { class: "name" }, "Vault"), div("fill"),
    open && div("tools",
      h("button", { class: "tool", type: "button", "aria-label": t.lockNow, title: t.lockNow, onclick: () => { void bridge.lock(); } }, icon("lock", 14), h("span", {}, t.lock)),
      menuButton),
    div("controls", control("minus", 14, t.minimize, bridge.minimize), control("square", 12, state.maximized ? t.restore : t.maximize, bridge.toggleMaximize), control("x", 14, t.close, bridge.close, "close")));
}

/** Before the first answer of the service: only the mark. */
export const starting = (): HTMLElement => div("view", mark(40, "soft"));

/** Vault cannot be reached: the service did not start, or Vault is not installed. */
export function outOfReach({ state, t }: Context, retry: () => void): HTMLElement {
  return div("view", div("card w360 center", div("heads center", heading(t.outTitle, 20), h("p", { class: "ui14" }, state.problem === "not_installed" ? t.notInstalledBody : t.outBody)), button(t.tryAgain, { primary: true, onclick: retry })));
}
