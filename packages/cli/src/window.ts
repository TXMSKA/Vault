import { VaultClientError } from "../../client/src/index.ts";
import { runHelper } from "../../client/src/helper.ts";
// Windows Hello asks over the window in front, which is the terminal where the person typed.
export async function foregroundWindow(): Promise<string> {
  if (process.platform !== "win32") throw new VaultClientError("unavailable");
  try { return (await runHelper("foreground-window", {})).hwnd; }
  catch { throw new VaultClientError("unavailable"); }
}
