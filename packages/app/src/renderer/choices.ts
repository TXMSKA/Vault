import type { SettingsView } from "../shared/api.js";
/** The choices the settings offer, in the order they are listed, and the one change a choice makes. The main process accepts these and no others. */
export const IDLE_CHOICES = [1, 5, 15, 30, 60, 240] as const;
export const LANGUAGE_CHOICES = ["system", "en", "es"] as const;
export const THEME_CHOICES = ["system", "dark", "light"] as const;
/** The settings with one value changed; every other value stays. */
export function withChoice<K extends keyof SettingsView>(settings: SettingsView, key: K, value: SettingsView[K]): SettingsView {
  return { idleMinutes: settings.idleMinutes, lockWithLastApp: settings.lockWithLastApp, language: settings.language, theme: settings.theme, [key]: value };
}
