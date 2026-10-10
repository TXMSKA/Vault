// What a Vault release holds and how its files are summed. Used by scripts/package-console.mjs, scripts/release-notes.mjs and the release check in test/release.mjs.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const INSTALLER = "Vault-Setup-x64.exe";
/** The five files of a release: the installer and its two update files, and the console install (the zip and its script). The sums file is the sixth and cannot list itself. */
export const RELEASE_FILES = [INSTALLER, `${INSTALLER}.blockmap`, "latest.yml", "vault-x64.zip", "install.ps1"];
export const SUMS_FILE = "SHA256SUMS.txt";

/** The release files a folder lacks, and the files it holds that no release has (electron-builder's debug files, a leftover of an earlier build). The sums file is neither. */
export function releaseProblems(names) {
  const present = new Set(names);
  return { missing: RELEASE_FILES.filter(name => !present.has(name)), unexpected: names.filter(name => name !== SUMS_FILE && !RELEASE_FILES.includes(name)).sort() };
}
/** The names of the plain files in a folder; the unpacked app and other folders beside them are not release files. */
export const filesIn = folder => readdirSync(folder, { withFileTypes: true }).filter(item => item.isFile()).map(item => item.name).sort();
export const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
export const sha512Base64 = file => createHash("sha512").update(readFileSync(file)).digest("base64");
/** One line per file, as sha256sum prints it. */
export const sumsText = (folder, names) => names.slice().sort().map(name => `${sha256(join(folder, name))}  ${name}\n`).join("");
export const sizes = (folder, names) => names.map(name => [name, statSync(join(folder, name)).size]);

/** latest.yml names the installer by its SHA-512 (base64, twice) and size. Both change when the installer does after it was built, which signing does. */
export function refreshLatest(text, sha512, size) {
  if ((text.match(/^[ \t]*sha512: .+$/gm) ?? []).length !== 2 || (text.match(/^[ \t]+size: \d+[ \t]*$/gm) ?? []).length !== 1) throw new Error("latest.yml does not have the shape electron-builder writes.");
  return text.replace(/^([ \t]*)sha512: .+$/gm, (_whole, lead) => `${lead}sha512: ${sha512}`).replace(/^([ \t]+)size: \d+([ \t]*)$/m, (_whole, lead, tail) => `${lead}size: ${size}${tail}`);
}
/** The SHA-512 that latest.yml gives its installer. */
export const latestHash = text => text.match(/^[ \t]*sha512: (.+?)[ \t]*$/m)?.[1];

/** The line about code signing the release notes carry, in both languages. */
export const SIGNING = {
  signed: { en: "The installer and the programs in it are code signed. Free code signing provided by SignPath.io, certificate by SignPath Foundation.", es: "El instalador y los programas que contiene están firmados. Firma de código gratuita provista por SignPath.io, certificado de SignPath Foundation." },
  unsigned: { en: "This release is not code signed yet, so Windows SmartScreen can warn when the installer runs. Free code signing from the SignPath Foundation has been applied for.", es: "Esta versión todavía no está firmada, por lo que Windows SmartScreen puede mostrar una advertencia al ejecutar el instalador. Se solicitó la firma de código gratuita de SignPath Foundation." },
};
/**
 * Fills the release notes template: {{version}}, {{checksums}} (the sums file) and the signing line of each language. The template keeps each
 * language in a part of its own; nothing is translated here.
 */
export function renderNotes(template, { version, checksums, signed }) {
  const values = { version, checksums: checksums.trimEnd(), signing_en: SIGNING[signed ? "signed" : "unsigned"].en, signing_es: SIGNING[signed ? "signed" : "unsigned"].es };
  const used = new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]));
  for (const name of used) if (!(name in values)) throw new Error(`The release notes use {{${name}}}, which has no value.`);
  for (const name of Object.keys(values)) if (!used.has(name)) throw new Error(`The release notes template lacks {{${name}}}.`);
  return template.replace(/\{\{(\w+)\}\}/g, (_whole, name) => values[name]);
}
