import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VaultClientError } from "../../client/src/index.ts";
import { privateDirectory } from "../../client/src/private.ts";
import { runHelper } from "../../client/src/helper.ts";
import { atomicText } from "../../client/src/files.ts";

// dev-install puts a `vault` launcher in <home>/bin so every terminal finds the CLI.
// On Windows that folder joins the user Path; on Linux a link in ~/.local/bin points at it.
// A custom VAULT_HOME leaves the Path to the person, so tests never touch it.
// Returns the folder still to add to the Path, or null when nothing is left to do.
export async function installLauncher(home: string, cli: string): Promise<string | null> {
  const bin = join(home, "bin"), node = process.execPath; privateDirectory(bin);
  if (process.platform === "win32") {
    if (/["%\r\n]/.test(node + cli)) throw new VaultClientError("invalid");
    await atomicText(join(bin, "vault.cmd"), `@"${node}" "${cli}" %*\r\n`);
    if (process.env.VAULT_HOME) return bin;
    await addToUserPath(bin); return null;
  }
  if (/['\r\n]/.test(node + cli)) throw new VaultClientError("invalid");
  const launcher = join(bin, "vault"); await atomicText(launcher, `#!/bin/sh\nexec '${node}' '${cli}' "$@"\n`, 0o700);
  if (process.env.VAULT_HOME) return bin;
  const local = join(homedir(), ".local", "bin"), link = join(local, "vault"); await mkdir(local, { recursive: true });
  const existing = await lstat(link).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) return bin;
  await rm(link, { force: true }); await symlink(launcher, link); return null;
}
// The native helper reads the user Path without expanding it, keeps its registry kind, adds the folder when missing and announces the change so new terminals see it.
async function addToUserPath(bin: string) {
  try { await runHelper("user-path-add", { path: bin }); }
  catch (error) { throw new VaultClientError("path_failed", { cause: error }); }
}
