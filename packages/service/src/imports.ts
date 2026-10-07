import { newEntry, MAX_ENTRIES } from "vault-core";
import type { Entry } from "vault-core";
import type { ImportFormat } from "../../client/src/types.ts";
import { FILE_CAP } from "../../client/src/files.ts";
import { ServiceError } from "./errors.ts";
import { xml } from "./xml.ts";
import type { XmlNode } from "./xml.ts";
export const formats = ["chrome", "edge", "firefox", "bitwarden", "1password", "keepass"];

// Quoting is strict so a malformed export cannot shift a password into another field.
export function csv(input: string): string[][] {
  input = input.replace(/^\uFEFF/, "");
  const rows: string[][] = []; let row: string[] = [], field = "", state: "start" | "plain" | "quoted" | "end" = "start";
  const cell = () => { row.push(field); field = ""; state = "start"; if (row.length > 100) throw new ServiceError("invalid"); };
  const line = () => { cell(); if (row.some(value => value !== "")) rows.push(row); row = []; if (rows.length > 10001) throw new ServiceError("too_large", 413); };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (state === "quoted") { if (char === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else state = "end"; } else field += char; }
    else if (char === ",") cell();
    else if (char === "\r" || char === "\n") { if (char === "\r" && input[i + 1] === "\n") i++; line(); }
    else if (state === "end") throw new ServiceError("invalid");
    else if (char === '"') { if (state !== "start") throw new ServiceError("invalid"); state = "quoted"; }
    else { field += char; state = "plain"; }
    if (field.length > 32000) throw new ServiceError("too_large", 413);
  }
  if (state === "quoted") throw new ServiceError("invalid");
  if (field || row.length || state === "end") line();
  return rows;
}
const normalize = (name: string) => name.trim().toLowerCase().replace(/[ _-]/g, "");
function login(title: unknown, website: unknown, username: unknown, password: unknown, note: unknown = "", totp: unknown = ""): Entry {
  for (const value of [title, website, username, password, note, totp]) if (typeof value !== "string" || value.length > 32000 || value.includes("\0")) throw new ServiceError("invalid");
  if ((title as string).length > 500 || (website as string).length > 8192) throw new ServiceError("invalid");
  const entry = newEntry("login"); entry.title = title as string; entry.note = note as string; entry.totp = totp as string;
  for (const [id, value] of [["website", website], ["username", username], ["password", password]]) entry.fields.find(field => field.id === id)!.value = value as string;
  return entry;
}
function keepass(input: string): Entry[] {
  const root = xml(input), entries: Entry[] = [];
  const single = (node: XmlNode, name: string, required = true) => {
    const children = node.children.filter(child => child.name === name);
    if (children.length > 1 || required && !children.length) throw new ServiceError("invalid"); return children[0];
  };
  const leaf = (node: XmlNode | undefined) => { if (!node) return ""; if (node.children.length) throw new ServiceError("invalid"); return node.text; };
  function group(node: XmlNode) {
    if (/[^ \t\n]/.test(node.text)) throw new ServiceError("invalid");
    for (const child of node.children) {
      if (child.name === "Group") group(child);
      if (child.name !== "Entry") continue;
      if (/[^ \t\n]/.test(child.text)) throw new ServiceError("invalid");
      const values = new Map<string, string>();
      for (const field of child.children.filter(node => node.name === "String")) {
        if (/[^ \t\n]/.test(field.text) || field.children.length !== 2) throw new ServiceError("invalid");
        const key = leaf(single(field, "Key")), value = single(field, "Value")!;
        if (!key || values.has(key) || value.attributes.Protected !== undefined && value.attributes.Protected !== "False") throw new ServiceError("invalid");
        values.set(key, leaf(value));
      }
      for (const key of ["UserName", "Password", "URL"]) if (!values.has(key)) throw new ServiceError("invalid");
      entries.push(login(values.get("Title") ?? "", values.get("URL"), values.get("UserName"), values.get("Password"), values.get("Notes") ?? "", values.get("otp") ?? ""));
      if (entries.length > 10000) throw new ServiceError("too_large", 413);
      // History contains old credentials, not additional current logins.
    }
  }
  if (root.name !== "KeePassFile" || /[^ \t\n]/.test(root.text)) throw new ServiceError("invalid");
  const container = single(root, "Root")!;
  if (/[^ \t\n]/.test(container.text)) throw new ServiceError("invalid");
  group(single(container, "Group")!);
  return entries;
}
export function parseImport(format: ImportFormat, input: string): { entries: Entry[]; skipped: number } {
  if (!formats.includes(format) || typeof input !== "string" || Buffer.byteLength(input) > FILE_CAP || input.includes("\0")) throw new ServiceError("invalid");
  let skipped = 0; const entries: Entry[] = [];
  if (format === "keepass" && input.trimStart().startsWith("<")) {
    entries.push(...keepass(input));
  } else if (format === "bitwarden" && input.trimStart().startsWith("{")) {
    let data;
    try { data = JSON.parse(input); } catch { throw new ServiceError("invalid"); }
    if (data.encrypted === true || !Array.isArray(data.items) || data.items.length > 10000) throw new ServiceError("invalid");
    for (const item of data.items) {
      if (!item || typeof item !== "object") throw new ServiceError("invalid");
      if (item.type !== 1) { skipped++; continue; }
      const value = item.login; if (!value || !Array.isArray(value.uris ?? [])) throw new ServiceError("invalid");
      const uris = value.uris ?? []; if (uris.length > 100) throw new ServiceError("invalid");
      for (const uri of uris.length ? uris : [{ uri: "" }]) entries.push(login(item.name ?? "", uri?.uri ?? "", value.username ?? "", value.password ?? "", item.notes ?? "", value.totp ?? ""));
    }
  } else {
    const rows = csv(input); if (!rows.length) throw new ServiceError("invalid");
    const header = rows.shift()!.map(normalize);
    if (new Set(header).size !== header.length || header.some(name => !name)) throw new ServiceError("invalid");
    const choose = (...names: string[]) => header.findIndex(name => names.map(normalize).includes(name));
    let title: number, url: number, user: number, pass: number, notes: number, type = -1, totp = choose("totp", "otpAuth", "login_totp", "one-time password");
    if (format === "chrome" || format === "edge" || format === "firefox") {
      title = choose("name"); url = choose("url"); user = choose("username"); pass = choose("password"); notes = choose("note", "notes");
    } else if (format === "bitwarden") {
      title = choose("name"); url = choose("login_uri"); user = choose("login_username"); pass = choose("login_password"); notes = choose("notes"); type = choose("type"); if (type < 0) throw new ServiceError("invalid");
    } else if (format === "1password") {
      title = choose("title"); url = choose("url", "website"); user = choose("username"); pass = choose("password"); notes = choose("notes"); type = choose("type");
    } else {
      title = choose("title", "account"); url = choose("url", "web site"); user = choose("username", "user name", "login name"); pass = choose("password"); notes = choose("notes", "comments");
    }
    if ([url, user, pass].some(index => index < 0)) throw new ServiceError("invalid");
    for (const row of rows) {
      if (row.length !== header.length) throw new ServiceError("invalid");
      if (type >= 0 && !["login", "password", "1"].includes(row[type].toLowerCase())) { skipped++; continue; }
      entries.push(login(title < 0 ? row[url] : row[title], row[url], row[user], row[pass], notes < 0 ? "" : row[notes], totp < 0 ? "" : row[totp]));
    }
  }
  if (entries.length > 10000) throw new ServiceError("too_large", 413);
  return { entries, skipped };
}
export function duplicateKey(entry: Entry): string {
  const website = entry.fields.find(field => field.id === "website")?.value ?? "";
  const username = entry.fields.find(field => field.id === "username")?.value ?? "";
  return entry.kind === "login" ? JSON.stringify([website, username]) : entry.kind === "env" ? JSON.stringify(["env", entry.title]) : entry.id.toLowerCase();
}
export { MAX_ENTRIES };
