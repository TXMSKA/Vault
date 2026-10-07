import { VaultMemory } from "vault-core";
import { ServiceError } from "./errors.ts";
import { holds } from "./secrets.ts";
type Presence = { app: string; until: number };
export const DISCONNECTED_MS = 10 * 60 * 1000;
export class Lifecycle {
  memory: VaultMemory; now: () => number; ttl: number; presences = new Map<string, Presence>();
  private absentSince: number;
  constructor(memory: VaultMemory, now = Date.now, ttl = 60000) { this.memory = memory; this.now = now; this.ttl = ttl; this.absentSince = now(); }
  present(app: string, session: string) {
    this.check();
    const previous = this.presences.get(session); if (previous && previous.app !== app) throw new ServiceError("forbidden", 403);
    if (!previous && this.presences.size >= 200) throw new ServiceError("limited", 429);
    this.presences.set(session, { app, until: this.now() + this.ttl });
  }
  leave(app: string, session: string) { const previous = this.presences.get(session); if (previous && previous.app !== app) throw new ServiceError("forbidden", 403); this.presences.delete(session); if (previous && !this.presences.size) this.absentSince = this.now(); if (!this.presences.size) this.memory.lock(); }
  revoke(app: string) { const hadPresence = this.presences.size > 0; for (const [session, presence] of this.presences) if (presence.app === app) this.presences.delete(session); if (hadPresence && !this.presences.size) this.absentSince = this.now(); if (!this.presences.size) this.memory.lock(); }
  check() {
    let expired = false, lastExpiry = this.absentSince;
    for (const [session, presence] of this.presences) if (presence.until <= this.now()) { this.presences.delete(session); expired = true; lastExpiry = Math.max(lastExpiry, presence.until); }
    if (expired && !this.presences.size) this.absentSince = lastExpiry;
    if (this.memory.expired() || expired && !this.presences.size) this.memory.lock();
    // Only a memory that has not expired is kept alive; touch() cannot revive one that has.
    else if ([...this.presences.values()].some(presence => holds(presence.app))) this.memory.touch();
  }
  shouldExit() {
    this.check(); if (this.presences.size || this.now() - this.absentSince < DISCONNECTED_MS) return false;
    try { this.memory.get(this.memory.ticket()); return false; } catch { return true; }
  }
  requirePresence(app: string) { this.check(); if (![...this.presences.values()].some(presence => presence.app === app)) throw new ServiceError("not_present", 403); }
}
