import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { installedApp } from "../../client/src/app.ts";
import { serviceEnv } from "../../client/src/paths.ts";
import type { Lifecycle } from "./lifecycle.ts";
export const START_GUARD_MS = 30000;
/**
 * Starts the Vault app that install.json names, in its prompts view, when a prompt needs a person and no vault-app is present.
 * Detached, with an argument array and no shell, and never again while the last start is under 30 seconds old.
 * Without an app recorded, or with one that is not a file, nothing starts and the prompt waits for whoever opens Vault.
 */
export function appStarter(home: string, lifecycle: Lifecycle, now: () => number) {
  let last: number | undefined;
  return () => {
    if (last !== undefined && now() - last < START_GUARD_MS || lifecycle.has("vault-app")) return;
    const app = installedApp(home); if (!app) return;
    last = now();
    // The first launch of a program can take seconds (a virus scan), so the answer to the request that asked goes out before the start.
    setTimeout(() => {
      try {
        const child = spawn(app, ["--prompts"], { cwd: dirname(app), env: serviceEnv(home), shell: false, detached: true, windowsHide: false, stdio: "ignore" });
        child.once("error", () => undefined); child.unref();
      } catch {}
    }, 100);
  };
}
