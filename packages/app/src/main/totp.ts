import { createHmac } from "node:crypto";
/** One-time codes are the ones every authenticator makes: RFC 6238, SHA-1, 30 seconds, 6 digits. */
export const PERIOD = 30;
export const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** RFC 4648 base32 without case, spaces, hyphens or padding mattering; nothing when a character is not in the alphabet. */
export function base32(input: string): Buffer | undefined {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) return undefined;
  const bytes: number[] = []; let value = 0, bits = 0;
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); value &= (1 << bits) - 1; }
  }
  return bytes.length ? Buffer.from(bytes) : undefined;
}
/**
 * The key bytes of what is stored: a base32 secret, or an otpauth://totp address that carries one. An address that asks for anything but
 * SHA-1, 6 digits and 30 seconds is refused, since the code made here would not match the one the service expects.
 */
export function parseKey(stored: string): Buffer | undefined {
  const text = stored.trim();
  if (!/^otpauth:/i.test(text)) return base32(text);
  let url: URL; try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp") return undefined;
  const query = url.searchParams, secret = query.get("secret"), algorithm = query.get("algorithm"), digits = query.get("digits"), period = query.get("period");
  if (!secret || algorithm !== null && algorithm.toUpperCase() !== "SHA1" || digits !== null && digits !== String(DIGITS) || period !== null && period !== String(PERIOD)) return undefined;
  return base32(secret);
}
/** RFC 4226 for one counter value. */
export function hotp(secret: Uint8Array, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest(), offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}
/** The code for the moment `now` (milliseconds), and the whole seconds left until it changes. */
export function totp(secret: Uint8Array, now: number, digits = DIGITS): { code: string; remaining: number } {
  const seconds = Math.floor(now / 1000);
  return { code: hotp(secret, Math.floor(seconds / PERIOD), digits), remaining: PERIOD - seconds % PERIOD };
}
