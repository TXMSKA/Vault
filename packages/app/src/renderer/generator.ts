/** The password generator: a length and three switches, from the system's random numbers. Lower case letters are always in. */
export type GeneratorOptions = { length: number; symbols: boolean; numbers: boolean; uppercase: boolean };
export const LENGTH_MIN = 8;
export const LENGTH_MAX = 64;
export const DEFAULT_GENERATOR: GeneratorOptions = { length: 20, symbols: true, numbers: true, uppercase: true };
export const LOWER = "abcdefghijklmnopqrstuvwxyz";
export const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const NUMBERS = "0123456789";
export const SYMBOLS = "!@#$%^&*-_=+?";
export const clampLength = (value: number) => Number.isFinite(value) ? Math.min(LENGTH_MAX, Math.max(LENGTH_MIN, Math.round(value))) : DEFAULT_GENERATOR.length;
/** A whole number from 0 up to but not including `limit`, with no bias toward the low ones. */
export function randomBelow(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 ** 32) throw new RangeError("limit");
  const span = 2 ** 32, fair = span - span % limit, buffer = new Uint32Array(1);
  for (;;) { crypto.getRandomValues(buffer); if (buffer[0] < fair) return buffer[0] % limit; }
}
/** The sets in use for these options, lower case first. */
export const alphabets = (options: GeneratorOptions) => [LOWER, ...options.uppercase ? [UPPER] : [], ...options.numbers ? [NUMBERS] : [], ...options.symbols ? [SYMBOLS] : []];
/**
 * A password of the chosen length that has at least one character of every set in use. `random` answers a whole number below its limit and is the
 * system's unless a test brings its own.
 */
export function generate(options: GeneratorOptions, random: (limit: number) => number = randomBelow): string {
  const length = clampLength(options.length), sets = alphabets(options), all = sets.join("");
  const chosen = sets.map(set => set[random(set.length)]);
  while (chosen.length < length) chosen.push(all[random(all.length)]);
  for (let i = chosen.length - 1; i > 0; i--) { const j = random(i + 1); [chosen[i], chosen[j]] = [chosen[j], chosen[i]]; }
  return chosen.join("");
}
