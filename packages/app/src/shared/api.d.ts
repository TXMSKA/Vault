// What the window may ask of the main process, and what the main process tells it. Types only: nothing here is emitted,
// and no value in it is a secret except the ones a person types or reveals (passwords and recovery keys).
export type Language = "en" | "es";
export type Theme = "dark" | "light";
/** A failure the window has words for. It carries a short code, never a message or a value. */
export type Failure = { ok: false; code: string };
export type Result<T extends object = {}> = ({ ok: true } & T) | Failure;
export type AskingApp = { id: string; name: string };
/** What a prompt tells the person; a run's values are never part of it. */
export type PromptView =
  | { id: string; kind: "unlock"; app: AskingApp; reason: string | null; expiresAt: string }
  | { id: string; kind: "run"; app: AskingApp; project: string; cwd: string; commands: string[][]; short: string[] | null; problem: "missing" | "ambiguous" | null; expiresAt: string }
  | { id: string; kind: "permission"; app: AskingApp; permission: "import"; expiresAt: string };
export type AppState = {
  phase: "starting" | "ready" | "unavailable";
  /** Why Vault is out of reach, while `phase` is "unavailable". */
  problem: "not_installed" | "unavailable" | null;
  created: boolean;
  unlocked: boolean;
  /** Whether Windows Hello can be offered here: Windows, and set up for this vault. */
  hello: boolean;
  language: Language;
  theme: Theme;
  computer: string;
  maximized: boolean;
  /** The oldest prompt that waits for this window's answer, or none. */
  prompt: PromptView | null;
};
/** The one object the window sees. Every call is answered, none throws; a failure is `{ ok: false, code }`. */
export interface VaultBridge {
  state(): Promise<AppState>;
  /** Calls the listener with the new state each time it changes. Returns the function that stops listening. */
  onState(listener: (state: AppState) => void): () => void;
  create(input: { password: string }): Promise<Result<{ recovery: string }>>;
  chooseBackup(): Promise<Result<{ name: string }>>;
  restoreBackup(input: { password: string }): Promise<Result<{ recovery: string; restored: boolean }>>;
  unlock(input: { password: string }): Promise<Result>;
  unlockWithHello(): Promise<Result>;
  recover(input: { recovery: string; password: string }): Promise<Result<{ recovery: string }>>;
  lock(): Promise<Result>;
  saveRecoverySheet(): Promise<Result<{ name: string }>>;
  printRecoverySheet(): Promise<Result>;
  /** The person is done with the recovery key: the main process forgets it. */
  finishSetup(): Promise<Result>;
  approveRun(input: { id: string; password: string }): Promise<Result>;
  approveRunWithHello(input: { id: string }): Promise<Result>;
  allowImport(input: { id: string; password: string }): Promise<Result>;
  allowImportWithHello(input: { id: string }): Promise<Result>;
  dismissPrompt(input: { id: string }): Promise<Result>;
  /** The person touched the window; it keeps a prompts-only start open. */
  interact(): Promise<void>;
  retry(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}
