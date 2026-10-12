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
// The release workflow is asserted from the job blocks themselves. There is no YAML parser in the tools this file is allowed to import.
const jobsOf = text => { const body = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length), marks = [...body.matchAll(/^  ([A-Za-z0-9-]+):\n/gm)]; return Object.fromEntries(marks.map((mark, index) => [mark[1], body.slice(mark.index, marks[index + 1]?.index ?? body.length)])); };
const stepOf = (body, name) => { const marker = `      - name: ${name}\n`, start = body.indexOf(marker); if (start < 0) throw new Error(`missing step ${name}`); const rest = body.slice(start + marker.length), next = rest.search(/\n {6}- /); return next < 0 ? rest : rest.slice(0, next); };
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
    check.deepEqual([...text.matchAll(/^\s*runs-on: (.+)$/gm)].map(match => match[1]), name === "release.yml" ? Array(6).fill("windows-latest") : ["windows-latest"]);
    check.doesNotMatch(text, /self-hosted|ubuntu|macos/i); check.match(text, /^permissions:\n  contents: read$/m);
    check.equal((text.match(/node-version: 26\.8\.2/g) ?? []).length, name === "release.yml" ? 3 : 1);
    check.doesNotMatch(text, /persist-credentials: true/); check.equal((text.match(/persist-credentials: false/g) ?? []).length, name === "release.yml" ? 3 : 1);
    check.equal((text.match(/fetch-depth: 0/g) ?? []).length, name === "release.yml" ? 3 : 1);
  }
  const release = read(".github", "workflows", "release.yml");
  const jobs = jobsOf(release), names = ["build", "sign-programs", "repack", "sign-installer", "finalize", "publish"];
  check.deepEqual(Object.keys(jobs), names);
  check.match(release, /on:\n  push:\n    tags:\n      - 'v\*'/);
  check.equal((release.match(/github\.repository == 'TXMSKA\/Vault'/g) ?? []).length, 6);
  check.equal((release.match(/contents: write/g) ?? []).length, 1); check.ok(jobs.publish.includes("contents: write") && release.indexOf("contents: write") > release.indexOf("\n  publish:"));
  check.doesNotMatch(release, /write-all|id-token:|packages: write|pull-requests: write/);
  for (const name of names) if (name !== "publish") { check.match(jobs[name], /contents: read/); check.doesNotMatch(jobs[name], /contents: write/); }
  check.match(jobs.publish, /permissions:\n      contents: write\n(?:      #.*\n)?      actions: read\n/); check.match(jobs.publish, /needs: finalize\n/); check.doesNotMatch(jobs.publish, /always\(\)|SIGNPATH_API_TOKEN|environment:/);
  check.match(jobs.publish, /if: "!cancelled\(\) && github\.repository == 'TXMSKA\/Vault' && needs\.finalize\.result == 'success'"\n/);
  const signIf = "github.repository == 'TXMSKA/Vault' && vars.SIGNPATH_ENABLED == 'true'";
  const continueIf = disabled => `always() && !cancelled() && github.repository == 'TXMSKA/Vault' && needs.${disabled}.result == 'success' && ((vars.SIGNPATH_ENABLED == 'true' && needs.${disabled === "build" ? "sign-programs" : "sign-installer"}.result == 'success') || (vars.SIGNPATH_ENABLED != 'true' && needs.${disabled === "build" ? "sign-programs" : "sign-installer"}.result == 'skipped'))`;
  check.ok(jobs.repack.includes(continueIf("build"))); check.ok(jobs.finalize.includes(continueIf("repack")));
  check.equal((release.match(/environment: release/g) ?? []).length, 2);
  for (const name of ["sign-programs", "sign-installer"]) {
    const body = jobs[name];
    check.match(body, new RegExp(`if: ${signIf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`)); check.match(body, /environment: release\n/);
    check.match(body, /permissions:\n      contents: read\n      actions: read\n/);
    check.doesNotMatch(body, /actions\/checkout|actions\/setup-node|npm |node |package-console|package-installer|scripts\/|always\(\)/);
    check.match(body, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/); check.match(body, /gh run download \$env:GITHUB_RUN_ID --repo \$env:GITHUB_REPOSITORY /);
    check.match(body, /signpath\/github-action-submit-signing-request@c92b958760219087e01f8d67a1669ed57afe2627 # v2/);
    check.match(body, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/);
  }
  check.match(jobs["sign-programs"], /needs: build\n/); check.match(jobs["sign-programs"], /programs-unsigned/); check.match(jobs["sign-programs"], /SIGNPATH_PROGRAMS_CONFIGURATION_SLUG/);
  check.match(jobs["sign-programs"], /github-artifact-id: \$\{\{ needs\.build\.outputs\.programs-artifact-id \}\}/);
  check.doesNotMatch(jobs["sign-programs"], /SIGNPATH_INSTALLER_CONFIGURATION_SLUG/);
  check.match(jobs["sign-installer"], /needs: repack\n/); check.match(jobs["sign-installer"], /installer-unsigned/); check.match(jobs["sign-installer"], /Vault-Setup-x64\.exe/);
  check.match(jobs["sign-installer"], /SIGNPATH_INSTALLER_CONFIGURATION_SLUG/);
  check.match(jobs["sign-installer"], /github-artifact-id: \$\{\{ needs\.repack\.outputs\.installer-artifact-id \}\}/);
  check.doesNotMatch(jobs["sign-installer"], /SIGNPATH_PROGRAMS_CONFIGURATION_SLUG/);
  const tokenLines = release.split("\n").filter(line => line.includes("SIGNPATH_API_TOKEN"));
  check.equal(tokenLines.length, 2);
  for (const line of tokenLines) check.match(line, /^\s*api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}$/);
  check.equal(jobs["sign-programs"].includes("SIGNPATH_API_TOKEN") && jobs["sign-installer"].includes("SIGNPATH_API_TOKEN"), true);
  for (const name of ["build", "repack", "finalize", "publish"]) check.equal(jobs[name].includes("SIGNPATH_API_TOKEN"), false);
  check.ok([...release.matchAll(/secrets\.([A-Z0-9_]+)/g)].every(match => match[1] === "GITHUB_TOKEN" || match[1] === "SIGNPATH_API_TOKEN"));
  for (const name of ["build", "repack", "finalize"]) check.equal(jobs[name].includes("environment:"), false);
  check.match(jobs.build, /merge-base --is-ancestor/); check.match(jobs.build, /is not v\$version/);
  check.match(jobs.build, /programs-unsigned/); check.match(jobs.build, /release-layout/); check.match(jobs.build, /release-unsigned/); check.match(jobs.build, /release-notes-unsigned/);
  check.match(jobs.build, /release-notes\.mjs unsigned /); check.ok(jobs.build.indexOf("npm run scan:secrets") < jobs.build.indexOf("npm ci"));
  for (const name of ["repack", "finalize"]) { check.ok(jobs[name].indexOf("npm run scan:secrets") < jobs[name].indexOf("npm ci")); check.doesNotMatch(jobs[name], /npm install\b/); check.match(jobs[name], /persist-credentials: false/); }
  const signed = stepOf(jobs.repack, "Repack from the signed programs"), kept = stepOf(jobs.repack, "Keep the unsigned release");
  check.match(signed, /if: vars\.SIGNPATH_ENABLED == 'true'/); check.match(signed, /Get-AuthenticodeSignature/); check.match(signed, /Vault\.exe/); check.match(signed, /vault-helper\.exe/);
  check.match(signed, /package-console\.mjs --keep/); check.match(signed, /package-installer\.mjs --prepackaged/);
  check.match(kept, /if: vars\.SIGNPATH_ENABLED != 'true'/); check.match(kept, /release-unsigned/); check.doesNotMatch(kept, /package-console|package-installer|node /);
  check.match(jobs.repack, /needs: \[build, sign-programs\]/); check.match(jobs.finalize, /needs: \[repack, sign-installer\]/);
  const replace = stepOf(jobs.finalize, "Replace the signed installer"), sumsStep = stepOf(jobs.finalize, "Write the sums"), notes = stepOf(jobs.finalize, "Write the release notes");
  check.match(replace, /if: vars\.SIGNPATH_ENABLED == 'true'/); check.match(replace, /Get-AuthenticodeSignature/); check.match(replace, /Vault-Setup-x64\.exe/);
  check.doesNotMatch(sumsStep, /SIGNPATH_ENABLED/); check.match(sumsStep, /package-console\.mjs --finish/);
  check.match(notes, /vars\.SIGNPATH_ENABLED == 'true' && 'signed' \|\| 'unsigned'/); check.match(notes, /release-notes\.mjs /);
  check.match(jobs.finalize, /name: release-files/); check.match(jobs.finalize, /name: release-notes\n/);
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
  for (const body of [jobs.build, jobsOf(check_).check]) {
    check.match(body, /- run: npm audit --audit-level=high\n/);
    check.ok(body.indexOf("npm ci") < body.indexOf("npm audit --audit-level=high"));
    check.ok(body.indexOf("npm audit --audit-level=high") < body.indexOf("npm run build"));
    check.doesNotMatch(body, /npm audit[^\n]*(?:--omit|--production)/);
  }
  check.match(check_, /fetch-depth: 0\n          persist-credentials: false/); check.ok(check_.indexOf("npm run scan:secrets") < check_.indexOf("npm ci"));
  check.match(check_, /npm run typecheck\n      - run: npm test\n/); check.match(check_, /- run: npm run dist$/m); check.doesNotMatch(check_, /gh release|SIGNPATH|contents: write/);
  console.log(`Release: ${checks} checks passed.`);
} catch (error) {
  console.error(`Release checks failed: ${error?.name === "AssertionError" ? "assertion" : "operation"}.`);
  console.error(error?.message ?? error); if (error?.stack) console.error(error.stack.split("\n").filter(line => /release\.mjs:\d+:\d+/.test(line)).join("\n"));
  process.exitCode = 1;
} finally { rmSync(scratch, { recursive: true, force: true }); }
