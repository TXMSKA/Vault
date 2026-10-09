import type { Language, Theme } from "../shared/api.js";
import type { Settings } from "vault-client";
/** "system" follows the operating system: the language of the locale (Spanish for any "es" locale, English otherwise) and its dark or light mode. */
export const resolveLanguage = (setting: Settings["language"], locale: string): Language => setting === "system" ? /^es(?:[-_]|$)/i.test(locale) ? "es" : "en" : setting;
export const resolveTheme = (setting: Settings["theme"], dark: boolean): Theme => setting === "system" ? dark ? "dark" : "light" : setting;
/** The window's own colours before the page paints, so a start never flashes white: the body of each theme and its title bar. */
export const BACKGROUNDS: Record<Theme, { surface: string; chrome: string }> = { dark: { surface: "#161a20", chrome: "#111419" }, light: { surface: "#e6e8eb", chrome: "#dde0e4" } };
