// The pieces of Vault's app screens (the app board), drawn in the chosen
// direction: Dial's theme, faces and corners with the keyhole as the mark.
// The window chrome, the entry rows, the entry fields and the monograms are
// shared with the identity board and live in ./vault.mjs. Every screen takes
// a theme, DIAL or DIAL_LIGHT, so the light screens reuse the same pieces.

import { box, col, row, stack, icon, fill } from "blueprint/kit.mjs";
import { CHOSEN, CONTROL_H, PAD, TITLE_H, LIST_W, slug, type, appIcon, controls, iconButton, monogram, entryRow } from "./vault.mjs";
import { DIAL } from "./skins.mjs";

export const d = CHOSEN;
export const t = type(d);

/**
 * Vault is looked at for a moment, beside the app the password is for: find,
 * copy, close. Two panes (the list and the open entry) need about 920 pixels;
 * the height shows eight entries without scrolling.
 */
export const SIZE = { w: 920, h: 640 };
export const BODY_H = SIZE.h - TITLE_H;
const DETAIL_W = SIZE.w - LIST_W;

// ---- text -------------------------------------------------------------------

/** A small label above a group or a field. */
export const label = (value, props = {}) => t.ui(value, { size: 12, weight: 600, color: "soft", ...props });

/** The name of a thing in a list or a setting. */
export const strong = (value, props = {}) => t.body(value, { weight: 600, color: "title", ...props });

/** A title inside the window. */
export const heading = (value, props = {}) => t.display(value, { size: 20, weight: 600, color: "title", ...props });

/** A line with a leading icon; `tone` colours the icon (soft, primary or error). */
export const notice = (glyph, value, { tone = "soft", ...props } = {}) =>
  row({ gap: 10, align: "start", ...props }, icon(glyph, { size: 16, color: tone }), col({ grow: 1 }, t.ui(value, { color: "text" })));

// ---- controls ---------------------------------------------------------------

/** A button: `primary` fills it with the accent, `danger` writes it in the error colour, the rest are outlined. */
export function button(value, { primary = false, danger = false, glyph, h = CONTROL_H, w, grow, ref } = {}) {
  const ink = primary ? "on-primary" : danger ? "error" : "title";
  return row(
    { w, grow, h, pad: [0, 16], gap: 8, radius: d.r.control, justify: "center", fill: primary ? "primary" : undefined, stroke: primary ? undefined : "field-line", name: ref ?? slug(value), label: value },
    glyph ? icon(glyph, { size: 16, color: ink }) : null,
    t.ui(value, { weight: 600, color: ink }),
  );
}

/** A link: accent text over a rule, since the kit's text has no underline. */
export const link = (value, ref) => col({ gap: 1, self: "start", name: ref ?? slug(value), label: value }, t.ui(value, { weight: 500, color: "primary" }), box({ h: 1, fill: "primary" }));

/**
 * A text field. `mono` sets the value in the mono face (passwords, keys),
 * `focus` draws the focused border in the accent, `error` in the error colour,
 * `trail` adds controls at its right end.
 */
export function input(value, { placeholder, glyph, w, grow, ref, title, mono = false, focus = false, error = false, trail = [] } = {}) {
  const shown = value ?? placeholder;
  const look = { color: value ? "title" : "dim", lines: 1, grow: 1 };
  return row(
    { w, grow, h: CONTROL_H + 4, pad: [0, trail.length ? 4 : 12, 0, 12], gap: 8, radius: d.r.control, fill: "surface-2", stroke: error ? "error" : focus ? "primary" : "field-line", strokeWidth: focus || error ? 2 : 1, name: ref, label: title ?? shown },
    glyph ? icon(glyph, { size: 16, color: "soft" }) : null,
    mono && value ? t.mono(shown, look) : t.ui(shown, { size: 14, ...look }),
    ...trail,
  );
}

/** A field with its label above and an optional hint or error below. */
export function formField(name, control, { hint, error } = {}) {
  return col(
    { gap: 6 },
    label(name),
    control,
    error ? notice("circleAlert", error, { tone: "error" }) : hint ? t.ui(hint, { size: 12, color: "soft" }) : null,
  );
}

/** A select: the value on the left, the chevron at the right edge, as tall and as wide as the other fields. */
export function select(value, { w, grow, ref, title, open = false } = {}) {
  return row(
    { w, grow, h: CONTROL_H + 4, pad: [0, 12], gap: 8, radius: d.r.control, fill: "surface-2", stroke: open ? "primary" : "field-line", strokeWidth: open ? 2 : 1, name: ref, label: title ?? value },
    t.ui(value, { size: 14, color: "title", grow: 1 }),
    icon("chevronDown", { size: 16, color: "soft" }),
  );
}

/** A switch; the knob sits right and the track fills with the accent when on. */
export const toggle = (on, { ref, title } = {}) =>
  stack(
    { w: 40, h: 24, radius: "pill", fill: on ? "primary" : "surface-3", stroke: on ? undefined : "field-line", name: ref, label: title },
    box({ w: 18, h: 18, radius: "pill", fill: on ? "on-primary" : "soft", place: { x: on ? 19 : 3, y: 3 } }),
  );

/** A checkbox with its text. */
export const checkbox = (on, value, ref) =>
  row(
    { gap: 10, name: ref ?? slug(value), label: value },
    stack(
      { w: 18, h: 18, radius: 4, fill: on ? "primary" : undefined, stroke: on ? undefined : "field-line" },
      on ? icon("check", { size: 14, stroke: 3, color: "on-primary", place: "center" }) : null,
    ),
    t.ui(value, { size: 14, color: "title" }),
  );

/** A radio row: a ring, filled in the accent when chosen, the name and a line under it. */
export function choice(on, title, line, ref) {
  return row(
    { pad: 16, gap: 14, align: "start", radius: d.r.group, stroke: on ? "primary" : "line", strokeWidth: on ? 2 : 1, fill: on ? "selected" : undefined, name: ref ?? slug(title), label: title },
    stack(
      { w: 18, h: 18, radius: "pill", stroke: on ? "primary" : "field-line", strokeWidth: 2 },
      on ? box({ w: 8, h: 8, radius: "pill", fill: "primary", place: "center" }) : null,
    ),
    col({ gap: 4, grow: 1 }, strong(title), t.ui(line, { color: "soft" })),
  );
}

// ---- overlays ---------------------------------------------------------------

/**
 * An open list under a control: theme colours, inset rounded rows, the chosen
 * one marked with a check. Each item is `{ label, line, hint, glyph, on, ref }`
 * or "rule"; a `line` says what the option does, a `hint` is a count or a key. `at` places it in the window.
 */
export function menu(items, { w = 260, at, name = "menu", title = "Menu" } = {}) {
  return col(
    { w, pad: 6, gap: 2, radius: d.r.control + 2, fill: "surface-2", stroke: "line-strong", place: at, name, label: title },
    ...items.map((item) =>
      item === "rule"
        ? box({ h: 1, fill: "line" })
        : row(
            { pad: [item.line ? 8 : 0, 10], h: item.line ? undefined : 36, gap: 10, align: item.line ? "start" : "center", radius: d.r.control, fill: item.hover ? "surface-3" : undefined, name: item.ref ?? slug(item.label), label: item.label },
            item.glyph ? icon(item.glyph, { size: 16, color: item.tone ?? "soft" }) : null,
            col({ gap: 2, grow: 1 }, t.ui(item.label, { size: 14, weight: 500, color: item.tone ?? "title" }), item.line ? t.ui(item.line, { size: 12, color: "soft" }) : null),
            item.hint ? t.ui(item.hint, { size: 12, color: "soft" }) : null,
            item.on ? icon("check", { size: 16, color: "primary" }) : null,
          ),
    ),
  );
}

/** The dim over the window behind a dialog. */
const scrim = () => box({ w: SIZE.w, h: BODY_H, fill: "overlay", place: { x: 0, y: TITLE_H } });

/** A dialog centred over the window: its title, its body and its buttons, right aligned, with an optional `lead` at the left. */
export function dialog({ title, w = 440, name = "dialog", lead }, body, actions) {
  return [
    scrim(),
    col(
      { w, pad: 24, gap: 18, radius: d.r.window, fill: "surface", stroke: "line-strong", place: "center", name, label: title },
      heading(title, { size: 18 }),
      ...body,
      row({ gap: 10 }, lead ?? null, fill(), ...actions),
    ),
  ];
}

/** A toast at the foot of the open-entry pane, clear of the list: a message, an optional action and a close button. */
export function toast(value, { action, glyph = "check" } = {}) {
  return row(
    { w: 420, h: 48, pad: [0, 6, 0, 16], gap: 12, radius: d.r.control + 2, fill: "surface-3", stroke: "line-strong", place: "bottom-right", dx: -(DETAIL_W - 420) / 2, dy: -20, name: "toast", label: "Toast" },
    icon(glyph, { size: 16, color: "primary" }),
    t.ui(value, { size: 14, color: "title", grow: 1 }),
    action ? row({ h: 32, pad: [0, 12], radius: d.r.control, name: `toast-${slug(action)}`, label: action }, t.ui(action, { weight: 600, color: "primary" })) : null,
    iconButton(d, "x", { name: "toast-close", label: "Close", size: 32 }),
  );
}

// ---- the window -------------------------------------------------------------

/** The title bar. Unlocked, it carries Lock and the menu; locked and during setup it has neither. */
function titleBar({ locked = false, menuOpen = false } = {}) {
  return row(
    { h: TITLE_H, pad: [0, 0, 0, 12], gap: 8, fill: "chrome", edge: { side: "bottom", color: "line" }, name: "title-bar", label: "Title bar" },
    appIcon(d, 20),
    t.ui("Vault", { weight: 600, color: "title" }),
    fill(),
    locked
      ? null
      : row(
          { gap: 4 },
          row({ h: 28, pad: [0, 10], gap: 6, radius: d.r.control, name: "lock", label: "Lock Vault now" }, icon("lock", { size: 14, color: "text" }), t.ui("Lock", { weight: 500, color: "title" })),
          stack({ w: 28, h: 28, radius: d.r.control, fill: menuOpen ? "surface-3" : undefined, name: "menu-button", label: "Menu" }, icon("ellipsis", { size: 16, color: "text", place: "center" })),
        ),
    box({ w: 8 }),
    controls(44, TITLE_H, "window-controls"),
  );
}

/**
 * One screen of the app: the window, its title bar and its body, then any
 * overlays (menus, dialogs, toasts) placed over it. `theme` is DIAL or DIAL_LIGHT.
 */
export function appWindow({ theme = DIAL, locked, menuOpen } = {}, body, overlays = []) {
  const { w, h } = SIZE;
  return stack(
    { w, h, radius: d.r.window, clip: true, fill: "surface", theme, name: "window", label: "Vault window" },
    col({ w, h }, titleBar({ locked, menuOpen }), body),
    ...overlays.flat().filter(Boolean),
    // The edge is drawn over the content: the bars and the panes are filled and would hide it underneath.
    box({ w, h, radius: d.r.window, stroke: "line", place: { x: 0, y: 0 } }),
  );
}

/** A full-width view of the body (setup, unlock, Apps, Import, Export, Settings). */
export const view = (props, ...kids) => col({ w: SIZE.w, h: BODY_H, fill: "surface", ...props }, ...kids);

/** A centred column inside a view, for setup and unlock. */
export const centred = (w, ...kids) => view({ align: "center", justify: "center" }, col({ w, gap: 20 }, ...kids));

/** The head of a secondary view: back to the list, its title, optional controls at the right. */
export function sectionHead(title, ...trail) {
  return row(
    { h: 56, pad: [0, PAD, 0, 12], gap: 8, edge: { side: "bottom", color: "line" }, name: "section-head", label: title },
    stack({ w: 32, h: 32, radius: d.r.control, name: "back", label: "Back to the list" }, icon("arrowLeft", { size: 18, color: "text", place: "center" })),
    heading(title, { size: 18 }),
    fill(),
    ...trail,
  );
}

/** The body of a secondary view under its head. */
export const page = (...kids) => col({ grow: 1, pad: [24, PAD, PAD], gap: 20 }, ...kids);

/** A setting: its name and what it does on the left, its control on the right. */
export function setting(title, line, control, ref) {
  return row(
    { pad: [14, 0], gap: 24, edge: { side: "bottom", color: "line" }, name: ref ?? slug(title), label: title },
    col({ gap: 4, grow: 1 }, strong(title), t.ui(line, { color: "soft" })),
    control,
  );
}

// ---- the list ---------------------------------------------------------------

/** The search field and the add button at the top of the list. */
function listTop({ search, focus, addOpen }) {
  return row(
    { gap: 8 },
    row(
      { h: CONTROL_H, grow: 1, pad: [0, 12], gap: 8, radius: d.r.control, fill: "surface-2", stroke: focus ? "primary" : "field-line", strokeWidth: focus ? 2 : 1, name: "search", label: "Search" },
      icon("search", { size: 16, color: "soft" }),
      t.ui(search ?? "Search Vault", { size: 14, color: search ? "title" : "dim", grow: 1 }),
      search ? icon("x", { size: 14, color: "soft" }) : null,
    ),
    stack(
      { w: CONTROL_H, h: CONTROL_H, radius: d.r.control, fill: addOpen ? "primary-hover" : "primary", name: "add", label: "Add an entry" },
      icon("plus", { size: 18, stroke: 2.4, color: "on-primary", place: "center" }),
    ),
  );
}

/** The kind filter: a quiet select-like button over the list, with the count. */
function filterRow({ filter, count, open }) {
  return row(
    { pad: [0, 4, 0, 10], gap: 8 },
    row(
      { h: 28, pad: [0, 8], gap: 6, radius: d.r.control, fill: open ? "surface-3" : undefined, name: "filter", label: `Show: ${filter}` },
      t.ui(filter, { size: 12, weight: 600, color: "title" }),
      icon("chevronDown", { size: 14, color: "soft" }),
    ),
    fill(),
    t.ui(String(count), { size: 12, color: "soft" }),
  );
}

/**
 * The list pane: search and add, the kind filter, then the entries sorted by
 * recent use. `selected` is the index of the open entry, or none.
 */
export function listPane({ entries, selected = 0, search, focus, filter = "All entries", count = 128, filterOpen, addOpen, empty } = {}) {
  return col(
    { w: LIST_W, h: BODY_H, pad: [PAD, 14], gap: 16, fill: "chrome", edge: { side: "right", color: "line" }, name: "list", label: "Entries" },
    listTop({ search, focus, addOpen }),
    empty ? null : filterRow({ filter, count, open: filterOpen }),
    empty ? empty : col({ gap: 2 }, ...entries.map((entry, i) => entryRow(d, t, entry, i === selected))),
  );
}

/** The right pane: whatever is open, or a quiet line when nothing is. */
export const detail = (...kids) => col({ w: DETAIL_W, h: BODY_H, pad: PAD, gap: 20, fill: "surface", name: "entry", label: "Open entry" }, ...kids);

/** The head of an open entry: its monogram, name and kind, and its actions. */
export function entryHead(name, kind, ...actions) {
  return row(
    { gap: 14 },
    monogram(d, t, name[0], 48),
    col({ gap: 2, grow: 1 }, t.display(name, { size: 20, weight: 600, color: "title" }), t.ui(kind, { color: "soft" })),
    ...actions,
  );
}

/** The head of a new entry: the kind's icon in place of a monogram, since the entry has no name yet. */
export function kindHead(title, kind, glyph) {
  return row(
    { gap: 14 },
    stack({ w: 48, h: 48, radius: d.r.control, fill: "surface-3" }, icon(glyph, { size: 22, color: "text", place: "center" })),
    col({ gap: 2, grow: 1 }, t.display(title, { size: 20, weight: 600, color: "title" }), t.ui(kind, { color: "soft" })),
  );
}

/** A small outlined button with an icon, for the head of an entry. */
export const smallButton = (glyph, value, ref) =>
  row({ h: 32, pad: [0, 12], gap: 6, radius: d.r.control, stroke: "field-line", name: ref ?? slug(value), label: value }, icon(glyph, { size: 14, color: "text" }), t.ui(value, { weight: 500, color: "title" }));

/** The group that holds an entry's fields. */
export const fieldGroup = (...kids) => col({ radius: d.r.group, stroke: "line", name: "fields", label: "Fields" }, ...kids);

export { iconButton, monogram, CONTROL_H, PAD, slug, appIcon };
