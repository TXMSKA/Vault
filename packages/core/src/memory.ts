import { IDLE_MS } from "./model.js";

/** A generation invalidates async decrypts/uploads as soon as lock starts. */
export class VaultMemory {
  private generation = 0;
  private key: CryptoKey | null = null;
  private activity = 0;
  constructor(private clock = Date.now, private idleMs: number | null = IDLE_MS) {
    if (idleMs !== null && (!Number.isSafeInteger(idleMs) || idleMs < 0)) throw new Error("invalid");
  }
  ticket() { return this.generation; }
  current(ticket: number) { return ticket === this.generation; }
  open(key: CryptoKey, ticket: number) {
    if (!this.current(ticket)) return false;
    this.key = key; this.activity = this.clock(); return true;
  }
  touch() {
    if (this.expired()) return false;
    this.activity = this.clock(); return !!this.key;
  }
  expired() { return !!this.key && this.idleMs !== null && this.clock() - this.activity >= this.idleMs; }
  get(ticket: number): CryptoKey {
    if (!this.current(ticket) || !this.key || this.expired()) throw new Error("locked");
    return this.key;
  }
  lock() { this.generation++; this.key = null; this.activity = 0; }
}
