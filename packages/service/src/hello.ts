import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
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
/** How long what the helper said about Windows Hello is trusted before it is asked again. */
export const HELLO_CHECK_MS = 60000;
export function helloAdapter(home: string, vault: Vault) {
  const filename = join(home, "secrets", "hello.json");
  const adapter = createHelloAdapter(vault.store, { protect: bytes => dpapi(bytes), unprotect: bytes => dpapi(bytes, true) }, {
    async read() { try { return JSON.parse(await readCapped(filename, 24000)) as WrappedKey; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new VaultError("unavailable"); } },
    write: value => atomicJson(filename, value), remove: () => rm(filename, { force: true }),
  }, vault.memory, runHelper);
  let known = false, checked = 0, checking = false;
  return {
    ...adapter,
    /** Whether Hello is set up for this vault: its wrapped key exists. */
    async enabled() { try { return (await stat(filename)).isFile(); } catch { return false; } },
    /**
     * Whether Hello can be used here, as the helper last said, and never later than the answer being asked for: the helper's first run can wait on
     * the antivirus for half a minute, and the status is asked every few seconds. The first answer is "no"; the helper is asked again once a minute.
     */
    availableNow() {
      if (process.platform !== "win32") return false;
      if (!checking && Date.now() - checked >= HELLO_CHECK_MS) {
        checking = true;
        void adapter.available().then(value => { known = value; }, () => { known = false; }).finally(() => { checked = Date.now(); checking = false; });
      }
      return known;
    },
  };
}
