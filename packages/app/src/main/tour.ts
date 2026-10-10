import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readCapped } from "vault-client";
/**
 * Whether the first-open tips were dismissed, kept in the app's own folder (inside the vault home), never in the service's.
 * A missing or unreadable file means they were not; a dismissal counts for this run even when the file cannot be written.
 */
export function createTour(folder: string) {
  const file = join(folder, "tour.json");
  let dismissed = false;
  return {
    async load() {
      try { const value: unknown = JSON.parse(await readCapped(file, 1024)); dismissed = !!value && typeof value === "object" && (value as { dismissed?: unknown }).dismissed === true; }
      catch { dismissed = false; }
    },
    pending: () => !dismissed,
    async dismiss(): Promise<void> {
      dismissed = true;
      const temporary = `${file}.${process.pid}.tmp`;
      try { await mkdir(folder, { recursive: true }); await writeFile(temporary, JSON.stringify({ dismissed: true }), { mode: 0o600 }); await rename(temporary, file); }
      catch { await rm(temporary, { force: true }).catch(() => undefined); }
    },
  };
}
export type Tour = ReturnType<typeof createTour>;
