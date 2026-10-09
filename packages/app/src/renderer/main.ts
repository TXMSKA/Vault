import type { AppState } from "../shared/api.js";
import { dictionary } from "./i18n.ts";
import { request } from "./requests.ts";
import type { Dialog } from "./requests.ts";
import { emptyList, outOfReach, starting, titleBar } from "./shell.ts";
import { create, recoveryKey, restore, welcome } from "./setup.ts";
import { helloWaiting, locked, recoveryUnlock } from "./unlock.ts";
import { bridge, flow, view } from "./ui.ts";
import type { Context } from "./ui.ts";

const bar = document.getElementById("bar")!, screen = document.getElementById("screen")!, overlay = document.getElementById("overlay")!, sheet = document.getElementById("sheet")!;
let current: AppState | undefined, received = false, shown = { bar: "", screen: "", overlay: "" }, dialog: Dialog | undefined;

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
  return { id: "list", build: () => emptyList(context) };
}

function render() {
  const state = current; if (!state) return;
  const t = dictionary(state.language), context: Context = { state, t };
  document.documentElement.lang = state.language; document.documentElement.dataset.theme = state.theme;
  // Lock and the menu belong to an open vault, not to setup and not to the locked screens.
  const open = state.phase === "ready" && state.created && state.unlocked && !flow.setup, barKey = `${state.language}|${open}|${state.maximized}`;
  if (barKey !== shown.bar) { shown.bar = barKey; bar.replaceChildren(titleBar(context, open)); }
  const next = pick(context), screenKey = `${state.language}|${next.id}`;
  if (screenKey !== shown.screen) { shown.screen = screenKey; view.sheet(undefined); screen.replaceChildren(next.build()); }
  // A run or a permission waits over whatever is on screen. An unlock prompt is part of the locked screen itself.
  const asked = state.phase === "ready" && state.created && state.prompt && state.prompt.kind !== "unlock" ? state.prompt : undefined;
  const overlayKey = asked ? `${state.language}|${asked.id}|${asked.kind === "run" ? JSON.stringify([asked.short, asked.problem]) : ""}|${state.hello && !flow.helloOff}` : "";
  if (overlayKey !== shown.overlay) {
    shown.overlay = overlayKey; dialog?.dispose(); dialog = undefined; overlay.replaceChildren();
    if (asked) { dialog = request(context, asked); overlay.append(dialog.root); }
  }
  screen.toggleAttribute("inert", Boolean(asked));
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
  bridge.onState(state => { received = true; apply(state); });
  void bridge.state().then(state => { if (!received) apply(state); });
  // The first touch tells the main process that a person is here, which keeps a start for prompts only open.
  let touched = false;
  for (const name of ["pointerdown", "keydown"]) addEventListener(name, () => { if (!touched) { touched = true; void bridge.interact(); } }, { capture: true });
  addEventListener("contextmenu", event => event.preventDefault());
}
