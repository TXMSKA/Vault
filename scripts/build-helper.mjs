// Compiles packages/helper/src/vault-helper.cs into packages/helper/bin/vault-helper.exe with the .NET Framework 4 compiler every Windows 10 and 11 ships.
// There is no SDK, package or download. Other platforms have no helper, so the script does nothing there.
// The file version Windows shows comes from the version in the root package.json: the two version attributes of the source are replaced in a copy beside the executable.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);
const root = process.env.SystemRoot || "C:\\Windows", framework = join(root, "Microsoft.NET", "Framework64", "v4.0.30319"), metadata = join(root, "System32", "WinMetadata");
const source = fileURLToPath(new URL("../packages/helper/src/vault-helper.cs", import.meta.url)), output = fileURLToPath(new URL("../packages/helper/bin/vault-helper.exe", import.meta.url));
const versioned = fileURLToPath(new URL("../packages/helper/bin/vault-helper.versioned.cs", import.meta.url)), manifest = fileURLToPath(new URL("../package.json", import.meta.url));
// The build is skipped while the executable is newer than its source, the version it carries and this script.
if (existsSync(output) && [source, manifest, fileURLToPath(import.meta.url)].every(file => statSync(file).mtimeMs <= statSync(output).mtimeMs)) process.exit(0);
const fail = message => { console.error(message); process.exit(1); };
const version = String(JSON.parse(readFileSync(manifest, "utf8")).version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
if (!version) fail("The version in package.json is not a version such as 0.1.0.");
// A Windows file version is four numbers up to 65535: the pre-release part of the version has no place in it.
if (version.slice(1).some(part => Number(part) > 65535)) fail("The version in package.json is too large for a Windows file version.");
const attribute = /\[assembly: (AssemblyVersion|AssemblyFileVersion)\("[^"]*"\)\]/g, windowsVersion = `${version[1]}.${version[2]}.${version[3]}.0`;
const text = readFileSync(source, "utf8");
if ((text.match(attribute) ?? []).length !== 2) fail("The helper source does not carry the version attributes this script replaces.");
mkdirSync(join(output, ".."), { recursive: true });
writeFileSync(versioned, text.replace(attribute, (_whole, name) => `[assembly: ${name}("${windowsVersion}")]`));
const references = [join(metadata, "Windows.Foundation.winmd"), join(metadata, "Windows.Security.winmd"), join(framework, "System.Runtime.dll"), join(framework, "System.Security.dll")];
rmSync(output, { force: true });
const result = spawnSync(join(framework, "csc.exe"), ["/nologo", "/optimize", "/target:exe", `/out:${output}`, ...references.map(file => `/reference:${file}`), versioned], { shell: false, windowsHide: true, stdio: "inherit" });
rmSync(versioned, { force: true });
if (result.status !== 0 || !existsSync(output)) fail("The Vault helper did not compile.");
