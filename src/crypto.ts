// This module only handles browser-memory keys. No plaintext is sent to the server.
import type { Envelope, Sealed, VaultState } from "./model";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function base64(bytes: Uint8Array): string { return btoa(Array.from(bytes, b => String.fromCharCode(b)).join("")); }
export function unbase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
async function derived(secret: string, salt: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: unbase64(salt), iterations: 600000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
async function importKey(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> { return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]); }
export async function encrypt(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>, context: string): Promise<Sealed> {
  const iv = random(12);
  return { iv: base64(iv), data: base64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`nebula-vault:1:${context}`) }, key, bytes))) };
}
export async function decrypt(key: CryptoKey, sealed: Sealed, context: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(sealed.iv), additionalData: encoder.encode(`nebula-vault:1:${context}`) }, key, unbase64(sealed.data)));
}
export const encryptJson = (key: CryptoKey, value: unknown, context: string) => encrypt(key, encoder.encode(JSON.stringify(value)), context);
export async function decryptJson<T>(key: CryptoKey, sealed: Sealed, context: string): Promise<T> {
  const bytes = await decrypt(key, sealed, context);
  try { return JSON.parse(decoder.decode(bytes)) as T; } finally { bytes.fill(0); }
}
async function proof(key: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    const hmac = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return base64(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, encoder.encode("nebula-vault:authenticate:1"))));
  } finally { bytes.fill(0); }
}
export async function hashProof(value: string): Promise<string> { return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", unbase64(value)))); }
export function recoveryKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 120 bits, six groups as on the board.
  return Array.from(random(24), b => alphabet[b % 32]).join("").match(/.{4}/g)!.join(" - ");
}
export function normalizeRecovery(value: string): string { return value.toUpperCase().replace(/[\s-]/g, ""); }
export async function createEnvelope(password: string, retained?: Uint8Array<ArrayBuffer>): Promise<{ state: VaultState; recovery: string; key: CryptoKey; masterProof: string }> {
  if (password.length < 15 || password.length > 128) throw new Error("invalid");
  const dataKey = retained ?? random(32), recovery = recoveryKey();
  const masterSalt = base64(random(16)), recoverySalt = base64(random(16));
  const masterKey = await derived(password, masterSalt), recoverKey = await derived(normalizeRecovery(recovery), recoverySalt);
  const masterProof = await proof(masterKey), recoveryProof = await proof(recoverKey);
  try {
    const state: VaultState = { format: 1, iterations: 600000, masterSalt, recoverySalt,
      master: await encrypt(masterKey, dataKey, "master"), recovery: await encrypt(recoverKey, dataKey, "recovery"),
      masterHash: await hashProof(masterProof), recoveryHash: await hashProof(recoveryProof) };
    return { state, recovery, key: await importKey(dataKey), masterProof };
  } finally { dataKey.fill(0); }
}
export async function unlock(envelope: Envelope, password: string, recover = false): Promise<{ key: CryptoKey; proof: string; bytes: Uint8Array<ArrayBuffer> }> {
  if (envelope.format !== 1 || envelope.iterations !== 600000 || password.length > 128 || (recover && !/^[A-HJ-NP-Z2-9]{24}$/.test(normalizeRecovery(password)))) throw new Error("invalid");
  const wrap = await derived(recover ? normalizeRecovery(password) : password, recover ? envelope.recoverySalt : envelope.masterSalt);
  const bytes = await decrypt(wrap, recover ? envelope.recovery : envelope.master, recover ? "recovery" : "master");
  if (bytes.length !== 32) { bytes.fill(0); throw new Error("invalid"); }
  return { key: await importKey(bytes), proof: await proof(wrap), bytes };
}

// Rejection sampling keeps every character equally likely, and every selected group present.
export function generatePassword(length: number, symbols = true, numbers = true, uppercase = true): string {
  const groups = ["abcdefghijklmnopqrstuvwxyz", ...(uppercase ? ["ABCDEFGHIJKLMNOPQRSTUVWXYZ"] : []), ...(numbers ? ["0123456789"] : []), ...(symbols ? ["!@#$%&*+-=?"] : [])];
  if (!Number.isInteger(length) || length < 8 || length > 64) throw new Error("invalid");
  const pick = (chars: string) => { let n: number; do { n = random(1)[0]; } while (n >= 256 - 256 % chars.length); return chars[n % chars.length]; };
  const result = groups.map(pick); const alphabet = groups.join("");
  while (result.length < length) result.push(pick(alphabet));
  for (let i = result.length - 1; i > 0; i--) { let n: number; do { n = random(1)[0]; } while (n >= 256 - 256 % (i + 1)); const j = n % (i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result.join("");
}

export function parseTotp(input: string): { secret: string; algorithm: string; digits: number; period: number } {
  let secret = input.trim(), algorithm = "SHA-1", digits = 6;
  if (secret.startsWith("otpauth://")) {
    const url = new URL(secret);
    if (url.hostname !== "totp") throw new Error("invalid");
    secret = url.searchParams.get("secret") || "";
    const a = (url.searchParams.get("algorithm") || "SHA1").toUpperCase();
    algorithm = ({ SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" } as Record<string, string>)[a];
    digits = Number(url.searchParams.get("digits") || 6);
    if (Number(url.searchParams.get("period") || 30) !== 30) throw new Error("invalid");
  }
  secret = secret.toUpperCase().replace(/\s|=+$/g, "");
  if (!/^[A-Z2-7]{16,208}$/.test(secret) || !algorithm || ![6, 8].includes(digits)) throw new Error("invalid");
  return { secret, algorithm, digits, period: 30 };
}
export async function totp(input: string, time = Date.now()): Promise<string> {
  const { secret, algorithm, digits } = parseTotp(input);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = ""; for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Uint8Array.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: algorithm }, false, ["sign"]); bytes.fill(0);
  const counter = new Uint8Array(8); new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(time / 30000)));
  const result = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = result.at(-1)! & 15;
  const code = (new DataView(result.buffer).getUint32(offset) & 0x7fffffff) % 10 ** digits;
  result.fill(0); return String(code).padStart(digits, "0");
}
