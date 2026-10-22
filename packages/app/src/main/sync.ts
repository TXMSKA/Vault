import type { Client, SyncStatus } from "vault-client";
import type { Result, SyncView } from "../shared/api.js";
import { codeOf } from "./link.ts";
/** Where the Cosmic account lives: the published Quantum, unless VAULT_QUANTUM_API and VAULT_QUANTUM_SITE name others (local tests). */
export const QUANTUM_DEFAULTS = { api: "https://quantum.txmska.com", site: "https://cosmic.txmska.com" };
export type QuantumConfig = { api: string; site: string } | undefined;
export function quantumConfig(env: NodeJS.ProcessEnv): QuantumConfig {
  const api = env.VAULT_QUANTUM_API?.trim(), site = env.VAULT_QUANTUM_SITE?.trim();
  return api && site ? { api, site } : QUANTUM_DEFAULTS;
}
export type SyncOptions = { service(): Client | undefined; quantum(): QuantumConfig; openUrl(url: string): Promise<void>; chooseFolder(): Promise<string | undefined>; refresh(): Promise<void> };
/** What the window may know of sync: no device ids, only how many other computers share the vault. */
export function syncView(status: SyncStatus): SyncView {
  return {
    configured: status.configured, origin: status.origin, account: status.account, folder: status.folder, storage: status.storage, lastSynced: status.lastSynced,
    others: Math.max(0, status.computers.length - 1), pending: status.pending, conflicts: status.conflicts, problem: status.failure?.cause ?? null,
  };
}
/**
 * Sync as the window drives it. The browser does the Cosmic sign-in: this side opens the page, then waits for the service to say who signed in.
 * The folder the person picks stays here until setup or join uses it, so the page never names a path to the service.
 */
export function createSync(options: SyncOptions) {
  let signing: string | undefined, folder: string | undefined, attempt = 0;
  async function run<T extends object>(work: (service: Client) => Promise<T>): Promise<Result<T>> {
    const service = options.service(); if (!service) return { ok: false, code: "unavailable" };
    try { return { ok: true, ...await work(service) } as Result<T>; } catch (error) { return { ok: false, code: codeOf(error) }; }
  }
  const status = (service: Client) => service.sync.status().then(value => ({ status: syncView(value) }));
  return {
    status: () => run(status),
    /** Opens the sign-in page; a second call opens a fresh one and the first wait ends. */
    signIn: () => run(async service => {
      const quantum = options.quantum(); if (!quantum) throw { code: "quantum_url_required" };
      const { url, id } = await service.sync.quantum.signIn(quantum.api, quantum.site); signing = id; attempt++;
      await options.openUrl(url); return {};
    }),
    /** Waits for the browser; an older wait that a new sign-in replaced answers `cancelled`. */
    wait: () => run(async service => {
      const id = signing, mine = attempt; if (!id) throw { code: "not_found" };
      try { const { account } = await service.sync.quantum.wait(id); if (mine !== attempt) throw { code: "cancelled" }; const { datasets } = await service.sync.quantum.account(); return { account, datasets }; }
      catch (error) { if (mine !== attempt) throw { code: "cancelled" }; throw error; }
      finally { if (mine === attempt) signing = undefined; }
    }),
    cancel() { attempt++; signing = undefined; return { ok: true } as const; },
    chooseFolder: async (): Promise<Result<{ name: string }>> => { const chosen = await options.chooseFolder(); if (!chosen) return { ok: false, code: "cancelled" }; folder = chosen; return { ok: true, name: chosen }; },
    setup: (via: "quantum" | "folder") => run(async service => {
      if (via === "folder" && !folder) throw { code: "no_folder" };
      const value = via === "quantum" ? await service.sync.setupQuantum() : await service.sync.setup(folder!); await options.refresh(); return { status: syncView(value) };
    }),
    join: (via: "quantum" | "folder", secret: { password: string } | { recovery: string }) => run(async service => {
      if (via === "folder" && !folder) throw { code: "no_folder" };
      const value = via === "quantum" ? await service.sync.joinQuantum(secret) : await service.sync.join(folder!, secret); await options.refresh(); return { status: syncView(value) };
    }),
    move: () => run(async service => { const value = await service.sync.switchToQuantum(); return { status: syncView(value) }; }),
    now: () => run(async service => ({ status: syncView(await service.sync.now()) })),
    leave: (remove: boolean, signOut: boolean) => run(async service => {
      await service.sync.leave(remove); if (signOut) { try { await service.sync.quantum.signOut(); } catch {} }
      return status(service);
    }),
    signOut: () => run(async service => { await service.sync.quantum.signOut(); return {}; }),
  };
}
export type Sync = ReturnType<typeof createSync>;
