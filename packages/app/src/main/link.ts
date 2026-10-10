import type { AppIdentity, Backup, Client, Prompt, RunSummary, Settings } from "vault-client";
import { stateInput, unlock as openBackup } from "vault-core";
import type { PromptView, Result } from "../shared/api.js";
import { route, toView } from "./prompts.ts";
import { DEFAULTS, toService } from "./settings.ts";
/** How this app registers with the service: a Cosmic app that manages Vault, like the command line. */
export const IDENTITY: AppIdentity = { id: "vault-app", name: "Vault", kind: "cosmic" };
export const REFRESH_MS = 2000;
export { DEFAULTS };
const CODE = /^[a-z][a-z_]{0,39}$/;
/** The short code of a failure, for the window to find words for. Anything that is not a plain code is "unavailable". */
export const codeOf = (error: unknown): string => { const code = (error as { code?: unknown } | null | undefined)?.code; return typeof code === "string" && CODE.test(code) ? code : "unavailable"; };
const failure = (error: unknown): Result<never> => ({ ok: false, code: codeOf(error) });
export type LinkOptions = {
  connect(): Promise<Client>;
  /** The handle of this app's window, as a decimal string, so that Windows Hello appears over it. */
  handle(): string;
  sleep?: (ms: number) => Promise<void>;
};
export type Snapshot = { phase: "starting" | "ready" | "unavailable"; problem: "not_installed" | "unavailable" | null; created: boolean; unlocked: boolean; hello: boolean; helloAvailable: boolean; settings: Settings; prompt: PromptView | null; pending: number };
/**
 * The main process's whole conversation with the service: it connects (and keeps trying while the service is out of reach), polls the
 * status and the settings, long-polls the prompts that wait for this app, and runs the person's answers. Nothing here knows about windows.
 */
export function createLink(options: LinkOptions) {
  let client: Client | undefined, phase: Snapshot["phase"] = "starting", problem: Snapshot["problem"] = null, created = false, unlocked = false, hello = false, helloAvailable = false, settings = DEFAULTS;
  let prompts: Prompt[] = [], held: string | undefined, secured = false, stopped = false, failures = 0, ticks = 0, last = "", started = false, backup: { name: string; value: Backup } | undefined;
  const seen = new Set<string>(), gone = new Set<string>(), details = new Map<string, Pick<RunSummary, "short" | "problem">>();
  const changes = new Set<(snapshot: Snapshot) => void>(), arrivals = new Set<(ids: string[]) => void>(), wakers = new Set<() => void>();
  const wake = () => { for (const waker of [...wakers]) waker(); };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => { const finish = () => { clearTimeout(timer); wakers.delete(finish); done(); }, timer = setTimeout(finish, ms); wakers.add(finish); }));
  const shown = () => route(prompts, seen, { created, unlocked }).shown;
  function snapshot(): Snapshot {
    const prompt = shown();
    return { phase, problem, created, unlocked, hello, helloAvailable, settings, prompt: prompt ? toView(prompt, details.get(prompt.id)) : null, pending: prompts.length };
  }
  function emit() {
    const view = snapshot(), key = JSON.stringify(view);
    if (key === last) return;
    last = key; for (const listener of [...changes]) listener(view);
  }
  /** What only the run list knows about the run on screen: names too short to hide, and a project that is missing or not unique. */
  async function enrich(list = prompts) {
    const prompt = route(list, seen, { created, unlocked }).shown, current = client;
    if (!current || prompt?.kind !== "run") return;
    try { for (const run of await current.runs.list()) details.set(run.id, { short: run.short, problem: run.problem }); } catch {}
  }
  async function setPrompts(list: Prompt[]) {
    for (const id of gone) if (!list.some(prompt => prompt.id === id)) gone.delete(id);
    list = list.filter(prompt => !gone.has(prompt.id));
    const { fresh } = route(list, seen, { created, unlocked });
    // The run list is asked before the prompt is shown, so a run never appears without what only that list knows.
    await enrich(list);
    // An answer given while the run list was being read must not be undone by this list.
    list = list.filter(prompt => !gone.has(prompt.id)); prompts = list; for (const id of fresh) seen.add(id);
    if (seen.size > 500) for (const id of [...seen].slice(0, seen.size - 500)) seen.delete(id);
    for (const id of details.keys()) if (!list.some(prompt => prompt.id === id)) details.delete(id);
    if (fresh.length) for (const listener of [...arrivals]) listener(fresh);
    emit();
  }
  async function refresh() {
    const current = client; if (!current) throw new Error("unavailable");
    const status = await current.status(), was = unlocked;
    created = status.created; unlocked = status.unlocked;
    // The service ends every unlock prompt when the vault opens; the next list will say so, but the screen need not wait for it.
    if (unlocked) prompts = prompts.filter(prompt => prompt.kind !== "unlock");
    if (ticks++ % 5 === 0) { try { settings = await current.settings.get(); } catch {} }
    // Windows Hello is set up when the service holds its wrapped key, and can be set up when the helper says it is available.
    hello = status.hello?.enabled === true; helloAvailable = status.hello?.available === true;
    if (was !== unlocked) await enrich();
    phase = "ready"; problem = null; emit();
  }
  /** Reads the state now instead of at the next turn. `settings` reads the settings too, which are otherwise read every fifth turn. */
  const refreshed = async (settings = false) => { if (settings) ticks = 0; try { await refresh(); } catch {} };
  async function promptLoop() {
    let misses = 0;
    while (!stopped) {
      if (!client) { await sleep(500); continue; }
      try {
        // The service answers at once while a prompt waits and holds the call for up to 25 seconds when none does.
        const list = await client.prompts.list(); misses = 0;
        if (stopped) return;
        await setPrompts(list); await sleep(list.length ? 1000 : 100);
      } catch { if (stopped) return; misses++; await sleep(Math.min(30000, 1000 * 2 ** Math.min(misses - 1, 5))); }
    }
  }
  async function mainLoop() {
    while (!stopped) {
      try {
        if (!client) { client = await options.connect(); if (!started) { started = true; void promptLoop(); } }
        await refresh(); failures = 0;
      } catch (error) {
        failures++;
        if (!client || failures >= 2) { phase = "unavailable"; problem = ["not_installed", "invalid_install"].includes(codeOf(error)) ? "not_installed" : "unavailable"; emit(); }
      }
      if (!stopped) await sleep(failures ? Math.min(30000, REFRESH_MS * 2 ** Math.min(failures, 4)) : REFRESH_MS);
    }
  }
  /** Runs one answer of the person against the service, then reads the state back so the window shows the result. */
  async function act<T extends object = {}>(work: (service: Client) => Promise<T | void>): Promise<Result<T>> {
    const service = client; if (!service) return { ok: false, code: "unavailable" };
    let value: T | void;
    try { value = await work(service); } catch (error) { return failure(error); }
    await refreshed(); return { ok: true, ...(value ?? {}) } as Result<T>;
  }
  /** An answered prompt leaves the screen at once, even while the next list from the service still carries it. */
  const answered = (id: string) => { gone.add(id); prompts = prompts.filter(prompt => prompt.id !== id); };
  const waiting = (id: string, kind: Prompt["kind"]) => prompts.find(prompt => prompt.id === id && prompt.kind === kind);
  return {
    start() { void mainLoop(); },
    async stop() {
      stopped = true; wake(); const service = client; client = undefined;
      if (service) await Promise.race([service.close().catch(() => undefined), new Promise<void>(done => setTimeout(done, 3000).unref())]);
    },
    snapshot,
    /** The connection to the service, for the calls that need it directly; nothing when Vault is out of reach. */
    service: () => client,
    onChange(listener: (snapshot: Snapshot) => void) { changes.add(listener); },
    /** Called with the ids of prompts this window has not seen before. */
    onArrival(listener: (ids: string[]) => void) { arrivals.add(listener); },
    refresh: refreshed,
    retry() { failures = 0; wake(); },
    recovery: () => held,
    /** Whether the recovery key held now was saved or printed. */
    secured: () => secured,
    secure() { secured = true; },
    release() { held = undefined; secured = false; },
    /** The choices go to the service first; the window follows what the service answers. */
    saveSettings: (next: Settings) => act(async service => { settings = await service.settings.set(toService(next)); }),
    enableHello: (password: string) => act(service => service.hello.enable(password)),
    disableHello: () => act(service => service.hello.disable()),
    backup: { set(name: string, value: Backup) { backup = { name, value }; }, clear() { backup = undefined; } },
    create: (password: string) => act(async service => { const { recovery } = await service.create(password); held = recovery; secured = false; return { recovery }; }),
    unlock: (password: string) => act(service => service.unlock(password)),
    unlockWithHello: () => act(service => service.hello.unlock(options.handle())),
    recover: (recovery: string, password: string) => act(async service => { const result = await service.recover(recovery, password); held = result.recovery; secured = false; return { recovery: result.recovery }; }),
    lock: () => act(service => service.lock()),
    approveRun: (id: string, password: string) => act(async service => { await service.runs.approve(id, password); answered(id); }),
    approveRunWithHello: (id: string) => act(async service => { await service.runs.approveWithHello(id, options.handle()); answered(id); }),
    /** The permission goes to the app that asked, as named by the prompt on hand, never by the window. */
    allowImport: (id: string, password: string) => act(async service => { const prompt = waiting(id, "permission"); if (!prompt) throw { code: "not_found" }; await service.permissions.importWithPassword(password, prompt.app.id); answered(id); }),
    allowImportWithHello: (id: string) => act(async service => { const prompt = waiting(id, "permission"); if (!prompt) throw { code: "not_found" }; await service.permissions.importWithHello(options.handle(), prompt.app.id); answered(id); }),
    dismiss: (id: string) => act(async service => { await service.prompts.dismiss(id); answered(id); }),
    /**
     * A new vault from an encrypted backup: the backup's password must open the backup first, so a typing mistake never becomes the
     * master password. The vault is then created with that password and the backup restored into it.
     */
    async restoreBackup(password: string): Promise<Result<{ recovery: string; restored: boolean }>> {
      const chosen = backup; if (!chosen) return { ok: false, code: "no_backup" };
      try { (await openBackup(stateInput(chosen.value.envelope), password)).bytes.fill(0); } catch { return { ok: false, code: "wrong_backup_password" }; }
      const result = await act<{ recovery: string; restored: boolean }>(async service => {
        const { recovery } = await service.create(password); held = recovery; secured = false;
        let restored = true; try { await service.restore(chosen.value, password); } catch { restored = false; }
        return { recovery, restored };
      });
      if (result.ok) backup = undefined; return result;
    },
  };
}
export type Link = ReturnType<typeof createLink>;
