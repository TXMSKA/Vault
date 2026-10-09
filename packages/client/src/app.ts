import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstallRecord } from "./types.ts";
const absolute = /^(?:[A-Za-z]:[\\/]|\/)/;
/** The Vault app that install.json names, or nothing while it names none, names no file, or the record is unreadable. */
export function installedApp(home: string): string | undefined {
  let install: Partial<InstallRecord> | null;
  try {
    const file = openSync(join(home, "install.json"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(file); if (!stat.isFile() || stat.size > 16384) return undefined;
      const text = Buffer.alloc(stat.size); readSync(file, text, 0, stat.size, 0); install = JSON.parse(text.toString("utf8"));
    } finally { closeSync(file); }
  } catch { return undefined; }
  const app = install && typeof install === "object" ? install.app : undefined;
  if (typeof app !== "string" || !absolute.test(app)) return undefined;
  try { return statSync(app, { throwIfNoEntry: false })?.isFile() ? app : undefined; } catch { return undefined; }
}
