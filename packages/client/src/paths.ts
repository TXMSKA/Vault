import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { VaultClientError } from "./errors.ts";
export const appIdPattern = /^[a-z][a-z0-9-]{1,39}$/;
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.VAULT_HOME) return resolve(env.VAULT_HOME);
  if (process.env.NODE_ENV === "test" || process.env.NODE_TEST_CONTEXT) throw new VaultClientError("test_default_root");
  const root = process.platform === "win32" ? env.LOCALAPPDATA || join(homedir(), "AppData", "Local") : env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(root, "Cosmic", "apps", "Vault");
}
// Same restrictions as the service's Quantum URL check. The client cannot import that module.
export function cosmicSite(value: string): string {
  if (!value || value.length > 2048 || value.includes("\0")) throw new VaultClientError("invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new VaultClientError("invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.protocol === "http:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new VaultClientError("invalid");
  return url.href.replace(/\/+$/, "");
}
// A background vault does not inherit app credentials or Node injection options.
// The account site is the one extra setting, checked here so a bad value is not dropped on the way to the child.
export function serviceEnv(home: string): NodeJS.ProcessEnv {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|XDG_DATA_HOME|LANG|LC_ALL|PSMODULEPATH|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|OS)$/i;
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.test(name))), VAULT_HOME: home };
  if (process.env.VAULT_QUANTUM_SITE !== undefined) env.VAULT_QUANTUM_SITE = cosmicSite(process.env.VAULT_QUANTUM_SITE);
  return env;
}
