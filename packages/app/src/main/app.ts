import { app, clipboard, dialog, Menu, nativeTheme, protocol, session, shell } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, resolveHome } from "vault-client";
import type { AppState, Result } from "../shared/api.js";
import { parseArgs } from "./args.ts";
import { createClipboard } from "./clipboard.ts";
import type { ClipboardPort } from "./clipboard.ts";
import { createEntries } from "./entries.ts";
import { kitName, readBackup, writeKit } from "./files.ts";
import { registerIpc, STATE_CHANNEL } from "./ipc.ts";
import type { Handlers } from "./ipc.ts";
import { createLink, IDENTITY } from "./link.ts";
import type { Link } from "./link.ts";
import { dataFolder } from "./paths.ts";
import { SCHEME } from "./protocol.ts";
import { quitWhenIdle } from "./quit.ts";
import { BACKGROUNDS, resolveLanguage, resolveTheme } from "./theme.ts";
import { createTour } from "./tour.ts";
import { createWindow, secureSession } from "./window.ts";
export const PARTITION = "vault-app";
/** What the app asks of the operating system's dialogs and printers; a test replaces them, since nobody is there to answer. */
export type Platform = {
  saveFile(window: BrowserWindow): Promise<string | undefined>;
  openFile(window: BrowserWindow): Promise<string | undefined>;
  print(contents: WebContents): Promise<Result>;
  clipboard: ClipboardPort;
  /** Opens a website in the person's browser. */
  openUrl(url: string): Promise<void>;
};
export const systemPlatform: Platform = {
  async saveFile(window) {
    const answer = await dialog.showSaveDialog(window, { defaultPath: join(homedir(), "Vault recovery kit.txt"), filters: [{ name: "Text", extensions: ["txt"] }], properties: ["showOverwriteConfirmation"] });
    return answer.canceled ? undefined : answer.filePath;
  },
  async openFile(window) {
    const answer = await dialog.showOpenDialog(window, { filters: [{ name: "Vault backup", extensions: ["vault", "json"] }, { name: "All files", extensions: ["*"] }], properties: ["openFile"] });
    return answer.canceled ? undefined : answer.filePaths[0];
  },
  clipboard: { readText: () => clipboard.readText(), writeText: text => clipboard.writeText(text), clear: () => clipboard.clear() },
  openUrl: url => shell.openExternal(url),
  print: contents => new Promise(done => contents.print({ silent: false, printBackground: true, pageSize: "A4", margins: { marginType: "none" } }, (printed, reason) => done(printed ? { ok: true } : { ok: false, code: /cancel/i.test(reason) ? "cancelled" : "print_failed" }))),
};
/**
 * `clipboardMs` is for tests only, so that the 30 seconds a copied value stays on the clipboard need not be waited out; the app itself never sets it.
 */
export type StartOptions = { argv?: string[]; env?: NodeJS.ProcessEnv; platform?: Partial<Platform>; clipboardMs?: number };
export type Running = { window: BrowserWindow; link: Link; compose(): AppState; stop(): Promise<void> };
/**
 * Does what Electron needs before it is ready: one instance per vault home, the sandbox for every page, the scheme the page is served on.
 * Answers the function that opens the window, or nothing when another instance already runs (it was told to come forward).
 */
export function prepare(options: StartOptions = {}): (() => Promise<Running>) | undefined {
  const args = parseArgs(options.argv ?? process.argv.slice(1)), home = resolveHome(options.env ?? process.env), platform: Platform = { ...systemPlatform, ...options.platform };
  // The browser's own files live in a folder of their own inside the vault home, so that removing the home's data takes them too; never in a folder the service owns.
  if (!app.isReady()) app.setPath("userData", dataFolder(home));
  if (options.clipboardMs !== undefined && (!Number.isSafeInteger(options.clipboardMs) || options.clipboardMs < 1)) throw new Error("invalid");
  if (!app.requestSingleInstanceLock()) { app.quit(); return undefined; }
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  return () => run(args.prompts, home, platform, options.clipboardMs);
}
/** Prepares, then opens the window once Electron is ready. */
export async function start(options: StartOptions = {}): Promise<Running | undefined> { return prepare(options)?.(); }
async function run(promptsOnly: boolean, home: string, platform: Platform, clipboardMs?: number): Promise<Running> {
  await app.whenReady();
  app.setAppUserModelId("com.cosmic.vault"); Menu.setApplicationMenu(null);
  const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..", "renderer"), icon = join(here, "..", "..", "..", "..", "assets", "icon", "vault-icon-512.png");
  secureSession(session.fromPartition(PARTITION), root);
  const window = createWindow({ preload: join(here, "..", "preload", "preload.cjs"), partition: PARTITION, background: BACKGROUNDS[resolveTheme("system", nativeTheme.shouldUseDarkColors)].surface, ...existsSync(icon) ? { icon } : {} });
  const handle = () => { const bytes = window.getNativeWindowHandle(); return (bytes.length >= 8 ? bytes.readBigUInt64LE(0) : BigInt(bytes.readUInt32LE(0))).toString(); };
  const link = createLink({ connect: () => connect({ app: IDENTITY, home }), handle });
  const tour = createTour(app.getPath("userData")); await tour.load();
  const copied = createClipboard(platform.clipboard, clipboardMs === undefined ? {} : { ms: clipboardMs });
  const entries = createEntries({ service: () => link.service(), clipboard: copied, openUrl: platform.openUrl });
  const idle = promptsOnly ? quitWhenIdle({ pending: () => link.snapshot().pending, quit: () => app.quit() }) : undefined;
  const reveal = () => { if (window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
  let sent = "", background = "", closing = false, force = false, open = false;
  const compose = (): AppState => {
    const snapshot = link.snapshot();
    return {
      phase: snapshot.phase, problem: snapshot.problem, created: snapshot.created, unlocked: snapshot.unlocked, hello: snapshot.hello, helloAvailable: snapshot.helloAvailable, settings: snapshot.settings,
      tour: tour.pending(), closing, prompt: snapshot.prompt,
      language: resolveLanguage(snapshot.settings.language, app.getLocale()), theme: resolveTheme(snapshot.settings.theme, nativeTheme.shouldUseDarkColors), computer: hostname(), maximized: window.isMaximized(),
    };
  };
  const push = () => {
    if (window.isDestroyed()) return;
    const state = compose(), key = JSON.stringify(state);
    if (BACKGROUNDS[state.theme].surface !== background) { background = BACKGROUNDS[state.theme].surface; window.setBackgroundColor(background); }
    if (key !== sent) { sent = key; if (!window.webContents.isLoading()) window.webContents.send(STATE_CHANNEL, state); }
  };
  // Nothing deleted can be put back, and no list is kept, once the vault is locked.
  link.onChange(snapshot => { if (open && !snapshot.unlocked) entries.forget(); open = snapshot.unlocked; push(); }); link.onArrival(reveal);
  nativeTheme.on("updated", push); window.on("maximize", push); window.on("unmaximize", push); window.on("focus", () => { void link.refresh(); });
  app.on("second-instance", () => { idle?.interact(); reveal(); });
  // Closing while the recovery key is on screen and was neither saved nor printed asks first; the window shows the question and answers it.
  // A close the person confirmed passes once.
  window.on("close", event => {
    if (force) { force = false; return; }
    if (link.recovery() === undefined || link.secured()) return;
    event.preventDefault(); closing = true; push();
  });
  // A call that finds the vault locked tells the window at once instead of at the next turn.
  const read = async <T extends object>(work: Promise<Result<T>>) => { const result = await work; if (!result.ok && result.code === "locked") void link.refresh(); return result; };
  const handlers: Handlers = {
    state: () => compose(),
    create: ({ password }) => link.create(password),
    chooseBackup: async () => {
      const file = await platform.openFile(window); if (!file) return { ok: false, code: "cancelled" };
      const backup = await readBackup(file); if (!backup) return { ok: false, code: "invalid_backup" };
      link.backup.set(basename(file), backup); return { ok: true, name: basename(file) };
    },
    restoreBackup: ({ password }) => link.restoreBackup(password),
    unlock: ({ password }) => link.unlock(password),
    unlockWithHello: () => link.unlockWithHello(),
    recover: ({ recovery, password }) => link.recover(recovery, password),
    lock: () => link.lock(),
    saveRecoverySheet: async (): Promise<Result<{ name: string }>> => {
      const recovery = link.recovery(); if (!recovery) return { ok: false, code: "no_recovery" };
      const file = await platform.saveFile(window); if (!file) return { ok: false, code: "cancelled" };
      const outcome = await writeKit(file, recovery);
      if (outcome === "saved") link.secure();
      return outcome === "saved" ? { ok: true, name: kitName(file) } : { ok: false, code: outcome === "exists" ? "exists" : "save_failed" };
    },
    printRecoverySheet: async () => {
      if (!link.recovery()) return { ok: false, code: "no_recovery" };
      const result = await platform.print(window.webContents); if (result.ok) link.secure(); return result;
    },
    finishSetup: () => { link.release(); closing = false; push(); return { ok: true }; },
    approveRun: ({ id, password }) => link.approveRun(id, password),
    approveRunWithHello: ({ id }) => link.approveRunWithHello(id),
    allowImport: ({ id, password }) => link.allowImport(id, password),
    allowImportWithHello: ({ id }) => link.allowImportWithHello(id),
    dismissPrompt: ({ id }) => link.dismiss(id),
    entries: () => read(entries.list()),
    entryOpen: ({ id }) => read(entries.open(id)),
    entryReveal: ({ id, part }) => read(entries.reveal(id, part)),
    entryCopy: ({ id, part }) => read(entries.copy(id, part)),
    entryCode: ({ id }) => read(entries.code(id)),
    entryCopyCode: ({ id }) => read(entries.copyCode(id)),
    entryOpenSite: ({ id }) => read(entries.openSite(id)),
    entryFavorite: ({ id, favorite }) => read(entries.favorite(id, favorite)),
    entrySave: ({ entry, expected }) => read(entries.save(entry, expected)),
    entryRemove: ({ id, expected }) => read(entries.remove(id, expected)),
    entryUndo: ({ id }) => read(entries.undo(id)),
    saveSettings: next => link.saveSettings(next),
    enableHello: ({ password }) => link.enableHello(password),
    disableHello: () => link.disableHello(),
    dismissTour: async () => { await tour.dismiss(); push(); return { ok: true }; },
    cancelClose: () => { closing = false; push(); },
    confirmClose: () => { force = true; closing = false; push(); window.close(); },
    interact: () => { idle?.interact(); },
    retry: () => { link.retry(); },
    minimize: () => { window.minimize(); },
    toggleMaximize: () => { if (window.isMaximized()) window.unmaximize(); else window.maximize(); },
    close: () => { window.close(); },
  };
  const unregister = registerIpc(() => window.isDestroyed() ? undefined : window.webContents, handlers);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { idle?.interact(); unregister(); await copied.flush(); entries.forget(); await link.stop(); })();
  // Quitting leaves the service first, so Vault locks as its settings say when this was the last app.
  app.on("before-quit", event => { if (stopping) return; event.preventDefault(); void stop().finally(() => app.exit(0)); });
  window.on("closed", () => app.quit()); app.on("window-all-closed", () => app.quit());
  window.once("ready-to-show", () => { if (!promptsOnly) reveal(); });
  await window.loadURL(`app://vault/`);
  link.start(); idle?.arm();
  return { window, link, compose, stop };
}
