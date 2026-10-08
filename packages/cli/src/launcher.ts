import { lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { VaultClientError } from "../../client/src/index.ts";
import { privateDirectory } from "../../client/src/private.ts";
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
    addToUserPath(bin); return null;
  }
  if (/['\r\n]/.test(node + cli)) throw new VaultClientError("invalid");
  const launcher = join(bin, "vault"); await atomicText(launcher, `#!/bin/sh\nexec '${node}' '${cli}' "$@"\n`, 0o700);
  if (process.env.VAULT_HOME) return bin;
  const local = join(homedir(), ".local", "bin"), link = join(local, "vault"); await mkdir(local, { recursive: true });
  const existing = await lstat(link).catch(() => undefined);
  if (existing && !existing.isSymbolicLink()) return bin;
  await rm(link, { force: true }); await symlink(launcher, link); return null;
}
// Reads the user Path without expanding it, keeps its registry kind, and announces the change so new terminals see it.
function addToUserPath(bin: string) {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "$ErrorActionPreference='Stop'; $d=$env:VAULT_BIN; $k=Get-Item -LiteralPath 'HKCU:\\Environment'; $has=$k.GetValueNames() -contains 'Path'; $p=if($has){[string]$k.GetValue('Path','','DoNotExpandEnvironmentNames')}else{''}; $kind=if($has){[string]$k.GetValueKind('Path')}else{'ExpandString'}; $parts=@($p -split ';' | Where-Object { $_ -ne '' }); if($parts -notcontains $d){ New-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name 'Path' -Value (($parts + $d) -join ';') -PropertyType $kind -Force | Out-Null; [Environment]::SetEnvironmentVariable('VAULT_PATH_REFRESH',$null,'User') }";
  try { execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: "ignore", timeout: 10000, env: { ...process.env, VAULT_BIN: bin } }); }
  catch (error) { throw new VaultClientError("path_failed", { cause: error }); }
}
