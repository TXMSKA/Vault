import type { Settings } from "./types.ts";
export const IDLE_CHOICES = [1, 5, 15, 30, 60, 240] as const;
export const LANGUAGES = ["system", "en", "es"] as const;
export const THEMES = ["system", "dark", "light"] as const;
export const DEFAULT_SETTINGS: Settings = { idleMinutes: 5, lockWithLastApp: true, language: "system", theme: "system" };
/** Exactly the four keys, each one a listed value; anything else is refused. */
export function isSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === "idleMinutes,language,lockWithLastApp,theme" && IDLE_CHOICES.some(choice => choice === v.idleMinutes) && typeof v.lockWithLastApp === "boolean" && LANGUAGES.some(choice => choice === v.language) && THEMES.some(choice => choice === v.theme);
}
