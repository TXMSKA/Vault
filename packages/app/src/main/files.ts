import { open, rm } from "node:fs/promises";
import { basename } from "node:path";
import { readCapped, recoveryKit } from "vault-client";
import type { Backup } from "vault-client";
/** Saves the recovery kit as a new file, readable by its owner only; an existing file is never replaced. */
export async function writeKit(filename: string, recovery: string): Promise<"saved" | "exists" | "failed"> {
  const target = filename.toLowerCase().endsWith(".txt") ? filename : `${filename}.txt`;
  let file;
  try { file = await open(target, "wx", 0o600); } catch (error) { return (error as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed"; }
  let saved = false;
  try { await file.writeFile(recoveryKit(recovery)); await file.sync(); saved = true; return "saved"; }
  catch { return "failed"; }
  finally { await file.close(); if (!saved) await rm(target, { force: true }); }
}
export const kitName = (filename: string) => { const name = basename(filename); return name.toLowerCase().endsWith(".txt") ? name : `${name}.txt`; };
/** Reads a Vault backup: JSON of at most 8 MB with exactly the backup's keys. Anything else is not a backup. */
export async function readBackup(filename: string): Promise<Backup | undefined> {
  try {
    const value: unknown = JSON.parse(await readCapped(filename));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "envelope,format,sealed,version") return undefined;
    const backup = value as Backup;
    return backup.format === "vault-backup" && backup.version === 1 ? backup : undefined;
  } catch { return undefined; }
}
