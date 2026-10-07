import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startService } from "./server.ts";
export async function serve() {
  const service = await startService();
  const fatal = () => { service.vault.memory.lock(); void service.shutdown().finally(() => { process.exitCode = 1; }); };
  process.once("unhandledRejection", fatal); process.once("uncaughtException", fatal);
  return service;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await serve(); } catch { process.stderr.write("Vault service could not start.\n"); process.exitCode = 1; }
}
