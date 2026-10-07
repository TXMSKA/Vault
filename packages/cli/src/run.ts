import { spawn } from "node:child_process";
import type { Client } from "../../client/src/types.ts";
import { VaultClientError } from "../../client/src/index.ts";
export async function runProject(api: Client, project: string, command: string[], source: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!project || !command.length || command.some(arg => typeof arg !== "string" || arg.includes("\0")) || !command[0]) throw new VaultClientError("invalid");
  const variables = await api.environment(project), env = { ...source };
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) throw new VaultClientError("invalid");
    if (process.platform === "win32") for (const existing of Object.keys(env)) if (existing.toLowerCase() === name.toLowerCase()) delete env[existing];
    env[name] = value;
  }
  // The child owns its output. Vault emits neither the environment nor the command arguments.
  return new Promise((done, fail) => {
    const child = spawn(command[0], command.slice(1), { shell: false, stdio: "inherit", env, windowsHide: true });
    const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    const clean = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    child.once("error", () => { clean(); fail(new VaultClientError("command_failed")); });
    child.once("close", (code, signal) => { clean(); done(code ?? (signal === "SIGINT" ? 130 : 1)); });
  });
}
