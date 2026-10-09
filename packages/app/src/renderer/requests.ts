import type { PromptView } from "../shared/api.js";
import { div, h } from "./dom.ts";
import { icon } from "./icons.ts";
import { busy, button, field, heading, link, notice, reason } from "./parts.ts";
import { commandLine, minutesLeft, visible } from "./text.ts";
import { bridge, flow, view } from "./ui.ts";
import type { Context } from "./ui.ts";
type Request = Extract<PromptView, { kind: "run" | "permission" }>;
export type Dialog = { root: HTMLElement; dispose(): void };
const fact = (name: string, value: string, mono = false) => div("fact", h("span", { class: "label" }, name), h("span", { class: `value selectable${mono ? " mono" : ""}` }, value));

/**
 * A request that waits for the person, in the board's dialog over the window: an agent asks to run commands, or an app asks to
 * import passwords. Approving takes Windows Hello when it is set up, or the master password; the other way is one link away.
 */
export function request({ state, t }: Context, prompt: Request): Dialog {
  let hello = state.hello && !flow.helloOff;
  const run = prompt.kind === "run" ? prompt : undefined, name = visible(prompt.app.name);
  const title = run ? t.runTitle(name, run.commands.length) : t.permissionTitle(name), titleId = "dialog-title";
  const clock = h("span", {}, "");
  const tick = () => { const minutes = minutesLeft(prompt.expiresAt, Date.now()); clock.textContent = `${t.expires(minutes)}${minutes > 0 && run ? ` ${t.covers(run.commands.length)}` : ""}`; };
  tick(); const timer = setInterval(tick, 15000);
  const root = div("scrim"), dialog = h("form", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, novalidate: true, tabindex: "-1", onsubmit: (event: Event) => event.preventDefault() });
  root.append(dialog);
  function build(first?: string) {
    // Windows Hello is only offered while it is set up; a failure that says it is not set up takes it away for the session.
    const canHello = state.hello && !flow.helloOff; if (!canHello) hello = false;
    const password = hello ? undefined : field({ label: t.masterPassword, name: "password", mono: true, secret: true, reveal: true, autocomplete: "current-password", t });
    const slot = div("slot", ...first ? [notice("circleAlert", first, "error")] : []), waiting = div("slot");
    const body = run
      ? [
          div("facts", fact(t.runProject, visible(run.project)), fact(t.runFolder, visible(run.cwd), true)),
          div("commands", ...run.commands.map(argv => h("div", { class: "command selectable" }, commandLine(argv)))),
          notice("info", t.runValues(visible(run.project))),
          run.problem ? notice("circleAlert", run.problem === "missing" ? t.runMissing(visible(run.project)) : t.runAmbiguous(visible(run.project)), "error") : run.short?.length ? notice("eye", t.runShort(run.short.map(visible).join(", "), run.short.length)) : null,
        ]
      : [
          div("facts", fact(t.permissionApp, `${name} (${visible(prompt.app.id)})`)),
          h("p", { class: "lead" }, t.permissionBody(name)),
        ];
    const answer = button(prompt.kind === "run" ? t.approve : t.allow, { primary: true, type: "submit", glyph: hello ? "fingerprint" : undefined });
    const refuse = button(prompt.kind === "run" ? t.reject : t.deny, { onclick: async () => {
      const result = await busy(dialog, () => bridge.dismissPrompt({ id: prompt.id }));
      if (!result.ok) slot.replaceChildren(notice("circleAlert", failure(result.code), "error")); await view.sync();
    } });
    const failure = (code: string) => reason(t, code, { locked: hello ? t.helloFailed : t.passwordWrong, expired: t.requestExpired, not_pending: t.requestAnswered, not_found: t.requestAnswered, unavailable: hello ? t.helloUnavailable : t.unavailable });
    const parts: (Node | null | undefined)[] = [
      heading(title, 18, titleId), ...body,
      div("expiry", icon("clock", 14), clock), password?.root, waiting, slot,
      div("actions gap", canHello ? link(hello ? t.usePassword : t.useHello, () => { hello = !hello; build(); }) : null, div("fill"), refuse, answer),
    ];
    dialog.replaceChildren(...parts.filter((part): part is Node => !!part));
    dialog.onsubmit = async event => {
      event.preventDefault(); slot.replaceChildren(); password?.error();
      const typed = password?.input.value;
      if (password && !typed) { password.input.focus(); return; }
      if (hello) waiting.replaceChildren(notice("info", t.helloBody));
      const result = await busy(dialog, () => run
        ? hello ? bridge.approveRunWithHello({ id: prompt.id }) : bridge.approveRun({ id: prompt.id, password: typed! })
        : hello ? bridge.allowImportWithHello({ id: prompt.id }) : bridge.allowImport({ id: prompt.id, password: typed! }));
      waiting.replaceChildren();
      if (!result.ok) {
        // Windows Hello that cannot be used is not offered again; the dialog goes on with the master password.
        if (result.code === "unavailable" && hello) { flow.helloOff = true; hello = false; build(t.helloUnavailable); await view.sync(); return; }
        const text = failure(result.code);
        if (password && result.code === "locked") password.error(text); else slot.replaceChildren(notice("circleAlert", text, "error"));
        password?.input.focus();
      }
      await view.sync();
    };
    queueMicrotask(() => (password ? password.input : dialog).focus());
  }
  build();
  return { root, dispose() { clearInterval(timer); } };
}
