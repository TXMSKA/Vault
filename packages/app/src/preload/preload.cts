// The only thing the page can reach: a frozen object with one function per operation Vault's window may ask for. Each one sends its
// own fixed channel; the page names no channel, and the main process checks every argument before anything runs. A sandboxed
// preload cannot load other files, so this one stands alone and the channels are written out here and in main/validate.ts (a test keeps them equal).
import { contextBridge, ipcRenderer } from "electron";
import type { AppState, VaultBridge } from "../shared/api.js" with { "resolution-mode": "import" };

const call = (name: string, payload?: unknown): Promise<any> => ipcRenderer.invoke(`vault:${name}`, payload);
const bridge = {
  state: () => call("state"),
  onState(listener: (state: AppState) => void) {
    if (typeof listener !== "function") throw new TypeError("A listener is a function.");
    const handler = (_event: unknown, state: AppState) => { listener(state); };
    ipcRenderer.on("vault:changed", handler);
    return () => { ipcRenderer.removeListener("vault:changed", handler); };
  },
  create: input => call("create", input),
  chooseBackup: () => call("chooseBackup"),
  restoreBackup: input => call("restoreBackup", input),
  unlock: input => call("unlock", input),
  unlockWithHello: () => call("unlockWithHello"),
  recover: input => call("recover", input),
  lock: () => call("lock"),
  saveRecoverySheet: () => call("saveRecoverySheet"),
  printRecoverySheet: () => call("printRecoverySheet"),
  finishSetup: () => call("finishSetup"),
  approveRun: input => call("approveRun", input),
  approveRunWithHello: input => call("approveRunWithHello", input),
  allowImport: input => call("allowImport", input),
  allowImportWithHello: input => call("allowImportWithHello", input),
  dismissPrompt: input => call("dismissPrompt", input),
  entries: () => call("entries"),
  entryOpen: input => call("entryOpen", input),
  entryReveal: input => call("entryReveal", input),
  entryCopy: input => call("entryCopy", input),
  entryCode: input => call("entryCode", input),
  entryCopyCode: input => call("entryCopyCode", input),
  entryOpenSite: input => call("entryOpenSite", input),
  entryFavorite: input => call("entryFavorite", input),
  entrySave: input => call("entrySave", input),
  entryRemove: input => call("entryRemove", input),
  entryUndo: input => call("entryUndo", input),
  saveSettings: input => call("saveSettings", input),
  enableHello: input => call("enableHello", input),
  disableHello: () => call("disableHello"),
  dismissTour: () => call("dismissTour"),
  cancelClose: () => call("cancelClose"),
  confirmClose: () => call("confirmClose"),
  interact: () => call("interact"),
  retry: () => call("retry"),
  minimize: () => call("minimize"),
  toggleMaximize: () => call("toggleMaximize"),
  close: () => call("close"),
} satisfies VaultBridge;
contextBridge.exposeInMainWorld("vault", Object.freeze(bridge));
