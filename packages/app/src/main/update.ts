import type { Language } from "../shared/api.js";
/** Where the updates come from: the releases of Vault's repository, published by a person. */
export const FEED = { provider: "github", owner: "TXMSKA", repo: "Vault" } as const;
export const FIRST_CHECK_MS = 10000;
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The part of electron-updater's updater that Vault uses, so that the decisions below run without Electron. */
export type UpdaterPort = {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowPrerelease: boolean; allowDowngrade: boolean;
  setFeedURL(feed: typeof FEED): void;
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(silent: boolean, runAfter: boolean): void;
};
export type UpdateText = { message: string; detail: string; install: string; later: string };
type Timers = { after(run: () => void, ms: number): unknown; every(run: () => void, ms: number): unknown; clear(timer: unknown): void };
/** Updates run only in an installed copy: never from a development checkout, and never when the start said not to (tests do). */
export const updatesEnabled = (options: { packaged: boolean; disabled?: boolean }) => options.packaged && options.disabled !== true;
/** Updates come from the releases only, never a pre-release or an older version; a downloaded update waits for the person's answer. */
export function configureUpdater(updater: UpdaterPort) {
  updater.setFeedURL(FEED);
  updater.autoDownload = true; updater.autoInstallOnAppQuit = false; updater.allowPrerelease = false; updater.allowDowngrade = false;
}
/** The question about a downloaded update, impersonal in both languages. The version is shown as a plain number, never a link or a file name. */
export function updateText(language: Language, version: string): UpdateText {
  const shown = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/.test(version) ? version : "";
  if (language === "es") return {
    message: shown ? `Hay una versión nueva de Vault: ${shown}` : "Hay una versión nueva de Vault",
    detail: "La versión ya está descargada. Al instalarla, Vault se cierra y se vuelve a abrir. Si se elige más tarde, la pregunta vuelve en el próximo inicio de Vault.",
    install: "Instalar ahora", later: "Más tarde",
  };
  return {
    message: shown ? `A new version of Vault is ready: ${shown}` : "A new version of Vault is ready",
    detail: "The version is already downloaded. Installing it closes Vault and opens it again. If later is chosen, the question comes back the next time Vault starts.",
    install: "Install now", later: "Later",
  };
}
const realTimers: Timers = {
  after: (run, ms) => { const timer = setTimeout(run, ms); timer.unref(); return timer; },
  every: (run, ms) => { const timer = setInterval(run, ms); timer.unref(); return timer; },
  clear: timer => { clearTimeout(timer as NodeJS.Timeout); clearInterval(timer as NodeJS.Timeout); },
};
/**
 * Checks 10 seconds after `start` and every 6 hours after that. A downloaded update is offered once per version in a run: the person installs it
 * now (Vault quits, installs silently and opens again) or later, and later means the question comes back at the next start, when the check finds the
 * same update already downloaded. Nothing installs without the answer.
 */
export function createUpdates(options: { updater(): Promise<UpdaterPort>; packaged: boolean; disabled?: boolean; language(): Language; ask(text: UpdateText): Promise<"install" | "later">; timers?: Timers }) {
  const timers = options.timers ?? realTimers, offered = new Set<string>();
  let started = false, stopped = false, asking = false, first: unknown, repeat: unknown, updater: UpdaterPort | undefined;
  async function offer(version: string) {
    if (!updater || asking || offered.has(version)) return;
    asking = true; offered.add(version);
    try { if (await options.ask(updateText(options.language(), version)) === "install") updater.quitAndInstall(true, true); }
    catch { /* a dialog that cannot show leaves the update downloaded for the next start */ }
    finally { asking = false; }
  }
  const check = () => { void updater?.checkForUpdates().catch(() => undefined); };
  return {
    /** Answers whether updates run. A second call does nothing. */
    async start(): Promise<boolean> {
      if (stopped) return false;
      if (started) return true;
      if (!updatesEnabled(options)) return false;
      started = true;
      try { updater = await options.updater(); configureUpdater(updater); } catch { started = false; updater = undefined; return false; }
      if (stopped) return false;
      updater.on("update-downloaded", info => { void offer(String(info?.version ?? "")); });
      updater.on("error", () => undefined);
      first = timers.after(() => { first = undefined; check(); repeat = timers.every(check, CHECK_EVERY_MS); }, FIRST_CHECK_MS);
      return true;
    },
    stop() { stopped = true; if (first !== undefined) timers.clear(first); if (repeat !== undefined) timers.clear(repeat); first = repeat = undefined; },
  };
}
