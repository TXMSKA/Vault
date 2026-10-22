import { spawn } from "node:child_process";
import { VaultClientError } from "../../client/src/index.ts";
/** Explicit flags override the optional local endpoints. */
export function quantumUrls(args: string[]): { api: string; site: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) { const flag = args[i], value = args[i + 1]; if (!["--api", "--site"].includes(flag) || Object.hasOwn(flags, flag) || !value || value.startsWith("--")) throw new VaultClientError("invalid"); flags[flag] = value; }
  const api = flags["--api"] ?? process.env.VAULT_QUANTUM_API, site = flags["--site"] ?? process.env.VAULT_QUANTUM_SITE;
  if (!api || !site) throw new VaultClientError("quantum_url_required"); return { api, site };
}
/** The printed URL remains usable when no browser launcher is available. */
export function openQuantum(url: string): void {
  try { const child = spawn(process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open", [url], { shell: false, detached: true, windowsHide: true, stdio: "ignore" }); child.once("error", () => {}); child.unref(); } catch {}
}
