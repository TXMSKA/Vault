import { timingSafeEqual } from "node:crypto";
import { createEnvelope, hashProof, unlock } from "./crypto.js";
import { VaultMemory } from "./memory.js";
import { stateInput, VaultError } from "./store.js";
import type { VaultStore } from "./store.js";
import type { VaultLogger } from "./logger.js";

type Failure = { count: number; until: number };
const failures = new WeakMap<object, Failure>();
const pending = new WeakMap<object, Promise<unknown>>();
export type UnlockOptions = { clock?: () => number; memory?: VaultMemory; logger?: VaultLogger };
export function createVaultUnlock(store: VaultStore, options: UnlockOptions = {}) {
  const clock = options.clock ?? Date.now, memory = options.memory ?? new VaultMemory(clock);
  const scope = store.identity ?? store;
  function event(name: string, outcome: string) { options.logger?.(name, { actor: "local", source: "process", outcome }); }
  function queue<T>(operation: () => Promise<T>): Promise<T> {
    // A failed attempt must not poison later attempts in the same process.
    const run = (pending.get(scope) ?? Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(scope, run); void run.finally(() => { if (pending.get(scope) === run) pending.delete(scope); }).catch(() => undefined); return run;
  }
  async function authenticate(secret: string, recover: boolean) {
    const failure = failures.get(scope);
    if (failure && clock() < failure.until) { event("unlock_limited", "denied"); throw new VaultError("limited"); }
    const current = await store.envelope(); if (!current.state) throw new VaultError("not_found");
    const state = stateInput(current.state); let opened;
    try {
      opened = await unlock(state, secret, recover);
      const actual = Buffer.from(await hashProof(opened.proof), "base64"), expected = Buffer.from(recover ? state.recoveryHash : state.masterHash, "base64");
      if (!timingSafeEqual(actual, expected)) throw new VaultError("locked");
    } catch {
      opened?.bytes.fill(0);
      const count = (failure?.count ?? 0) + 1; failures.set(scope, { count, until: clock() + Math.min(30000, 500 * 2 ** Math.min(count, 6)) });
      event("unlock", "denied"); throw new VaultError("locked");
    }
    failures.delete(scope); return { current, opened };
  }
  return {
    memory,
    unlock(password: string) {
      const ticket = memory.ticket();
      return queue(async () => {
        const { current, opened } = await authenticate(password, false);
        try {
          if ((await store.envelope()).version !== current.version) throw new VaultError("conflict");
          if (!memory.open(opened.key, ticket)) throw new VaultError("locked"); event("unlock", "allowed"); return opened.key;
        }
        finally { opened.bytes.fill(0); }
      });
    },
    recover(recovery: string, password: string) {
      const ticket = memory.ticket();
      return queue(async () => {
        if (typeof password !== "string" || password.length < 15 || password.length > 128) throw new VaultError("invalid");
        const { current, opened } = await authenticate(recovery, true);
        try {
          const next = await createEnvelope(password, opened.bytes);
          if (next.state.masterHash === current.state!.masterHash || next.state.recoveryHash === current.state!.recoveryHash) throw new VaultError("invalid");
          if (!memory.current(ticket)) throw new VaultError("locked");
          const result = await store.replace(next.state, current.version);
          if (!memory.current(ticket)) throw new VaultError("locked");
          memory.lock(); const fresh = memory.ticket();
          if (!memory.open(next.key, fresh)) throw new VaultError("locked");
          event("recovery", "allowed"); return { key: next.key, recovery: next.recovery, version: result.version };
        } catch (error) { throw error instanceof VaultError ? error : new VaultError("unavailable"); }
        finally { opened.bytes.fill(0); }
      });
    },
    lock() { memory.lock(); event("lock", "allowed"); },
  };
}
