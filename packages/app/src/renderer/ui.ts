import type { AppState, VaultBridge } from "../shared/api.js";
import type { Dictionary } from "./i18n.ts";
declare global { interface Window { vault: VaultBridge } }
export const bridge: VaultBridge = window.vault;
/** What the screens share: the state the main process last sent, and the words of its language. */
export type Context = { state: AppState; t: Dictionary };
/** Where the person is inside the flows that the service state alone does not say: first run, the recovery key on screen, unlocking another way. */
export const flow = {
  first: "welcome" as "welcome" | "create" | "restore",
  chosen: "create" as "create" | "restore",
  /** The recovery key on screen after a vault is made or recovered; it stays until the person opens Vault. */
  setup: undefined as { recovery: string; restored: boolean } | undefined,
  unlock: "locked" as "locked" | "recovery" | "hello",
  /** A note on the locked screen after Windows Hello did not work. */
  note: undefined as "hello_failed" | "hello_unavailable" | undefined,
  /** Windows Hello is not offered again once this session learned it is not set up. */
  helloOff: false,
  /** Counts the Windows Hello waits, so that the answer of one the person cancelled is ignored. */
  hello: 0,
};
/** Hooks the page sets once it exists: draw again, read the state from the main process, and put the printed sheet beside the app. */
export const view = { redraw: () => {}, sync: async () => {}, sheet: (_page?: HTMLElement) => {} };
/** Moves to another screen of a flow. */
export function go(change: () => void) { change(); view.redraw(); }
