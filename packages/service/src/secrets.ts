import { join } from "node:path";
import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readCapped, atomicJson } from "../../client/src/files.ts";
import { privateFile } from "../../client/src/private.ts";
import { appIdPattern } from "../../client/src/paths.ts";
import type { AppIdentity, AppView, Kind } from "../../client/src/types.ts";
import { object, text, ServiceError } from "./errors.ts";
const all: Kind[] = ["login", "card", "doc", "note", "key", "custom", "env"];
const trusted = new Set(["horizon", "nova", "nebula", "vault-cli", "vault-app"]);
export const manages = (app: AppView) => app.id === "vault-cli" || app.id === "vault-app";
export const blocked = (app: AppIdentity) => /^lyra(?:-|$)/.test(app.id);
// An agent never receives values: once allowed, it can only propose runs that a person approves.
export const isAgent = (app: AppIdentity) => app.kind === "agent";
export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export function matches(input: string, expected: string) {
  const a = Buffer.from(hashToken(input), "hex"), b = Buffer.from(expected, "hex"); return b.length === a.length && timingSafeEqual(a, b);
}
export function bootstrapKey(home: string) {
  const filename = join(home, "secrets", "bootstrap.key");
  try { fs.writeFileSync(filename, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  privateFile(filename); if (fs.statSync(filename).size !== 43) throw new ServiceError("unavailable", 500);
  const key = fs.readFileSync(filename, "utf8"); if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new ServiceError("unavailable", 500); return hashToken(key);
}
type RecordApp = { app: AppView; tokenHash: string };
export class Apps {
  rows: RecordApp[] = []; filename: string;
  constructor(home: string) { this.filename = join(home, "secrets", "apps.json"); }
  async load() {
    let value;
    try { value = JSON.parse(await readCapped(this.filename, 128 * 1024)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new ServiceError("unavailable", 500); }
    if (!Array.isArray(value) || value.length > 100) throw new ServiceError("unavailable", 500);
    for (const row of value) {
      object(row, "app,tokenHash"); object(row.app, Object.hasOwn(row.app ?? {}, "permissions") ? "id,kind,kinds,name,permissions,status" : "id,kind,kinds,name,status"); identity({ id: row.app.id, name: row.app.name, kind: row.app.kind });
      if (!/^[a-f0-9]{64}$/.test(row.tokenHash) || !["granted", "pending", "revoked"].includes(row.app.status)) throw new ServiceError("unavailable", 500);
      row.app.kinds = kinds(row.app); if (blocked(row.app) && row.app.status === "granted") throw new ServiceError("unavailable", 500);
      // Rows written before permissions existed have none.
      const permissions = row.app.permissions ?? [];
      if (!Array.isArray(permissions) || permissions.some(item => item !== "import") || new Set(permissions).size !== permissions.length || permissions.length && (blocked(row.app) || isAgent(row.app))) throw new ServiceError("unavailable", 500);
      row.app.permissions = permissions;
    }
    if (new Set(value.map(row => row.app.id)).size !== value.length) throw new ServiceError("unavailable", 500);
    this.rows = value;
  }
  list() { return this.rows.map(row => ({ ...row.app, kinds: [...row.app.kinds], permissions: [...row.app.permissions] })); }
  byToken(token: string) { return this.rows.find(row => matches(token, row.tokenHash))?.app; }
  async register(value: unknown) {
    const app = identity(value), previous = this.rows.find(row => row.app.id === app.id);
    if (previous && previous.app.kind !== app.kind) throw new ServiceError("invalid");
    if (!previous && this.rows.length >= 100) throw new ServiceError("limited", 429);
    const token = randomBytes(32).toString("base64url");
    const next: RecordApp = { app: { ...app, status: previous?.app.status ?? (trusted.has(app.id) && !blocked(app) ? "granted" : "pending"), kinds: kinds(app), permissions: previous?.app.permissions ?? [] }, tokenHash: hashToken(token) };
    const rows = previous ? this.rows.map(row => row === previous ? next : row) : [...this.rows, next];
    await atomicJson(this.filename, rows); this.rows = rows;
    return { app: next.app, token };
  }
  async setStatus(id: string, status: "granted" | "revoked") {
    const row = this.rows.find(row => row.app.id === id); if (!row) throw new ServiceError("not_found", 404);
    if (status === "granted" && blocked(row.app)) throw new ServiceError("forbidden", 403);
    const app = { ...row.app, status, permissions: status === "revoked" ? [] : row.app.permissions }, rows = this.rows.map(current => current === row ? { ...row, app } : current);
    await atomicJson(this.filename, rows); this.rows = rows; return app;
  }
  // Recorded only after the person proved it is them; an agent or a blocked app can never hold one.
  async grant(id: string, permission: "import") {
    const row = this.rows.find(row => row.app.id === id); if (!row) throw new ServiceError("not_found", 404);
    if (blocked(row.app) || isAgent(row.app) || row.app.status !== "granted") throw new ServiceError("forbidden", 403);
    if (row.app.permissions.includes(permission)) return row.app;
    const app = { ...row.app, permissions: [...row.app.permissions, permission] }, rows = this.rows.map(current => current === row ? { ...row, app } : current);
    await atomicJson(this.filename, rows); this.rows = rows; return app;
  }
}
function kinds(app: AppIdentity): Kind[] { return blocked(app) || isAgent(app) ? [] : app.id === "horizon" ? ["login"] : app.id === "nova" ? ["env"] : [...all]; }
// Held by policy, never by request, so no app can ask to keep Vault unlocked.
export const holds = (app: string) => app === "horizon";
export function identity(value: unknown): AppIdentity {
  const v = object(value, "id,kind,name"), id = text(v.id, 40), name = text(v.name, 120), kind = v.kind;
  if (!appIdPattern.test(id) || !name.trim() || /[\r\n\x00-\x1f]/.test(name) || !["cosmic", "app", "agent"].includes(String(kind)) || (kind === "cosmic") !== trusted.has(id)) throw new ServiceError("invalid");
  return { id, name, kind: kind as AppIdentity["kind"] };
}
