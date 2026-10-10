import { ipcMain } from "electron";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { ORIGIN } from "./protocol.ts";
import { SHAPES, accepts } from "./validate.ts";
import type { Call, Payload } from "./validate.ts";
export const CHANNEL = (call: string) => `vault:${call}`;
/** The one channel the main process pushes state on. */
export const STATE_CHANNEL = "vault:changed";
/** What a call answers when it is refused: calls that return a result say so, the others say nothing. */
const SILENT = new Set<Call>(["state", "interact", "retry", "minimize", "toggleMaximize", "close", "cancelClose", "confirmClose"]);
export type Handlers = { [C in Call]: (payload: Payload<C>) => unknown };
/**
 * One handler per call the bridge offers, and no other channel. A call is answered only when it comes from this window's own page
 * (never from another frame, window or address) and carries exactly what the call takes; anything else is refused without running.
 */
export function registerIpc(contents: () => WebContents | undefined, handlers: Handlers): () => void {
  const trusted = (event: IpcMainInvokeEvent) => {
    const page = contents(), frame = event.senderFrame;
    return !!page && !page.isDestroyed() && event.sender === page && !!frame && frame === page.mainFrame && frame.url.startsWith(`${ORIGIN}/`);
  };
  for (const call of Object.keys(SHAPES) as Call[]) {
    ipcMain.handle(CHANNEL(call), async (event, payload: unknown) => {
      if (!trusted(event) || !accepts(call, payload)) return SILENT.has(call) ? undefined : { ok: false, code: "invalid" };
      try { return await (handlers[call] as (payload: unknown) => unknown)(payload); }
      catch { return SILENT.has(call) ? undefined : { ok: false, code: "unavailable" }; }
    });
  }
  return () => { for (const call of Object.keys(SHAPES)) ipcMain.removeHandler(CHANNEL(call)); };
}
