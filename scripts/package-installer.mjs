// Builds the Windows installer with electron-builder from the built app (npm run build) and the staged layout (node scripts/stage.mjs).
// build/release gets Vault-Setup-x64.exe, its blockmap, latest.yml and the unpacked app in win-unpacked. Run node scripts/package-console.mjs --finish afterwards.
// Usage: node scripts/package-installer.mjs [--prepackaged]
//   --prepackaged  builds the installer from build/release/win-unpacked as it is, which is how the release workflow builds it from the signed files.
// ELECTRON_OVERRIDE_DIST_PATH, when set, names an Electron 44.5.1 folder to pack instead of downloading one.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)), app = join(root, "packages", "app"), unpacked = join(root, "build", "release", "win-unpacked");
const fail = message => { console.error(message); process.exit(1); };
const flag = process.argv[2];
if (process.argv.length > 3 || flag !== undefined && flag !== "--prepackaged") fail("Usage: node scripts/package-installer.mjs [--prepackaged]");
if (process.platform !== "win32") fail("The installer is built on Windows.");
const version = path => JSON.parse(readFileSync(path, "utf8")).version;
// The version of the installer, of Vault.exe and of the update feed is the app package's; the helper and the release notes take the root one. They must be one number.
if (version(join(root, "package.json")) !== version(join(app, "package.json"))) fail("The version in package.json and in packages/app/package.json differ.");
if (flag === "--prepackaged") { if (!existsSync(join(unpacked, "Vault.exe"))) fail("There is no unpacked app. Run npm run dist first."); }
else {
  if (!existsSync(join(app, "dist", "main", "main.js"))) fail("The app is not built. Run npm run build first.");
  if (!existsSync(join(root, "build", "stage", "lib", "package.json"))) fail("There is no staged layout. Run node scripts/stage.mjs first.");
}
const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js"), args = [cli, "--win", "--x64", "--config", "electron-builder.yml", "--publish", "never"];
if (flag === "--prepackaged") args.push("--prepackaged", unpacked);
const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH;
if (dist) { if (!existsSync(join(dist, "electron.exe"))) fail("ELECTRON_OVERRIDE_DIST_PATH has no electron.exe."); args.push(`-c.electronDist=${dist}`); }
// electron-builder looks for no signing certificate and publishes nothing; a CSC variable from the machine must not turn either on.
const env = { ...process.env }; for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) delete env[name];
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const result = spawnSync(process.execPath, args, { cwd: app, env, stdio: "inherit", windowsHide: true });
if (result.status !== 0) fail("electron-builder did not finish.");
