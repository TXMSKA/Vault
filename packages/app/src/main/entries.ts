import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { CHUNK_BYTES, MAX_FILE_BYTES, filename } from "vault-core";
import type { Client, Entry, Field } from "vault-client";
import type { EntryInput, EntrySummary, EntryView, FileView, Result } from "../shared/api.js";
import type { Clipboard } from "./clipboard.ts";
import { codeOf } from "./link.ts";
import { parseKey, totp } from "./totp.ts";
/** How long a deleted entry can be put back. The window's toast stays up for less than this. */
export const UNDO_MS = 15000;
const SEARCH_CAP = 600;
/** The value of a field that is not secret; a secret field, or none, is nothing. */
const plain = (entry: Entry, id: string) => { const field = entry.fields.find(item => item.id === id); return field && !field.secret ? field.value : ""; };
const host = (site: string) => { try { const url = new URL(site); return /^https?:$/.test(url.protocol) ? url.hostname : site.trim(); } catch { return site.trim(); } };
/** The second line of a row, from fields that are not secret: a username or a website's host, a bank or a holder, a file type. */
export function detailOf(entry: Entry): string {
  if (entry.kind === "login") return plain(entry, "username").trim() || host(plain(entry, "website"));
  if (entry.kind === "card") return plain(entry, "bank").trim() || plain(entry, "holder").trim();
  if (entry.kind === "apikey") return plain(entry, "provider").trim();
  if (entry.kind === "doc") { const name = entry.files[0]?.name ?? "", dot = name.lastIndexOf("."); return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase().slice(0, 8) : ""; }
  return "";
}
/** A row of the list: titles, usernames, websites and the other fields that are not secret, and nothing the entry keeps hidden. */
export function summarize(entry: Entry, version: number): EntrySummary {
  const text = [entry.title, ...entry.fields.filter(field => !field.secret).map(field => field.value)].join("\n").toLowerCase().slice(0, SEARCH_CAP);
  return {
    id: entry.id, kind: entry.kind, title: entry.title, favorite: entry.favorite, version, updatedAt: entry.updatedAt, detail: detailOf(entry),
    count: entry.kind === "env" || entry.kind === "custom" ? entry.fields.length : entry.kind === "doc" ? entry.files.length : 0, search: text,
  };
}
/** An open entry as the window gets it: a secret field says whether it holds a value, and the value stays here; the note and the one-time code key are always hidden. */
export function viewOf(entry: Entry, version: number): EntryView {
  return {
    id: entry.id, kind: entry.kind, title: entry.title, favorite: entry.favorite, version, updatedAt: entry.updatedAt,
    fields: entry.fields.map(field => ({ id: field.id, name: field.name, secret: field.secret, filled: field.value.length > 0, value: field.secret ? null : field.value })),
    note: { filled: entry.note.length > 0 }, totp: entry.totp.length > 0, files: entry.files.map(file => ({ id: file.id, name: file.name, type: file.type, size: file.size })),
  };
}
/**
 * What is saved: the window's entry laid over the one the service holds. A secret field, the note or the one-time code key that the window left
 * out keeps its value; files come from the main process. A custom or environment entry has exactly the fields the window sends;
 * any other kind also keeps the fields the window did not mention.
 */
export function merge(old: Entry | undefined, input: EntryInput, updatedAt: string, files = old?.files ?? []): Entry {
  const before = new Map((old?.fields ?? []).map(field => [field.id, field]));
  const fields: Field[] = input.fields.map(field => ({ id: field.id, name: field.name, secret: field.secret, value: field.value ?? before.get(field.id)?.value ?? "" }));
  if (old && old.kind !== "custom" && old.kind !== "env") for (const field of old.fields) if (!input.fields.some(item => item.id === field.id)) fields.push({ ...field });
  return {
    id: input.id, kind: input.kind, title: input.title, favorite: input.favorite, fields, note: input.note ?? old?.note ?? "", totp: input.totp ?? old?.totp ?? "",
    recovery: old ? old.recovery.map(item => ({ ...item })) : [], files: files.map(file => ({ ...file, chunks: [...file.chunks] })), updatedAt,
  };
}
const newest = (a: EntrySummary, b: EntrySummary) => a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1);
export type EntriesOptions = { service(): Client | undefined; clipboard: Clipboard; openUrl(url: string): Promise<void>; now?(): number; undoMs?: number };
/**
 * The entries as the window sees them. The list and the open entry that go to the window have no secret value; a value is fetched from the service again
 * for the one call that reveals, copies or turns it into a one-time code, and is never kept here.
 */
export function createEntries(options: EntriesOptions) {
  const now = options.now ?? Date.now, undoMs = options.undoMs ?? UNDO_MS;
  const pending = new Map<string, { name: string; type: string; size: number; bytes: Buffer }>(); let generation = 0;
  const discard = () => { generation++; for (const file of pending.values()) file.bytes.fill(0); pending.clear(); };
  let views = new Map<string, EntryView>(), held: { entry: Entry; timer: NodeJS.Timeout } | undefined;
  async function run<T extends object>(work: (service: Client) => Promise<T>): Promise<Result<T>> {
    const service = options.service(); if (!service) return { ok: false, code: "unavailable" };
    try { return { ok: true, ...await work(service) } as Result<T>; } catch (error) { return { ok: false, code: codeOf(error) }; }
  }
  const part = (entry: Entry, name: string) => name === "note" ? entry.note : name.startsWith("f:") ? entry.fields.find(field => field.id === name.slice(2))?.value : undefined;
  const iso = () => new Date(now()).toISOString();
  const forget = () => { if (held) clearTimeout(held.timer); held = undefined; };
  const found = (value: string | undefined) => { if (value === undefined || value === "") throw { code: "not_found" }; return value; };
  return {
    attach: (path: string) => run(async () => {
      if (pending.size >= 50) throw { code: "limited" };
      const ticket = generation;
      if (!(await lstat(path)).isFile()) throw { code: "invalid" };
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let bytes: Buffer | undefined;
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw { code: "too_large" };
        bytes = Buffer.alloc(stat.size + 1); let size = 0;
        while (size < bytes.length) { const part = await handle.read(bytes, size, bytes.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
        if (!size || size !== stat.size) throw { code: "too_large" };
        if (ticket !== generation) throw { code: "locked" };
        if (pending.size >= 50) throw { code: "limited" };
        const name = filename(path), types: Record<string, string> = { pdf: "application/pdf", txt: "text/plain", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", json: "application/json", keystore: "application/octet-stream", jks: "application/octet-stream", p12: "application/octet-stream", pfx: "application/octet-stream" };
        const file: FileView = { id: randomUUID(), name, type: types[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream", size };
        pending.set(file.id, { name, type: file.type, size, bytes: bytes.subarray(0, size) }); bytes = undefined; return { file };
      } finally { bytes?.fill(0); await handle.close(); }
    }),
    discard() { discard(); return { ok: true } as const; },
    list: () => run(async service => {
      const rows = await service.entries.list();
      views = new Map(rows.map(row => [row.entry.id, viewOf(row.entry, row.version)]));
      return { entries: rows.map(row => summarize(row.entry, row.version)).sort(newest) };
    }),
    open: (id: string) => run(async service => {
      const cached = views.get(id); if (cached) return { entry: cached };
      const row = await service.entries.get(id), entry = viewOf(row.entry, row.version); views.set(id, entry); return { entry };
    }),
    reveal: (id: string, name: string) => run(async service => ({ value: found(part((await service.entries.get(id)).entry, name)) })),
    copy: (id: string, name: string) => run(async service => { await options.clipboard.copy(found(part((await service.entries.get(id)).entry, name))); return {}; }),
    code: (id: string) => run(async service => {
      const entry = (await service.entries.get(id)).entry; if (!entry.totp) throw { code: "not_found" };
      const key = parseKey(entry.totp); if (!key) throw { code: "invalid_code_key" };
      try { return totp(key, now()); } finally { key.fill(0); }
    }),
    copyCode: (id: string) => run(async service => {
      const entry = (await service.entries.get(id)).entry; if (!entry.totp) throw { code: "not_found" };
      const key = parseKey(entry.totp); if (!key) throw { code: "invalid_code_key" };
      try { await options.clipboard.copy(totp(key, now()).code); } finally { key.fill(0); }
      return {};
    }),
    openSite: (id: string) => run(async service => {
      let url: URL; try { url = new URL(plain((await service.entries.get(id)).entry, "website").trim()); } catch { throw { code: "invalid" }; }
      if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password) throw { code: "invalid" };
      await options.openUrl(url.href); return {};
    }),
    favorite: (id: string, favorite: boolean) => run(async service => {
      const row = await service.entries.get(id); if (row.entry.favorite === favorite) return { version: row.version };
      return service.entries.save({ ...row.entry, favorite }, row.version);
    }),
    save: async (input: EntryInput, expected: number) => {
      const used = new Map((input.files ?? []).flatMap(id => { const file = pending.get(id); return file ? [[id, file] as const] : []; })), ticket = generation;
      try { return await run(async service => {
        const uploaded: string[] = [];
        try {
          if (input.files !== undefined && (input.kind !== "doc" || input.files.length > 50 || new Set(input.files).size !== input.files.length)) throw { code: "invalid" };
          if (input.kind === "env") for (const view of views.values()) if (view.kind === "env" && view.title === input.title && view.id !== input.id) throw { code: "project_taken" };
          const row = expected === 0 ? undefined : await service.entries.get(input.id);
          if (row && row.version !== expected) throw { code: "conflict" };
          if (row && row.entry.kind !== input.kind) throw { code: "invalid" };
          let files = row?.entry.files ?? [];
          if (input.files !== undefined) {
            const existing = new Map(files.map(file => [file.id, file])); files = [];
            if (input.files.some(id => !existing.has(id) && !used.has(id))) throw { code: "not_found" };
            for (const id of input.files) {
              const old = existing.get(id); if (old) { files.push(old); continue; }
              const file = used.get(id)!, chunks: string[] = [];
              for (let offset = 0; offset < file.size; offset += 64 * CHUNK_BYTES) {
                if (ticket !== generation) throw { code: "locked" };
                const data: string[] = [];
                for (let start = offset; start < Math.min(file.size, offset + 64 * CHUNK_BYTES); start += CHUNK_BYTES) data.push(file.bytes.subarray(start, Math.min(file.size, start + CHUNK_BYTES)).toString("base64"));
                const result = await service.chunks.put(data); uploaded.push(...result.ids); chunks.push(...result.ids);
              }
              files.push({ id, name: file.name, type: file.type, size: file.size, chunks });
            }
          }
          if (ticket !== generation) throw { code: "locked" };
          return await service.entries.save(merge(row?.entry, input, iso(), files), expected);
        } catch (error) { for (let i = 0; i < uploaded.length; i += 64) await service.chunks.remove(uploaded.slice(i, i + 64)).catch(() => undefined); throw error; }
      }); } finally { for (const [id, file] of used) { file.bytes.fill(0); pending.delete(id); } }
    },
    download: (entryId: string, fileId: string, target: string) => run(async service => {
      const entry = (await service.entries.get(entryId)).entry, file = entry.files.find(file => file.id === fileId);
      if (!file) throw { code: "not_found" };
      const temporary = `${target}.${randomUUID()}.tmp`, ticket = generation; let size = 0;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          for (let i = 0; i < file.chunks.length; i += 64) {
            const { data } = await service.chunks.get(entryId, file.chunks.slice(i, i + 64));
            for (const value of data) {
              const bytes = Buffer.from(value, "base64");
              try { if (ticket !== generation) throw { code: "locked" }; size += bytes.length; if (size > file.size) throw { code: "invalid" }; await handle.writeFile(bytes); } finally { bytes.fill(0); }
            }
          }
          if (size !== file.size || ticket !== generation) throw { code: ticket !== generation ? "locked" : "invalid" };
        } finally { await handle.close(); }
        await rename(temporary, target); return {};
      } finally { await rm(temporary, { force: true }); }
    }),
    remove: (id: string, expected: number) => run(async service => {
      const row = await service.entries.get(id); if (row.version !== expected) throw { code: "conflict" };
      await service.entries.remove(id, expected);
      forget();
      // Putting an entry back needs everything it had; the files of a document are gone with it, so only the others can come back.
      if (row.entry.files.length) return { undo: false };
      const timer = setTimeout(() => { if (held?.entry.id === id) held = undefined; }, undoMs); timer.unref(); held = { entry: row.entry, timer };
      return { undo: true };
    }),
    undo: (id: string) => run(async service => {
      const kept = held; if (!kept || kept.entry.id !== id) throw { code: "not_found" };
      await service.entries.save(kept.entry, 0); forget(); return {};
    }),
    /** The vault is locked or the window is closing: nothing deleted can come back, and nothing is kept. */
    forget() { discard(); forget(); views = new Map(); },
  };
}
export type Entries = ReturnType<typeof createEntries>;
