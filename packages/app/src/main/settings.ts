import type { Settings } from "vault-client";
/** The choices the window offers are the ones the service accepts, in the order the window lists them. */
export const IDLE_MINUTES = [1, 5, 15, 30, 60, 240] as const;
export const LANGUAGES = ["system", "en", "es"] as const;
export const THEMES = ["system", "dark", "light"] as const;
export const DEFAULTS: Settings = { idleMinutes: 5, lockWithLastApp: true, language: "system", theme: "system" };
/** Exactly the four keys of the settings, each one a listed value. */
export function isSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === "idleMinutes,language,lockWithLastApp,theme" && IDLE_MINUTES.some(item => item === v.idleMinutes) && typeof v.lockWithLastApp === "boolean"
    && LANGUAGES.some(item => item === v.language) && THEMES.some(item => item === v.theme);
}
/** The settings to send the service: a new object of the four keys, so nothing else the window put on its input goes along. */
export const toService = (value: Settings): Settings => ({ idleMinutes: value.idleMinutes, lockWithLastApp: value.lockWithLastApp, language: value.language, theme: value.theme });
