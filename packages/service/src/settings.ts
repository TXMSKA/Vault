import { join } from "node:path";
import { atomicJson, readCapped } from "../../client/src/files.ts";
import { DEFAULT_SETTINGS, isSettings } from "../../client/src/settings.ts";
import type { Settings as SettingsView } from "../../client/src/types.ts";
import { ServiceError } from "./errors.ts";
/** The person's choices, kept in <home>/settings.json. A missing or unreadable file means the defaults, and the next change writes a good one. */
export class Settings {
  filename: string; value: SettingsView = { ...DEFAULT_SETTINGS };
  constructor(home: string) { this.filename = join(home, "settings.json"); }
  async load() {
    try { const value: unknown = JSON.parse(await readCapped(this.filename, 4096)); if (isSettings(value)) this.value = { ...value }; } catch {}
  }
  get(): SettingsView { return { ...this.value }; }
  get idleMs() { return this.value.idleMinutes * 60000; }
  /** Every value is validated; the file is replaced atomically before the new choices count. */
  async save(value: unknown): Promise<SettingsView> {
    if (!isSettings(value)) throw new ServiceError("invalid");
    const next = { idleMinutes: value.idleMinutes, lockWithLastApp: value.lockWithLastApp, language: value.language, theme: value.theme };
    await atomicJson(this.filename, next); this.value = next; return this.get();
  }
}
