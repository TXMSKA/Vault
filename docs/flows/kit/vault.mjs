// Vault's identity samples: the same app window (the list with one login
// open) and the same unlock card drawn under each direction's own theme, faces
// and corner radii, so only the identity changes from one direction to the
// next. The marks are the `vault-mark` node of ./extra-nodes.mjs. The entries,
// the sites and the person in them are invented.

import { box, col, row, stack, text, icon, fill } from "blueprint/kit.mjs";
import { DIAL, SEAL, KEY } from "./skins.mjs";

export const W = 1440;
export const H = 900;

const WINDOW = { w: 880, h: 600 };
const CARD = { w: 432 };
export const TITLE_H = 36;
export const LIST_W = 300;
// The body of the window sits on one grid: this is the side margin of both panes.
export const PAD = 24;
// Buttons and fields share this height.
export const CONTROL_H = 36;

export const slug = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * What changes between directions besides the colours: the mark, the faces
 * (names the skin resolves), the type sizes and the corner radii.
 */
export const DIRECTIONS = {
  dial: {
    id: "dial",
    name: "Dial",
    kind: "dial",
    theme: DIAL,
    line: "Dial: the combination of a safe, precise and steady.",
    faces: { body: "dial-body", display: "dial-display" },
    type: { body: 14, ui: 13, nameTrack: -0.02 },
    r: { window: 10, control: 8, row: 8, group: 10 },
    note: "Named after the combination dial of a safe: graphite steel with one muted brass accent, Space Grotesk for the name and titles and Inter for reading, medium corners, and a mark that is one circle with the index tick at its top, in one stroke weight. Text clears 4.5:1, the accent 4.5:1 and control borders 3:1 on every surface.",
  },
  seal: {
    id: "seal",
    name: "Seal",
    kind: "seal",
    theme: SEAL,
    line: "Seal: kept like a sealed letter, personal and warm.",
    faces: { body: "seal-body", display: "seal-display" },
    type: { body: 14, ui: 13, nameTrack: 0 },
    r: { window: 16, control: 12, row: 12, group: 14 },
    note: "Named after a letter closed with wax: warm ink brown with one soft sealing-wax red accent and cream text, Lora for the name and titles and Nunito for reading, soft corners, and a mark that is a plain filled keyhole pressed into a wax-red field. Text clears 4.5:1, the accent 4.5:1 and control borders 3:1 on every surface.",
  },
  key: {
    id: "key",
    name: "Key",
    kind: "key",
    theme: KEY,
    line: "Key: the key in your hand, exact and technical.",
    faces: { body: "key-body", display: "key-display" },
    type: { body: 14, ui: 13, nameTrack: -0.01 },
    r: { window: 6, control: 4, row: 4, group: 6 },
    note: "Named after the key itself: deep petrol with one pale aqua accent, JetBrains Mono for the name, titles and every value and DM Sans for reading, tight corners, and a mark that is a plain key (a round bow, the shaft and two teeth) inside a rounded square, in one stroke weight. Text clears 4.5:1, the accent 4.5:1 and control borders 3:1 on every surface.",
  },
};

/** Tom's pick (2026-10-07): Dial's theme, faces and corners, with Seal's keyhole as the mark. */
export const CHOSEN = {
  ...DIRECTIONS.dial,
  id: "chosen",
  name: "Dial with the keyhole",
  kind: "seal",
  line: "Vault: the combination of a safe, with the keyhole as its mark.",
  note: "The direction chosen: Dial's graphite and brass, Space Grotesk and Inter, medium corners, with Seal's plain keyhole as the mark, in brass on the steel field. The app board is drawn in it.",
};

// ---- text and marks ---------------------------------------------------------

/** Text in the direction's own faces; `mono` is for passwords, codes and other values. */
export const type = (d) => ({
  body: (value, props = {}) => text(value, { face: d.faces.body, size: d.type.body, lh: 1.5, color: "text", ...props }),
  ui: (value, props = {}) => text(value, { face: d.faces.body, size: d.type.ui, lh: 1.4, color: "text", ...props }),
  display: (value, props = {}) => text(value, { face: d.faces.display, lh: 1.15, ...props }),
  mono: (value, props = {}) => text(value, { face: "mono", size: 14, lh: 1.4, color: "title", ...props }),
});

/** The bare mark in one colour role, with no field behind it. */
export const mark = (d, size, props = {}) => ({ t: "vault-mark", kind: d.kind, size, ink: "primary", ...props });

/** The app icon: the mark on its field. */
export const appIcon = (d, size, props = {}) => mark(d, size, { tile: "tile", ink: "on-tile", ...props });

// ---- small parts ------------------------------------------------------------

export const controls = (w, h, name) =>
  row(
    { h, name, label: "Minimize, maximize and close" },
    ...["minus", "square", "x"].map((glyph) => stack({ w, h }, icon(glyph, { size: glyph === "square" ? 12 : 14, color: "soft", place: "center" }))),
  );

/** A square icon button with the control's corners; `stroke` outlines it. */
export const iconButton = (d, glyph, { name, label, size = 32, stroke = false, color = "soft" } = {}) =>
  stack(
    { w: size, h: size, radius: d.r.control, stroke: stroke ? "field-line" : undefined, name, label },
    icon(glyph, { size: 16, color, place: "center" }),
  );

/** An entry's monogram: its initial on a quiet square, since the sites are invented and have no icons. */
export const monogram = (d, t, initial, size) =>
  stack(
    { w: size, h: size, radius: d.r.control, fill: "surface-3" },
    t.display(initial, { size: Math.round(size * 0.44), weight: 600, color: "title", place: "center" }),
  );

// ---- the app window ---------------------------------------------------------

function titleBar(d, t) {
  return row(
    { h: TITLE_H, pad: [0, 0, 0, 12], gap: 8, fill: "chrome", edge: { side: "bottom", color: "line" }, name: "title-bar", label: "Title bar" },
    appIcon(d, 20),
    t.ui("Vault", { weight: 600, color: "title" }),
    fill(),
    controls(44, TITLE_H, "window-controls"),
  );
}

export const ENTRIES = [
  { name: "Northwind Mail", sub: "alex.rivera@northwind.example" },
  { name: "Riverbank", sub: "alex.rivera" },
  { name: "Pinewood Forum", sub: "arivera" },
  { name: "Atlas Card", sub: "Card ending 4821" },
  { name: "Home Wi-Fi", sub: "Note" },
  { name: "Sprout deploys", sub: "Environment, 6 values" },
];

export function entryRow(d, t, entry, on) {
  return row(
    { h: 56, pad: [0, 10], gap: 12, radius: d.r.row, fill: on ? "selected" : undefined, name: `entry-${slug(entry.name)}`, label: entry.name },
    monogram(d, t, entry.name[0], 32),
    col(
      { gap: 2, grow: 1 },
      t.ui(entry.name, { weight: 600, color: "title", lines: 1 }),
      t.ui(entry.sub, { size: 12, color: "soft", lines: 1 }),
    ),
  );
}

/** The list pane: search and the add button, then the entries sorted by recent use. */
function listPane(d, t, h) {
  return col(
    { w: LIST_W, h, pad: [PAD, 14], gap: 16, fill: "chrome", edge: { side: "right", color: "line" }, name: "list", label: "Entries" },
    row(
      { gap: 8 },
      row(
        { h: CONTROL_H, grow: 1, pad: [0, 12], gap: 8, radius: d.r.control, fill: "surface-2", stroke: "field-line", name: "search", label: "Search" },
        icon("search", { size: 16, color: "soft" }),
        t.ui("Search Vault", { color: "dim" }),
      ),
      stack(
        { w: CONTROL_H, h: CONTROL_H, radius: d.r.control, fill: "primary", name: "add", label: "Add an entry" },
        icon("plus", { size: 18, stroke: 2.4, color: "on-primary", place: "center" }),
      ),
    ),
    row({ pad: [0, 10] }, t.ui("All entries", { size: 12, weight: 600, color: "soft" }), fill(), t.ui("128", { size: 12, color: "soft" })),
    col({ gap: 2 }, ...ENTRIES.map((entry, i) => entryRow(d, t, entry, i === 0))),
  );
}

/** One line of the open entry: label over value, its actions on the right. */
export function entryField(d, t, { label, value, mono = false, accent = false, actions = [], trail }) {
  return row(
    { h: 64, pad: [0, 16], gap: 12, name: `field-${slug(label)}`, label },
    col(
      { gap: 4, grow: 1 },
      t.ui(label, { size: 12, weight: 500, color: "soft" }),
      mono ? t.mono(value, { color: accent ? "primary" : "title", weight: accent ? 600 : 400 }) : t.body(value, { color: "title", lines: 1 }),
    ),
    trail ?? null,
    ...actions.map((glyph) => iconButton(d, glyph, { name: `${slug(label)}-${slug(glyph)}`, label: glyph === "copy" ? `Copy ${label.toLowerCase()}` : glyph === "eye" ? "Reveal" : "Open website" })),
  );
}

export const divider = () => box({ h: 1, fill: "line" });

/** The open entry: its name and kind, then its fields in one bordered group. */
function detailPane(d, t, w, h) {
  return col(
    { w, h, pad: PAD, gap: 20, fill: "surface", name: "entry", label: "Open entry" },
    row(
      { gap: 14 },
      monogram(d, t, "N", 48),
      col({ gap: 2, grow: 1 }, t.display("Northwind Mail", { size: 20, weight: 600, color: "title" }), t.ui("Login", { color: "soft" })),
      row(
        { h: 32, pad: [0, 12], gap: 6, radius: d.r.control, stroke: "field-line", name: "edit", label: "Edit" },
        icon("pencil", { size: 14, color: "text" }),
        t.ui("Edit", { weight: 500, color: "title" }),
      ),
    ),
    col(
      { radius: d.r.group, stroke: "line", name: "fields", label: "Fields" },
      entryField(d, t, { label: "Username", value: "alex.rivera@northwind.example", actions: ["copy"] }),
      divider(),
      entryField(d, t, { label: "Password", value: "•".repeat(14), mono: true, actions: ["eye", "copy"] }),
      divider(),
      entryField(d, t, {
        label: "One-time code",
        value: "284 913",
        mono: true,
        accent: true,
        trail: t.ui("18 s", { color: "soft", name: "code-timer", label: "Seconds left" }),
        actions: ["copy"],
      }),
      divider(),
      entryField(d, t, { label: "Website", value: "northwind.example", actions: ["externalLink"] }),
    ),
    row({ gap: 8 }, icon("clock", { size: 14, color: "soft" }), t.ui("Copied values clear from the clipboard after 30 seconds.", { size: 12, color: "soft" })),
  );
}

/** Vault's window on its list, one login open, 880 by 600. */
export function vaultWindow(d) {
  const t = type(d);
  const { w, h } = WINDOW;
  const bodyH = h - TITLE_H;
  return stack(
    { w, h, radius: d.r.window, clip: true, name: "window", label: "Vault app window" },
    col({ w, h }, titleBar(d, t), row({ h: bodyH }, listPane(d, t, bodyH), detailPane(d, t, w - LIST_W, bodyH))),
    // The edge is drawn over the content: the bars and the pane are filled and would hide it underneath.
    box({ w, h, radius: d.r.window, stroke: "line", place: { x: 0, y: 0 } }),
  );
}

// ---- the unlock card --------------------------------------------------------

/** The unlock card, 432 wide: master password, then Windows Hello and the recovery key. */
export function unlockCard(d) {
  const t = type(d);
  return col(
    { w: CARD.w, pad: 28, gap: 16, radius: d.r.window, fill: "surface", stroke: "line", name: "unlock", label: "Unlock card" },
    col(
      { gap: 6 },
      t.display("Unlock Vault", { size: 20, weight: 600, color: "title" }),
      t.ui("One unlock opens Vault in every Cosmic app.", { color: "soft" }),
    ),
    row(
      { h: CONTROL_H + 4, pad: [0, 4, 0, 14], gap: 8, radius: d.r.control, fill: "surface-2", stroke: "field-line", name: "master-password", label: "Master password" },
      t.mono("•".repeat(16), { grow: 1 }),
      iconButton(d, "eye", { name: "reveal", label: "Reveal", size: 32 }),
    ),
    stack(
      { h: CONTROL_H + 4, radius: d.r.control, fill: "primary", name: "unlock-button", label: "Unlock" },
      t.ui("Unlock", { size: 14, weight: 600, color: "on-primary", place: "center" }),
    ),
    row(
      { gap: 16 },
      row(
        { h: CONTROL_H, pad: [0, 12], gap: 8, radius: d.r.control, stroke: "field-line", name: "windows-hello", label: "Use Windows Hello" },
        icon("fingerprint", { size: 16, color: "text" }),
        t.ui("Windows Hello", { weight: 500, color: "title" }),
      ),
      fill(),
      // The kit's text has no underline, so the link's underline is a rule under it.
      col({ gap: 1, name: "recovery", label: "Use recovery key" }, t.ui("Use recovery key", { weight: 500, color: "primary" }), box({ h: 1, fill: "primary" })),
    ),
  );
}

// ---- the direction's screen -------------------------------------------------

/** One direction on a 1440 by 900 screen: the window on the left, the icon, the name and the unlock card on the right. */
export function directionScreen(d) {
  const t = type(d);
  return stack(
    { w: W, h: H, fill: "canvas", theme: d.theme, clip: true, name: `${d.id}-screen`, label: `${d.name} direction` },
    row(
      { w: W, h: H, pad: [150, 48], gap: 32 },
      vaultWindow(d),
      col(
        { w: CARD.w, h: WINDOW.h, justify: "between" },
        col(
          { gap: 24 },
          row(
            { gap: 24, name: "logo", label: "App icon and name" },
            appIcon(d, 144, { name: "app-icon", label: "App icon" }),
            t.display("Vault", { size: 80, weight: 600, color: "title", track: d.type.nameTrack }),
          ),
          t.body(d.line, { size: 16, color: "text", name: "direction-line", label: "Direction and idea" }),
        ),
        unlockCard(d),
      ),
    ),
  );
}
