import type { EntryInput, FieldInput, Kind } from "../shared/api.js";
import type { Settings } from "vault-client";
import { isSettings } from "./settings.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Check<T = unknown> = (value: unknown) => value is T;
const text = (min: number, max: number): Check<string> => (value): value is string => typeof value === "string" && value.length >= min && value.length <= max && !value.includes("\0");
const promptId: Check<string> = (value): value is string => typeof value === "string" && UUID.test(value);
const yes: Check<boolean> = (value): value is boolean => typeof value === "boolean";
/** A version the window saw: 0 for an entry that does not exist yet. */
const version: Check<number> = (value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A field of an entry as the window names it for a reveal or a copy: `f:` and the field's id, or `note`. */
const part: Check<string> = (value): value is string => typeof value === "string" && (value === "note" || value.startsWith("f:") && value.length > 2 && value.length <= 102 && !value.includes("\0"));
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const KINDS: readonly Kind[] = ["login", "card", "doc", "note", "key", "custom", "env"];
const only = (value: Record<string, unknown>, required: string[], optional: string[]) => {
  const keys = Object.keys(value);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key));
};
const field = (value: unknown): value is FieldInput =>
  plain(value) && only(value, ["id", "name", "secret"], ["value"]) && text(1, 100)(value.id) && text(0, 100)(value.name) && yes(value.secret) && (value.value === undefined || text(0, 32000)(value.value));
/** What a save may carry, key by key and within the service's own limits; the service checks it again. */
const entry = (value: unknown): value is EntryInput => {
  if (!plain(value) || !only(value, ["id", "kind", "title", "favorite", "fields"], ["note", "totp"])) return false;
  if (!promptId(value.id) || !KINDS.includes(value.kind as Kind) || !text(0, 500)(value.title) || !yes(value.favorite)) return false;
  if (!Array.isArray(value.fields) || value.fields.length > 100 || !value.fields.every(field)) return false;
  return (value.note === undefined || text(0, 32000)(value.note)) && (value.totp === undefined || text(0, 8192)(value.totp));
};
const settings: Check<Settings> = (value): value is Settings => isSettings(value);
/** What each call may carry, key by key: exactly these keys and no others, each one passing its check. `null` is a call with nothing. */
export const SHAPES = {
  create: { password: text(15, 128) },
  chooseBackup: null,
  restoreBackup: { password: text(15, 128) },
  unlock: { password: text(1, 128) },
  unlockWithHello: null,
  recover: { password: text(15, 128), recovery: text(1, 128) },
  lock: null,
  saveRecoverySheet: null,
  printRecoverySheet: null,
  finishSetup: null,
  approveRun: { id: promptId, password: text(1, 128) },
  approveRunWithHello: { id: promptId },
  allowImport: { id: promptId, password: text(1, 128) },
  allowImportWithHello: { id: promptId },
  dismissPrompt: { id: promptId },
  entries: null,
  entryOpen: { id: promptId },
  entryReveal: { id: promptId, part },
  entryCopy: { id: promptId, part },
  entryCode: { id: promptId },
  entryCopyCode: { id: promptId },
  entryOpenSite: { id: promptId },
  entryFavorite: { id: promptId, favorite: yes },
  entrySave: { entry, expected: version },
  entryRemove: { id: promptId, expected: version },
  entryUndo: { id: promptId },
  saveSettings: settings,
  enableHello: { password: text(1, 128) },
  disableHello: null,
  dismissTour: null,
  cancelClose: null,
  confirmClose: null,
  interact: null,
  retry: null,
  minimize: null,
  toggleMaximize: null,
  close: null,
  state: null,
} as const satisfies Record<string, Record<string, Check> | Check | null>;
export type Call = keyof typeof SHAPES;
type Shape<C extends Call> = (typeof SHAPES)[C];
/** What a handler receives: nothing for a call with nothing, the value itself for a call that takes one whole value, else the checked keys. */
export type Payload<C extends Call> = Shape<C> extends null ? undefined : Shape<C> extends Check<infer T> ? T : { [K in keyof Shape<C>]: Shape<C>[K] extends Check<infer T> ? T : never };
/** True when `payload` is exactly what `call` takes. A plain object from the window, never an array, a class or an inherited key. */
export function accepts(call: string, payload: unknown): boolean {
  if (!Object.hasOwn(SHAPES, call)) return false;
  const shape = SHAPES[call as Call] as Record<string, Check> | Check | null;
  if (shape === null) return payload === undefined;
  if (typeof shape === "function") return shape(payload);
  if (!plain(payload)) return false;
  const keys = Object.keys(shape);
  return Object.keys(payload).length === keys.length && keys.every(key => Object.hasOwn(payload, key) && shape[key](payload[key]));
}
