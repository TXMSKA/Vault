import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findService, VaultClientError } from "../../client/src/index.ts";
import { atomicJson } from "../../client/src/files.ts";
import { prepareHome } from "../../client/src/private.ts";
import { installLauncher, removeLauncher } from "./launcher.ts";

const windows = process.platform === "win32", isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };

/** An installed copy keeps Node beside `lib/`, the compiled CLI and service under `lib/`, on Windows the helper too, and the app beside Node when there is one. */
export type Layout = { root: string; node: string; cli: string; service: string; helper?: string; app?: string };
/** The installed copy this module runs from, or nothing in a development checkout, which has none of these files. */
export function layout(source = import.meta.url): Layout | undefined {
  const root = resolve(fileURLToPath(source), "../../../.."), lib = join(root, "lib");
  const found = { root, node: join(root, windows ? "node.exe" : "node"), cli: join(lib, "cli", "src", "main.js"), service: join(lib, "service", "src", "main.js") }, helper = join(lib, "helper", "bin", "vault-helper.exe"), app = join(root, "Vault.exe");
  if (![found.node, found.cli, found.service].every(isFile) || windows && !isFile(helper)) return undefined;
  return { ...found, ...windows ? { helper } : {}, ...windows && isFile(app) ? { app } : {} };
}
/** The app named by --app: an existing file, whatever the folder it is called from. */
export function appFile(value: string): string {
  const path = resolve(value); if (!isFile(path)) throw new VaultClientError("invalid"); return path;
}
/** Records the installed copy for the client, then puts the launcher on the Path. Returns the folder still to add to the Path by hand, or null. */
export async function install(home: string, place: Layout, app = place.app): Promise<string | null> {
  prepareHome(home);
  await atomicJson(join(home, "install.json"), { version: 1, command: place.node, args: [place.service], ...place.helper ? { helper: place.helper } : {}, ...app ? { app } : {} });
  return installLauncher(home, place.cli, place.node);
}
/** Ends the background service when one answers for its recorded process, and waits until that process is gone. */
export async function stopService(home: string): Promise<void> {
  const record = await findService(home); if (!record) return;
  try { process.kill(record.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new VaultClientError("busy", { cause: error }); }
  for (let i = 0; i < 100; i++) { if (!alive(record.pid)) return; await pause(50); }
  throw new VaultClientError("busy");
}
/** Stops the service, takes the launcher and its Path entry away and forgets the installation; the data stays unless `wipe` deletes the whole data folder. Returns the folder still to remove from the Path by hand, or null. */
export async function uninstall(home: string, wipe: boolean): Promise<string | null> {
  if (wipe && dirname(home) === home) throw new VaultClientError("invalid");
  await stopService(home);
  const manual = await removeLauncher(home);
  await rm(join(home, "install.json"), { force: true });
  if (wipe) await rm(home, { recursive: true, force: true });
  return manual;
}
