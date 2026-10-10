import type { Client, Entry, Field } from "vault-client";
import type { EntryInput, EntrySummary, EntryView, Result } from "../shared/api.js";
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
 * out keeps its value; recovery codes and files are never the window's to change. A custom or environment entry has exactly the fields the window sends;
 * any other kind also keeps the fields the window did not mention.
 */
export function merge(old: Entry | undefined, input: EntryInput, updatedAt: string): Entry {
  const before = new Map((old?.fields ?? []).map(field => [field.id, field]));
  const fields: Field[] = input.fields.map(field => ({ id: field.id, name: field.name, secret: field.secret, value: field.value ?? before.get(field.id)?.value ?? "" }));
  if (old && old.kind !== "custom" && old.kind !== "env") for (const field of old.fields) if (!input.fields.some(item => item.id === field.id)) fields.push({ ...field });
  return {
    id: input.id, kind: input.kind, title: input.title, favorite: input.favorite, fields, note: input.note ?? old?.note ?? "", totp: input.totp ?? old?.totp ?? "",
    recovery: old ? old.recovery.map(item => ({ ...item })) : [], files: old ? old.files.map(file => ({ ...file, chunks: [...file.chunks] })) : [], updatedAt,
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
    save: (input: EntryInput, expected: number) => run(async service => {
      if (input.kind === "env") for (const view of views.values()) if (view.kind === "env" && view.title === input.title && view.id !== input.id) throw { code: "project_taken" };
      if (expected === 0) return service.entries.save(merge(undefined, input, iso()), 0);
      const row = await service.entries.get(input.id);
      if (row.version !== expected) throw { code: "conflict" };
      if (row.entry.kind !== input.kind) throw { code: "invalid" };
      return service.entries.save(merge(row.entry, input, iso()), expected);
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
    forget() { forget(); views = new Map(); },
  };
}
export type Entries = ReturnType<typeof createEntries>;
