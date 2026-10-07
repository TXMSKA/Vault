import { spawn } from "node:child_process";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { createHelloAdapter, VaultError } from "vault-core";
import type { WrappedKey } from "vault-core";
import { atomicJson, readCapped } from "../../client/src/files.ts";
import type { Vault } from "./vault.ts";
export function dpapi(bytes: Uint8Array, decrypt = false): Promise<Uint8Array<ArrayBuffer>> {
  if (process.platform !== "win32") return Promise.reject(new VaultError("unavailable"));
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::ReadLine()); try{$r=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))}finally{[Array]::Clear($b,0,$b.Length); if($r){[Array]::Clear($r,0,$r.Length)}}`;
  return new Promise((done, fail) => {
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], timeout: 15000 });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 22000) child.kill(); });
    child.on("error", () => fail(new VaultError("unavailable")));
    child.on("close", code => {
      if (code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) { fail(new VaultError("unavailable")); return; }
      done(Uint8Array.from(Buffer.from(output, "base64")));
    });
    child.stdin.on("error", () => fail(new VaultError("unavailable"))); child.stdin.end(`${Buffer.from(bytes).toString("base64")}\n`);
  });
}
export function helloAdapter(home: string, vault: Vault) {
  const filename = join(home, "secrets", "hello.json");
  return createHelloAdapter(vault.store, { protect: bytes => dpapi(bytes), unprotect: bytes => dpapi(bytes, true) }, {
    async read() { try { return JSON.parse(await readCapped(filename, 24000)) as WrappedKey; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new VaultError("unavailable"); } },
    write: value => atomicJson(filename, value), remove: () => rm(filename, { force: true }),
  }, vault.memory);
}
