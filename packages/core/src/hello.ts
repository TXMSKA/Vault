import { base64, unbase64, unlock } from "./crypto.js";
import { createVaultUnlock } from "./unlock.js";
import { shape, version, VaultError } from "./store.js";
import type { VaultStore } from "./store.js";
import type { VaultMemory } from "./memory.js";

export interface KeyProtector {
  protect(bytes: Uint8Array<ArrayBuffer>): Uint8Array | Promise<Uint8Array>;
  unprotect(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>;
}
export type WrappedKey = { version: number; blob: string };
export interface HelloKeyStore {
  read(): Promise<WrappedKey | null>;
  write(value: WrappedKey): Promise<void>;
  remove(): Promise<void>;
}
// The service injects the runner of the native helper, so the core never starts a process or imports the client.
export interface HelperRunner {
  (verb: "hello-available", request: Record<string, never>): Promise<{ available: boolean }>;
  (verb: "hello-verify", request: { hwnd: string; message: string }): Promise<{ result: string }>;
}
export async function helloAvailable(run: HelperRunner): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try { return (await run("hello-available", {})).available === true; }
  catch { return false; } // An unavailable verifier leaves password unlock as the only path.
}
async function verify(run: HelperRunner, hwnd: bigint): Promise<void> {
  if (process.platform !== "win32" || hwnd <= 0n || !await helloAvailable(run)) throw new VaultError("unavailable");
  let answer; try { answer = await run("hello-verify", { hwnd: hwnd.toString(), message: "Unlock Vault" }); } catch { throw new VaultError("unavailable"); }
  if (answer.result !== "Verified") throw new VaultError("locked");
}
export function createHelloAdapter(store: VaultStore, protector: KeyProtector, wrapped: HelloKeyStore, memory: VaultMemory, helper: HelperRunner) {
  const auth = createVaultUnlock(store, { memory }); let generation = 0, pending: Promise<unknown> = Promise.resolve();
  function queue<T>(operation: () => Promise<T>): Promise<T> {
    const run = pending.catch(() => undefined).then(operation); pending = run; return run;
  }
  return {
    available: () => helloAvailable(helper),
    enable(password: string) {
      const ticket = memory.ticket(), attempt = generation;
      return queue(async () => {
        if (!await helloAvailable(helper)) throw new VaultError("unavailable");
        await auth.unlock(password); const current = await store.envelope(); if (!current.state) throw new VaultError("not_found");
        let opened;
        try {
          opened = await unlock(current.state, password); const protectedBytes = await protector.protect(opened.bytes);
          if (!protectedBytes.length || protectedBytes.length > 16384) throw new VaultError("invalid");
          if (attempt !== generation || !memory.current(ticket) || (await store.envelope()).version !== current.version) throw new VaultError("locked");
          await wrapped.write({ version: current.version, blob: base64(protectedBytes) });
          if (attempt !== generation) { await wrapped.remove(); throw new VaultError("locked"); }
        } catch (error) { throw error instanceof VaultError ? error : new VaultError("unavailable"); }
        finally { opened?.bytes.fill(0); }
      });
    },
    async unlock(hwnd: bigint) {
      const ticket = memory.ticket(), attempt = generation; let bytes;
      try {
        const value = await wrapped.read(); if (!value) throw new VaultError("not_found");
        shape(value, "blob,version"); version(value.version);
        if (typeof value.blob !== "string" || value.blob.length > 22000) throw new VaultError("invalid");
        const current = await store.envelope(); if (!current.state || current.version !== value.version) throw new VaultError("locked");
        await verify(helper, hwnd);
        if (attempt !== generation || !memory.current(ticket)) throw new VaultError("locked");
        bytes = await protector.unprotect(unbase64(value.blob));
        if (bytes.length !== 32) throw new VaultError("invalid");
        const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
        if ((await store.envelope()).version !== value.version || attempt !== generation || !memory.open(key, ticket)) throw new VaultError("locked");
        return key;
      } catch (error) { throw error instanceof VaultError ? error : new VaultError("unavailable"); }
      finally { bytes?.fill(0); }
    },
    disable() { generation++; return queue(() => wrapped.remove()); },
  };
}
