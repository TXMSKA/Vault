# Vault

Vault is the local password service shared by Nebula, Horizon and Nova.
Each app builds its own interface and reaches the same vault through
`vault-client`. Unlocking in one app unlocks it for the others. The service
keeps the data key in memory and encrypts every entry before saving it.

Vault is open source under the Apache License 2.0; see `LICENSE`. Packages
are consumed through local `file:` dependencies and are never published. Node 24 or 26 is required. There are
no runtime dependencies outside the workspaces except the app's `electron-updater`.

## What is here

- `packages/core`: task 001's model, crypto, file store, memory, unlock,
  recovery, redacting logger and Windows Hello adapter, with its tests.
- `packages/service`: a background process on `127.0.0.1`, on a port chosen
  by the system. It owns the shared key, grants and presence leases.
- `packages/client`: discovery, startup, registration, typed calls and
  heartbeat. It builds to ESM JavaScript with declarations and has no
  runtime dependencies. Apps use this package only.
- `packages/cli`: the `vault` developer command. Copy follows the system's
  Spanish or English locale. Passwords and recovery keys use hidden prompts.
- `packages/app`: Vault's own window, an Electron app: first run, unlock, the
  prompts that wait for a person, the entries of every kind, the settings and
  the first-open tips. See The app.
- `packages/helper`: `vault-helper.exe`, the one small native program Vault
  starts on Windows. It does Windows Hello consent and availability, DPAPI,
  the foreground window, private ACLs and the user Path. Vault starts no
  shell for any of them.
- `scripts`: the helper build, the staging script, the console packaging
  with `install.ps1` and the installer packaging; see Install.
- `assets/icon`: the app icon, a brass keyhole on a steel field, as SVG and
  512 and 1024 px PNG. Other documents and repositories take it from here.

The core keeps Nebula's format 1 envelope, `nebula-vault:1:*` encryption
contexts and 600000 PBKDF2 iterations. `env` is an added entry kind; existing
kinds and sealed data stay compatible. Nebula's migration is a later task.

## Development

The development dependencies are already installed. Build before starting
so the service can load the core. The service and CLI run TypeScript using
Node's type stripping, straight from the sources. All four packages also build
to JavaScript in `dist/`, which is what an installed copy runs.

```
npm run typecheck
npm test
npm run build
node packages/cli/src/main.ts dev-install
node packages/cli/src/main.ts status
```

`npm run build` also compiles the helper from `packages/helper/src/vault-helper.cs`
into `packages/helper/bin/vault-helper.exe` (ignored by git). It uses the .NET
Framework 4 compiler every Windows 10 and 11 includes, `csc.exe` in
`%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319`, so there is no SDK, package
or download. Other platforms have no helper and skip the step.

Each build has a new hash, and while the helper is unsigned the antivirus can
hold its first run for up to half a minute (28 seconds measured on Windows 11
with Norton). Helper calls therefore allow 60 seconds, `dev-install` runs the
helper once while it protects the data folder, and the client's `connect` and
file token store call it asynchronously, so a host's main thread never waits
on it.

`dev-install` records this checkout's absolute service command, on Windows the
absolute path of the helper too (the optional `helper` field of `install.json`),
and writes a `vault` launcher in the data root's `bin/`. On Windows that folder joins the
user Path; on Linux `~/.local/bin/vault` links to it. With `VAULT_HOME` set
the Path is left alone and the folder is printed. Open a new terminal after
installing. The next
client connection starts it as a hidden detached process with an argument
array. `status` reports a stopped service without starting it. `serve`
runs it in the foreground. The workspace's `vault` executable can also be
used after relinking with `npm install --offline --ignore-scripts`.

The client finds the helper in `VAULT_HELPER` when it is set (tests only), then in
the `helper` field of `<data root>/install.json`, then beside this checkout. It
starts it with an argument array holding one fixed verb, writes the request as one
JSON line on stdin (at most 64 KiB, unknown fields refused) and reads one JSON line
from stdout (at most 64 KiB, exact keys, a time limit of 15 seconds or 2 minutes
for Hello consent). Values never reach arguments, the environment, logs or errors.
The verbs are `hello-available`, `hello-verify`, `dpapi-protect`, `dpapi-unprotect`,
`foreground-window`, `protect-folder`, `check-file`, `user-path-add` and
`user-path-remove`; the core receives the runner from the service and never starts
a process itself.

Hosts add `"vault-client": "file:../Vault/packages/client"` (adjust the
path for their layout). They connect in their trusted Node or Electron main
process and close the client when their window or app closes:

```js
import { connect } from "vault-client";

const vault = await connect({
  app: { id: "horizon", name: "Horizon", kind: "cosmic" },
  tokens: hostTokenStore,
});
// hostTokenStore implements async get() and set(token).
// The host supplies the password through its own hidden input.
await vault.unlock(password);
const rows = await vault.logins("https://example.com");
// Render only the fields the person asks to see.
await vault.close();
```

The client provides `status`, `create`, `unlock`, `recover`, `lock`,
`hello`, `logins`, `entries`, `environment`, `import`, `export`, `restore`,
`apps`, `present` and `close`. A private file token store is the default;
apps can supply their own protected token storage. Never put this client
or its tokens in a renderer or browser page. Do not retry a failed write
blindly: a dropped response can follow a completed write.

## Install

After `npm run build`, `node scripts/stage.mjs [folder]` assembles the installable
layout in `build/stage` (git ignores `build/`). It holds `node.exe`, a copy of the
Node that runs the script, so CI pins the version; `lib/` with the compiled
JavaScript of the core, client, service and CLI, the one `vault-core` link Node
needs and `lib/helper/bin/vault-helper.exe`; `LICENSE`; and this README. No
TypeScript and no development dependency goes in. `node scripts/package-console.mjs`
then fills `build/release` with `vault-x64.zip` (the stage), `install.ps1` and
`SHA256SUMS.txt`, which has a SHA-256 and a file name per line.

People install from a PowerShell prompt with one line:

```
powershell -ExecutionPolicy Bypass -c "irm https://github.com/TXMSKA/Vault/releases/latest/download/install.ps1 | iex"
```

`install.ps1` runs in Windows PowerShell 5.1 and PowerShell 7. It downloads
`SHA256SUMS.txt` and `vault-x64.zip` from the latest GitHub release (a saved copy
run as `.\install.ps1 -Version 0.1.0` takes that release instead), stops when the
zip does not match its sum, unpacks it into `%LOCALAPPDATA%\Programs\Vault` and
runs `vault install` from there. A copy already in that folder first runs its own
`vault uninstall`, which keeps the vault. The script never asks for or handles a
password: the vault is created afterwards with `vault create`.

`vault install` runs from an installed copy and refuses anywhere else. It writes
`install.json` with the copy's `node.exe` as the command, its service as the only
argument, its helper and, when `Vault.exe` sits beside `node.exe` or `--app <path>`
names a file, that app in the optional `app` field (an absolute path, checked like
`helper`). It then writes the launcher and joins the user Path as `dev-install`
does, pointing at the installed `node.exe`, and asks for a new terminal.
`vault uninstall` ends a running service (`run/service.json` names it, and
`/v1/health` must answer with that process), removes `bin/` and its Path entry
through the helper's `user-path-remove`, deletes `install.json` and keeps the
vault data. `vault uninstall --remove-data` also deletes the whole data folder
after a typed `DELETE` (`BORRAR` in Spanish) at a terminal, and refuses without
one. With `VAULT_HOME` set, neither command touches the Path and both print the
folder. The program folder itself stays until it is deleted by hand.

### The installer

`npm run dist` builds the packages, stages the layout, packs the console zip, builds
the installer with electron-builder (`packages/app/electron-builder.yml`) and writes
`SHA256SUMS.txt`. Everything lands in `build/release`, and the unpacked app stays in
`build/release/win-unpacked`. Node 24 or 26 on Windows is all it needs; electron-builder
downloads Electron 44.5.1 unless `ELECTRON_OVERRIDE_DIST_PATH` names a folder that
already holds it (the folder is passed as `electronDist`). The packaging dependencies
are exact: `electron-builder` 26.15.3, `@electron/fuses` 2.1.3 (development) and
`electron-updater` 6.8.9 (the app's only runtime dependency).

```
npm ci
npm run dist
```

The release is these files, and `SHA256SUMS.txt` has the SHA-256 of each:

- `Vault-Setup-x64.exe`: the installer, for one user and 64-bit Windows. It needs no
  administrator rights and puts Vault in `%LOCALAPPDATA%\Programs\Vault`, the folder
  `install.ps1` uses, so there is one Vault per computer. It adds a Start-menu shortcut and no
  desktop one. `/S` installs silently. Beside `Vault.exe` it copies the console layout
  (`node.exe`, `lib`, `LICENSE`, `README.md`). Before files are replaced it runs the installed
  copy's `vault uninstall`, which stops the service and keeps the vault; after they are copied it
  runs `vault install --app` on `Vault.exe`, and the install fails with a message if that
  fails. Uninstalling runs `vault uninstall` too and never deletes the vault.
- `Vault-Setup-x64.exe.blockmap` and `latest.yml`: what the updater reads (below).
- `vault-x64.zip` and `install.ps1`: the console install, without the app.
- `SHA256SUMS.txt`: the sums.

Vault.exe is packed with the Electron fuses Horizon uses (no `ELECTRON_RUN_AS_NODE`, no
`NODE_OPTIONS` or inspector arguments, encrypted cookies, the embedded ASAR integrity check
and `OnlyLoadAppFromAsar` on, extra `file:` privileges off), flipped in
`packages/app/scripts/after-pack.cjs` before anything is signed. `vault-helper.exe` and
`Vault.exe` carry the product name Vault and the version of `package.json` (the helper gets
it from `scripts/build-helper.mjs`).

**Updates.** A packaged Vault (never a development checkout, never a test) checks the
releases of TXMSKA/Vault on GitHub 10 seconds after its window is first shown and every 6 hours
while it runs. It downloads a newer release by itself, skips pre-releases and never goes back
to an older version, then asks in a native dialog, in the language of the app: install now (Vault
quits, installs silently and opens again) or later (the question comes back at the next start).
A start only for prompts (`--prompts`) never asks until its window is shown.

**Releases.** `.github/workflows/check.yml` runs the typecheck, the tests and `npm run dist`
on every push and pull request. Pushing a tag `vX.Y.Z`, where the version is the one in
`package.json` and the commit is on the default branch, runs `.github/workflows/release.yml` in
TXMSKA/Vault only: it builds, tests and, when the repository variable `SIGNPATH_ENABLED` is
`true`, has SignPath sign `Vault.exe`, `vault-helper.exe` and the installer (the secret
`SIGNPATH_API_TOKEN`, the variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`,
`SIGNPATH_POLICY_SLUG`, `SIGNPATH_PROGRAMS_CONFIGURATION_SLUG` and
`SIGNPATH_INSTALLER_CONFIGURATION_SLUG`; the policy file is
`.signpath/policies/vault/release-signing.yml`). Without the variable the unsigned files go on.
The last job alone can write to the repository: it makes a draft release for the tag with the
files above and the notes of `docs/release-notes.md`, and a person publishes it. Every action
is pinned to a commit, and every job runs on a GitHub-hosted Windows runner with Node 26.8.2.

## Storage and access

The data root is `%LOCALAPPDATA%/Cosmic/apps/Vault` on Windows and
`$XDG_DATA_HOME/Cosmic/apps/Vault` or `~/.local/share/Cosmic/apps/Vault` on
Linux. `VAULT_HOME` overrides it for tests. Inside are `install.json`,
`run/service.json`, `run/service.lock`, `settings.json`, `secrets/`, `store/`, `logs/` and `bin/`, and `app/` once the Vault app has run (its own files, not the service's).
The old core default at `Cosmic/vault` is not migrated automatically.

The service protects directories with private Windows ACLs, set and checked by the
helper, for the user, SYSTEM and Administrators, or `0700` on POSIX. Files use `0600` on POSIX.
Bootstrap credentials and CLI token files are private; app token hashes
are stored in `secrets/apps.json` and compared in constant time.

Horizon gets login entries through `logins(origin)` only. Matches use the
exact normalized HTTP or HTTPS origin, including port, without subdomain
or suffix matching. Nova gets `env` entries only. An environment entry's
title is the project name; field IDs are variable names, and every value
must be secret. Nebula, `vault-app` and `vault-cli` get all kinds. Other apps
stay pending until allowed. Agent identities and Lyra cannot be allowed.
Only `vault-app` and `vault-cli` manage apps, recovery, import and export.
Saving or removing checks both the existing and replacement entry kind.
An entry outside the caller's kinds returns 404 on read, update, remove and
environment access, like a missing entry. Lists omit those entries. Horizon
cannot use generic entry reads to bypass origin filtering.

These grants are consent and revocation within one user's account. Like
Lyra's bootstrap design, another process running as that user can read the
bootstrap file and claim a trusted app name. This is not a sandbox between
processes of the same user. The service refuses all `Origin` headers,
cross-site fetch metadata and foreign Host headers. Browser code cannot
call it directly. HTTP stays on loopback; values are not sent to a network
service.

Each connection holds a separate presence with a 20 second heartbeat and
60 second expiry. Heartbeats do not count as activity. The key drops after
five minutes without value access, after the last presence leaves or
expires, and on service exit. A short CLI invocation closes its presence
when done, so `unlock` alone locks again if no other app is open. Commands
that need values ask to unlock when necessary. Lock invalidates in-flight
key operations. The service exits when locked after ten minutes without a
present app. A later client connection starts it again, with the vault locked.

Entries and attachment chunks keep task 001's per-file versions, exclusive
write lock, flush and atomic rename. Updates require the expected version;
0 creates an entry. The limits are 4096 entries and 6400 chunks. A
failed multi-entry import or restore can leave some completed writes or
sealed orphan chunks after an I/O failure; rerunning skips duplicates.
There is no multi-file transaction or automatic orphan cleanup.

## Settings, prompts and the app

Four settings belong to the person, kept in `<home>/settings.json` (written atomically and
private like the other files; a missing or unreadable file means the defaults): `idleMinutes`
(1, 5, 15, 30, 60 or 240; 5 by default), `lockWithLastApp` (true by default), `language`
(`system`, `en` or `es`) and `theme` (`system`, `dark` or `light`). `GET /v1/settings` and
`PUT /v1/settings` are for `vault-app` and `vault-cli` only; a change sends all four keys,
every value is checked and unknown keys are refused. The idle time reaches the key already in
memory at once. With `lockWithLastApp` true Vault locks when the last app leaves, as before;
with false it stays unlocked until the idle time runs out. The client has `settings.get()` and
`settings.set(value)`; `vault settings` prints the four and `vault settings set <key> <value>`
changes one.

The service keeps what waits for a person in a queue in memory. An *unlock* prompt is created by
any allowed app or the CLI (`POST /v1/prompts/unlock`, with an optional short plain-text reason)
and is done when Vault is unlocked by any route. A *run* prompt is a pending agent run, so it
leaves the queue when it is approved, rejected or expires. A *permission* prompt is an app asking
for the import permission (`POST /v1/apps/permissions/import/request`); it is done when
`vault-app` or `vault-cli` grants it by naming the app (the `app` field of the existing
`permissions/import` calls, after their own password or Hello proof), and the app proving it for
itself works as before. Each entry has an id, a kind, the asking app, `createdAt`, `expiresAt` and
a summary that holds no secret value (a run's environment is never in it). Unlock and permission
prompts expire after five minutes, runs after ten. At most 50 prompts wait in all and 5 per app;
more answer 429. Prompts never extend the idle time.

`GET /v1/status` answers `created`, `unlocked`, `present` and `idleMs` to every app. To `vault-app` and
`vault-cli` it also answers `hello: { available, enabled }`: `enabled` is true when the wrapped Windows Hello key
exists, and `available` is what the helper last said about Hello on this computer. The status never waits for the
helper: it answers what it knows (nothing at first), asks the helper in the background and trusts the answer for a
minute.

`GET /v1/prompts`, for `vault-app` only, answers the waiting list at once or, when it is empty,
holds the call for up to 25 seconds and then answers the list, possibly empty. `POST
/v1/prompts/dismiss` turns one down: the asking app hears `cancelled`, a run is rejected and a
permission is refused. The app that asked follows its prompt with `GET /v1/prompts/wait?id=`
(also up to 25 seconds; `pending`, `done`, `cancelled` or `expired`) and asks again while it is
pending. When a prompt is created, no `vault-app` is present and `install.json` names an `app`
that is an absolute path to an existing file, the service starts it once with `--prompts`
(detached, no shell, not again within 30 seconds); with no app recorded nothing starts.

With the app installed (`install.json` has `app`), a command that needs Vault unlocked (`unlock`,
`get`, `import`, `export`, `restore`, and `sync` setup, now, conflicts, restore and dismiss)
creates an unlock prompt, prints one line and waits for the person to answer it in Vault's window
instead of asking for the master password in the terminal. `run` waits for its approval in the
window too, for a person and for an agent, and `vault approve` only says that approvals happen
there. `--terminal` on those commands keeps the terminal flow, so agents and scripts can rely on
it; after `--` the word belongs to the command. Without the app nothing changes: the password is
asked in the terminal and `vault approve` lists the waiting requests.

## The app

`packages/app` is Vault's own window, drawn from the approved board in
`docs/flows`. Outside the workspaces it depends on `electron-updater` 6.8.9 (the
update check, see The installer) and, for development, on `electron` 44.5.1,
`electron-builder` 26.15.3 and `@electron/fuses` 2.1.3, all exact. `.npmrc` keeps install scripts off, so installing
does not download the Electron binary: point `ELECTRON_OVERRIDE_DIST_PATH` at an
Electron 44.5.1 folder, or run `node node_modules/electron/install.js` once.
`npm run app` never downloads anything.

```
npm run build
$env:VAULT_HOME = "$env:TEMP\vault-try"   # a throwaway home, unless the real one is meant
npm run app
```

`npm run app` starts the app from this checkout against `VAULT_HOME` (the default
home when it is not set). The app connects as `vault-app`, and the client starts the
service from `install.json` as it does for any app, so run `dev-install` first (it
writes to the same home). Arguments after `--` go to the app; `--prompts` is the one
the service uses: the window stays hidden until a prompt arrives, and the app closes
after 30 seconds if no prompt waits and nobody touches it. A second launch, with or
without it, brings the first window forward. The browser's own files live beside the
home, in `<home>/app`, a folder of its own beside the service's `run`, `secrets`, `store`, `logs`, `bin` and
`sync`, so that `vault uninstall --remove-data`, which deletes the whole home, takes it too.

The window opens on the entries of the vault. The list on the left has a search (names, usernames,
websites and the other fields that are not secret), a kind filter with the count of each kind and of the
favourites, and the + button, whose menu offers the seven kinds: login, card, document, note, key,
environment and custom. An open entry shows its fields hidden: a secret field shows dots until the person
reveals it, a login's one-time code counts down its 30 seconds, and every value can be copied. Edit, Delete (with
Undo for as long as the toast is up) and the favourite star work on every kind; a login's form has a password
generator (length, symbols, numbers, uppercase). The title bar's menu has Settings and Show the tips again;
Apps, Import and Export say they are in the command line for now (`vault apps`, `vault import`,
`vault export`). The settings are the idle lock (1, 5, 15, 30 minutes, 1 and 4 hours), lock when the last app
closes, Windows Hello (turned on with the master password, off with one press), language and theme; each is
saved through `PUT /v1/settings` when it is chosen and applied at once. The first-open tips show once, and their
dismissal is kept in `<home>/app/tour.json`. Closing the window while the recovery key is on screen and was
neither saved nor printed asks first.

Values stay in the main process. A list or an open entry reaches the window with the fields that are not
secret and nothing else (a secret field says only whether it holds a value, and the note and the one-time code
key are never sent); revealing or copying fetches the entry from the service again, for that one value.
Copying puts the value on the clipboard and clears it 30 seconds later, only if the clipboard still holds
that value (and at once on quit). One-time codes (RFC 6238, SHA-1, 30 seconds, 6 digits) are made in the main
process from the entry's key, a base32 secret or an `otpauth://totp` address, and only the current code
and its seconds reach the window. Saving sends the version the window saw; an entry that changed meanwhile
answers a conflict instead of being overwritten, and a secret the form never held is put back by the main
process, not sent by the window. Documents list their files, but there is no way yet to add one, and deleting
a document that has files asks first and cannot be undone.

The main process alone talks to the service. The window is a frameless 920 by 640
page served from `app://vault/` (no other address loads) under a strict
Content-Security-Policy, with context isolation and the sandbox on, and it reaches the
main process only through the frozen object of `src/preload`: one function per
operation, each checked key by key before it runs. Passwords and recovery keys cross it
only when a person types or reveals them and are never logged. Language and theme
follow the settings (`system` follows the operating system). The screens are in
`src/renderer`, in plain TypeScript and DOM; the colours, sizes and type are the
board's, and the fonts (Inter, Space Grotesk and JetBrains Mono, all OFL) are served
from the app.

`npm test` covers the window's pure parts (what the bridge accepts, the entries without their secrets, the
one-time codes against the RFC 6238 vectors, the clipboard rule, the generator, the settings, the tips) and its
link to a real service. The whole
app, window included, is driven by an Electron check that needs a built app and an
Electron folder. It uses a temporary home, a stand-in for Windows Hello and in-memory stand-ins for the
clipboard and the browser (the main process takes a test-only `clipboardMs` option so that the 30 seconds need
not be waited out; the app never sets it), adds an entry of every kind through the window and goes through the
list, the entries, the menu, the settings, the tips and the close warning, and writes a screenshot of each
screen in the dark and the light theme to `build/screens`:

```
$env:ELECTRON_OVERRIDE_DIST_PATH = "<Electron 44.5.1 folder>"
& "$env:ELECTRON_OVERRIDE_DIST_PATH\electron.exe" packages\app\test\smoke.cjs
```

## CLI

```
vault create --kit <file.txt>
vault unlock [--terminal]
vault recover --kit <file.txt>
vault lock
vault status
vault apps
vault apps allow <id>
vault apps revoke <id>
vault settings
vault settings set <key> <value>
vault run --project <name> -- <command> [args...]
vault approve [--terminal]
vault get <entry-id> [field-id] [--reveal]
vault import <file> --from chrome|edge|firefox|bitwarden|1password|keepass
vault export <file>
vault restore <file>
```

Creation generates a recovery key. It is returned once to the requesting
app and written by the CLI into the chosen plain-text recovery kit. The
CLI never prints it. Keep the kit offline and private: it can replace the
master password. Recovery preserves the data key and entries, changes the
master password, rotates the recovery key and invalidates Hello setup.
Existing output files are not overwritten.

`run` requires stdin to be a terminal and explicit confirmation before value
access. `get` prints a field value only with `--reveal` and the same terminal
confirmation; the default field is `password`. Without that flag it prints
instructions without reading values.
Refusal or cancellation occurs before connecting or fetching values. These
checks prevent unattended CLI use; the same-user bootstrap limitation above
still applies to direct clients.

`run` loads only the named project's variables and spawns the command with
an argument array and `shell: false`. Vault prints neither the variables
nor the command arguments. The child controls its own output, so choose
commands that do not print their environment. Windows `.cmd` and `.bat`
files need an explicitly chosen interpreter. Vault does not insert one.

Imports read only the file named by the person, capped at 8 MiB, as UTF-8.
The strict CSV reader handles quoting, escaped quotes, CRLF and multiline
cells. Chrome, Edge and Firefox CSV, Bitwarden unencrypted JSON and CSV,
1Password CSV, KeePass and KeePassXC CSV, and KeePass 2.x XML become logins. The
XML reader is dependency-free, capped at 8 MiB, 64 levels and 200000 elements,
with no DTD or external entity support. It reads current entries in nested
groups and ignores history and attachments. Protected ciphertext values are
refused. 1PUX and KDBX are not supported. Duplicate
website and username pairs are skipped and counted. Non-login Bitwarden
items are counted as skipped. Bitwarden JSON with several URIs creates a
login for each URI. Import does not copy attachments, passkeys or arbitrary
custom fields from other managers. Export schemas and links are recorded
in `docs/import-formats.md`; no manager's code is included.

`export` makes an encrypted backup with a separate password supplied at a
hidden prompt. `restore` opens it into the currently unlocked vault,
reseals entries and attachment chunks with its data key, and skips
duplicates. Backup payloads are capped at 6 MiB, with an 8 MiB file limit.
The backup password has the same 15 to 128 character requirement as the
master password.

## Sync between computers

Run `vault sync setup <folder>` on the computer with your vault, then
`vault sync join <folder>` on an empty computer with the same master
password (or `--recovery` for the recovery key). Both ask before sharing
encrypted copies. The folder holds your vault protected by the master
password, so choose a strong one and keep your recovery kit safe.
`vault sync status` shows the folder, last sync, computers and conflicts;
`vault sync now` syncs while unlocked. Conflicts keep the other version
until you restore or dismiss it. Under `Vault Sync/<datasetId>`,
`dataset.vsync` holds the wrapped envelope, and each writer's own
`writers/<deviceId>/<generationId>/` holds immutable encrypted batches,
checkpoint parts, blobs and wrapped envelopes. Local bookkeeping stays
under `<home>/sync/`.

## Code signing policy

Free code signing is applied for from the SignPath Foundation. Once it is granted, the
release says: *Free code signing provided by SignPath.io, certificate by SignPath Foundation*.
Until it is granted, the builds are unsigned and the release notes say so.

- Authors, reviewers and approvers: TXMSKA.
- Every signing request is approved by hand.
- Only releases built by the release workflow from a tag on the default branch, on a
  GitHub-hosted runner, are submitted; the policy is in
  `.signpath/policies/vault/release-signing.yml`.

## Privacy

Vault does not transfer any information to other networked systems unless the person asks for it.
Sync writes encrypted packages only to the folder the person chooses. Update checks read the
releases of TXMSKA/Vault on GitHub and send nothing but the request for them.

## Checks and limits

Tests use synthetic values and temporary `VAULT_HOME` folders, remove them
afterward, and suppress assertion details that could show values. They fail
if a default data root is used. A preloaded filesystem guard also rejects
explicit access beneath the machine's default Cosmic directories, including
in workers and detached test processes. Tests cover the core regressions,
concurrent file writes, actual detached client
startup, request and grant checks, kind and origin filtering, shared
unlock, idle and presence locks, recovery, every import format, encrypted
backup restoration including chunks, confirmed terminal value access,
argument-array environment runs, 4096-entry boundaries and idle shutdown
through an injected clock, the settings, the prompt queue with its limits and long polls, the
start of the app (a small fake program), and the CLI's unlock prompts. Windows tests round-trip synthetic bytes through
the helper's DPAPI without triggering an interactive Hello prompt, ask the real helper
whether Hello is available, apply and check a real ACL on a temporary folder, and
refuse malformed helper requests. The runner tests use a stand-in that answers with
bad output or never answers, and a test fails if any file under `packages/*/src` names
a shell.
The DPAPI round-trip test is mandatory on Windows; an OS refusal fails the
suite after the other regressions run. This sandbox currently denies that
operation, so a successful round trip still needs an unrestricted Windows run.

Every route declares its access and allowed body and query fields. The
service caps ordinary bodies at 256 KiB, import and restore bodies at
12 MiB, connections at 64, and queued requests at 20. Rates are 240 requests
per app per minute, 30 registrations per minute, and 600 local requests
per minute. Failed unlocks also use the core's growing delay. Rate state
is process-local. Errors return a stable code and request ID. Logs contain
redacted scalar security events and never request bodies or entry values.

Windows Hello uses task 001's desktop verifier, now inside the helper, with the
caller's HWND and a service-owned DPAPI wrapper for the current user. `hello.enable` needs
the master password; `hello.unlock` requires verification before unwrapping.
Interactive Hello verification needs a person and a real host window.
Automated tests never trigger its prompt. Background-process verification with
a real host window remains to be tested with Tom; master-password unlock is
the tested interactive path.

The managed Windows sandbox refuses the ACL change. Production fails closed if
private ACLs cannot be applied. A test-only fixture answers the helper's
`protect-folder` and `check-file` verbs solely inside synthetic service scratch
folders, and is explicitly preloaded by tests; the real ACL test uses another
temporary folder and needs an unrestricted Windows run. Hello consent, which needs
a person, and `user-path-add` and `user-path-remove`, which edit the real user Path, are
never called by tests: install and uninstall tests set `VAULT_HOME`, which leaves the
Path alone, and the helper tests send those verbs only requests it refuses before
opening the registry.
POSIX permissions are implemented but were not exercised on Linux here.

## Not here

Host interfaces, startup with the computer and Nebula's migration are later tasks. Hosts own clipboard
policy and their UI. There is no backup scheduler. Log retention and alerts
have not been decided. The final joint security audit with Lyra remains a
separate audit; the task's relevant safeguards are covered here by tests.
