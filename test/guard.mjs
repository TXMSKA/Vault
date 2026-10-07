import fs from "node:fs";
import promises from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

process.env.NODE_ENV = "test";
const bases = process.platform === "win32"
  ? [process.env.LOCALAPPDATA, join(homedir(), "AppData", "Local")]
  : [process.env.XDG_DATA_HOME, join(homedir(), ".local", "share")];
export const defaultRoots = bases.filter(Boolean).map(base => resolve(base, "Cosmic"));
function guard(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== "string") return;
  const candidate = resolve(value);
  for (const root of defaultRoots) {
    const inside = relative(root, candidate);
    if (!inside || !inside.startsWith("..") && !isAbsolute(inside)) throw new Error("test_default_root");
  }
}
// Guard OS access as well as path resolution, including explicitly supplied defaults.
// Test workers preload this fixture so a missing VAULT_HOME cannot reach real data.
for (const name of ["access", "appendFile", "chmod", "chown", "copyFile", "cp", "exists", "lstat", "mkdir", "mkdtemp", "open", "opendir", "readFile", "readdir", "readlink", "realpath", "rename", "rm", "rmdir", "stat", "truncate", "unlink", "watch", "writeFile", "createReadStream", "createWriteStream"]) {
  const wrap = original => function (...args) { guard(args[0]); if (["copyFile", "cp", "rename"].includes(name)) guard(args[1]); return original.apply(this, args); };
  if (typeof fs[name] === "function") fs[name] = wrap(fs[name]);
  if (typeof fs[`${name}Sync`] === "function") {
    const original = fs[`${name}Sync`], wrapped = wrap(original);
    if (original.native) wrapped.native = wrap(original.native);
    fs[`${name}Sync`] = wrapped;
  }
  if (typeof promises[name] === "function") promises[name] = wrap(promises[name]);
}
syncBuiltinESMExports();
