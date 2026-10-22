import { spawn } from "node:child_process";
import { VaultClientError } from "../../client/src/index.ts";
/** The published Quantum API and the Cosmic account site, used unless flags or VAULT_QUANTUM_API and VAULT_QUANTUM_SITE name others (local tests). */
export const QUANTUM_DEFAULTS = { api: "https://quantum.txmska.com", site: "https://cosmic.txmska.com" };
/** Explicit flags override the environment, which overrides the published addresses. */
export function quantumUrls(args: string[]): { api: string; site: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) { const flag = args[i], value = args[i + 1]; if (!["--api", "--site"].includes(flag) || Object.hasOwn(flags, flag) || !value || value.startsWith("--")) throw new VaultClientError("invalid"); flags[flag] = value; }
  const api = flags["--api"] ?? (process.env.VAULT_QUANTUM_API || QUANTUM_DEFAULTS.api), site = flags["--site"] ?? (process.env.VAULT_QUANTUM_SITE || QUANTUM_DEFAULTS.site);
  if (!api || !site) throw new VaultClientError("quantum_url_required"); return { api, site };
}
/** The printed URL remains usable when no browser launcher is available. */
export function openQuantum(url: string): void {
  try { const child = spawn(process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open", [url], { shell: false, detached: true, windowsHide: true, stdio: "ignore" }); child.once("error", () => {}); child.unref(); } catch {}
}
