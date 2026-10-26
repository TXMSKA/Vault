# Vault Beta contract

The baseline, scope and contracts Vault's Beta builds on. Vault's Beta candidate ships as 0.2.1;
the published 0.2.0 stays as it is.

## Baseline

Vault 0.2.0, released unsigned on 2026-10-24 from `e78d9ed` (tag `v0.2.0`): the local service,
the `vault` command line, the desktop app, attachments on Document entries, folder sync and
Quantum sync with the app's sync screens, Electron 44.9.3.

## Scope

| Item | State |
|---|---|
| Seven entry kinds, shared unlock, app permissions, recovery, approved command runs | Implemented in 0.2.0. Installed acceptance after the Beta fixes awaits evidence. |
| Attachments on Document entries (20 MiB per file, 50 per entry) | Implemented in 0.2.0. Real drag and drop and large files await evidence. |
| Encrypted export covering every accepted attachment | Missing: the backup payload is capped at 6 MiB. Being built. |
| Folder sync | Implemented. Provider-neutral wording is missing. |
| Quantum sync for accounts with `vault:sync` | Implemented for Dawn in 0.2.0. Dawn Lite, Insider, plan loss and the final Quantum contract await Quantum's frozen Beta backend. |
| Startup after a dead service lease | An intermittent test failure is open. |
| Key hub: API keys in Vault for Lyra and other apps | Missing. The contract with Lyra is being agreed. |
| Release candidate and controlled Beta downloads | Missing. They follow the Quantum distribution contract. |
| Code signing | Disabled for the Beta. Releases are unsigned. |

Out of scope: a new AI feature, a shared password vault, a mobile app, a Linux installer,
live connections to other managers and a broad interface redesign.

## Content ownership

| Data | Treatment |
|---|---|
| Entries, notes, fields, one-time code keys, recovery codes and Document attachments | Vault's encrypted content, synced with the vault. |
| Wrapped envelope, its changes and deletion records | Part of the vault's sync. |
| Conflicting revisions and the attachment chunks they reference | Kept by Vault's conflict rules. |
| Cosmic tokens, app grants, bootstrap credentials and Windows Hello material | Private to the computer. They are never synced. |
| Installation records, locks, logs, clipboard and temporary attachment buffers | Private to the computer. |
| Folders and files outside Vault | Never scanned or synced. An attached file becomes an encrypted copy owned by Vault. |

## Quantum

Vault keeps PKCE sign-in, its transport seam and the `.vsync` layout. It relies on Quantum for:

- app-scoped tokens with rotation and revocation, and a stable account identity;
- the effective `vault:sync` capability, enforced by the server;
- the account-wide storage pool with machine-readable errors;
- immutable objects with SHA-256 checks and writer ownership;
- the change feed;
- the plan-loss lifecycle;
- the approved download and update manifest.

Cosmic sign-in never unlocks the vault. Quantum receives neither a usable vault key nor plaintext.
Local use and folder sync never need an account.

## Host apps

Nebula, Horizon, Nova, Lyra and other hosts reach Vault only through `vault-client` from a trusted
process. They never bundle Vault, write its installation records or read its store directly.
App-kind restrictions and the agent rules stay in force. The service protocol marker stays `0.1.0`,
so clients already shipped keep recognizing the service.

## Key hub

With Vault installed, API keys and secrets can live in Vault and sync with it. Lyra and the other
apps take their keys from Vault, each only for the keys the person allowed it. Without Vault, each
app keeps its own encrypted secrets. Agents still never receive values. The client contract is
agreed with Lyra before it is built.
