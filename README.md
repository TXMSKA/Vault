# Vault

The shared base of Vault, the password store of TXMSKA's apps. Nebula,
Horizon and Nova build their own interfaces on top of it (Tom, 2026-10-07).
The package is private, consumed through a local `file:` dependency, and
never published. It runs in Node 24 or 26 and Electron's main process.

## What is here

- `src/model.ts`: the entry model and the limits.
- `src/crypto.ts`: AES-GCM encryption, master password and recovery key
  envelopes, password generation and TOTP codes. The model and crypto come
  from Nebula's `lib/vault/` at `0d3bf34`. Only the crypto import extension
  changed for Node ESM: envelope fields, additional data contexts
  `nebula-vault:1:*` and 600000 PBKDF2 iterations stay unchanged.
- `src/store.ts`: the storage interface, sealed input validation and stable
  error codes. The validation and limits follow Nebula's service.
- `src/file-store.ts`: one shared vault folder, with a separate versioned
  JSON file for the envelope, each entry and each attachment chunk.
- `src/unlock.ts`: master password unlock and recovery against a store.
  Recovery retains the data key, replaces the envelope with an expected
  version and returns a new recovery key. Failed attempts impose a growing
  process-local delay, from one second to thirty seconds. Controllers for
  the same file store share the delay; restarting the process resets it.
- `src/memory.ts`: the unlocked key and generation tickets. The host passes
  an idle duration in milliseconds; `null` means no idle lock. The default
  remains five minutes. Hosts call `lock()` on exit and check expiry during
  use or on their own timer.
- `src/hello.ts`: Windows Hello availability and desktop verification through
  PowerShell and `UserConsentVerifier`, without a native module. The host
  supplies the window handle, a key protector and storage for the wrapped
  key. Horizon can use Electron's `safeStorage` as the protector. The key
  is released only after verification. Disabling deletes the wrapped key;
  envelope replacement invalidates it. Linux, missing Hello configuration
  and verifier errors leave master password unlock available.
- `src/logger.ts`: a logger with a host-supplied sink. It redacts secret
  field names and token-shaped values before writing, accepts scalar fields
  and never serializes bodies or arbitrary error details. Unlock, denial,
  rate limit, recovery and lock events can use this sink.

## Storage

The default folder is `%LOCALAPPDATA%/Cosmic/vault` on Windows and
`$XDG_DATA_HOME/Cosmic/vault` or `~/.local/share/Cosmic/vault` on Linux.
Pass a folder to `new FileVaultStore(folder)` to choose another location.
Tests always pass a fresh folder inside the repository's `.test-tmp/`.

Every operation takes an exclusive `wx` lock file. Versions, the 250 entry
limit, the 6400 chunk limit and attachment claims are checked while holding
that lock. New entries use expected version `0`; updates and removals use
current positive versions. A stale version returns `conflict`. Chunks
are immutable and a chunk can be claimed by only one entry. Replacing or
removing an entry removes its released chunks; removing a claimed chunk
returns `conflict`. UUID case is preserved for entry encryption contexts,
with case-insensitive file identities to prevent collisions on Windows.

Writes use a temporary file, flush it, then rename it over the old file.
On POSIX the directory is flushed too. Folders use `0700` and files use
`0600` where supported. Windows uses the user's inherited folder ACLs;
POSIX permission tests are skipped there. Lock recovery requires both a
timeout and a dead owner. A live owner is never displaced. A separate
recovery claim prevents competing processes from removing a new lock.
An interrupted recovery claim or a lock without valid owner metadata fails
closed; it requires inspection after all hosts have stopped.

Passwords, recovery phrases, data keys and entry contents never go into
these JSON files as plaintext. The envelope holds wrapped keys, salts and
proof hashes. Entry IDs, versions and attachment claims remain visible.
The storage interface operates on sealed data and is not an authentication
boundary: hosts keep it in their trusted process and gate their UI with
`VaultMemory`. Raw key bytes returned by the crypto API must be cleared
after use; the unlock and Hello adapters clear their temporary bytes.

For a host with no idle lock:

```js
import { FileVaultStore, VaultMemory, createVaultUnlock } from "vault";

const store = new FileVaultStore();
const memory = new VaultMemory(Date.now, null);
const vault = createVaultUnlock(store, { memory });
// Use vault.unlock(password), vault.recover(recovery, newPassword) and vault.lock().
```

## Not here

Host interfaces, clipboard policy, settings, Electron's protector and its
wrapped-key persistence belong to the consuming apps. The host must refuse
a protector that cannot encrypt securely. Nebula still uses its own store;
its migration is a later task, and this repository does not edit it.

There is no network service, cloud sync, backup scheduler or migration run
by the build. Log retention, access protection and alerts belong to the
host's sink. Multi-file crash recovery is not a transaction: an interrupted
attachment upload or cleanup can leave sealed orphan chunks, which a host
can remove explicitly. Unlock does not collect them automatically because
another app may still be uploading them.

Interactive Windows Hello verification needs a person and a host window.
Automated tests call availability only, never the verification prompt.

## Commands

The development dependencies are already installed. No runtime dependencies
are needed.

```
npm test
npm run typecheck
npm run build
node -e "import('./dist/index.js').then(m=>console.log(Object.keys(m).join(',')))"
```

The build emits ESM JavaScript and declarations to `dist/`; package exports
point there. Tests include the original 31 crypto, model and memory checks,
the file store and recovery, and two independent Node processes updating
one vault. All test secrets are synthetic and scratch folders are removed
after the run.
