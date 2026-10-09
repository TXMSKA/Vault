export const PROMPTS_QUIT_MS = 30000;
type Timers = { set(run: () => void, ms: number): unknown; clear(timer: unknown): void };
/**
 * A start that was only for prompts closes itself after 30 seconds, unless a prompt waits or the person touched the window by then.
 * Once the person has interacted or a prompt has waited, the app stays open and nothing closes it but the person.
 */
export function quitWhenIdle(options: { pending(): number; quit(): void; ms?: number; timers?: Timers }) {
  const timers = options.timers ?? { set: (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return timer; }, clear: timer => clearTimeout(timer as NodeJS.Timeout) };
  let timer: unknown, interacted = false;
  return {
    arm() { if (timer === undefined && !interacted) timer = timers.set(() => { timer = undefined; if (!interacted && options.pending() === 0) options.quit(); }, options.ms ?? PROMPTS_QUIT_MS); },
    /** The person touched the window, or opened Vault again. */
    interact() { interacted = true; if (timer !== undefined) { timers.clear(timer); timer = undefined; } },
  };
}
