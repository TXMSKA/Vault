import type { EntryInput, EntryView, FieldInput, FieldView, Kind } from "../shared/api.js";
import { div, h } from "./dom.ts";
import type { Child } from "./dom.ts";
import { clampLength, DEFAULT_GENERATOR, generate, LENGTH_MAX, LENGTH_MIN } from "./generator.ts";
import type { GeneratorOptions } from "./generator.ts";
import { icon } from "./icons.ts";
import { tile } from "./entry.ts";
import { KIND_GLYPH, KNOWN_FIELDS } from "./kinds.ts";
import { closePopovers, openPopover, opened } from "./menu.ts";
import { busy, button, checkbox, field, iconButton, notice, reason } from "./parts.ts";
import { bridge } from "./ui.ts";
import type { Context } from "./ui.ts";
import type { Dictionary } from "./i18n.ts";
export type FormHooks = {
  cancel(): void;
  /** The entry was saved. */
  saved(id: string): void;
  /** The person asked to delete the entry that is being edited. */
  remove(entry: EntryView): void;
  /** The entry changed somewhere else: show it again as it is now. */
  reload(): void;
};
export type FormPane = { root: HTMLElement; dirty(): boolean; dispose(): void };
type Control = { root: HTMLElement; input: HTMLInputElement | HTMLTextAreaElement; box: HTMLElement; error(message?: string): void };
/** What a control stands for in the entry: its title, one of its fields, its note or its one-time code key. */
type Slot = { target: "title" | "field" | "note" | "totp"; id: string; name: string; secret: boolean; had: boolean; touched: boolean; control: Control };
type VRow = { existing: FieldView | undefined; id: string; name: HTMLInputElement; value: HTMLInputElement; secret: boolean; touched: boolean; root: HTMLElement; gone: boolean };
const DOTS = "••••••••";
let generator: GeneratorOptions = { ...DEFAULT_GENERATOR };
/** A multi-line control in the look of the board's fields; `tall` is its height in pixels. */
function area(options: { label: string; name: string; mono?: boolean; placeholder?: string; tall: number; hint?: string; trail?: HTMLElement[] }): Control {
  const input = h("textarea", { name: options.name, placeholder: options.placeholder, autocomplete: "off", spellcheck: "false", "aria-label": options.label });
  const box = div(`input area${options.mono ? " mono" : ""}`, input, ...options.trail ?? []);
  box.style.height = `${options.tall}px`;
  const below = div("below"), root = div("fg", h("label", { class: "label" }, options.label), box, below);
  const hint = () => { below.replaceChildren(...options.hint ? [h("span", { class: "hint" }, options.hint)] : []); box.classList.remove("error"); input.removeAttribute("aria-invalid"); };
  hint(); input.addEventListener("input", () => { if (box.classList.contains("error")) hint(); });
  return { root, input, box, error(message) { if (!message) { hint(); return; } below.replaceChildren(notice("circleAlert", message, "error")); box.classList.add("error"); input.setAttribute("aria-invalid", "true"); } };
}
/**
 * The generator under a password field: a length and three switches, a new password each time something changes, and one button that puts it in the field.
 * The password only exists here until it is used.
 */
function generatorPanel(t: Dictionary, use: (password: string) => void): HTMLElement {
  let current = generate(generator);
  const preview = h("div", { class: "preview mono selectable" }, current), length = h("span", { class: "strong" }, String(generator.length));
  const again = () => { current = generate(generator); preview.textContent = current; };
  const slider = h("input", { type: "range", class: "slider", min: LENGTH_MIN, max: LENGTH_MAX, step: 1, value: generator.length, "aria-label": t.lengthLabel });
  const fill = () => slider.style.setProperty("--fill", `${(generator.length - LENGTH_MIN) / (LENGTH_MAX - LENGTH_MIN) * 100}%`);
  fill();
  slider.addEventListener("input", () => { generator.length = clampLength(Number(slider.value)); length.textContent = String(generator.length); fill(); again(); });
  const option = (text: string, key: "symbols" | "numbers" | "uppercase") => checkbox(text, generator[key], on => { generator[key] = on; again(); }).root;
  return div("generator",
    div("row", h("strong", { class: "strong" }, t.generate), div("fill"), iconButton("refreshCw", t.makeAnother, again)),
    preview,
    div("fg", div("row", h("span", { class: "label" }, t.lengthLabel), div("fill"), length), slider),
    div("row gap18", option(t.symbolsLabel, "symbols"), option(t.numbersLabel, "numbers"), option(t.uppercaseLabel, "uppercase")),
    div("row", div("fill"), button(t.useGenerated, { primary: true, onclick: () => use(current) })));
}
/**
 * The form of an entry, new or being edited, as the board draws each kind. What the person did not change stays as it is: a secret value the form never held is
 * not sent back, and the main process puts it back from the entry it fetches. `collect` gives the entry to save, or says what is wrong.
 */
export function formPane({ t }: Context, options: { kind: Kind; entry?: EntryView; hooks: FormHooks }): FormPane {
  const { kind, entry, hooks } = options, known = new Map((entry?.fields ?? []).map(item => [item.id, item]));
  let dirty = false, disposed = false;
  const slots: Slot[] = [], rows: VRow[] = [], status = div("slot"), body = div("fields");
  const mark = () => { dirty = true; };
  const eyes = new Map<Control, HTMLButtonElement>();
  /** Shows or hides what a secret control holds, and keeps its eye button saying which. */
  function setShown(control: Control, on: boolean) {
    control.box.classList.toggle("shown", on);
    if (control.input instanceof HTMLInputElement) control.input.type = on ? "text" : "password"; else control.box.classList.toggle("masked", !on);
    const eye = eyes.get(control); if (!eye) return;
    eye.replaceChildren(icon(on ? "eyeOff" : "eye", 16)); eye.setAttribute("aria-label", on ? t.hide : t.reveal); eye.title = on ? t.hide : t.reveal; eye.setAttribute("aria-pressed", String(on));
  }
  /** The eye of a secret control. On an existing value that was never loaded it asks for that one value first, since showing it is the person's choice. */
  function eyeFor(slot: () => Slot, revealable: string | undefined): HTMLButtonElement {
    const eye = iconButton("eye", t.reveal, async () => {
      const current = slot(), control = current.control, hidden = !control.box.classList.contains("shown");
      if (hidden && revealable && current.had && !current.touched && control.input.value === "") {
        const result = await bridge.entryReveal({ id: entry!.id, part: revealable });
        if (!result.ok) { control.error(reason(t, result.code)); return; }
        control.input.value = result.value;
      }
      setShown(control, hidden);
    });
    eye.setAttribute("aria-pressed", "false"); return eye;
  }
  /** One control of the entry's own: a name, a field, the note or the one-time code key. */
  function slotFor(spec: { target: Slot["target"]; id?: string; label: string; placeholder?: string; secret?: boolean; mono?: boolean; tall?: number; hint?: string; part?: string; generator?: boolean; reveals?: boolean }): HTMLElement {
    const old = spec.target === "field" ? known.get(spec.id!) : undefined;
    const secret = spec.target === "note" || spec.target === "totp" ? true : old ? old.secret : spec.secret ?? false;
    const had = spec.target === "title" ? false : spec.target === "note" ? !!entry?.note.filled : spec.target === "totp" ? !!entry?.totp : !!old?.filled && secret;
    const slotRef: { current?: Slot } = {};
    const trail: HTMLElement[] = [];
    // A new multi-line secret (a note, a key) is plain text to type, as the board draws it; it has an eye only once it holds something to hide.
    const wantsEye = secret && spec.reveals !== false && (!spec.tall || had);
    const eye = wantsEye ? eyeFor(() => slotRef.current!, spec.part) : undefined;
    if (eye) trail.push(eye);
    if (spec.generator) {
      const wand = iconButton("wandSparkles", t.generate, () => {
        if (opened(wand)) { closePopovers(); return; }
        const popover = openPopover(wand, generatorPanel(t, password => { control.input.value = password; setShown(control, true); mark(); current.touched = true; popover.close(); wand.focus(); }), { width: 340, align: "right", label: t.generate });
      });
      wand.setAttribute("aria-haspopup", "dialog"); wand.setAttribute("aria-expanded", "false"); trail.push(wand);
    }
    const placeholder = had ? DOTS : spec.placeholder;
    const control: Control = spec.tall
      ? area({ label: spec.label, name: spec.id ?? spec.target, mono: spec.mono, placeholder, tall: spec.tall, hint: had ? t.unchangedHint : spec.hint, trail })
      : field({ label: spec.label, name: spec.id ?? spec.target, mono: spec.mono, secret, placeholder, hint: had && spec.target !== "totp" ? t.unchangedHint : spec.hint, trail, t, value: !secret ? (spec.target === "title" ? entry?.title : old?.value ?? undefined) : undefined });
    if (spec.tall && !secret) control.input.value = spec.target === "title" ? entry?.title ?? "" : old?.value ?? "";
    if (eye) eyes.set(control, eye);
    if (secret && had && control.input instanceof HTMLTextAreaElement) control.box.classList.add("masked");
    const current: Slot = { target: spec.target, id: spec.id ?? "", name: old?.name ?? "", secret, had, touched: false, control };
    slotRef.current = current; slots.push(current);
    control.input.addEventListener("input", () => { current.touched = true; mark(); });
    return control.root;
  }
  const layout: Record<Kind, () => Child[]> = {
    login: () => [
      slotFor({ target: "title", label: t.formName, placeholder: t.fieldPlaceholder("loginName") }),
      slotFor({ target: "field", id: "username", label: t.fieldLabel("username"), placeholder: t.fieldPlaceholder("username") }),
      slotFor({ target: "field", id: "password", label: t.fieldLabel("password"), placeholder: t.fieldPlaceholder("password"), secret: true, mono: true, part: "f:password", generator: true }),
      div("pair login", slotFor({ target: "field", id: "website", label: t.fieldLabel("website"), placeholder: t.fieldPlaceholder("website") }), slotFor({ target: "totp", label: t.fieldLabel("totp"), placeholder: t.fieldPlaceholder("totp"), mono: true, reveals: !entry?.totp })),
    ],
    card: () => [
      slotFor({ target: "title", label: t.formName, placeholder: t.fieldPlaceholder("cardName") }),
      slotFor({ target: "field", id: "holder", label: t.fieldLabel("holder"), placeholder: t.fieldPlaceholder("holder") }),
      slotFor({ target: "field", id: "number", label: t.fieldLabel("number"), placeholder: t.fieldPlaceholder("number"), secret: true, mono: true, part: "f:number" }),
      div("pair", slotFor({ target: "field", id: "expiry", label: t.fieldLabel("expiry"), placeholder: t.fieldPlaceholder("expiry") }), slotFor({ target: "field", id: "securityCode", label: t.fieldLabel("securityCode"), placeholder: t.fieldPlaceholder("securityCode"), secret: true, mono: true, part: "f:securityCode" })),
    ],
    doc: () => [
      slotFor({ target: "title", label: t.formName, placeholder: t.fieldPlaceholder("docName") }),
      slotFor({ target: "note", label: t.noteLabel, placeholder: t.fieldPlaceholder("optional"), tall: 96, part: "note" }),
    ],
    note: () => [
      slotFor({ target: "title", label: t.formName, placeholder: t.fieldPlaceholder("noteName") }),
      slotFor({ target: "note", label: t.fieldLabel("text"), placeholder: t.fieldPlaceholder("noteText"), tall: 220, part: "note" }),
    ],
    key: () => [
      slotFor({ target: "title", label: t.formName, placeholder: t.fieldPlaceholder("keyName") }),
      slotFor({ target: "field", id: "key", label: t.fieldLabel("key"), placeholder: t.fieldPlaceholder("key"), secret: true, mono: true, tall: 150, part: "f:key" }),
      slotFor({ target: "field", id: "passphrase", label: t.fieldLabel("passphrase"), placeholder: t.fieldPlaceholder("passphrase"), secret: true, mono: true, part: "f:passphrase" }),
    ],
    env: () => [
      slotFor({ target: "title", label: t.fieldLabel("project"), placeholder: t.fieldPlaceholder("project"), hint: t.projectHint, mono: true }),
      h("span", { class: "label" }, t.valuesLabel), valueRows(),
    ],
    custom: () => [
      slotFor({ target: "title", label: t.formName, placeholder: t.fieldPlaceholder("customName") }),
      h("span", { class: "label" }, t.fieldsLabel), valueRows(),
    ],
  };
  /** The rows of an environment entry (a name and a value) or of a custom one (a name, a value and whether it is hidden), with the buttons to add and remove. */
  function valueRows(): HTMLElement {
    const list = div("vrows"), env = kind === "env";
    function add(existing?: FieldView): VRow {
      const secret = env || (existing?.secret ?? true), had = !!existing?.filled && !!existing.secret;
      const name = h("input", { type: "text", name: "field-name", value: existing ? existing.name || existing.id : undefined, placeholder: env ? "API_TOKEN" : t.fieldNameHolder, autocomplete: "off", spellcheck: "false", "aria-label": t.fieldNameHolder, readonly: env && !!existing });
      const value = h("input", { type: secret ? "password" : "text", name: "field-value", value: existing && !existing.secret ? existing.value ?? undefined : undefined, placeholder: had ? DOTS : t.valueHolder, autocomplete: "off", spellcheck: "false", "aria-label": t.valueHolder });
      const row: VRow = { existing, id: existing?.id ?? "", name, value, secret, touched: false, root: div("vrow"), gone: false };
      value.addEventListener("input", () => { row.touched = true; mark(); }); name.addEventListener("input", mark);
      const hide = iconButton(row.secret ? "eyeOff" : "eye", row.secret ? t.hiddenOn : t.hiddenOff, async () => {
        const toShown = row.secret;
        // A hidden value that was never loaded is asked for before it is shown, since showing it is the person's choice.
        if (toShown && existing && had && !row.touched && value.value === "") {
          const result = await bridge.entryReveal({ id: entry!.id, part: `f:${existing.id}` });
          if (!result.ok) { status.replaceChildren(notice("circleAlert", reason(t, result.code), "error")); return; }
          value.value = result.value; row.touched = true;
        }
        row.secret = !toShown; value.type = row.secret ? "password" : "text"; hide.replaceChildren(icon(row.secret ? "eyeOff" : "eye", 16)); hide.setAttribute("aria-label", row.secret ? t.hiddenOn : t.hiddenOff); hide.title = row.secret ? t.hiddenOn : t.hiddenOff; mark();
      });
      const remove = iconButton("x", t.removeValue, () => { row.gone = true; row.root.remove(); mark(); });
      row.root.append(div("input mono w200", name), div(`input mono grow${env ? "" : ""}`, value), ...env ? [] : [hide], remove);
      rows.push(row); list.append(row.root); return row;
    }
    for (const item of entry?.fields ?? []) add(item);
    if (!entry && !rows.length) add();
    const addButton = h("button", { class: "small", type: "button", onclick: () => { const row = add(); mark(); row.name.focus(); } }, icon("plus", 14), h("span", {}, env ? t.addValue : t.addField));
    return div("vlist", list, div("row start", addButton));
  }
  // The other fields of an existing login, card or key (a bank, a licence key) have a line each after the ones the board draws.
  const PLANNED: Partial<Record<Kind, string[]>> = { login: ["username", "password", "website"], card: ["holder", "number", "expiry", "securityCode"], key: ["key", "passphrase"] };
  const extras = (): Child[] => {
    const planned = PLANNED[kind]; if (!planned) return [];
    return (entry?.fields ?? []).filter(item => !planned.includes(item.id) && item.filled).map(item => slotFor({
      target: "field", id: item.id, label: KNOWN_FIELDS[kind]?.includes(item.id) ? t.fieldLabel(item.id) : item.name || item.id, mono: item.secret, part: `f:${item.id}`,
    }));
  };
  const title = entry ? entry.title : t.newTitle(kind);
  const head = div("head", entry ? tile(entry.title, 48) : div("tile s48 kind", icon(KIND_GLYPH[kind], 22)), div("titles", h("h1", { class: "h h20" }, title), h("span", { class: "kind" }, t.kindName(kind))));
  body.append(...[...layout[kind](), ...extras()].filter((node): node is string | Node => node != null && node !== false));
  const save = button(t.save, { primary: true, type: "submit" });
  const foot = div("actions gap", entry ? button(t.deleteEntry, { danger: true, glyph: "trash2", onclick: () => hooks.remove(entry) }) : null, div("fill"), button(t.cancel, { onclick: () => hooks.cancel() }), save);
  const root = h("form", { class: "formpane", novalidate: true }, head, body, status, foot);

  function collect(): EntryInput | undefined {
    status.replaceChildren(); for (const slot of slots) slot.control.error(); let bad = false;
    const result: { title: string; fields: FieldInput[]; note?: string; totp?: string } = { title: "", fields: [] };
    for (const slot of slots) {
      const value = slot.control.input.value, keep = slot.secret && slot.had && !slot.touched;
      if (slot.target === "title") { result.title = value.trim(); if (!result.title) { slot.control.error(t.needName); bad = true; } }
      else if (slot.target === "note") { if (!keep) result.note = value; }
      else if (slot.target === "totp") { if (!keep) result.totp = value.trim(); }
      else result.fields.push(keep ? { id: slot.id, name: slot.name, secret: true } : { id: slot.id, name: slot.name, secret: slot.secret, value });
    }
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.gone) continue;
      const name = row.name.value.trim(), value = row.value.value;
      if (!name && !value && !row.existing) continue;
      if (!name) { status.replaceChildren(notice("circleAlert", t.needName, "error")); row.name.focus(); bad = true; continue; }
      if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { status.replaceChildren(notice("circleAlert", t.badName(name), "error")); row.name.focus(); bad = true; continue; }
      if (seen.has(name.toLowerCase())) { status.replaceChildren(notice("circleAlert", t.sameName(name), "error")); row.name.focus(); bad = true; continue; }
      seen.add(name.toLowerCase());
      const id = kind === "env" ? name : row.existing?.id ?? crypto.randomUUID(), keep = !!row.existing?.secret && row.existing.filled && !row.touched && row.secret;
      result.fields.push(keep ? { id, name, secret: true } : { id, name: kind === "env" ? name : name, secret: kind === "env" ? true : row.secret, value });
    }
    if (bad) return undefined;
    return { id: entry?.id ?? crypto.randomUUID(), kind, title: result.title, favorite: entry?.favorite ?? false, fields: result.fields, ...result.note !== undefined ? { note: result.note } : {}, ...result.totp !== undefined ? { totp: result.totp } : {} };
  }
  root.addEventListener("submit", async event => {
    event.preventDefault(); const input = collect(); if (!input) return;
    const result = await busy(root, () => bridge.entrySave({ entry: input, expected: entry?.version ?? 0 }));
    if (disposed) return;
    if (result.ok) { hooks.saved(input.id); return; }
    if (result.code === "conflict") { status.replaceChildren(notice("circleAlert", t.conflict, "error"), button(t.reload, { onclick: () => hooks.reload() })); return; }
    if (result.code === "project_taken") { slots[0].control.error(t.projectTaken(input.title)); slots[0].control.input.focus(); return; }
    if (result.code === "not_found" && entry) { status.replaceChildren(notice("circleAlert", t.entryGone, "error")); return; }
    status.replaceChildren(notice("circleAlert", reason(t, result.code), "error"));
  });
  root.addEventListener("keydown", event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); hooks.cancel(); } });
  queueMicrotask(() => (slots[0]?.control.input ?? rows[0]?.name)?.focus());
  return { root, dirty: () => dirty, dispose() { disposed = true; closePopovers(); } };
}
