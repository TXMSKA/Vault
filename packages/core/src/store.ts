import type { EncryptedEntry, Sealed, VaultState } from "./model.js";

export class VaultError extends Error {
  constructor(public code: "invalid" | "locked" | "conflict" | "unavailable" | "not_found" | "limited", options?: ErrorOptions) { super(code, options); }
}
export type StoredEnvelope = { state: VaultState | null; version: number };
export type StoredEntry = EncryptedEntry & { chunks: string[] };
export interface VaultStore {
  readonly identity?: object;
  envelope(): Promise<StoredEnvelope>;
  create(value: VaultState): Promise<{ version: number }>;
  replace(value: VaultState, expected: number): Promise<{ version: number }>;
  entries(): Promise<StoredEntry[]>;
  save(entryId: string, value: Sealed, expected: number, chunks: string[]): Promise<{ version: number }>;
  remove(entryId: string, expected: number): Promise<void>;
  putChunk(chunkId: string, value: Sealed): Promise<{ version: number }>;
  getChunk(chunkId: string): Promise<Sealed>;
  removeChunk(chunkId: string): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function id(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) throw new VaultError("invalid"); return value; }
export function version(value: unknown, create = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (create ? 0 : 1)) throw new VaultError("invalid"); return value;
}
function string(value: unknown, size: number): string {
  if (typeof value !== "string" || value.length !== Math.ceil(size / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || Buffer.from(value, "base64").length !== size || Buffer.from(value, "base64").toString("base64") !== value) throw new VaultError("invalid"); return value;
}
export function shape(value: unknown, keys: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys) throw new VaultError("invalid");
}
export function sealed(value: unknown, max = 48000): Sealed {
  shape(value, "data,iv"); const v = value as Sealed; string(v.iv, 12);
  if (typeof v.data !== "string" || v.data.length > max * 1.4) throw new VaultError("invalid");
  const bytes = Buffer.from(v.data, "base64");
  if (bytes.length < 16 || bytes.length > max || bytes.toString("base64") !== v.data) throw new VaultError("invalid"); return { iv: v.iv, data: v.data };
}
export function stateInput(value: unknown): VaultState {
  shape(value, "format,iterations,master,masterHash,masterSalt,recovery,recoveryHash,recoverySalt"); const v = value as VaultState;
  if (v.format !== 1 || v.iterations !== 600000) throw new VaultError("invalid");
  const master = sealed(v.master, 48), recovery = sealed(v.recovery, 48);
  if (Buffer.from(master.data, "base64").length !== 48 || Buffer.from(recovery.data, "base64").length !== 48) throw new VaultError("invalid");
  return { format: 1, iterations: 600000, masterSalt: string(v.masterSalt, 16), recoverySalt: string(v.recoverySalt, 16), master, recovery, masterHash: string(v.masterHash, 32), recoveryHash: string(v.recoveryHash, 32) };
}
export function chunkIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 2560) throw new VaultError("invalid");
  const result = value.map(id); if (new Set(result.map(value => value.toLowerCase())).size !== result.length) throw new VaultError("invalid"); return result;
}
export function errorCode(error: unknown): VaultError["code"] { return error instanceof VaultError ? error.code : "unavailable"; }
