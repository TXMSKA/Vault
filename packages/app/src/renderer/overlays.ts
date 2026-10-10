import { div, h } from "./dom.ts";
import type { Child } from "./dom.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { button, heading, iconButton } from "./parts.ts";
import { view } from "./ui.ts";
import type { Dictionary } from "./i18n.ts";
let counter = 0;
/** A dialog of the board over the whole window: its title, what it says, and buttons at the right. Escape answers `onescape`. */
export function dialogBox(options: { title: string; width?: number; onsubmit?: (event: Event) => void; onescape?: () => void }, body: Child[], actions: Child[]): { root: HTMLElement; dialog: HTMLFormElement } {
  const id = `modal-title-${++counter}`;
  const dialog = h("form", { class: "dialog narrow", role: "dialog", "aria-modal": "true", "aria-labelledby": id, novalidate: true, tabindex: "-1", onsubmit: (event: Event) => { event.preventDefault(); options.onsubmit?.(event); } },
    heading(options.title, 18, id), ...body, div("actions gap", div("fill"), ...actions));
  if (options.width) dialog.style.width = `${options.width}px`;
  const root = div("scrim", dialog);
  root.addEventListener("keydown", event => { if (event.key === "Escape" && options.onescape) { event.preventDefault(); event.stopPropagation(); options.onescape(); } });
  return { root, dialog };
}
/** Asks a question that has two answers, in the board's dialog, and answers true for the second button (the one that does the thing). */
export function confirm(t: Dictionary, options: { title: string; body: string; yes: string; danger?: boolean; no?: string }): Promise<boolean> {
  return new Promise(done => {
    const finish = (answer: boolean) => { view.modal(undefined); done(answer); };
    const { root, dialog } = dialogBox({ title: options.title, onescape: () => finish(false) }, [h("p", { class: "lead" }, options.body)],
      [button(options.no ?? t.cancel, { onclick: () => finish(false) }), button(options.yes, { primary: !options.danger, danger: options.danger, type: "submit" })]);
    dialog.addEventListener("submit", () => finish(true));
    view.modal(root); queueMicrotask(() => dialog.focus());
  });
}
export type ToastSpec = { text: string; glyph?: IconName; action?: { label: string; run(): void }; closeLabel: string; ms: number };
let toastTimer: number | undefined;
/** Takes the toast away, if there is one. */
export function clearToast(host: HTMLElement) { host.querySelector(".toast")?.remove(); if (toastTimer !== undefined) clearTimeout(toastTimer); toastTimer = undefined; }
/** A message at the foot of the open-entry pane: what happened, an action when there is one, and a close button. It replaces the one before it and goes by itself. */
export function showToast(host: HTMLElement, spec: ToastSpec): () => void {
  host.querySelector(".toast")?.remove(); if (toastTimer !== undefined) clearTimeout(toastTimer);
  const dismiss = () => { toast.remove(); if (toastTimer !== undefined) clearTimeout(toastTimer); toastTimer = undefined; };
  const toast = div("toast", icon(spec.glyph ?? "check", 16), h("span", { class: "text" }, spec.text),
    spec.action && h("button", { class: "toast-action", type: "button", onclick: () => { dismiss(); spec.action!.run(); } }, spec.action.label), iconButton("x", spec.closeLabel, dismiss));
  toast.setAttribute("role", "status"); host.append(toast);
  toastTimer = window.setTimeout(dismiss, spec.ms);
  return dismiss;
}
