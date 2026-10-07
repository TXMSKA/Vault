import { execFile } from "node:child_process";
import { join } from "node:path";
import { base64, unbase64, unlock } from "./crypto.js";
import { createVaultUnlock } from "./unlock.js";
import { shape, version, VaultError } from "./store.js";
import type { VaultStore } from "./store.js";
import type { VaultMemory } from "./memory.js";

export interface KeyProtector {
  protect(bytes: Uint8Array<ArrayBuffer>): Uint8Array | Promise<Uint8Array>;
  unprotect(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>;
}
export type WrappedKey = { version: number; blob: string };
export interface HelloKeyStore {
  read(): Promise<WrappedKey | null>;
  write(value: WrappedKey): Promise<void>;
  remove(): Promise<void>;
}
const prelude = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$availability = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$result = [Windows.Security.Credentials.UI.UserConsentVerificationResult,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
function Await($operation, $type) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation@TICK@1' } | Select-Object -First 1
  $task = $method.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
`;
// Desktop verification needs the host HWND, rather than a UWP CoreWindow.
const interop = String.raw`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
public interface IVaultConsent {
  [return: MarshalAs(UnmanagedType.IInspectable)]
  object RequestVerificationForWindowAsync(IntPtr window, IntPtr message, ref Guid iid);
}
public static class VaultConsent {
  [DllImport("combase.dll")] static extern int RoInitialize(uint type);
  [DllImport("combase.dll")] static extern void RoUninitialize();
  [DllImport("combase.dll", PreserveSig = false)] static extern void WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string value, int length, out IntPtr result);
  [DllImport("combase.dll", PreserveSig = false)] static extern void WindowsDeleteString(IntPtr value);
  [DllImport("combase.dll", PreserveSig = false)] static extern void RoGetActivationFactory(IntPtr name, ref Guid iid, [MarshalAs(UnmanagedType.IInspectable)] out object factory);
  public static object Request(long window, Guid operation) {
    IntPtr name = IntPtr.Zero, message = IntPtr.Zero; object factory = null;
    int initialized = RoInitialize(0);
    if (initialized < 0 && initialized != unchecked((int)0x80010106)) Marshal.ThrowExceptionForHR(initialized);
    try {
      string type = "Windows.Security.Credentials.UI.UserConsentVerifier", text = "Unlock Vault";
      WindowsCreateString(type, type.Length, out name); WindowsCreateString(text, text.Length, out message);
      Guid iid = typeof(IVaultConsent).GUID; RoGetActivationFactory(name, ref iid, out factory);
      return ((IVaultConsent)factory).RequestVerificationForWindowAsync(new IntPtr(window), message, ref operation);
    } finally {
      if (factory != null) Marshal.ReleaseComObject(factory);
      if (message != IntPtr.Zero) WindowsDeleteString(message);
      if (name != IntPtr.Zero) WindowsDeleteString(name);
      if (initialized >= 0) RoUninitialize();
    }
  }
}
'@
$operationType = [Windows.Foundation.IAsyncOperation@TICK@1,Windows.Foundation,ContentType=WindowsRuntime].MakeGenericType($result)
$operation = [VaultConsent]::Request([long]$env:VAULT_HELLO_HWND, $operationType.GUID)
(Await $operation $result).ToString()
`;
function powershell(script: string, hwnd?: bigint): Promise<string> {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((done, fail) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script.replaceAll("@TICK@", "\u0060"), "utf16le").toString("base64")],
      { windowsHide: true, timeout: hwnd === undefined ? 15000 : 120000, maxBuffer: 8192, env: { ...process.env, VAULT_HELLO_HWND: hwnd?.toString() ?? "" } },
      (error, stdout) => error ? fail(new VaultError("unavailable")) : done(stdout.trim()));
  });
}
export async function helloAvailable(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try { return await powershell(`${prelude}(Await ($verifier::CheckAvailabilityAsync()) $availability).ToString()`) === "Available"; }
  catch { return false; } // An unavailable verifier leaves password unlock as the only path.
}
async function verify(hwnd: bigint): Promise<void> {
  if (process.platform !== "win32" || hwnd <= 0n || !await helloAvailable()) throw new VaultError("unavailable");
  if (await powershell(prelude + interop, hwnd) !== "Verified") throw new VaultError("locked");
}
export function createHelloAdapter(store: VaultStore, protector: KeyProtector, wrapped: HelloKeyStore, memory: VaultMemory) {
  const auth = createVaultUnlock(store, { memory }); let generation = 0, pending: Promise<unknown> = Promise.resolve();
  function queue<T>(operation: () => Promise<T>): Promise<T> {
    const run = pending.catch(() => undefined).then(operation); pending = run; return run;
  }
  return {
    available: helloAvailable,
    enable(password: string) {
      const ticket = memory.ticket(), attempt = generation;
      return queue(async () => {
        if (!await helloAvailable()) throw new VaultError("unavailable");
        await auth.unlock(password); const current = await store.envelope(); if (!current.state) throw new VaultError("not_found");
        let opened;
        try {
          opened = await unlock(current.state, password); const protectedBytes = await protector.protect(opened.bytes);
          if (!protectedBytes.length || protectedBytes.length > 16384) throw new VaultError("invalid");
          if (attempt !== generation || !memory.current(ticket) || (await store.envelope()).version !== current.version) throw new VaultError("locked");
          await wrapped.write({ version: current.version, blob: base64(protectedBytes) });
          if (attempt !== generation) { await wrapped.remove(); throw new VaultError("locked"); }
        } catch (error) { throw error instanceof VaultError ? error : new VaultError("unavailable"); }
        finally { opened?.bytes.fill(0); }
      });
    },
    async unlock(hwnd: bigint) {
      const ticket = memory.ticket(), attempt = generation; let bytes;
      try {
        const value = await wrapped.read(); if (!value) throw new VaultError("not_found");
        shape(value, "blob,version"); version(value.version);
        if (typeof value.blob !== "string" || value.blob.length > 22000) throw new VaultError("invalid");
        const current = await store.envelope(); if (!current.state || current.version !== value.version) throw new VaultError("locked");
        await verify(hwnd);
        if (attempt !== generation || !memory.current(ticket)) throw new VaultError("locked");
        bytes = await protector.unprotect(unbase64(value.blob));
        if (bytes.length !== 32) throw new VaultError("invalid");
        const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
        if ((await store.envelope()).version !== value.version || attempt !== generation || !memory.open(key, ticket)) throw new VaultError("locked");
        return key;
      } catch (error) { throw error instanceof VaultError ? error : new VaultError("unavailable"); }
      finally { bytes?.fill(0); }
    },
    disable() { generation++; return queue(() => wrapped.remove()); },
  };
}
