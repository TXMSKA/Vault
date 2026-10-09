// Starts the Vault app from this checkout, against the vault home that VAULT_HOME names (or the default one when it is not set).
// Electron is not downloaded here: point ELECTRON_OVERRIDE_DIST_PATH at an Electron 44.5.1 folder, or install the binary once with
// `node node_modules/electron/install.js`. Run `npm run build` first.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = fileURLToPath(new URL("../", import.meta.url)), fail = message => { console.error(message); process.exit(1); };
if (!existsSync(join(app, "dist", "main", "main.js"))) fail("The app is not built. Run npm run build first.");
const names = { win32: "electron.exe", darwin: join("Electron.app", "Contents", "MacOS", "Electron"), linux: "electron" };
const override = process.env.ELECTRON_OVERRIDE_DIST_PATH, folder = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
let binary;
if (override) binary = join(override, names[process.platform] ?? "electron");
else if (existsSync(join(folder, "path.txt"))) binary = join(folder, "dist", readFileSync(join(folder, "path.txt"), "utf8"));
if (!binary || !existsSync(binary)) fail("Electron is not installed. Set ELECTRON_OVERRIDE_DIST_PATH to an Electron 44.5.1 folder, or run node node_modules/electron/install.js once.");
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(binary, [app, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("error", error => fail(`Electron could not start: ${error.message}`));
child.on("exit", code => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill());
