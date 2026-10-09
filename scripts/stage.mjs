// Assembles the installable layout from the built packages, so an installed copy never runs TypeScript or needs a development dependency:
//   node.exe        a copy of the Node that runs this script (CI pins it)
//   lib/            the compiled CLI, service and client, the helper, and node_modules/vault-core
//   LICENSE, README.md
// Usage: node scripts/stage.mjs [folder]. The default folder is build/stage. Run `npm run build` first.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)), packages = join(root, "packages"), windows = process.platform === "win32";
const fail = message => { console.error(message); process.exit(1); };
if (process.argv.length > 3) fail("Usage: node scripts/stage.mjs [folder]");
const out = resolve(process.argv[2] ?? join(root, "build", "stage")), lib = join(out, "lib"), version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const helper = join(packages, "helper", "bin", "vault-helper.exe");
const inputs = [join(packages, "core", "dist", "index.js"), join(packages, "service", "dist", "service", "src", "main.js"), join(packages, "cli", "dist", "cli", "src", "main.js"), ...windows ? [helper] : []];
if (!inputs.every(existsSync)) fail("The packages are not built. Run npm run build first.");
// Only an empty folder or an earlier stage is cleared, so a wrong argument cannot delete anything else.
if (existsSync(out) && readdirSync(out).length && !existsSync(join(lib, "package.json"))) fail(`${out} is not empty and is not a staged layout.`);
rmSync(out, { recursive: true, force: true }); mkdirSync(lib, { recursive: true });
const json = value => `${JSON.stringify(value, null, 2)}\n`;
writeFileSync(join(lib, "package.json"), json({ name: "vault", version, private: true, type: "module" }));

copyFileSync(process.execPath, join(out, windows ? "node.exe" : "node"));
// The service and the CLI import each other's and the client's sources by relative path, so their compiled trees share one root.
for (const name of ["service", "cli"]) cpSync(join(packages, name, "dist"), lib, { recursive: true, force: true });
if (windows) { mkdirSync(join(lib, "helper", "bin"), { recursive: true }); copyFileSync(helper, join(lib, "helper", "bin", "vault-helper.exe")); }
const core = join(lib, "node_modules", "vault-core");
cpSync(join(packages, "core", "dist"), join(core, "dist"), { recursive: true, filter: source => statSync(source).isDirectory() || source.endsWith(".js") });
writeFileSync(join(core, "package.json"), json({ name: "vault-core", version, private: true, type: "module", exports: { ".": "./dist/index.js" } }));
for (const name of ["LICENSE", "README.md"]) copyFileSync(join(root, name), join(out, name));
console.log(`Staged ${out} with ${process.version}.`);
