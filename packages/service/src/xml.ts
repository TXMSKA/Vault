import { FILE_CAP } from "../../client/src/files.ts";
import { ServiceError } from "./errors.ts";
export type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string };
const invalid = () => new ServiceError("invalid");
function characters(value: string) {
  for (const char of value) {
    const n = char.codePointAt(0)!;
    if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0xD7FF || n >= 0xE000 && n <= 0xFFFD || n >= 0x10000 && n <= 0x10FFFF)) throw invalid();
  }
  return value;
}
function entities(value: string): string {
  const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return characters(value.replace(/&([^;]*);|&/g, (match, name: string | undefined) => {
    if (!name) throw invalid();
    if (Object.hasOwn(predefined, name)) return predefined[name];
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name)) throw invalid();
    const n = name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isSafeInteger(n) || n > 0x10FFFF) throw invalid();
    return String.fromCodePoint(n);
  }));
}
// A closed XML subset has no entity resolver or document type path. Resource caps
// apply before building a tree, including to metadata that the importer ignores.
export function xml(input: string): XmlNode {
  if (Buffer.byteLength(input) > FILE_CAP) throw new ServiceError("too_large", 413);
  input = characters(input.replace(/^\uFEFF/, "")).replace(/\r\n?/g, "\n");
  let position = 0, nodes = 0, root: XmlNode | undefined;
  const stack: XmlNode[] = [];
  const append = (value: string) => {
    const node = stack.at(-1);
    if (!node) { if (/[^ \t\n]/.test(value)) throw invalid(); return; }
    node.text += value; if (node.text.length > 32000) throw new ServiceError("too_large", 413);
  };
  if (input.startsWith("<?xml")) {
    const declaration = /^<\?xml[ \t\n]+version[ \t\n]*=[ \t\n]*(['"])1\.0\1(?:[ \t\n]+encoding[ \t\n]*=[ \t\n]*(['"])[uU][tT][fF]-8\2)?(?:[ \t\n]+standalone[ \t\n]*=[ \t\n]*(['"])(?:yes|no)\3)?[ \t\n]*\?>/.exec(input);
    if (!declaration) throw invalid(); position = declaration[0].length;
  }
  while (position < input.length) {
    if (input[position] !== "<") {
      const end = input.indexOf("<", position), next = end < 0 ? input.length : end, raw = input.slice(position, next);
      if (raw.includes("]]>")) throw invalid(); append(stack.length ? entities(raw) : raw); position = next; continue;
    }
    if (input.startsWith("<!--", position)) {
      const end = input.indexOf("-->", position + 4);
      if (end < 0 || input.slice(position + 4, end).includes("--") || input[end - 1] === "-") throw invalid();
      position = end + 3; continue;
    }
    if (input.startsWith("<![CDATA[", position)) {
      const end = input.indexOf("]]>", position + 9);
      if (end < 0 || !stack.length) throw invalid(); append(input.slice(position + 9, end)); position = end + 3; continue;
    }
    const close = /^<\/([A-Za-z_][A-Za-z0-9_.-]*)[ \t\n]*>/.exec(input.slice(position));
    if (close) { if (stack.pop()?.name !== close[1]) throw invalid(); position += close[0].length; continue; }
    const start = /^<([A-Za-z_][A-Za-z0-9_.-]*)/.exec(input.slice(position));
    if (!start) throw invalid(); position += start[0].length;
    const node: XmlNode = { name: start[1], attributes: Object.create(null), children: [], text: "" };
    let selfClosing = false, count = 0;
    for (;;) {
      const end = /^[ \t\n]*(\/?>)/.exec(input.slice(position));
      if (end) { selfClosing = end[1] === "/>"; position += end[0].length; break; }
      const attribute = /^[ \t\n]+([A-Za-z_][A-Za-z0-9_.-]*)[ \t\n]*=[ \t\n]*(['"])([^<]*?)\2/.exec(input.slice(position));
      if (!attribute || Object.hasOwn(node.attributes, attribute[1]) || ++count > 32 || attribute[3].length > 32000) throw invalid();
      node.attributes[attribute[1]] = entities(attribute[3].replace(/[\t\n]/g, " ")); position += attribute[0].length;
    }
    if (++nodes > 200000 || stack.length >= 64) throw new ServiceError("too_large", 413);
    const parent = stack.at(-1);
    if (parent) parent.children.push(node); else { if (root) throw invalid(); root = node; }
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || !root) throw invalid();
  return root;
}
