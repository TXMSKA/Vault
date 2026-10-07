import { execFile } from "node:child_process";
import { join } from "node:path";
import { VaultClientError } from "../../client/src/index.ts";
// Windows Hello asks over the window in front, which is the terminal where the person typed.
export function foregroundWindow(): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new VaultClientError("unavailable"));
  const script = `Add-Type -Namespace VaultCli -Name Window -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'; [VaultCli.Window]::GetForegroundWindow().ToInt64()`;
  const executable = join(process.env.SystemRoot || "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((done, fail) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15000, maxBuffer: 1024 }, (error, stdout) => {
      const value = stdout.trim(); if (error || !/^[1-9][0-9]{0,18}$/.test(value)) fail(new VaultClientError("unavailable")); else done(value);
    });
  });
}
