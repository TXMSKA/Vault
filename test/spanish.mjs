// Every Spanish text a person reads in Vault is neutral and impersonal: no voseo and no tuteo (Tom, 2026-10-09).
// This check reads the Spanish side of every copy pair in the command line, the client and the service, the Spanish strings of the installer
// (packages/app/installer/installer.nsh), the Spanish half of the release notes (docs/release-notes.md) and the Spanish signing lines of the release
// (scripts/release-files.mjs), and fails on second-person pronouns, voseo and tuteo verb forms and Rioplatense words. The app's dictionary and its
// update question have their own check in packages/app/test/units.test.mjs. A new word that only looks like a second-person form goes into `allowed`.
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
function judge(spanish, where) {
  checked++;
  if (pronouns.test(spanish)) problems.push(`${where}: ${spanish.match(pronouns)[0]}`);
  for (const word of spanish.match(/\p{L}+(?:á|é|í|ás|és|ís)(?!\p{L})/gu) ?? []) if (!allowed.has(word.toLowerCase())) problems.push(`${where}: ${word}`);
}
for (const folder of ["cli", "client", "service"]) for (const file of walk(join(root, "packages", folder, "src"))) {
  const text = readFileSync(file, "utf8"); let match;
  while ((match = pair.exec(text))) judge(match[2].slice(1, -1).replace(/\$\{[^}]*\}/g, " ").replace(/\\n/g, " "), `${relative(root, file)}:${text.slice(0, match.index).split("\n").length}`);
}
if (!checked) problems.push("no Spanish copy found: the pattern no longer matches the copy calls");

// The installer: the strings it defines for Spanish.
const installer = "packages/app/installer/installer.nsh", nsis = readFileSync(join(root, installer), "utf8").replace(/^﻿/, "").split(/\r?\n/);
// A string of Vault's own has an English and a Spanish text; a Spanish-only one replaces electron-builder's Spanish, which speaks in the second person.
const spanishNames = new Set(), englishNames = new Set();
nsis.forEach((line, index) => {
  const spanish = line.match(/LangString (\w+) \$\{LANG_SPANISHINTERNATIONAL\} "([^"]*)"/), english = line.match(/LangString (\w+) \$\{LANG_ENGLISH\} "/);
  if (spanish) { spanishNames.add(spanish[1]); judge(spanish[2].replace(/\$\{[^}]*\}/g, " ").replace(/\$\\n/g, " "), `${installer}:${index + 1}`); }
  if (english) englishNames.add(english[1]);
});
if (!spanishNames.size || [...englishNames].some(name => !spanishNames.has(name))) problems.push(`${installer}: every installer string needs a Spanish one`);
for (const name of ["appRunning", "appCannotBeClosed", "decompressionFailed", "uninstallFailed"]) if (!spanishNames.has(name)) problems.push(`${installer}: the Spanish of ${name} is electron-builder's, in the second person`);

// The release notes: everything after the Spanish heading.
const notes = readFileSync(join(root, "docs", "release-notes.md"), "utf8").replace(/\r\n/g, "\n"), start = notes.indexOf("\n## Español\n");
if (start < 0) problems.push("docs/release-notes.md: no Spanish part");
else notes.slice(start).split("\n").forEach((line, index) => { if (line.trim() && !line.startsWith("```") && !line.startsWith("powershell ")) judge(line, `docs/release-notes.md:${notes.slice(0, start).split("\n").length + index + 1}`); });

// The signing lines of the release.
const signing = readFileSync(join(root, "scripts", "release-files.mjs"), "utf8");
for (const match of signing.matchAll(/\bes: "([^"]*)"/g)) judge(match[1], `scripts/release-files.mjs:${signing.slice(0, match.index).split("\n").length}`);

if (problems.length) { console.error(`Spanish copy check failed: ${problems.length} second-person forms.\n${problems.join("\n")}`); process.exitCode = 1; }
else console.log(`Spanish copy: ${checked} texts checked, impersonal.`);
