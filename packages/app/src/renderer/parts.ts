import { div, h } from "./dom.ts";
import type { Child } from "./dom.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";
import type { Dictionary } from "./i18n.ts";
export type Tone = "soft" | "primary" | "error";
export type ButtonOptions = { primary?: boolean; danger?: boolean; glyph?: IconName; block?: boolean; grow?: boolean; type?: "button" | "submit"; disabled?: boolean; onclick?: (event: MouseEvent) => void; label?: string };
/** A button of the board: outlined, or filled with the accent when primary, or written in the error colour when it undoes something. */
export function button(text: string, options: ButtonOptions = {}): HTMLButtonElement {
  const classes = ["btn", options.primary && "primary", options.danger && "danger", options.block && "block", options.grow && "grow"].filter(Boolean).join(" ");
  return h("button", { class: classes, type: options.type ?? "button", disabled: options.disabled, onclick: options.onclick, "aria-label": options.label }, options.glyph && icon(options.glyph, 16), h("span", {}, text));
}
/** A square icon button with the control's corners. */
export const iconButton = (glyph: IconName, label: string, onclick?: (event: MouseEvent) => void, size = 16) => h("button", { class: "ib", type: "button", "aria-label": label, title: label, onclick }, icon(glyph, size));
/** A link: accent text over a rule. */
export const link = (text: string, onclick: () => void) => h("button", { class: "link", type: "button", onclick }, text);
/** A centred column of the width the board draws, in a form: Enter submits it, and nothing is sent anywhere. */
export const centred = (width: number, ...children: Child[]) => div("view", h("form", { class: `card w${width}`, novalidate: true, onsubmit: (event: Event) => event.preventDefault() }, ...children));
export const heading = (text: string, size: 18 | 20 | 22 | 24, id?: string) => h("h1", { class: `h h${size}`, id }, text);
export const lead = (text: string) => h("p", { class: "lead" }, text);
/** A line with a leading icon; `tone` colours the icon. */
export function notice(glyph: IconName, text: string, tone: Tone = "soft"): HTMLElement {
  const line = div(`notice ${tone}`, icon(glyph, 16), h("span", {}, text));
  if (tone === "error") line.setAttribute("role", "alert");
  return line;
}
export type Field = { root: HTMLElement; input: HTMLInputElement; box: HTMLElement; error(message?: string): void };
export type FieldOptions = { label?: string; name: string; mono?: boolean; secret?: boolean; reveal?: boolean; placeholder?: string; glyph?: IconName; hint?: string; value?: string; readonly?: boolean; autocomplete?: string; t: Dictionary; grow?: boolean };
/**
 * A text field with its label above and a hint or an error below. A secret field hides what is typed; with `reveal` it also has the board's eye button at its
 * right end. `error(message)` turns the border and the line below into the error, and `error()` puts the hint back.
 */
export function field(options: FieldOptions): Field {
  const input = h("input", { type: options.secret ? "password" : "text", name: options.name, placeholder: options.placeholder, value: options.value, readonly: options.readonly, autocomplete: options.autocomplete ?? "off", spellcheck: "false", autocapitalize: "off", "aria-label": options.label ?? options.placeholder ?? options.name });
  const trail: Child[] = [];
  if (options.secret && options.reveal) {
    const toggle = iconButton("eye", options.t.reveal, () => {
      const shown = input.type === "password"; input.type = shown ? "text" : "password"; toggle.replaceChildren(icon(shown ? "eyeOff" : "eye", 16));
      const label = shown ? options.t.hide : options.t.reveal; toggle.setAttribute("aria-label", label); toggle.setAttribute("aria-pressed", String(shown)); toggle.title = label; input.focus();
    });
    toggle.setAttribute("aria-pressed", "false"); trail.push(toggle);
  }
  const box = div(`input${options.mono ? " mono" : ""}${trail.length ? " trail" : ""}`, options.glyph && icon(options.glyph, 16), input, ...trail);
  const below = div("below"), root = div("fg", options.label && h("label", { class: "label" }, options.label), box, below);
  if (options.grow) root.classList.add("grow");
  const hint = () => { below.replaceChildren(...options.hint ? [h("span", { class: "hint" }, options.hint)] : []); box.classList.remove("error"); input.removeAttribute("aria-invalid"); };
  hint();
  // Typing again takes a shown error away, so a corrected value never sits under an old message.
  input.addEventListener("input", () => { if (box.classList.contains("error")) hint(); });
  return {
    root, input, box,
    error(message) { if (!message) { hint(); return; } below.replaceChildren(notice("circleAlert", message, "error")); box.classList.add("error"); input.setAttribute("aria-invalid", "true"); },
  };
}
/** A checkbox with its text. */
export function checkbox(text: string, checked: boolean, onchange: (checked: boolean) => void): { root: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "checkbox", class: "sr", checked, onchange: () => onchange(input.checked) });
  input.checked = checked;
  return { root: h("label", { class: "checkbox" }, input, div("box", icon("check", 14, 3)), h("span", {}, text)), input };
}
/** A radio row of the board: a ring, filled in the accent when chosen, the name and a line under it. */
export function choice(group: string, value: string, title: string, line: string, on: boolean, onchange: () => void): { root: HTMLElement; input: HTMLInputElement } {
  const input = h("input", { type: "radio", class: "sr", name: group, value, checked: on, onchange });
  input.checked = on;
  const root = h("label", { class: `choice${on ? " on" : ""}` }, input, div("ring", div("dot")), div("copy", h("strong", { class: "strong" }, title), h("span", { class: "line" }, line)));
  return { root, input };
}
/** Disables everything in `root` while `work` runs, so a second click or a keystroke cannot repeat it. */
export async function busy<T>(root: HTMLElement, work: () => Promise<T>): Promise<T> {
  const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")], before = controls.map(control => control.disabled);
  root.setAttribute("aria-busy", "true"); for (const control of controls) control.disabled = true;
  try { return await work(); }
  finally { controls.forEach((control, index) => { control.disabled = before[index]; }); root.removeAttribute("aria-busy"); }
}
/** The reasons the service or the window gives, in words; anything unknown is the general one. */
export function reason(t: Dictionary, code: string, specific: Record<string, string> = {}): string {
  if (Object.hasOwn(specific, code)) return specific[code];
  if (code === "limited" || code === "rate_limited") return t.limited;
  if (code === "busy") return t.busy;
  return t.unavailable;
}
