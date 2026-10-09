import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { VaultClientError } from "../../client/src/index.ts";
import { privateDirectory } from "../../client/src/private.ts";
import { runHelper } from "../../client/src/helper.ts";
import { atomicText } from "../../client/src/files.ts";

// dev-install and install put a `vault` launcher in <home>/bin so every terminal finds the CLI.
// On Windows that folder joins the user Path; on Linux a link in ~/.local/bin points at it.
// A custom VAULT_HOME leaves the Path to the person, so tests never touch it.
// The launcher runs `node` on `cli`: this process's Node for a checkout, the installed copy's own for an install.
// Returns the folder still to add to the Path, or null when nothing is left to do.
export async function installLauncher(home: string, cli: string, node = process.execPath): Promise<string | null> {
  const bin = join(home, "bin"); privateDirectory(bin);
  if (process.platform === "win32") {
    if (/["%\r\n]/.test(node + cli)) throw new VaultClientError("invalid");
    // VAULT_LAUNCHER tells uninstall that cmd is still reading this file; setlocal keeps it out of the calling shell.
    await atomicText(join(bin, "vault.cmd"), `@setlocal & set "VAULT_LAUNCHER=1" & "${node}" "${cli}" %*\r\n`);
    if (process.env.VAULT_HOME) return bin;
    await changeUserPath("user-path-add", bin); return null;
  }
  if (/['\r\n]/.test(node + cli)) throw new VaultClientError("invalid");
  const launcher = join(bin, "vault"); await atomicText(launcher, `#!/bin/sh\nexec '${node}' '${cli}' "$@"\n`, 0o700);
  if (process.env.VAULT_HOME) return bin;
  const local = join(homedir(), ".local", "bin"), link = join(local, "vault"); await mkdir(local, { recursive: true });
  const existing = await lstat(link).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) return bin;
  await rm(link, { force: true }); await symlink(launcher, link); return null;
}
// uninstall takes the launcher and its Path entry away again, the same way and under the same VAULT_HOME rule.
// Returns the folder still to remove from the Path, or null when nothing is left to do.
export async function removeLauncher(home: string): Promise<string | null> {
  const bin = join(home, "bin"), custom = !!process.env.VAULT_HOME;
  if (!custom && process.platform === "win32") await changeUserPath("user-path-remove", bin);
  if (!custom && process.platform !== "win32") { const link = join(homedir(), ".local", "bin", "vault"); if (await readlink(link).catch(() => undefined) === join(bin, "vault")) await rm(link, { force: true }); }
  // Run through vault.cmd, cmd reads the file again after this process ends, so a detached Node removes the folder a moment later.
  if (process.platform === "win32" && process.env.VAULT_LAUNCHER === "1") spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 3000)", bin], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else await rm(bin, { recursive: true, force: true });
  return custom ? bin : null;
}
// The native helper reads the user Path without expanding it, keeps its registry kind, adds or removes the folder when needed and announces the change so new terminals see it.
async function changeUserPath(verb: "user-path-add" | "user-path-remove", bin: string) {
  try { await runHelper(verb, { path: bin }); }
  catch (error) { throw new VaultClientError(verb === "user-path-add" ? "path_failed" : "path_remove_failed", { cause: error }); }
}
