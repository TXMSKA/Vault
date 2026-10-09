import { VaultClientError } from "../../client/src/index.ts";
import { IDLE_CHOICES, LANGUAGES, THEMES } from "../../client/src/settings.ts";
import type { Settings } from "../../client/src/types.ts";
import { copy } from "./copy.ts";
const list = (choices: readonly unknown[]) => choices.join(", ");
/** One line per setting: its name, its value and what it does. */
export function settingLines(settings: Settings): string[] {
  const about: Record<keyof Settings, string> = {
    idleMinutes: copy(`minutes without use before Vault locks (${list(IDLE_CHOICES)})`, `minutos sin uso antes de que Vault se bloquee (${list(IDLE_CHOICES)})`),
    lockWithLastApp: copy("lock when the last app closes (true, false)", "bloquear al cerrarse la última app (true, false)"),
    language: copy(`language of the Vault app (${list(LANGUAGES)})`, `idioma de la app de Vault (${list(LANGUAGES)})`),
    theme: copy(`colors of the Vault app (${list(THEMES)})`, `colores de la app de Vault (${list(THEMES)})`),
  };
  return (Object.keys(about) as (keyof Settings)[]).map(key => `${key} | ${settings[key]} | ${about[key]}`);
}
/** The settings with one value changed, read from the words typed. The client refuses a value that is not listed. */
export function withSetting(current: Settings, key: string, value: string): Settings {
  if (!Object.hasOwn(current, key)) throw new VaultClientError("invalid");
  const typed = key === "idleMinutes" ? /^[0-9]{1,3}$/.test(value) ? Number(value) : NaN : key === "lockWithLastApp" ? ({ true: true, false: false } as Record<string, boolean>)[value] : value;
  return { ...current, [key]: typed } as Settings;
}
