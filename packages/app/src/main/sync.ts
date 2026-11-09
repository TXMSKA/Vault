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
    managedSync: status.managedSync ?? null, missingPolicies: status.missingPolicies ?? [],
  };
}
/** An address the service named. The window never supplies one, and anything other than http(s) without userinfo is not opened. */
function browserPage(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw { code: "invalid" }; }
  if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password) throw { code: "invalid" };
  return url.href;
}
/**
 * Sync as the window drives it. The browser does the Cosmic sign-in: this side opens the page, then waits for the service to say who signed in.
 * Acceptance is the same kind of hand-off: the service names the account page, and this side only opens that address.
 * The folder the person picks stays here until setup or join uses it, so the page never names a path to the service.
 */
export function createSync(options: SyncOptions) {
  let signing: string | undefined, folder: string | undefined, attempt = 0;
  let accepting: { id: string; url: string } | undefined, acceptAttempt = 0, inFront = true, wakeFront: (() => void) | undefined, pollAbort: AbortController | undefined;
  async function run<T extends object>(work: (service: Client) => Promise<T>): Promise<Result<T>> {
    const service = options.service(); if (!service) return { ok: false, code: "unavailable" };
    try { return { ok: true, ...await work(service) } as Result<T>; } catch (error) { return { ok: false, code: codeOf(error) }; }
  }
  const status = (service: Client) => service.sync.status().then(value => ({ status: syncView(value) }));
  const untilFront = (mine: number) => inFront || mine !== acceptAttempt ? Promise.resolve() : new Promise<void>(resolve => { wakeFront = () => { wakeFront = undefined; resolve(); }; });
  return {
    status: () => run(status),
    /** Starts the service flow and opens the page it returns. A second start replaces the first. */
    acceptance: () => run(async service => {
      const started = await service.sync.quantum.acceptance();
      let url: string;
      try { url = browserPage(started.url); }
      catch (error) { await service.sync.quantum.cancelAcceptance(started.id).catch(() => undefined); throw error; }
      acceptAttempt++; accepting = { id: started.id, url }; pollAbort?.abort(); wakeFront?.();
      await options.openUrl(url); return {};
    }),
    /** Opens the page already started, without asking the service for another flow. */
    openAcceptance: () => run(async () => {
      if (!accepting) throw { code: "not_found" };
      await options.openUrl(browserPage(accepting.url)); return {};
    }),
    /**
     * One poll at a time, and only while the window is in front. A result that arrives after a blur is discarded;
     * the next poll, once the window is in front again, is what may finish the flow.
     */
    acceptanceWait: () => run(async service => {
      const id = accepting?.id, mine = acceptAttempt, signId = signing, signAttempt = attempt; if (!id) throw { code: "not_found" };
      for (;;) {
        if (mine !== acceptAttempt) throw { code: "cancelled" };
        if (!inFront) { await untilFront(mine); continue; }
        const controller = new AbortController(); pollAbort = controller;
        let result: { pending: true } | { account: string };
        try { result = await service.sync.quantum.poll(id, controller.signal); }
        catch (error) {
          if (pollAbort === controller) pollAbort = undefined;
          if (mine !== acceptAttempt) throw { code: "cancelled" };
          if (controller.signal.aborted) continue;
          throw error;
        }
        if (pollAbort === controller) pollAbort = undefined;
        if (mine !== acceptAttempt) throw { code: "cancelled" };
        if (controller.signal.aborted || !inFront || !("account" in result)) continue;
        const value = syncView(await service.sync.status());
        if (mine !== acceptAttempt || controller.signal.aborted || !inFront) continue;
        await options.refresh();
        if (mine !== acceptAttempt || !inFront) continue;
        let account: string | undefined, datasets: number | undefined;
        if (signId && signing === signId && attempt === signAttempt) {
          let loaded: { account: string; datasets: number } | undefined, failure: unknown;
          try { loaded = await service.sync.quantum.account(); } catch (error) { failure = error; }
          if (mine !== acceptAttempt) throw { code: "cancelled" };
          if (!inFront) continue;
          if (loaded) { if (signing === signId && attempt === signAttempt) { account = loaded.account; datasets = loaded.datasets; signing = undefined; } }
          else {
            if (signing === signId && attempt === signAttempt && codeOf(failure) !== "sync_acceptance_required") signing = undefined;
            if (codeOf(failure) !== "sync_acceptance_required") throw failure;
          }
        }
        if (accepting?.id === id) accepting = undefined;
        return account !== undefined && datasets !== undefined ? { status: value, account, datasets } : { status: value };
      }
    }),
    /** Blur pauses the acceptance poll. Focus lets it read again before any earlier result counts. */
    foreground(value: boolean) { if (inFront === value) return; inFront = value; if (value) wakeFront?.(); else pollAbort?.abort(); },
    /** Opens the sign-in page; a second call opens a fresh one and the first wait ends. */
    signIn: () => run(async service => {
      const quantum = options.quantum(); if (!quantum) throw { code: "quantum_url_required" };
      const { url, id } = await service.sync.quantum.signIn(quantum.api, quantum.site); signing = id; attempt++;
      await options.openUrl(url); return {};
    }),
    /** Waits for the browser; an older wait that a new sign-in replaced answers `cancelled`. */
    wait: () => run(async service => {
      const id = signing, mine = attempt; if (!id) throw { code: "not_found" };
      let retain = false;
      try {
        const { account } = await service.sync.quantum.wait(id); if (mine !== attempt) throw { code: "cancelled" };
        try { const { datasets } = await service.sync.quantum.account(); return { account, datasets }; }
        catch (error) { if (mine === attempt && codeOf(error) === "sync_acceptance_required") retain = true; throw error; }
      } catch (error) { if (mine !== attempt) throw { code: "cancelled" }; throw error; }
      finally { if (mine === attempt && !retain) signing = undefined; }
    }),
    async cancel() {
      attempt++; signing = undefined;
      const id = accepting?.id; acceptAttempt++; accepting = undefined; pollAbort?.abort(); wakeFront?.();
      if (!id) return { ok: true as const };
      const service = options.service(); if (!service) return { ok: false as const, code: "unavailable" };
      try { await service.sync.quantum.cancelAcceptance(id); return { ok: true as const }; }
      catch (error) { return { ok: false as const, code: codeOf(error) }; }
    },
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
