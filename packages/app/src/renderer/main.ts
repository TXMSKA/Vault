import type { AppState } from "../shared/api.js";
import { h } from "./dom.ts";
import { dictionary } from "./i18n.ts";
import { request } from "./requests.ts";
import type { Dialog } from "./requests.ts";
import { listScreen } from "./list.ts";
import { closePopovers } from "./menu.ts";
import { dialogBox } from "./overlays.ts";
import { button } from "./parts.ts";
import { session, resetSession } from "./session.ts";
import { settingsScreen } from "./settings.ts";
import { outOfReach, starting, titleBar } from "./shell.ts";
import { create, recoveryKey, restore, welcome } from "./setup.ts";
import { helloWaiting, locked, recoveryUnlock } from "./unlock.ts";
import { bridge, flow, view } from "./ui.ts";
import type { Context } from "./ui.ts";

const bar = document.getElementById("bar")!, screen = document.getElementById("screen")!, overlay = document.getElementById("overlay")!, sheet = document.getElementById("sheet")!, modal = document.getElementById("modal")!;
let current: AppState | undefined, received = false, shown = { bar: "", screen: "", overlay: "", closing: false }, dialog: Dialog | undefined, leavers: (() => void)[] = [], watchers: ((state: AppState) => void)[] = [], closingDialog: HTMLElement | undefined;

/** The screen for the state of the service and the place the person has reached in a flow. */
function pick(context: Context): { id: string; build: () => HTMLElement } {
  const { state } = context;
  if (state.phase === "starting") return { id: "starting", build: starting };
  if (state.phase === "unavailable") return { id: `out|${state.problem}`, build: () => outOfReach(context, () => { void bridge.retry(); }) };
  if (flow.setup) return { id: "key", build: () => recoveryKey(context) };
  if (!state.created) return { id: flow.first, build: () => (flow.first === "welcome" ? welcome : flow.first === "create" ? create : restore)(context) };
  if (!state.unlocked) {
    if (flow.unlock === "hello") return { id: "hello", build: () => helloWaiting(context) };
    if (flow.unlock === "recovery") return { id: "recovery", build: () => recoveryUnlock(context) };
    const asking = state.prompt?.kind === "unlock" ? state.prompt.id : "";
    return { id: `locked|${asking}|${state.hello && !flow.helloOff}|${flow.note ?? ""}`, build: () => locked(context) };
  }
  if (session.page === "settings") return { id: "settings", build: () => settingsScreen(context) };
  return { id: "list", build: () => listScreen(context) };
}

function render() {
  const state = current; if (!state) return;
  const t = dictionary(state.language), context: Context = { state, t };
  document.documentElement.lang = state.language; document.documentElement.dataset.theme = state.theme;
  // Lock and the menu belong to an open vault, not to setup and not to the locked screens.
  const open = state.phase === "ready" && state.created && state.unlocked && !flow.setup, barKey = `${state.language}|${open}|${state.maximized}`;
  if (barKey !== shown.bar) { shown.bar = barKey; bar.replaceChildren(titleBar(context, open)); }
  const next = pick(context), screenKey = `${state.language}|${next.id}`;
  if (screenKey !== shown.screen) {
    shown.screen = screenKey; view.sheet(undefined);
    // What the screen left running (a timer, a listener, an open menu) stops with it.
    closePopovers(); watchers.length = 0; for (const leave of leavers.splice(0)) leave();
    if (!state.unlocked || state.phase !== "ready") { resetSession(); view.modal(undefined); }
    screen.replaceChildren(next.build());
  }
  // A run or a permission waits over whatever is on screen. An unlock prompt is part of the locked screen itself.
  const asked = state.phase === "ready" && state.created && state.prompt && state.prompt.kind !== "unlock" ? state.prompt : undefined;
  const overlayKey = asked ? `${state.language}|${asked.id}|${asked.kind === "run" ? JSON.stringify([asked.short, asked.problem]) : ""}|${state.hello && !flow.helloOff}` : "";
  if (overlayKey !== shown.overlay) {
    shown.overlay = overlayKey; dialog?.dispose(); dialog = undefined; overlay.replaceChildren();
    if (asked) { dialog = request(context, asked); overlay.append(dialog.root); }
  }
  screen.toggleAttribute("inert", Boolean(asked) || modal.childElementCount > 0);
  for (const watcher of watchers) watcher(state);
  // Closing while the recovery key is unsaved asks first; the question stays up until it is answered.
  if (state.closing !== shown.closing) {
    shown.closing = state.closing;
    if (state.closing) {
      const t2 = t, close = dialogBox({ title: t2.closeKeyTitle, onescape: () => { void bridge.cancelClose(); } }, [h("p", { class: "lead" }, t2.closeKeyBody)],
        [button(t2.goBack, { primary: true, onclick: () => { void bridge.cancelClose(); } }), button(t2.closeAnyway, { danger: true, onclick: () => { void bridge.confirmClose(); } })]);
      closingDialog = close.root; view.modal(close.root); queueMicrotask(() => close.dialog.focus());
    } else if (closingDialog) { if (modal.contains(closingDialog)) view.modal(undefined); closingDialog = undefined; }
  }
}

function apply(state: AppState) {
  current = state;
  if (state.unlocked) { flow.unlock = "locked"; flow.note = undefined; }
  render();
}

if (!window.vault) {
  document.body.replaceChildren();
} else {
  view.redraw = render; view.sync = async () => { apply(await bridge.state()); };
  view.sheet = page => { sheet.replaceChildren(...page ? [page] : []); };
  view.leave = cleanup => { leavers.push(cleanup); };
  view.watch = listener => { watchers.push(listener); };
  view.state = () => current!;
  // A dialog over the whole window holds everything else still until it is answered.
  view.modal = page => {
    modal.replaceChildren(...page ? [page] : []);
    const held = modal.childElementCount > 0;
    for (const part of [bar, screen, overlay]) part.toggleAttribute("inert", held || part === screen && Boolean(current?.prompt && current.prompt.kind !== "unlock" && current.created));
  };
  bridge.onState(state => { received = true; apply(state); });
  void bridge.state().then(state => { if (!received) apply(state); });
  // The first touch tells the main process that a person is here, which keeps a start for prompts only open.
  let touched = false;
  for (const name of ["pointerdown", "keydown"]) addEventListener(name, () => { if (!touched) { touched = true; void bridge.interact(); } }, { capture: true });
  addEventListener("contextmenu", event => event.preventDefault());
}
