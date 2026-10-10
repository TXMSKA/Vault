// Icons from Lucide (https://lucide.dev), drawn on a 24 by 24 grid with a round 2 pixel stroke.
// Lucide is ISC licensed. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT).
// All other copyright (c) for Lucide are held by Lucide Contributors 2022.
// Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
// provided that the above copyright notice and this permission notice appear in all copies.
const MARKUP = {
  eye: `<path d="M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>`,
  eyeOff: `<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575a1 1 0 0 1 0 .696a10.8 10.8 0 0 1-1.444 2.49m-6.41-.679a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 4.446-5.143M2 2l20 20"/>`,
  lock: `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
  minus: `<path d="M5 12h14"/>`,
  square: `<rect width="18" height="18" x="3" y="3" rx="2"/>`,
  x: `<path d="M18 6L6 18M6 6l12 12"/>`,
  fingerprint: `<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88m4.29-.98c.12-.6.43-2.3.5-3.02M2 12a10 10 0 0 1 18-6M2 16h.01m19.79 0c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2m2.31 12c.21-.66.45-1.32.57-2M9 6.8a6 6 0 0 1 9 5.2v2"/>`,
  download: `<path d="M12 15V3m9 12v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10l5 5l5-5"/>`,
  fileText: `<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/>`,
  fileArchive: `<path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5"/><path d="M14 2v5a1 1 0 0 0 1 1h5M8 12v-1m0 7v-2m0-9V6"/><circle cx="8" cy="20" r="2"/>`,
  circleAlert: `<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>`,
  info: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  ellipsis: `<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>`,
  plus: `<path d="M5 12h14m-7-7v14"/>`,
  search: `<path d="m21 21l-4.34-4.34"/><circle cx="11" cy="11" r="8"/>`,
  check: `<path d="M20 6L9 17l-5-5"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  creditCard: `<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/><path d="M6 14h2"/>`,
  stickyNote: `<path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/>`,
  key: `<path d="m2 21 9.6-9.6"/><path d="m7.5 15.5 2.3 2.3a1 1 0 0 1 0 1.4l-2.1 2.1a1 1 0 0 1-1.4 0L4 19"/><circle cx="15.5" cy="7.5" r="5.5"/>`,
  squareTerminal: `<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>`,
  listPlus: `<path d="M16 5H3"/><path d="M11 12H3"/><path d="M16 19H3"/><path d="M18 9v6"/><path d="M21 12h-6"/>`,
  layers: `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>`,
  star: `<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`,
  wandSparkles: `<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>`,
  refreshCw: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  pencil: `<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>`,
  trash2: `<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
  copy: `<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
  externalLink: `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
  chevronDown: `<path d="m6 9 6 6 6-6"/>`,
  layoutGrid: `<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>`,
  upload: `<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>`,
  settings2: `<path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>`,
  lightbulb: `<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>`,
  arrowLeft: `<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>`,
  triangleAlert: `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
} as const;
export type IconName = keyof typeof MARKUP;
const SVG = "http://www.w3.org/2000/svg";
const ELEMENT = /<(path|circle|rect)\s+([^>]*?)\/?>/g, ATTRIBUTE = /([a-z][\w-]*)="([^"]*)"/g;
function element(tag: string, attributes: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}
/** An icon at `size` pixels. It takes the colour of the text around it, and is hidden from screen readers. */
export function icon(name: IconName, size = 16, stroke = 2): SVGSVGElement {
  const svg = element("svg", { width: String(size), height: String(size), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": String(stroke), "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" }) as SVGSVGElement;
  svg.classList.add("icon");
  for (const [, tag, rest] of MARKUP[name].matchAll(ELEMENT)) svg.append(element(tag, Object.fromEntries([...rest.matchAll(ATTRIBUTE)].map(([, key, value]) => [key, value]))));
  return svg;
}
// The keyhole of the Vault mark, on a 100 by 100 grid (see assets/icon/vault-icon.svg).
const KEYHOLE = "M50 16 A20 20 0 0 1 60 53.32 L65 84 H35 L40 53.32 A20 20 0 0 1 50 16 Z";
/** The app icon: the brass keyhole set in at 62 percent on its brushed steel field. */
export function appIcon(size: number): SVGSVGElement {
  const svg = element("svg", { width: String(size), height: String(size), viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }) as SVGSVGElement;
  svg.classList.add("app-icon");
  const field = element("rect", { width: "100", height: "100", rx: "22" }); field.classList.add("tile");
  const group = element("g", { transform: "translate(19 19) scale(0.62)" }), hole = element("path", { d: KEYHOLE }); hole.classList.add("on-tile");
  group.append(hole); svg.append(field, group); return svg;
}
/** The bare keyhole in one colour (`color` is a class on the svg), for the empty list and the printed sheet. */
export function mark(size: number, className: string): SVGSVGElement {
  const svg = element("svg", { width: String(size), height: String(size), viewBox: "0 0 100 100", "aria-hidden": "true", focusable: "false" }) as SVGSVGElement;
  svg.classList.add("mark", className); svg.append(element("path", { d: KEYHOLE })); return svg;
}
