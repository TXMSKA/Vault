// Checks the release machinery that needs no build: the list of release files and how they are summed, latest.yml after the installer changes, the
// release notes, and that the workflows pin every action to a commit and run on GitHub-hosted Windows only. Every value is synthetic.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALLER, RELEASE_FILES, SIGNING, SUMS_FILE, filesIn, latestHash, refreshLatest, releaseProblems, renderNotes, sumsText } from "../scripts/release-files.mjs";

// A checkout on Windows can turn line ends into CRLF; the files are compared as text with LF.
const root = fileURLToPath(new URL("../", import.meta.url)), lf = text => text.replace(/\r\n/g, "\n"), read = (...path) => lf(readFileSync(join(root, ...path), "utf8"));
let checks = 0;
const check = Object.fromEntries(["equal", "deepEqual", "match", "doesNotMatch", "ok", "throws"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
const scratch = mkdtempSync(join(resolve(tmpdir()), "release-"));
try {
  // ---- the five files of a release ---------------------------------------------------------------------------------------------------------------
  check.deepEqual(RELEASE_FILES, ["Vault-Setup-x64.exe", "Vault-Setup-x64.exe.blockmap", "latest.yml", "vault-x64.zip", "install.ps1"]);
  check.equal(INSTALLER, "Vault-Setup-x64.exe");
  check.deepEqual(releaseProblems([...RELEASE_FILES, SUMS_FILE]), { missing: [], unexpected: [] });
  check.deepEqual(releaseProblems(RELEASE_FILES), { missing: [], unexpected: [] });
  check.deepEqual(releaseProblems(["latest.yml", "install.ps1", "vault-x64.zip"]), { missing: ["Vault-Setup-x64.exe", "Vault-Setup-x64.exe.blockmap"], unexpected: [] });
  check.deepEqual(releaseProblems([...RELEASE_FILES, "builder-debug.yml", "builder-effective-config.yaml", SUMS_FILE]), { missing: [], unexpected: ["builder-debug.yml", "builder-effective-config.yaml"] });
  check.deepEqual(releaseProblems([]).missing, RELEASE_FILES);

  // ---- the sums: one line per file, as sha256sum prints it, for the files listed and no other, never the sums file ---------------------------------
  const folder = join(scratch, "release"); rmSync(folder, { recursive: true, force: true });
  mkdirSync(join(folder, "win-unpacked"), { recursive: true });
  for (const name of RELEASE_FILES) writeFileSync(join(folder, name), `synthetic ${name}`);
  writeFileSync(join(folder, "builder-debug.yml"), "x"); writeFileSync(join(folder, "win-unpacked", "Vault.exe"), "x");
  check.deepEqual(filesIn(folder), ["Vault-Setup-x64.exe", "Vault-Setup-x64.exe.blockmap", "builder-debug.yml", "install.ps1", "latest.yml", "vault-x64.zip"]);
  const sums = sumsText(folder, RELEASE_FILES), lines = sums.trimEnd().split("\n");
  check.equal(lines.length, 5); check.ok(sums.endsWith("\n"));
  check.deepEqual(lines.map(line => line.slice(66)), ["Vault-Setup-x64.exe", "Vault-Setup-x64.exe.blockmap", "install.ps1", "latest.yml", "vault-x64.zip"]);
  for (const line of lines) { check.match(line, /^[0-9a-f]{64}  \S+$/); const [sum, name] = line.split("  "); check.equal(sum, createHash("sha256").update(readFileSync(join(folder, name))).digest("hex")); }
  check.equal(createHash("sha256").update("abc").digest("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  check.doesNotMatch(sums, /SHA256SUMS|builder-debug|win-unpacked/);

  // ---- latest.yml after the installer changed (signing does that) --------------------------------------------------------------------------------
  const was = "A".repeat(86) + "==", now = "B".repeat(86) + "==";
  const latest = `version: 0.1.0\nfiles:\n  - url: ${INSTALLER}\n    sha512: ${was}\n    size: 112938674\npath: ${INSTALLER}\nsha512: ${was}\nreleaseDate: '2026-10-06T21:56:15.280Z'\n`;
  check.equal(latestHash(latest), was);
  const fresh = refreshLatest(latest, now, 112939000);
  check.equal(fresh, latest.replaceAll(was, now).replace("size: 112938674", "size: 112939000"));
  check.equal(latestHash(fresh), now); check.equal(refreshLatest(fresh, was, 112938674), latest);
  check.ok(fresh.includes("releaseDate: '2026-10-06T21:56:15.280Z'") && fresh.includes("version: 0.1.0"));
  check.equal(refreshLatest(latest.replaceAll("\n", "\r\n"), now, 5).includes("\r\n"), true);
  check.throws(() => refreshLatest("version: 0.1.0\npath: x\n", now, 1)); check.throws(() => refreshLatest(latest.replace("    size: 112938674\n", ""), now, 1));
  check.throws(() => refreshLatest(`${latest}sha512: ${was}\n`, now, 1));

  // ---- the release notes -------------------------------------------------------------------------------------------------------------------------
  const template = read("docs", "release-notes.md"), summed = "0".repeat(64) + "  install.ps1\n";
  for (const signed of [false, true]) {
    const notes = renderNotes(template, { version: "0.1.0", checksums: summed, signed });
    check.doesNotMatch(notes, /\{\{|\}\}/); check.match(notes, /^# Vault 0\.1\.0$/m);
    check.equal(notes.split(summed.trimEnd()).length - 1, 2); // the sums, once in each language
    check.ok(notes.includes(SIGNING[signed ? "signed" : "unsigned"].en) && notes.includes(SIGNING[signed ? "signed" : "unsigned"].es));
    check.ok(notes.includes(`powershell -ExecutionPolicy Bypass -c "irm https://github.com/TXMSKA/Vault/releases/latest/download/install.ps1 | iex"`));
    for (const name of RELEASE_FILES) check.ok(notes.includes(`\`${name}\``), name);
    check.match(notes, /^## English$/m); check.match(notes, /^## Español$/m); check.ok(notes.indexOf("## English") < notes.indexOf("## Español"));
  }
  check.match(SIGNING.signed.en, /Free code signing provided by SignPath\.io, certificate by SignPath Foundation/);
  check.match(SIGNING.unsigned.en, /not code signed/); check.match(SIGNING.unsigned.es, /todavía no está firmada/);
  check.throws(() => renderNotes("{{version}} {{unknown}}", { version: "1", checksums: "", signed: false }));
  check.throws(() => renderNotes("{{version}} {{checksums}}", { version: "1", checksums: "", signed: false }));

  // ---- the workflows: every action pinned to a commit with its version, GitHub-hosted Windows only, least privilege --------------------------------
  const folderOf = join(root, ".github", "workflows"), workflows = readdirSync(folderOf).filter(name => name.endsWith(".yml")).sort();
  check.deepEqual(workflows, ["check.yml", "release.yml"]);
  const pinned = { "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020", "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", "signpath/github-action-submit-signing-request": "c92b958760219087e01f8d67a1669ed57afe2627" };
  for (const name of workflows) {
    const text = read(".github", "workflows", name), uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
    check.ok(uses.length > 0, name);
    for (const [, action, rest] of uses) { const [repo, commit] = action.split("@"); check.equal(commit, pinned[repo], `${name} ${action}`); check.match(rest, /^ # v\d+(?:\.\d+\.\d+)?$/, `${name} ${action}`); }
    check.deepEqual([...text.matchAll(/^\s*runs-on: (.+)$/gm)].map(match => match[1]), name === "release.yml" ? ["windows-latest", "windows-latest"] : ["windows-latest"]);
    check.doesNotMatch(text, /self-hosted|ubuntu|macos/i); check.match(text, /^permissions:\n  contents: read$/m);
    check.equal((text.match(/node-version: 26\.8\.2/g) ?? []).length, 1);
    check.doesNotMatch(text, /persist-credentials: true/); check.equal((text.match(/persist-credentials: false/g) ?? []).length, 1);
  }
  const release = read(".github", "workflows", "release.yml");
  check.match(release, /on:\n  push:\n    tags:\n      - 'v\*'/); check.equal((release.match(/if: github\.repository == 'TXMSKA\/Vault'/g) ?? []).length, 2);
  check.equal((release.match(/contents: write/g) ?? []).length, 1); check.ok(release.indexOf("contents: write") > release.indexOf("  publish:"));
  check.equal((release.match(/if: vars\.SIGNPATH_ENABLED == 'true'/g) ?? []).length, 7);
  check.match(release, /gh release create \$env:GITHUB_REF_NAME .* --draft /);
  check.doesNotMatch(release, /--publish always|--prerelease|draft false/);
  // ---- the installer's additions: the commands that run, hidden and with every path quoted, and where they run --------------------------------------
  const nshPath = join(root, "packages", "app", "installer", "installer.nsh"), nsh = lf(readFileSync(nshPath, "utf8"));
  check.deepEqual([...readFileSync(nshPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]); // NSIS reads the accents only with a byte order mark
  const node = String.raw`"$INSTDIR\node.exe" "$INSTDIR\lib\cli\src\main.js"`;
  check.deepEqual([...nsh.matchAll(/^\s*nsExec::(\w+) (.*)$/gm)].map(match => [match[1], match[2]]), [["ExecToStack", `'${node} uninstall'`], ["ExecToStack", `'${node} install --app "$INSTDIR\\Vault.exe"'`], ["ExecToStack", `'${node} uninstall'`]]);
  check.doesNotMatch(nsh, /ExecWait|ExecShell|\bExec |powershell\.exe|cmd\.exe/i);
  check.equal((nsh.match(/MessageBox MB_OK\|MB_ICONSTOP "\$\(vaultCannot\w+\)" \/SD IDOK\n\s+SetErrorLevel 2\n\s+Abort/g) ?? []).length, 3); // each failure says so, in silent runs too, and stops
  check.match(nsh, /!macro customCheckAppRunning\n  !insertmacro IS_POWERSHELL_AVAILABLE\n  !insertmacro _CHECK_APP_RUNNING\n  !ifndef BUILD_UNINSTALLER\n    !insertmacro vaultStopService\n  !endif\n!macroend/);
  for (const macro of ["customHeader", "vaultStopService", "customInstall", "customUnInstall"]) check.match(nsh, new RegExp(`^!macro ${macro}$`, "m"), macro);
  const builder = read("packages", "app", "electron-builder.yml");
  check.match(builder, /^extraFiles:\n  - from: \.\.\/\.\.\/build\/stage\n    to: \.$/m); check.match(builder, /^afterPack: scripts\/after-pack\.cjs$/m); check.match(builder, /^icon: \.\.\/\.\.\/assets\/icon\/vault-icon-1024\.png$/m);
  check.match(builder, /^  output: \.\.\/\.\.\/build\/release$/m); check.match(builder, /^    - en_US\n    - es_ES$/m);
  const policy = read(".signpath", "policies", "vault", "release-signing.yml");
  check.match(policy, /^github-build-policies:$/m); check.match(policy, /require_github_hosted: true/); check.match(policy, /disallow_reruns: true/);
  const check_ = read(".github", "workflows", "check.yml");
  check.match(check_, /npm run typecheck\n      - run: npm test\n/); check.match(check_, /- run: npm run dist$/m); check.doesNotMatch(check_, /gh release|SIGNPATH|contents: write/);
  console.log(`Release: ${checks} checks passed.`);
} catch (error) {
  console.error(`Release checks failed: ${error?.name === "AssertionError" ? "assertion" : "operation"}.`);
  console.error(error?.message ?? error); if (error?.stack) console.error(error.stack.split("\n").filter(line => /release\.mjs:\d+:\d+/.test(line)).join("\n"));
  process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
