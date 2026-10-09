const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Check = (value: unknown) => boolean;
const text = (min: number, max: number): Check => value => typeof value === "string" && value.length >= min && value.length <= max && !value.includes("\0");
const promptId: Check = value => typeof value === "string" && UUID.test(value);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
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
  interact: null,
  retry: null,
  minimize: null,
  toggleMaximize: null,
  close: null,
  state: null,
} as const satisfies Record<string, Record<string, Check> | null>;
export type Call = keyof typeof SHAPES;
/** True when `payload` is exactly what `call` takes. A plain object from the window, never an array, a class or an inherited key. */
export function accepts(call: string, payload: unknown): boolean {
  if (!Object.hasOwn(SHAPES, call)) return false;
  const shape = SHAPES[call as Call] as Record<string, Check> | null;
  if (shape === null) return payload === undefined;
  if (!plain(payload)) return false;
  const keys = Object.keys(shape);
  return Object.keys(payload).length === keys.length && keys.every(key => Object.hasOwn(payload, key) && shape[key](payload[key]));
}
