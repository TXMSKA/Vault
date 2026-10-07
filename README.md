# Vault

Vault is the private local password service shared by Nebula, Horizon and
Nova. Each app builds its own interface and reaches the same vault through
`vault-client`. Unlocking in one app unlocks it for the others. The service
keeps the data key in memory and encrypts every entry before saving it.

The repository is private. Packages are consumed through local `file:`
dependencies and are never published. Node 24 or 26 is required. There are
no runtime dependencies outside the workspaces.

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

The core keeps Nebula's format 1 envelope, `nebula-vault:1:*` encryption
contexts and 600000 PBKDF2 iterations. `env` is an added entry kind; existing
kinds and sealed data stay compatible. Nebula's migration is a later task.

## Development

The development dependencies are already installed. Build before starting
so the service can load the core. The service and CLI run TypeScript using
Node's type stripping; the core and client build to `dist/`.

```
npm run typecheck
npm test
npm run build
node packages/cli/src/main.ts dev-install
node packages/cli/src/main.ts status
```

`dev-install` records this checkout's absolute service command. The next
client connection starts it as a hidden detached process with an argument
array. `status` reports a stopped service without starting it. `serve`
runs it in the foreground. The workspace's `vault` executable can also be
used after relinking with `npm install --offline --ignore-scripts`.

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

## Storage and access

The data root is `%LOCALAPPDATA%/Cosmic/apps/Vault` on Windows and
`$XDG_DATA_HOME/Cosmic/apps/Vault` or `~/.local/share/Cosmic/apps/Vault` on
Linux. `VAULT_HOME` overrides it for tests. Inside are `install.json`,
`run/service.json`, `run/service.lock`, `secrets/`, `store/` and `logs/`.
The old core default at `Cosmic/vault` is not migrated automatically.

The service protects directories with private Windows ACLs for the user,
SYSTEM and Administrators, or `0700` on POSIX. Files use `0600` on POSIX.
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

## CLI

```
vault create --kit <file.txt>
vault unlock
vault recover --kit <file.txt>
vault lock
vault status
vault apps
vault apps allow <id>
vault apps revoke <id>
vault run --project <name> -- <command> [args...]
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
through an injected clock. Windows tests round-trip synthetic bytes through
DPAPI without triggering an interactive Hello prompt.
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

Windows Hello uses task 001's desktop verifier with the caller's HWND and
a service-owned DPAPI wrapper for the current user. `hello.enable` needs
the master password; `hello.unlock` requires verification before unwrapping.
Interactive Hello verification needs a person and a real host window.
Automated tests never trigger its prompt. Background-process verification with
a real host window remains to be tested with Tom; master-password unlock is
the tested interactive path.

The managed Windows sandbox refuses `Set-Acl`. Production fails closed if
private ACLs cannot be applied. A test-only fixture adapts that OS call solely
inside synthetic service scratch folders, and is explicitly preloaded by
tests. Real Windows ACL application needs verification outside this sandbox.
POSIX permissions are implemented but were not exercised on Linux here.

## Not here

The small Vault app, host interfaces, cloud sync, installers, startup with
the computer and Nebula's migration are later tasks. Hosts own clipboard
policy and their UI. There is no backup scheduler. Log retention and alerts
have not been decided. The final joint security audit with Lyra remains a
separate audit; the task's relevant safeguards are covered here by tests.
