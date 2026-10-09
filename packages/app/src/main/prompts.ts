import type { Prompt, RunSummary } from "vault-client";
import type { PromptView } from "../shared/api.js";
const first = (prompts: readonly Prompt[]) => [...prompts].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
/**
 * What the window shows of the prompts that wait: the oldest one it can answer now, and the ones it has not seen before.
 * Before the vault exists there is nothing to unlock, approve or allow, so no prompt is shown (the window still comes forward for it).
 * An unlock prompt is not shown once the vault is open.
 */
export function route(prompts: readonly Prompt[], seen: ReadonlySet<string>, status: { created: boolean; unlocked: boolean }): { shown: Prompt | undefined; fresh: string[] } {
  const ordered = first(prompts), fresh = ordered.filter(prompt => !seen.has(prompt.id)).map(prompt => prompt.id);
  if (!status.created) return { shown: undefined, fresh };
  return { shown: ordered.find(prompt => prompt.kind !== "unlock" || !status.unlocked), fresh };
}
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;
/** The prompt as the window gets it: capped text and, for a run, what only the run list knows (names too short to hide, and a project that is missing or not unique). */
export function toView(prompt: Prompt, run?: Pick<RunSummary, "short" | "problem">): PromptView {
  const app = { id: clip(prompt.app.id, 40), name: clip(prompt.app.name, 120) }, expiresAt = prompt.expiresAt;
  if (prompt.kind === "unlock") return { id: prompt.id, kind: "unlock", app, reason: prompt.summary.reason === null ? null : clip(prompt.summary.reason, 120), expiresAt };
  if (prompt.kind === "permission") return { id: prompt.id, kind: "permission", app, permission: "import", expiresAt };
  return {
    id: prompt.id, kind: "run", app, project: clip(prompt.summary.project, 500), cwd: clip(prompt.summary.cwd, 4096), expiresAt,
    commands: prompt.summary.commands.slice(0, 10).map(argv => argv.slice(0, 64).map(arg => clip(arg, 8192))),
    short: run?.short ? run.short.slice(0, 100).map(name => clip(name, 256)) : null, problem: run?.problem ?? null,
  };
}
