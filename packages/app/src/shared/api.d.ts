// What the window may ask of the main process, and what the main process tells it. Types only: nothing here is emitted,
// and no value in it is a secret except the ones a person types or reveals (passwords and recovery keys, and a field's value the
// moment it is revealed). A list or an open entry carries the values of fields that are not secret and nothing else.
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
/** The person's choices, as chosen: "system" is still "system" here (see `language` and `theme` of the state for what shows). */
export type SettingsView = { idleMinutes: 1 | 5 | 15 | 30 | 60 | 240; lockWithLastApp: boolean; language: "system" | "en" | "es"; theme: "system" | "dark" | "light" };
export type Kind = "login" | "card" | "doc" | "note" | "key" | "custom" | "env";
/** One line of the list. `detail` is a username, a website's host, a bank or a file type: never a secret. `search` is the text a search looks through. */
export type EntrySummary = { id: string; kind: Kind; title: string; favorite: boolean; version: number; updatedAt: string; detail: string; count: number; search: string };
/** A field of an open entry. A secret field has no value here, only whether it holds one. */
export type FieldView = { id: string; name: string; secret: boolean; filled: boolean; value: string | null };
export type FileView = { id: string; name: string; type: string; size: number };
export type EntryView = {
  id: string; kind: Kind; title: string; favorite: boolean; version: number; updatedAt: string;
  fields: FieldView[]; note: { filled: boolean }; totp: boolean; files: FileView[];
};
/**
 * What the window saves. A secret field without `value` keeps the value it has; the main process puts it back from the entry it fetches.
 * `note` and `totp` are the same: left out, they stay as they are.
 */
export type FieldInput = { id: string; name: string; secret: boolean; value?: string };
export type EntryInput = { id: string; kind: Kind; title: string; favorite: boolean; fields: FieldInput[]; note?: string; totp?: string };
export type AppState = {
  phase: "starting" | "ready" | "unavailable";
  /** Why Vault is out of reach, while `phase` is "unavailable". */
  problem: "not_installed" | "unavailable" | null;
  created: boolean;
  unlocked: boolean;
  /** Whether Windows Hello can be offered at unlock: it is set up for this vault. */
  hello: boolean;
  /** Whether Windows Hello can be set up here. */
  helloAvailable: boolean;
  settings: SettingsView;
  language: Language;
  theme: Theme;
  computer: string;
  maximized: boolean;
  /** The first-open tips were never dismissed. */
  tour: boolean;
  /** Closing the window was asked while the recovery key is on screen and not yet saved or printed; the window asks first. */
  closing: boolean;
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
  /** The entries, newest change first, read again from the service. */
  entries(): Promise<Result<{ entries: EntrySummary[] }>>;
  entryOpen(input: { id: string }): Promise<Result<{ entry: EntryView }>>;
  /** `part` is `f:` and a field's id, or `note`. The value is fetched from the service for this call only. */
  entryReveal(input: { id: string; part: string }): Promise<Result<{ value: string }>>;
  /** Puts the value on the clipboard, which is cleared 30 seconds later if it still holds it. */
  entryCopy(input: { id: string; part: string }): Promise<Result>;
  /** The one-time code now, and the seconds until it changes. */
  entryCode(input: { id: string }): Promise<Result<{ code: string; remaining: number }>>;
  entryCopyCode(input: { id: string }): Promise<Result>;
  entryOpenSite(input: { id: string }): Promise<Result>;
  entryFavorite(input: { id: string; favorite: boolean }): Promise<Result<{ version: number }>>;
  /** `expected` is the version the window saw, or 0 for a new entry. An entry that changed meanwhile answers `conflict`. */
  entrySave(input: { entry: EntryInput; expected: number }): Promise<Result<{ version: number }>>;
  /** `undo` says whether the entry can be put back (a document with files cannot). */
  entryRemove(input: { id: string; expected: number }): Promise<Result<{ undo: boolean }>>;
  entryUndo(input: { id: string }): Promise<Result>;
  saveSettings(input: SettingsView): Promise<Result>;
  enableHello(input: { password: string }): Promise<Result>;
  disableHello(): Promise<Result>;
  dismissTour(): Promise<Result>;
  /** The person chose to stay when closing was warned about. */
  cancelClose(): Promise<void>;
  /** The person chose to close anyway. */
  confirmClose(): Promise<void>;
  /** The person touched the window; it keeps a prompts-only start open. */
  interact(): Promise<void>;
  retry(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
}
