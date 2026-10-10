/** A copied value leaves the clipboard after 30 seconds. */
export const CLIPBOARD_MS = 30000;
/** The system clipboard, as far as the app uses it. */
export type ClipboardPort = { readText(): Promise<string>; writeText(text: string): Promise<void>; clear(): void };
export type Timers = { set(run: () => void, ms: number): unknown; clear(timer: unknown): void };
const systemTimers: Timers = { set: (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return timer; }, clear: timer => clearTimeout(timer as NodeJS.Timeout) };
/**
 * Puts a value on the clipboard and takes it off again when the time is up, but only if the clipboard still holds that value: whatever the
 * person copied meanwhile is theirs. A newer copy takes over the timer. Quitting clears at once, under the same rule.
 */
export function createClipboard(port: ClipboardPort, options: { ms?: number; timers?: Timers } = {}) {
  const timers = options.timers ?? systemTimers, ms = options.ms ?? CLIPBOARD_MS;
  let held: string | undefined, timer: unknown;
  const holds = async (value: string) => { try { return await port.readText() === value; } catch { return false; } };
  async function finish() {
    if (timer !== undefined) { timers.clear(timer); timer = undefined; }
    const value = held; held = undefined;
    if (value !== undefined && await holds(value)) { try { port.clear(); } catch {} }
  }
  return {
    /** Resolves once the value is on the clipboard and its time has started. */
    async copy(value: string): Promise<void> {
      if (timer !== undefined) { timers.clear(timer); timer = undefined; }
      await port.writeText(value);
      if (timer !== undefined) timers.clear(timer);
      held = value; timer = timers.set(() => { void finish(); }, ms);
    },
    /** Clears now if the clipboard still holds the last copy; resolves once it is done. */
    flush: finish,
    pending: () => held !== undefined,
  };
}
export type Clipboard = ReturnType<typeof createClipboard>;
