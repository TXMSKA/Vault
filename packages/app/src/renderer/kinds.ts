import type { EntryView, FieldView, Kind } from "../shared/api.js";
import type { Dictionary } from "./i18n.ts";
import type { IconName } from "./icons.ts";
export const KIND_GLYPH: Record<Kind, IconName> = { login: "globe", card: "creditCard", doc: "fileText", note: "stickyNote", key: "key", env: "squareTerminal", custom: "listPlus" };
/** The order of the add menu, as the board lists the kinds. */
export const ADD_ORDER: readonly Kind[] = ["login", "card", "doc", "note", "key", "env", "custom"];
/** The fields a login, a card and a key are known by, in the order they show. Any other field of the entry follows them. */
export const KNOWN_FIELDS: Partial<Record<Kind, readonly string[]>> = {
  login: ["username", "password", "website"], card: ["holder", "bank", "number", "expiry", "securityCode", "pin"], key: ["key", "passphrase", "license"],
};
/** Whether a field of this id starts out hidden when it is added. */
export const HIDDEN_BY_DEFAULT = new Set(["password", "number", "securityCode", "pin", "key", "license", "passphrase"]);
/** The name a field shows under: the words of its id for the fields a kind is known by, the name the person gave it for any other. */
export function fieldTitle(t: Dictionary, kind: Kind, field: { id: string; name: string }): string {
  if (KNOWN_FIELDS[kind]?.includes(field.id)) return t.fieldLabel(field.id);
  return field.name.trim() || field.id;
}
/** The fields of an open entry in the order they show: the known ones first, then the rest as they were saved. */
export function ordered(entry: EntryView): FieldView[] {
  const known = KNOWN_FIELDS[entry.kind] ?? [];
  return [...known.flatMap(id => entry.fields.filter(field => field.id === id)), ...entry.fields.filter(field => !known.includes(field.id))];
}
