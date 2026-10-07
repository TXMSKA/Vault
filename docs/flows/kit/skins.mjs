// Vault's look on the boards. Vault has no product tokens yet: these three
// dark themes are the directions of the identity board, and each screen picks
// one through its `theme` prop. Tom chose Dial with Seal's keyhole as the mark
// (2026-10-07); DIAL_LIGHT is its light theme, designed on its own. Every text role clears 4.5:1 on the surfaces it
// sits on, the accent clears 4.5:1 on the window's surfaces, and `field-line`
// (the border of a control) clears 3:1 on every surface of the theme (checked
// by computing the WCAG ratio of each pair).
//
// Besides the kit's roles, each theme names `field-line` (the border of a
// field or a control), `selected` (the open row of a list), `tile` and `on-tile` (the app icon's field and the
// colour of the mark on it).
//
// Faces are named per direction, so one skin draws all three: `dial-*`,
// `seal-*` and `key-*`, plus the shared `mono` of passwords and codes. A
// text node asks for them with `face`.

import { PLAIN, SANS, pick, skinDefs as baseDefs } from "blueprint/skins.mjs";

/**
 * Dial: the combination dial of a safe. Graphite steel with a faint cool
 * tint, one muted brass accent. Steps between surfaces are small, so the
 * outlines of the controls carry the structure.
 */
export const DIAL = {
  ...PLAIN,
  canvas: "#0b0d10", // the floor behind the windows
  chrome: "#111419", // title bar and list pane
  surface: "#161a20", // the window body
  "surface-2": "#1e232b", // fields, the selected row
  "surface-3": "#29303a", // the chosen option of a segmented control
  selected: "#1e232b", // the open row of a list
  glass: "#161a20",
  hover: "#1a1f26",
  "border-subtle": "#262c35",
  line: "#262c35", // dividers and window edges
  "line-strong": "#36404c",
  frame: "#6f7a89",
  "field-line": "#6f7a89", // border of a field or a control, 3:1 or more on every surface
  title: "#f1f3f5", // titles and the main text of a surface
  text: "#dde1e6", // body text
  soft: "#a8b0ba", // labels and secondary text
  dim: "#959ea9", // placeholders
  primary: "#d6b46e", // the accent: muted brass
  "primary-hover": "#e2c587",
  "on-primary": "#1a1408", // text and icons on the accent
  wash: "#1e232b",
  "on-wash": "#f1f3f5",
  "primary-border": "#6f7a89",
  accent: "#d6b46e",
  tile: "#232a33", // the app icon's field: brushed steel
  "on-tile": "#d6b46e", // the brass dial on it
  overlay: "rgba(6, 7, 9, 0.66)", // the dim behind a dialog
  // PLAIN's error is a light-theme red; this one clears 4.5:1 on every surface.
  error: "#f0968b",
  "error-wash": "#2a1a1a",
};

/**
 * Seal: a letter closed with wax. Warm ink brown, one soft sealing-wax red
 * accent, cream text.
 */
export const SEAL = {
  ...PLAIN,
  canvas: "#120d0c",
  chrome: "#19120f",
  surface: "#1f1714",
  "surface-2": "#2a201c",
  "surface-3": "#362a25",
  selected: "#2a201c",
  glass: "#1f1714",
  hover: "#251c18",
  "border-subtle": "#3a2d27",
  line: "#3a2d27",
  "line-strong": "#4e3d35",
  frame: "#937d71",
  "field-line": "#937d71",
  title: "#f6ede6",
  text: "#eadfd7",
  soft: "#c4b2a7",
  dim: "#b09e93",
  primary: "#e8907d", // sealing wax, softened: never a saturated orange
  "primary-hover": "#efa695",
  "on-primary": "#1e0e0a",
  wash: "#2a201c",
  "on-wash": "#f6ede6",
  "primary-border": "#937d71",
  accent: "#e8907d",
  tile: "#7a2f26", // the app icon's field: the wax itself
  "on-tile": "#f6ede6", // the keyhole pressed into it
  overlay: "rgba(10, 6, 5, 0.66)",
  error: "#f2a093",
  "error-wash": "#2e1a17",
};

/**
 * Key: the key in the hand. Deep petrol, one pale aqua accent, mono for the
 * name and for every value.
 */
export const KEY = {
  ...PLAIN,
  canvas: "#061112",
  chrome: "#0a1718",
  surface: "#0e1c1e",
  "surface-2": "#142628",
  "surface-3": "#1d3336",
  selected: "#142628",
  glass: "#0e1c1e",
  hover: "#112123",
  "border-subtle": "#1d3134",
  line: "#1d3134",
  "line-strong": "#2a4447",
  frame: "#62858a",
  "field-line": "#62858a",
  title: "#ecf6f5",
  text: "#d4e5e3",
  soft: "#9cb8b5",
  dim: "#89a6a3",
  primary: "#7fd3c9", // pale aqua
  "primary-hover": "#9fe0d8",
  "on-primary": "#04201d",
  wash: "#142628",
  "on-wash": "#ecf6f5",
  "primary-border": "#62858a",
  accent: "#7fd3c9",
  tile: "#0f2a2c",
  "on-tile": "#7fd3c9",
  overlay: "rgba(3, 9, 10, 0.66)",
  error: "#f29a8f",
  "error-wash": "#2a1a19",
};

/**
 * Dial's light theme, built as the counterpart of the dark one, never by
 * inverting it: a dim cool grey floor with no surface near white, fields a
 * step lighter than the window, the open row a step darker, and the brass
 * deepened until it clears 4.5:1 as text. The app icon keeps its dark steel
 * field in both themes.
 */
export const DIAL_LIGHT = {
  ...DIAL,
  canvas: "#cfd3d8",
  chrome: "#dde0e4",
  surface: "#e6e8eb",
  "surface-2": "#eef0f2",
  "surface-3": "#d3d7dc",
  selected: "#d8dce1",
  glass: "#e6e8eb",
  hover: "#e0e3e6",
  "border-subtle": "#cdd1d6",
  line: "#c4c9cf",
  "line-strong": "#aab1b9",
  frame: "#68717d",
  "field-line": "#68717d",
  title: "#1b1f24",
  text: "#2a3038",
  soft: "#47505b",
  dim: "#505a65",
  primary: "#76591b",
  "primary-hover": "#664c15",
  "on-primary": "#f4efe4",
  wash: "#d8dce1",
  "on-wash": "#1b1f24",
  "primary-border": "#68717d",
  accent: "#76591b",
  overlay: "rgba(40, 44, 50, 0.38)",
  error: "#97372f",
  "error-wash": "#ecdcd9",
};

// The chosen theme is the layer's default; the identity board's screens still
// pick their own theme through `theme`.
const DESIGN = DIAL;

// The families are declared in theme.css. Each direction has a display face and
// a body face; the mono of passwords and codes is shared.
const STACK = {
  inter: '"Vault Inter", system-ui, sans-serif',
  dmsans: '"Vault DM Sans", system-ui, sans-serif',
  grotesk: '"Vault Space Grotesk", system-ui, sans-serif',
  lora: '"Vault Lora", Georgia, serif',
  nunito: '"Vault Nunito", system-ui, sans-serif',
  mono: '"Vault Mono", ui-monospace, Consolas, monospace',
};

const FACES = {
  body: STACK.inter,
  display: STACK.grotesk,
  mono: STACK.mono,
  "dial-body": STACK.inter, // Dial: Inter for reading
  "dial-display": STACK.grotesk, // Dial: Space Grotesk for the name and titles
  "seal-body": STACK.nunito, // Seal: Nunito, rounded and warm
  "seal-display": STACK.lora, // Seal: Lora, a calm book serif
  "key-body": STACK.dmsans, // Key: DM Sans for reading
  "key-display": STACK.mono, // Key: JetBrains Mono for the name and titles
};

export const skins = {
  design: {
    id: "design",
    shadow: false, // flat surfaces: no shadows in any direction
    color: (role) => pick(DESIGN, role),
    face: (face) => FACES[face] ?? SANS,
    weight: (face, weight) => weight,
    image(node, r) {
      const { _x: x, _y: y, _w: w, _h: h } = node;
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${DESIGN["surface-3"]}"/>`;
    },
  },
};

/** No pattern or gradient of its own: the shared defs are enough. */
export function skinDefs(prefix) {
  return baseDefs(prefix);
}
