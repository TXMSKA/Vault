import type { EntryView, FieldView } from "../shared/api.js";
import { div, h } from "./dom.ts";
import { icon } from "./icons.ts";
import type { IconName } from "./icons.ts";
import { fieldTitle, ordered } from "./kinds.ts";
import { iconButton } from "./parts.ts";
import { codeGroups, initial } from "./text.ts";
import { bridge } from "./ui.ts";
import type { Context } from "./ui.ts";
export type EntryHooks = {
  edit(): void;
  favourite(favorite: boolean): void;
  toast(text: string, glyph?: IconName): void;
  /** A call failed; the code says why. */
  failed(code: string): void;
};
export type EntryPane = { root: HTMLElement; dispose(): void };
const DOTS = "•".repeat(14);
/** The tile of an entry: its first letter on a quiet square. */
export const tile = (title: string, size: 32 | 48) => div(`tile s${size}`, h("span", {}, initial(title)));
type Row = { label: string; part?: string; secret: boolean; text?: string; mono?: boolean; block?: boolean; site?: boolean };
/**
 * An open entry, as the board draws it: its head with the favourite star and Edit, its fields in one bordered group, and a line about the clipboard. A secret field
 * shows dots until the person reveals it, which fetches the value for that one field; copying never shows it. A login's one-time code is asked for as
 * a code and shown with the seconds it has left. Nothing here keeps a value once the pane is replaced.
 */
export function entryPane({ t }: Context, entry: EntryView, hooks: EntryHooks): EntryPane {
  let disposed = false, timer: number | undefined;
  const copy = async (label: string, part: string) => {
    const result = await bridge.entryCopy({ id: entry.id, part });
    if (result.ok) hooks.toast(t.copied(label)); else hooks.failed(result.code);
  };
  const rowFor = (spec: Row): HTMLElement => {
    let shown: string | undefined;
    const value = h("div", { class: "value selectable" }), actions: HTMLElement[] = [];
    const paint = () => {
      value.textContent = shown ?? (spec.secret ? DOTS : spec.text ?? "");
      value.className = `value selectable${spec.mono || spec.secret ? " mono" : ""}${spec.block && shown !== undefined ? " block" : ""}`;
    };
    if (spec.secret && spec.part) {
      const part = spec.part, eye = iconButton("eye", t.reveal, async () => {
        if (shown !== undefined) shown = undefined;
        else { const result = await bridge.entryReveal({ id: entry.id, part }); if (!result.ok) { hooks.failed(result.code); return; } shown = result.value; }
        const on = shown !== undefined; eye.replaceChildren(icon(on ? "eyeOff" : "eye", 16)); eye.setAttribute("aria-label", on ? t.hide : t.reveal); eye.title = on ? t.hide : t.reveal; eye.setAttribute("aria-pressed", String(on)); paint();
      });
      eye.setAttribute("aria-pressed", "false"); actions.push(eye);
    }
    if (spec.site) actions.push(iconButton("externalLink", t.openWebsite, async () => { const result = await bridge.entryOpenSite({ id: entry.id }); if (!result.ok) hooks.failed(result.code); }));
    if (spec.part) { const part = spec.part; actions.push(iconButton("copy", t.copyField(spec.label), () => { void copy(spec.label, part); })); }
    paint();
    return div("frow", div("fcopy", h("span", { class: "label" }, spec.label), value), ...actions);
  };
  const fieldRow = (field: FieldView, mono = false): Row => ({ label: fieldTitle(t, entry.kind, field), part: `f:${field.id}`, secret: field.secret, text: field.value ?? "", mono: mono || field.id === "key", block: field.id === "key", site: field.id === "website" });
  const rows: HTMLElement[] = [];
  const shownFields = ordered(entry).filter(field => field.filled);
  for (const field of shownFields) {
    rows.push(rowFor(fieldRow(field, entry.kind === "env")));
    if (entry.kind === "login" && field.id === "password" && entry.totp) rows.push(codeRow());
  }
  if (entry.kind === "login" && entry.totp && !shownFields.some(field => field.id === "password")) rows.unshift(codeRow());
  for (const file of entry.files) rows.push(div("frow file", icon(file.type === "application/zip" ? "fileArchive" : "fileText", 18), div("fcopy", h("span", { class: "value selectable" }, file.name)), h("span", { class: "dim" }, t.kb(file.size))));
  if (entry.note.filled) rows.push(rowFor({ label: entry.kind === "note" ? t.fieldLabel("text") : t.noteLabel, part: "note", secret: true, block: true }));
  function codeRow(): HTMLElement {
    let code: string | undefined, expires = 0, bad = false, fetching = false;
    const value = h("div", { class: "value mono accent selectable" }, `${"•".repeat(3)} ${"•".repeat(3)}`), seconds = h("span", { class: "seconds" }, "");
    seconds.setAttribute("aria-label", t.secondsAria);
    const paint = () => {
      if (bad) { value.className = "value"; value.textContent = t.codeInvalid; seconds.textContent = ""; return; }
      if (code) { value.textContent = codeGroups(code); seconds.textContent = t.secondsLeft(Math.max(0, Math.ceil((expires - Date.now()) / 1000))); }
    };
    const fetchCode = async () => {
      fetching = true; const result = await bridge.entryCode({ id: entry.id }); fetching = false;
      if (disposed) return;
      if (result.ok) { code = result.code; expires = Date.now() + result.remaining * 1000; bad = false; } else { code = undefined; bad = true; }
      paint();
    };
    void fetchCode();
    // Once a second the seconds go down; at zero the next code is asked for.
    timer ??= window.setInterval(() => { if (code) { paint(); if (!fetching && Date.now() >= expires) void fetchCode(); } }, 1000);
    const label = t.oneTimeCode;
    return div("frow", div("fcopy", h("span", { class: "label" }, label), value), seconds, iconButton("copy", t.copyField(label), async () => {
      const result = await bridge.entryCopyCode({ id: entry.id });
      if (result.ok) hooks.toast(t.copied(label)); else hooks.failed(result.code);
    }));
  }
  const star = iconButton("star", entry.favorite ? t.removeFavourite : t.addFavourite, () => hooks.favourite(!entry.favorite));
  star.classList.toggle("on", entry.favorite); star.setAttribute("aria-pressed", String(entry.favorite));
  const edit = h("button", { class: "small", type: "button", onclick: () => hooks.edit() }, icon("pencil", 14), h("span", {}, t.edit));
  const root = div("entry",
    div("head", tile(entry.title, 48), div("titles", h("h1", { class: "h h20 selectable" }, entry.title), h("span", { class: "kind" }, t.kindName(entry.kind))), star, edit),
    rows.length ? div("group", ...rows) : null,
    div("clip", icon("clock", 14), h("span", {}, t.clipboardNote)));
  return { root, dispose() { disposed = true; if (timer !== undefined) clearInterval(timer); timer = undefined; } };
}
