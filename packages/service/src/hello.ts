import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createHelloAdapter, VaultError } from "vault-core";
import type { WrappedKey } from "vault-core";
import { atomicJson, readCapped } from "../../client/src/files.ts";
import { runHelper } from "../../client/src/helper.ts";
import type { Vault } from "./vault.ts";
// DPAPI through the native helper: current-user scope, bytes as base64 on stdin and stdout.
export async function dpapi(bytes: Uint8Array, decrypt = false): Promise<Uint8Array<ArrayBuffer>> {
  if (process.platform !== "win32") throw new VaultError("unavailable");
  const input = Buffer.from(bytes);
  try {
    const answer = await runHelper(decrypt ? "dpapi-unprotect" : "dpapi-protect", { data: input.toString("base64") }), output = Buffer.from(answer.data, "base64");
    try { return Uint8Array.from(output); } finally { output.fill(0); }
  } catch { throw new VaultError("unavailable"); }
  finally { input.fill(0); }
}
export function helloAdapter(home: string, vault: Vault) {
  const filename = join(home, "secrets", "hello.json");
  return createHelloAdapter(vault.store, { protect: bytes => dpapi(bytes), unprotect: bytes => dpapi(bytes, true) }, {
    async read() { try { return JSON.parse(await readCapped(filename, 24000)) as WrappedKey; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new VaultError("unavailable"); } },
    write: value => atomicJson(filename, value), remove: () => rm(filename, { force: true }),
  }, vault.memory, runHelper);
}
