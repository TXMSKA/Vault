import { VaultClientError } from "../../client/src/index.ts";
import type { Client } from "../../client/src/types.ts";
import { copy } from "./copy.ts";
import type { CliIO } from "./main.ts";
/**
 * Makes sure Vault is open. In the terminal that is the master password typed here; when the Vault app is installed it is an
 * unlock prompt in the app's window, and the command waits for the person to answer it there.
 */
export async function unlocked(api: Client, io: CliIO, viaApp: boolean, reason?: string): Promise<void> {
  if ((await api.status()).unlocked) return;
  if (!viaApp) { await api.unlock(await io.ask(copy("Master password: ", "Contraseña maestra: "))); return; }
  const { id } = await api.prompts.unlock(reason);
  io.error(copy("Unlock Vault in its window.", "Desbloqueá Vault en su ventana."));
  for (;;) {
    const { state } = await api.prompts.wait(id);
    if (state === "done") return;
    if (state !== "pending") throw new VaultClientError(state === "cancelled" ? "cancelled" : "unlock_expired");
  }
}
