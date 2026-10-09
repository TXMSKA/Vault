import { BrowserWindow } from "electron";
import type { Session, WebContents } from "electron";
import { ORIGIN, SCHEME, serve } from "./protocol.ts";
export const WIDTH = 920;
export const HEIGHT = 640;
/** Serves the app's own files on `app://vault/` and refuses everything else the page or the browser could ask for. */
export function secureSession(ses: Session, root: string) {
  ses.protocol.handle(SCHEME, request => serve(root, request));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${ORIGIN}/`) }));
}
/** No navigation, no new window, no webview, no zoom: the window shows the one page and nothing else. */
export function lockDown(contents: WebContents) {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"] as const) contents.on(event as "will-navigate", navigation => navigation.preventDefault());
  contents.setZoomFactor(1); void contents.setVisualZoomLevelLimits(1, 1);
  contents.on("before-input-event", (event, input) => { if (input.type === "keyDown" && (input.control || input.meta) && ["+", "-", "=", "0"].includes(input.key)) event.preventDefault(); });
}
/** The frameless window: 920 by 640 at the least, its own colours from the first paint, and a page that can reach nothing but the bridge. */
export function createWindow(options: { preload: string; partition: string; background: string; icon?: string }) {
  const window = new BrowserWindow({
    width: WIDTH, height: HEIGHT, minWidth: WIDTH, minHeight: HEIGHT, frame: false, show: false, title: "Vault", backgroundColor: options.background,
    ...options.icon ? { icon: options.icon } : {},
    webPreferences: {
      preload: options.preload, partition: options.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false, devTools: false, spellcheck: false, safeDialogs: true, navigateOnDragDrop: false,
    },
  });
  window.removeMenu(); lockDown(window.webContents);
  return window;
}
