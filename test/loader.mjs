import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// The sources use extensionless imports, as their hosts' bundlers expect, so tests transpile them in place.
const modules = new Map();
export function load(name) {
  name = name.replaceAll("\\", "/");
  if (!name.endsWith(".ts")) name = `${name}.ts`;
  if (modules.has(name)) return modules.get(name).exports;
  const compiled = ts.transpileModule(fs.readFileSync(name, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} }; modules.set(name, loaded);
  const localRequire = spec => load(path.join(path.dirname(name), spec));
  new Function("require", "module", "exports", compiled)(localRequire, loaded, loaded.exports);
  return loaded.exports;
}
