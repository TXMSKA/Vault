// Vault's three marks as one node type, drawn in an SVG of their own so a
// stroke scales with the mark and the board can be zoomed without thickening
// it (the shared `vector` keeps its stroke in screen pixels). Every stroked part
// of a mark has the same weight, and nothing is drawn that the mark's
// description does not name:
//   dial     a safe's combination dial: the dial, its knob and the index tick
//            between them at the top.
//   seal     a plain keyhole, filled: a round head and a tapered foot.
//   key      a plain key inside a rounded square: a round bow, the shaft and
//            two teeth.
// `tile` fills the icon's field (a rounded square of 22 percent radius); the
// dial and the keyhole are then set in at `scale` of it, the key's square
// is the field itself.

const STROKE = 5;

const DIAL = [
  "M50 14 A36 36 0 1 1 49.99 14", // the dial
  "M50 36 A14 14 0 1 1 49.99 36", // the knob
  "M50 14 V26", // the index tick, from the rim toward the knob
];

// The head is a circle of radius 20 centred at (50, 36); the foot leaves it where x is 40 and 60.
const KEYHOLE = "M50 16 A20 20 0 0 1 60 53.32 L65 84 H35 L40 53.32 A20 20 0 0 1 50 16 Z";

// The key is centred in the square: the bow's left edge and the shaft's end are equally far from its sides.
const KEY = [
  "M35.5 37 A13 13 0 1 1 35.49 37", // the bow
  "M48.5 50 H77.5", // the shaft
  "M77.5 50 V62", // the teeth
  "M68.5 50 V59",
];

export default {
  "vault-mark": {
    measure(node) {
      node._w = node.size;
      node._h = node.size;
    },
    draw(node, g) {
      const ink = g.paint(node.ink ?? "primary");
      const tile = node.tile ? g.paint(node.tile) : null;
      const kind = node.kind;
      const scale = tile && kind !== "key" ? node.scale ?? 0.62 : 1;
      const stroked = (paths) => `<path d="${paths.join(" ")}" fill="none" stroke="${ink}" stroke-width="${STROKE}"/>`;
      let body = "";
      if (kind === "dial") body = stroked(DIAL);
      if (kind === "seal") body = `<path d="${KEYHOLE}" fill="${ink}"/>`;
      if (kind === "key") {
        const half = STROKE / 2;
        body =
          `<rect x="${half}" y="${half}" width="${100 - STROKE}" height="${100 - STROKE}" rx="${22 - half}" fill="${tile ?? "none"}" stroke="${ink}" stroke-width="${STROKE}"/>` +
          stroked(KEY);
      }
      const field = tile && kind !== "key" ? `<rect width="100" height="100" rx="22" fill="${tile}"/>` : "";
      const inset = (100 - 100 * scale) / 2;
      g.out.push(
        `<svg x="${node._x}" y="${node._y}" width="${node._w}" height="${node._h}" viewBox="0 0 100 100" overflow="visible" stroke-linecap="round" stroke-linejoin="round">` +
          field +
          `<g transform="translate(${inset} ${inset}) scale(${scale})">${body}</g></svg>`,
      );
    },
  },
};
