import { app, dialog, Menu, nativeTheme, protocol, session } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, resolveHome } from "vault-client";
import type { AppState, Result } from "../shared/api.js";
import { parseArgs } from "./args.ts";
import { kitName, readBackup, writeKit } from "./files.ts";
import { registerIpc, STATE_CHANNEL } from "./ipc.ts";
import type { Handlers } from "./ipc.ts";
import { createLink, IDENTITY } from "./link.ts";
import type { Link } from "./link.ts";
import { SCHEME } from "./protocol.ts";
import { quitWhenIdle } from "./quit.ts";
import { BACKGROUNDS, resolveLanguage, resolveTheme } from "./theme.ts";
import { createWindow, secureSession } from "./window.ts";
export const PARTITION = "vault-app";
/** What the app asks of the operating system's dialogs and printers; a test replaces them, since nobody is there to answer. */
export type Platform = {
  saveFile(window: BrowserWindow): Promise<string | undefined>;
  openFile(window: BrowserWindow): Promise<string | undefined>;
  print(contents: WebContents): Promise<Result>;
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
  print: contents => new Promise(done => contents.print({ silent: false, printBackground: true, pageSize: "A4", margins: { marginType: "none" } }, (printed, reason) => done(printed ? { ok: true } : { ok: false, code: /cancel/i.test(reason) ? "cancelled" : "print_failed" }))),
};
export type StartOptions = { argv?: string[]; env?: NodeJS.ProcessEnv; platform?: Partial<Platform> };
export type Running = { window: BrowserWindow; link: Link; compose(): AppState; stop(): Promise<void> };
/**
 * Does what Electron needs before it is ready: one instance per vault home, the sandbox for every page, the scheme the page is served on.
 * Answers the function that opens the window, or nothing when another instance already runs (it was told to come forward).
 */
export function prepare(options: StartOptions = {}): (() => Promise<Running>) | undefined {
  const args = parseArgs(options.argv ?? process.argv.slice(1)), home = resolveHome(options.env ?? process.env), platform: Platform = { ...systemPlatform, ...options.platform };
  // The browser's own files live beside the vault home, never inside the private folder the service protects.
  if (!app.isReady()) app.setPath("userData", `${home}-app`);
  if (!app.requestSingleInstanceLock()) { app.quit(); return undefined; }
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  return () => run(args.prompts, home, platform);
}
/** Prepares, then opens the window once Electron is ready. */
export async function start(options: StartOptions = {}): Promise<Running | undefined> { return prepare(options)?.(); }
async function run(promptsOnly: boolean, home: string, platform: Platform): Promise<Running> {
  await app.whenReady();
  app.setAppUserModelId("com.cosmic.vault"); Menu.setApplicationMenu(null);
  const here = dirname(fileURLToPath(import.meta.url)), root = join(here, "..", "renderer"), icon = join(here, "..", "..", "..", "..", "assets", "icon", "vault-icon-512.png");
  secureSession(session.fromPartition(PARTITION), root);
  const window = createWindow({ preload: join(here, "..", "preload", "preload.cjs"), partition: PARTITION, background: BACKGROUNDS[resolveTheme("system", nativeTheme.shouldUseDarkColors)].surface, ...existsSync(icon) ? { icon } : {} });
  const handle = () => { const bytes = window.getNativeWindowHandle(); return (bytes.length >= 8 ? bytes.readBigUInt64LE(0) : BigInt(bytes.readUInt32LE(0))).toString(); };
  const hello = async () => { if (process.platform !== "win32") return false; try { return (await stat(join(home, "secrets", "hello.json"))).isFile(); } catch { return false; } };
  const link = createLink({ connect: () => connect({ app: IDENTITY, home }), hello, handle });
  const idle = promptsOnly ? quitWhenIdle({ pending: () => link.snapshot().pending, quit: () => app.quit() }) : undefined;
  const reveal = () => { if (window.isDestroyed()) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
  let sent = "", background = "";
  const compose = (): AppState => {
    const snapshot = link.snapshot();
    return {
      phase: snapshot.phase, problem: snapshot.problem, created: snapshot.created, unlocked: snapshot.unlocked, hello: snapshot.hello, prompt: snapshot.prompt,
      language: resolveLanguage(snapshot.settings.language, app.getLocale()), theme: resolveTheme(snapshot.settings.theme, nativeTheme.shouldUseDarkColors), computer: hostname(), maximized: window.isMaximized(),
    };
  };
  const push = () => {
    if (window.isDestroyed()) return;
    const state = compose(), key = JSON.stringify(state);
    if (BACKGROUNDS[state.theme].surface !== background) { background = BACKGROUNDS[state.theme].surface; window.setBackgroundColor(background); }
    if (key !== sent) { sent = key; if (!window.webContents.isLoading()) window.webContents.send(STATE_CHANNEL, state); }
  };
  link.onChange(push); link.onArrival(reveal);
  nativeTheme.on("updated", push); window.on("maximize", push); window.on("unmaximize", push); window.on("focus", () => { void link.refresh(); });
  app.on("second-instance", () => { idle?.interact(); reveal(); });
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
      return outcome === "saved" ? { ok: true, name: kitName(file) } : { ok: false, code: outcome === "exists" ? "exists" : "save_failed" };
    },
    printRecoverySheet: () => link.recovery() ? platform.print(window.webContents) : { ok: false, code: "no_recovery" },
    finishSetup: () => { link.release(); return { ok: true }; },
    approveRun: ({ id, password }) => link.approveRun(id, password),
    approveRunWithHello: ({ id }) => link.approveRunWithHello(id),
    allowImport: ({ id, password }) => link.allowImport(id, password),
    allowImportWithHello: ({ id }) => link.allowImportWithHello(id),
    dismissPrompt: ({ id }) => link.dismiss(id),
    interact: () => { idle?.interact(); },
    retry: () => { link.retry(); },
    minimize: () => { window.minimize(); },
    toggleMaximize: () => { if (window.isMaximized()) window.unmaximize(); else window.maximize(); },
    close: () => { window.close(); },
  };
  const unregister = registerIpc(() => window.isDestroyed() ? undefined : window.webContents, handlers);
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { idle?.interact(); unregister(); await link.stop(); })();
  // Quitting leaves the service first, so Vault locks as its settings say when this was the last app.
  app.on("before-quit", event => { if (stopping) return; event.preventDefault(); void stop().finally(() => app.exit(0)); });
  window.on("closed", () => app.quit()); app.on("window-all-closed", () => app.quit());
  window.once("ready-to-show", () => { if (!promptsOnly) reveal(); });
  await window.loadURL(`app://vault/`);
  link.start(); idle?.arm();
  return { window, link, compose, stop };
}
