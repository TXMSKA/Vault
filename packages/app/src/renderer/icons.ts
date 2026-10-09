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
