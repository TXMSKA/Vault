# Vault

The shared base of Vault, the password store of TXMSKA's apps. Nebula,
Horizon and Nova use the same base and each one builds its own interface on
top of it (Tom, 2026-10-07).

## What is here

- `src/model.ts`: the entry model (logins, cards, documents, notes, keys,
  custom entries) and the limits.
- `src/crypto.ts`: the encryption. Entries are sealed in the client with
  AES-GCM under a data key wrapped by a key derived from the master password
  (PBKDF2, SHA-256, 600000 iterations), with a recovery key as the only other
  way in. Also password generation and TOTP codes.
- `src/memory.ts`: holds the unlocked key in memory and locks it after the
  idle time.

These three files are copied unchanged from Nebula's `lib/vault/` at commit
`0d3bf34` on its `alpha` branch, so data sealed by Nebula opens here and the
other way round. The tests are the crypto, model and memory part of Nebula's
`scripts/vault.test.mjs`.

## Not here yet

- The store: Nebula's `lib/vault/service.ts` keeps the sealed entries in
  Nebula's own credential store. The shared base needs a storage interface
  each host implements.
- The idle time is fixed at five minutes. Horizon locks when the app closes
  by default, with the time set in Settings, so the lock policy has to become
  a setting of each host.
- Windows Hello on Windows, and how a standalone app such as Horizon reaches
  the same entries as Nebula.

## Commands

```
npm install
npm test
npm run typecheck
```
