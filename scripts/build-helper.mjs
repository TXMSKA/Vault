// Compiles packages/helper/src/vault-helper.cs into packages/helper/bin/vault-helper.exe with the .NET Framework 4 compiler every Windows 10 and 11 ships.
// There is no SDK, package or download. Other platforms have no helper, so the script does nothing there.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);
const root = process.env.SystemRoot || "C:\\Windows", framework = join(root, "Microsoft.NET", "Framework64", "v4.0.30319"), metadata = join(root, "System32", "WinMetadata");
const source = fileURLToPath(new URL("../packages/helper/src/vault-helper.cs", import.meta.url)), output = fileURLToPath(new URL("../packages/helper/bin/vault-helper.exe", import.meta.url));
// The build is skipped while the executable is newer than its source and this script.
if (existsSync(output) && [source, fileURLToPath(import.meta.url)].every(file => statSync(file).mtimeMs <= statSync(output).mtimeMs)) process.exit(0);
const references = [join(metadata, "Windows.Foundation.winmd"), join(metadata, "Windows.Security.winmd"), join(framework, "System.Runtime.dll"), join(framework, "System.Security.dll")];
mkdirSync(join(output, ".."), { recursive: true }); rmSync(output, { force: true });
const result = spawnSync(join(framework, "csc.exe"), ["/nologo", "/optimize", "/target:exe", `/out:${output}`, ...references.map(file => `/reference:${file}`), source], { shell: false, windowsHide: true, stdio: "inherit" });
if (result.status !== 0 || !existsSync(output)) { console.error("The Vault helper did not compile."); process.exit(1); }
