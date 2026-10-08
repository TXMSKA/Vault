import { encrypt, decrypt } from "./crypto.js";
import type { Sealed, VaultState } from "./model.js";
import { id, version, shape, sealed, chunkIds, stateInput, VaultError } from "./store.js";
export const SYNC_FORMAT = "vault-sync", SYNC_VERSION = 1, SYNC_PACKAGE_CAP = 8 * 1024 * 1024, SYNC_BLOB_CAP = 64 * 1024, SYNC_FILE_LIMIT = 10000, SYNC_WRITER_LIMIT = 64, SYNC_CALL_MS = 30000, SYNC_PULSE_MS = 60000, SYNC_WRITE_MS = 5000, SYNC_CHECKPOINT_OPS = 500, SYNC_TOMBSTONE_MS = 90 * 86400000, SYNC_COMPACT_MS = 30 * 86400000;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", sequence = "(?:0|[1-9][0-9]{0,15})";
export const syncPatterns = { writer: new RegExp(`^${uuid}$`), batch: new RegExp(`^(${sequence})-(${uuid})\\.vsync$`), checkpoint: new RegExp(`^(${sequence})-(${uuid})-([1-9][0-9]{0,3})-([1-9][0-9]{0,3})\\.vsync$`), blob: new RegExp(`^(${uuid})\\.vsync$`) };
export type SyncAddress = { datasetId: string; deviceId: string; generationId: string; type: "batch" | "checkpoint" | "blob" | "envelope"; sequence: number; packageId: string };
export type SyncEntry = { sealed: Sealed; chunks: string[] };
export type SyncOperation = { record: "entry" | "envelope"; id: string; revision: string; base: string | null; deviceId: string; time: number; value: SyncEntry | VaultState | null };
export type SyncBatch = { operations: SyncOperation[] };
export type SyncCheckpoint = { records: SyncOperation[]; applied: Record<string, number>; time: number; part: number; parts: number };
export type SyncBlob = { id: string; sealed: Sealed };
export type SyncDataset = { format: "vault-sync"; version: 1; datasetId: string; createdAt: number; envelope: VaultState };
export function syncNumber(value: unknown, zero = true): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new VaultError("invalid"); return value; }
function time(value: unknown) { const result = syncNumber(value); if (!Number.isFinite(new Date(result).getTime())) throw new VaultError("invalid"); return result; }
export function syncOperation(value: unknown): SyncOperation {
  shape(value, "base,deviceId,id,record,revision,time,value"); const v = value as SyncOperation; id(v.revision); id(v.deviceId); if (v.base !== null) id(v.base); time(v.time);
  if (v.record === "entry") { id(v.id); if (v.value !== null) { shape(v.value, "chunks,sealed"); const entry = v.value as SyncEntry; sealed(entry.sealed, 220000); chunkIds(entry.chunks); } }
  else if (v.record === "envelope" && v.id === "envelope" && v.value !== null) stateInput(v.value);
  else throw new VaultError("invalid"); return v;
}
export function syncApplied(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > SYNC_WRITER_LIMIT) throw new VaultError("invalid");
  for (const [writer, seq] of Object.entries(value)) { const parts = writer.split("/"); if (parts.length !== 2) throw new VaultError("invalid"); parts.forEach(id); syncNumber(seq); } return value as Record<string, number>;
}
export function syncPlaintext(type: SyncAddress["type"], value: unknown): SyncBatch | SyncCheckpoint | SyncBlob | SyncOperation {
  if (type === "blob") { shape(value, "id,sealed"); const v = value as SyncBlob; id(v.id); sealed(v.sealed, 32784); return v; }
  if (type === "envelope") { const op = syncOperation(value); if (op.record !== "envelope") throw new VaultError("invalid"); return op; }
  shape(value, type === "batch" ? "operations" : "applied,part,parts,records,time");
  const v = value as SyncBatch & SyncCheckpoint, operations = type === "batch" ? v.operations : v.records;
  if (!Array.isArray(operations) || operations.length > 10000) throw new VaultError("invalid"); operations.forEach(syncOperation);
  if (new Set(operations.map(op => op.id.toLowerCase())).size !== operations.length) throw new VaultError("invalid");
  if (type === "checkpoint") { syncApplied(v.applied); time(v.time); version(v.part); version(v.parts); if (v.part > v.parts || v.parts > 4096) throw new VaultError("invalid"); } return v;
}
export function syncDataset(value: unknown): SyncDataset {
  shape(value, "createdAt,datasetId,envelope,format,version"); const v = value as SyncDataset; if (v.format !== SYNC_FORMAT || v.version !== SYNC_VERSION) throw new VaultError("invalid"); id(v.datasetId); time(v.createdAt); stateInput(v.envelope); return v;
}
function context(a: SyncAddress) { id(a.datasetId); id(a.deviceId); id(a.generationId); id(a.packageId); syncNumber(a.sequence); if (!["batch", "checkpoint", "blob", "envelope"].includes(a.type)) throw new VaultError("invalid"); return `sync:${a.datasetId}:${a.deviceId}:${a.generationId}:${a.type}:${a.sequence}:${a.packageId}`; }
export async function sealSync(key: CryptoKey, address: SyncAddress, value: unknown): Promise<string> {
  syncPlaintext(address.type, value); const bytes = new TextEncoder().encode(JSON.stringify(value)), cap = address.type === "blob" ? SYNC_BLOB_CAP : SYNC_PACKAGE_CAP;
  try { if (bytes.length > cap) throw new VaultError("limited"); const result = JSON.stringify({ format: SYNC_FORMAT, version: SYNC_VERSION, sealed: await encrypt(key, bytes, context(address)) }); if (Buffer.byteLength(result) > cap) throw new VaultError("limited"); return result; } finally { bytes.fill(0); }
}
export async function openSync(key: CryptoKey, address: SyncAddress, input: string): Promise<SyncBatch | SyncCheckpoint | SyncBlob | SyncOperation> {
  const cap = address.type === "blob" ? SYNC_BLOB_CAP : SYNC_PACKAGE_CAP; let bytes;
  try { if (Buffer.byteLength(input) > cap) throw new VaultError("limited"); const parsed = JSON.parse(input); shape(parsed, "format,sealed,version"); if (parsed.format !== SYNC_FORMAT || parsed.version !== SYNC_VERSION) throw new VaultError("invalid"); bytes = await decrypt(key, sealed(parsed.sealed, cap), context(address)); return syncPlaintext(address.type, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (error) { throw error instanceof VaultError ? error : new VaultError("invalid"); } finally { bytes?.fill(0); }
}
export function syncWinner(a: SyncOperation, b: SyncOperation): SyncOperation { return a.time !== b.time ? a.time > b.time ? a : b : a.deviceId !== b.deviceId ? a.deviceId > b.deviceId ? a : b : a.revision > b.revision ? a : b; }
