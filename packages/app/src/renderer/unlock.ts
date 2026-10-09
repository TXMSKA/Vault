import { div, h } from "./dom.ts";
import { appIcon, icon } from "./icons.ts";
import { busy, button, centred, field, heading, lead, link, notice, reason } from "./parts.ts";
import { bridge, flow, go, view } from "./ui.ts";
import type { Context } from "./ui.ts";
import { visible } from "./text.ts";

/** Waits for Windows Hello over this window. The answer of one the person cancelled is ignored. */
async function askHello() {
  const turn = ++flow.hello;
  go(() => { flow.unlock = "hello"; flow.note = undefined; });
  const result = await bridge.unlockWithHello();
  if (turn !== flow.hello) return;
  if (result.ok) { go(() => { flow.unlock = "locked"; }); await view.sync(); return; }
  const missing = result.code === "unavailable" || result.code === "not_found";
  go(() => { flow.unlock = "locked"; flow.note = missing ? "hello_unavailable" : "hello_failed"; if (missing) flow.helloOff = true; });
  await view.sync();
}

/** What unlocking means is said once, here. An unlock prompt names the app that asks, by its registered name and id. */
export function locked({ state, t }: Context): HTMLElement {
  const asking = state.prompt?.kind === "unlock" ? state.prompt : undefined;
  const password = field({ name: "password", placeholder: t.masterPassword, mono: true, secret: true, reveal: true, autocomplete: "current-password", t });
  password.input.setAttribute("aria-label", t.masterPassword);
  const slot = div("slot");
  if (flow.note) slot.replaceChildren(notice("circleAlert", flow.note === "hello_unavailable" ? t.helloUnavailable : t.helloFailed, "error"));
  const unlock = button(t.unlock, { primary: true, type: "submit", block: !asking, grow: !!asking });
  const hello = state.hello && !flow.helloOff ? button(t.hello, { glyph: "fingerprint", onclick: () => { void askHello(); } }) : undefined;
  const asked = asking && div("asking", notice("info", t.lockedAsks(visible(asking.app.name), visible(asking.app.id))), asking.reason !== null && h("p", { class: "reason selectable" }, t.lockedReason(visible(asking.reason))));
  const root = centred(360,
    div("intro center", appIcon(56), div("heads center", heading(t.lockedTitle, 22), h("p", { class: "ui14" }, t.lockedBody))),
    asked,
    div("fg", password.root, slot),
    asking ? div("actions gap", button(t.cancel, { onclick: () => { void bridge.dismissPrompt({ id: asking.id }).then(() => view.sync()); } }), unlock) : unlock,
    div("actions", hello, div("fill"), link(t.useRecovery, () => go(() => { flow.unlock = "recovery"; flow.note = undefined; }))));
  root.querySelector("form")!.addEventListener("submit", async () => {
    const typed = password.input.value; password.error(); slot.replaceChildren(); flow.note = undefined;
    if (!typed) { password.input.focus(); return; }
    const result = await busy(root, () => bridge.unlock({ password: typed }));
    if (result.ok) { password.input.value = ""; await view.sync(); return; }
    password.error(result.code === "locked" ? t.lockedError : reason(t, result.code)); password.input.focus(); password.input.select(); await view.sync();
  });
  queueMicrotask(() => password.input.focus());
  return root;
}

/** Windows Hello draws its own Security window over this one. */
export function helloWaiting({ t }: Context): HTMLElement {
  const cancel = button(t.cancel, { onclick: () => { flow.hello++; go(() => { flow.unlock = "locked"; }); } });
  queueMicrotask(() => cancel.focus());
  return div("view", div("card w360 center", div("halo", icon("fingerprint", 32)), div("heads center", heading(t.helloTitle, 20), h("p", { class: "ui14" }, t.helloBody)), cancel));
}

/** The recovery key and a new master password; a new recovery key follows. */
export function recoveryUnlock({ t }: Context): HTMLElement {
  const key = field({ label: t.recoveryKey, name: "recovery", mono: true, autocomplete: "off", t });
  const password = field({ label: t.newPassword, name: "new-password", mono: true, secret: true, reveal: true, hint: t.passwordRange, autocomplete: "new-password", t });
  const repeat = field({ label: t.repeatIt, name: "repeat", mono: true, secret: true, autocomplete: "new-password", t });
  const failure = div("slot");
  const root = centred(420, div("heads", heading(t.recoveryUnlockTitle, 22), lead(t.recoveryUnlockBody)), key.root, password.root, repeat.root, notice("info", t.recoveryUnlockNotice), failure,
    div("actions", button(t.back, { onclick: () => go(() => { flow.unlock = "locked"; }) }), div("fill"), button(t.unlock, { primary: true, type: "submit" })));
  root.querySelector("form")!.addEventListener("submit", async () => {
    const typed = key.input.value.trim(), first = password.input.value;
    key.error(); password.error(); repeat.error(); failure.replaceChildren();
    if (!typed) { key.input.focus(); return; }
    if (first.length < 15 || first.length > 128) { password.error(t.passwordShort); password.input.focus(); return; }
    if (first !== repeat.input.value) { repeat.error(t.passwordMismatch); repeat.input.focus(); return; }
    const result = await busy(root, () => bridge.recover({ recovery: typed, password: first }));
    if (!result.ok) {
      if (result.code === "locked") key.error(t.recoveryWrong); else failure.replaceChildren(notice("circleAlert", reason(t, result.code), "error"));
      key.input.focus(); await view.sync(); return;
    }
    key.input.value = ""; password.input.value = ""; repeat.input.value = "";
    go(() => { flow.setup = { recovery: result.recovery, restored: true }; flow.unlock = "locked"; }); await view.sync();
  });
  queueMicrotask(() => key.input.focus());
  return root;
}
