// Writes the notes of a release from docs/release-notes.md, the version in package.json and build/release/SHA256SUMS.txt.
// Usage: node scripts/release-notes.mjs <signed|unsigned> <output file>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SUMS_FILE, renderNotes } from "./release-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), [signing, output] = process.argv.slice(2);
if (process.argv.length !== 4 || signing !== "signed" && signing !== "unsigned") { console.error("Usage: node scripts/release-notes.mjs <signed|unsigned> <output file>"); process.exit(1); }
const read = (...path) => readFileSync(join(root, ...path), "utf8");
const notes = renderNotes(read("docs", "release-notes.md"), { version: JSON.parse(read("package.json")).version, checksums: read("build", "release", SUMS_FILE), signed: signing === "signed" });
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(output, notes);
console.log(`Wrote ${output}.`);
