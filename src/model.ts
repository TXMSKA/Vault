export const KINDS = ["login", "card", "doc", "note", "key", "custom"] as const;
export type Kind = typeof KINDS[number];
export type Field = { id: string; name: string; value: string; secret: boolean };
export type Attachment = { id: string; name: string; type: string; size: number; chunks: string[] };
export type Entry = {
  id: string; kind: Kind; title: string; favorite: boolean; fields: Field[]; note: string;
  totp: string; recovery: { value: string; used: boolean }[]; files: Attachment[]; updatedAt: string;
};
export type Sealed = { iv: string; data: string };
export type Envelope = {
  format: 1; iterations: 600000; masterSalt: string; recoverySalt: string; master: Sealed; recovery: Sealed;
};
export type VaultState = Envelope & { masterHash: string; recoveryHash: string };
export type EncryptedEntry = { id: string; version: number; sealed: Sealed };
export const IDLE_MS = 5 * 60 * 1000;
export const CLIPBOARD_MS = 30 * 1000;
export const CHUNK_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ENTRIES = 250;
export const FIELD_KEYS = {
  login: ["username", "password", "website"], card: ["bank", "number", "expiry", "securityCode", "holder", "pin"],
  doc: [], note: [], key: ["key", "license"], custom: [],
} satisfies Record<Kind, string[]>;

export function filename(value: string): string {
  return value.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "").slice(0, 180).trim() || "document";
}

export function newEntry(kind: Kind): Entry {
  return { id: crypto.randomUUID(), kind, title: "", favorite: false, fields: FIELD_KEYS[kind].map(id => ({ id, name: "", value: "", secret: ["password", "number", "securityCode", "pin", "key", "license"].includes(id) })), note: "", totp: "", recovery: [], files: [], updatedAt: new Date().toISOString() };
}
