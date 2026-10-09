import { randomUUID } from "node:crypto";
import { id } from "vault-core";
import type { AppView, Prompt, PromptState, PromptTicket } from "../../client/src/types.ts";
import { ServiceError } from "./errors.ts";
import type { Runs } from "./runs.ts";
export const PROMPT_LIMITS = { total: 50, perApp: 5, expiresMs: 5 * 60 * 1000, keepMs: 2 * 60 * 1000, kept: 200, waitMs: 25000 };
export type PromptLimits = typeof PROMPT_LIMITS;
/** `unlocked` says whether the key is open now; `start` brings up the Vault app when nobody is there to answer. */
export type PromptHooks = { unlocked(): boolean; start(): void };
type Asked = { id: string; kind: "unlock" | "permission"; app: { id: string; name: string }; reason: string | null; createdAt: number; expiresAt: number; state: PromptState; endedAt?: number };
const iso = (time: number) => new Date(time).toISOString();
/**
 * What waits for a person, in memory only. An unlock and a permission are asked here; a run is the pending run of Runs, so it
 * leaves the queue when it is approved, rejected or expires by any route. A prompt names no secret value and never extends the idle time.
 */
export class Prompts {
  asked = new Map<string, Asked>(); sleepers = new Set<() => void>(); stopped = false; now: () => number; runs: Runs; hooks: PromptHooks; limits: PromptLimits;
  constructor(now: () => number, runs: Runs, hooks: PromptHooks, limits: Partial<PromptLimits> = {}) { this.now = now; this.runs = runs; this.hooks = hooks; this.limits = { ...PROMPT_LIMITS, ...limits }; }
  sweep() {
    for (const row of this.asked.values()) {
      if (row.state === "pending" && this.now() >= row.expiresAt) this.end(row, "expired");
      else if (row.endedAt !== undefined && this.now() - row.endedAt >= this.limits.keepMs) this.asked.delete(row.id);
    }
  }
  private end(row: Asked, state: PromptState) { row.state = state; row.endedAt = this.now(); }
  /** The pending prompts, oldest first. */
  pending(): Prompt[] {
    this.sweep();
    const asked = [...this.asked.values()].filter(row => row.state === "pending").map((row): Prompt => {
      const base = { id: row.id, app: { ...row.app }, createdAt: iso(row.createdAt), expiresAt: iso(row.expiresAt) };
      return row.kind === "unlock" ? { ...base, kind: "unlock", summary: { reason: row.reason } } : { ...base, kind: "permission", summary: { permission: "import" } };
    });
    const runs = this.runs.list().filter(run => run.status === "pending").map((run): Prompt => ({ id: run.id, app: { ...run.app }, createdAt: run.createdAt, expiresAt: run.expiresAt, kind: "run", summary: { project: run.project, cwd: run.cwd, commands: run.commands } }));
    return [...asked, ...runs].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  }
  /** Refuses with 429 when the queue, or the app's share of it, is full. */
  room(appId: string) {
    const all = this.pending();
    if (all.length >= this.limits.total || all.filter(prompt => prompt.app.id === appId).length >= this.limits.perApp) throw new ServiceError("limited", 429);
  }
  /** Wakes the calls that wait for a new prompt and starts the app when nobody is there. */
  announce() { this.wake(); this.hooks.start(); }
  private open(app: AppView, kind: "unlock" | "permission", reason: string | null, answered: boolean): PromptTicket {
    this.sweep(); if (!answered) this.room(app.id);
    const created = this.now(), row: Asked = { id: randomUUID(), kind, app: { id: app.id, name: app.name }, reason, createdAt: created, expiresAt: created + this.limits.expiresMs, state: answered ? "done" : "pending", ...answered ? { endedAt: created } : {} };
    // Answered prompts stay for their waiters; when there are many, the oldest go first.
    const finished = [...this.asked.values()].filter(old => old.endedAt !== undefined).sort((a, b) => a.endedAt! - b.endedAt!);
    for (const old of finished.slice(0, Math.max(0, finished.length - this.limits.kept + 1))) this.asked.delete(old.id);
    this.asked.set(row.id, row); if (!answered) this.announce();
    return { id: row.id, expiresAt: iso(row.expiresAt) };
  }
  /** Already answered when the vault is open. */
  unlock(app: AppView, reason?: string) { return this.open(app, "unlock", reason ?? null, this.hooks.unlocked()); }
  /** Already answered when the app holds the permission. */
  permission(app: AppView, held: boolean) { return this.open(app, "permission", null, held); }
  /** The vault was opened, by any route. */
  opened() { for (const row of this.asked.values()) if (row.state === "pending" && row.kind === "unlock") this.end(row, "done"); this.wake(); }
  /** The app received its permission, by its own proof or a manager's. */
  granted(appId: string) { for (const row of this.asked.values()) if (row.state === "pending" && row.kind === "permission" && row.app.id === appId) this.end(row, "done"); this.wake(); }
  /** vault-app turns a prompt down: a waiter hears `cancelled`, a run is rejected like any rejection. */
  dismiss(value: unknown) {
    const key = id(value).toLowerCase(); this.sweep(); const row = this.asked.get(key);
    if (row) { if (row.state !== "pending") throw new ServiceError("not_pending", 409); this.end(row, "cancelled"); this.wake(); return; }
    if (!this.runs.list().some(run => run.id === key && run.status === "pending")) throw new ServiceError("not_found", 404);
    this.runs.reject(key);
  }
  /** The pending list at once, or the first prompt to arrive within the wait; possibly an empty list. */
  async poll(ms = this.limits.waitMs): Promise<Prompt[]> { await this.hold(() => this.pending().length > 0, ms); return this.pending(); }
  /** The state of an unlock or permission prompt, only for the app that asked; it holds while pending, never longer than the prompt lives. */
  async wait(app: AppView, value: unknown, ms = this.limits.waitMs): Promise<{ state: PromptState }> {
    const key = id(value).toLowerCase(); this.sweep(); const row = this.asked.get(key);
    if (!row || row.app.id !== app.id) throw new ServiceError("not_found", 404);
    await this.hold(() => { this.sweep(); return row.state !== "pending"; }, Math.min(ms, Math.max(0, row.expiresAt - this.now()) + 5));
    this.sweep(); return { state: row.state };
  }
  stop() { this.stopped = true; this.wake(); }
  private wake() { for (const check of [...this.sleepers]) check(); }
  // Resolves when `ready` holds after a change to the queue, or when the time is up.
  private hold(ready: () => boolean, ms: number) {
    return new Promise<void>(done => {
      if (this.stopped || ready()) { done(); return; }
      const finish = () => { clearTimeout(timer); this.sleepers.delete(check); done(); }, check = () => { if (this.stopped || ready()) finish(); };
      const timer = setTimeout(finish, Math.min(ms, 2 ** 31 - 1)); timer.unref(); this.sleepers.add(check);
    });
  }
}
