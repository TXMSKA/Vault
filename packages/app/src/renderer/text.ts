/** Control, invisible and direction characters are shown as escapes, so a request cannot disguise what it says or runs. */
export const visible = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** A command as a person would type it: arguments with spaces or shell characters in quotes, every character that could hide something as an escape. */
export const commandLine = (argv: readonly string[]) => argv.map(arg => !arg || /[\s"'`$&|;<>()^%!*?]/.test(arg) ? `"${visible(arg).replace(/"/g, '\\"')}"` : visible(arg)).join(" ");
/** The recovery key in groups of four, three groups to a line. */
export function keyLines(recovery: string): string[] {
  const groups = recovery.toUpperCase().replace(/[^A-Z0-9]/g, "").match(/.{1,4}/g) ?? [], lines: string[] = [];
  for (let i = 0; i < groups.length; i += 3) lines.push(groups.slice(i, i + 3).join("-"));
  return lines;
}
/** Whole minutes left, rounded up; 0 when the time is up. */
export const minutesLeft = (expiresAt: string, now: number) => Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60000));
