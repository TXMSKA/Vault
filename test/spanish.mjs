// Every Spanish text a person reads in Vault is neutral and impersonal: no voseo and no tuteo (Tom, 2026-10-09).
// This check reads the Spanish side of every copy pair in the command line, the client and the service, and fails on
// second-person pronouns, voseo and tuteo verb forms and Rioplatense words. The app's dictionary has its own check in
// packages/app/test/units.test.mjs. A new word that only looks like a second-person form goes into `allowed`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const walk = folder => readdirSync(folder).flatMap(name => { const path = join(folder, name); return statSync(path).isDirectory() ? name === "dist" ? [] : walk(path) : /\.(ts|cts|mts)$/.test(name) ? [path] : []; });
const literal = String.raw`(\x60(?:[^\x60\\]|\\.)*\x60|"(?:[^"\\]|\\.)*")`, pair = new RegExp(String.raw`(?:copy\(\s*|\[\s*)` + literal + String.raw`\s*,\s*` + literal, "g");
const pronouns = /\b(vos|sos|tu|tus|te|ti|contigo|acá|vení|fijate|dale)\b/i;
// Words that end like a voseo imperative (-á, -é, -í) or a second-person present (-ás, -és, -ís) and are correct here.
const allowed = new Set(["está", "esté", "será", "podrá", "quedará", "qué", "sé", "aquí", "así", "allí", "ahí", "sí", "más", "después", "país", "inglés", "francés", "interés", "atrás", "además", "jamás", "demás", "través", "menú", "vía", "día", "días", "también", "último", "detrás", "según", "aún", "todavía"]);
const problems = [];
let checked = 0;
for (const folder of ["cli", "client", "service"]) for (const file of walk(join(root, "packages", folder, "src"))) {
  const text = readFileSync(file, "utf8"); let match;
  while ((match = pair.exec(text))) {
    const spanish = match[2].slice(1, -1).replace(/\$\{[^}]*\}/g, " ").replace(/\\n/g, " "); checked++;
    const where = `${relative(root, file)}:${text.slice(0, match.index).split("\n").length}`;
    if (pronouns.test(spanish)) problems.push(`${where}: ${spanish.match(pronouns)[0]}`);
    for (const word of spanish.match(/\p{L}+(?:á|é|í|ás|és|ís)(?!\p{L})/gu) ?? []) if (!allowed.has(word.toLowerCase())) problems.push(`${where}: ${word}`);
  }
}
if (!checked) problems.push("no Spanish copy found: the pattern no longer matches the copy calls");
if (problems.length) { console.error(`Spanish copy check failed: ${problems.length} second-person forms.\n${problems.join("\n")}`); process.exitCode = 1; }
else console.log(`Spanish copy: ${checked} texts checked, impersonal.`);
