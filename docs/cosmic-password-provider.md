# Cosmic password provider

Local Vault only. A trusted Node or Electron main process calls it through `vault-client`. The Cosmic password is the login saved for the Cosmic account site whose username is the email the app passes. There is no new Vault screen. The requesting email selects that saved login. It is not proof of a Quantum session.

Whether Vault is installed is the calling app's own detection. Vault adds no install check and no install endpoint.

The service binds to loopback and refuses an `Origin` header. Do not add a browser caller. A process under the same OS user can claim an app name from the bootstrap file. That is the existing local-user trust boundary.

## Who may call

Granted kind `cosmic`, with a live presence: `nebula`, `nova`, `horizon`, `lyra`, `hivem1nd`.

`hivem1nd` is the ONEM1ND human host. It has no ordinary entry kinds and no API-key permission. Its agent identities are excluded, as are `lyra-*`, `vault-app`, `vault-cli`, other apps, and every `agent`. Keep this API out of agent and model tools. Nova, Lyra and ONEM1ND do not use the generic entries or logins calls for this.

The request must not name an app, an entry, or a site. Vault uses the caller's token and the account-site origin captured when the service started (`VAULT_QUANTUM_SITE`, or `https://cosmic.txmska.com`). A running service keeps that origin.

## Request

Both calls are `POST` with bearer app token, JSON `{email:string}`, and no query. The email is nonempty, at most 320 characters, syntactically valid, with no controls and no surrounding whitespace. It is compared exactly with the saved username.

| Call | Success |
|---|---|
| `POST /v1/cosmic/password/status` | `200 {state:"available"\|"locked"\|"none"}`. Never a password. |
| `POST /v1/cosmic/password/read` | `200 {password:string}`. The saved password bytes, unchanged. |
| `POST /v1/unlock` | Existing `{password:string}` body, the Vault password. `200 {ok:true}`. |

## States

| Vault | Status | Read |
|---|---|---|
| No vault created yet | `200 {state:"none"}` | `404 not_found`. Vault is not created. |
| Open, one usable login | `200 {state:"available"}` | `200 {password}` |
| Open, no usable login | `200 {state:"none"}` | `404 not_found` |
| Open, two or more usable logins | `409 conflict` | `409 conflict` |
| Created, locked | `200 {state:"locked"}` | `423 locked` |

Locked means the saved fields cannot be read yet. The app shows Use Vault. After the person unlocks, call status again. `none` means the app hides the button and the person types the password. Vault stores no extra index to answer this while locked.

A usable login has kind `login`, the account-site origin, that exact username, and a nonempty password. A website path can match. A different protocol, host, or port cannot. Several matches are a conflict even when the passwords are equal. The error names no entry, username, or count. The person resolves duplicates in Vault or types the password in the app.

A status call does not keep Vault unlocked. Read only after the person chooses Use Vault. On `locked`, the app uses the existing `unlock`, then reads again. Clear the Vault password field when that call finishes. Fill the Cosmic password, not the Vault password. Discard the returned password when the card finishes, is cancelled, or the account changes. Do not write either password to logs, the terminal, or Relay. A wrong Cosmic password is handled by the app. Vault does not update the saved login for that.

## Errors

`400 invalid`, `401 unauthenticated`, `403 pending`, `403 revoked`, `403 forbidden`, `403 not_present`, `409 conflict`, `423 locked`, `429 rate_limited`, `429 limited`, `503 busy`, `503 unavailable`. Read also returns `404 not_found` when no usable login exists. An old service has no such route and returns `404 not_found`: keep manual entry, and do not fall back to generic secret routes.

Non-JSON, oversized, unsupported-method, and malformed-route requests keep the existing `415`, `413`, `405`, and `404` handling. Every error is `{error:{code,message,fields:{},requestId}}` with a fixed message and empty `fields`. Every response is `Cache-Control: no-store`. Wrong Vault passwords stay `423 locked`, then `429 limited`, and the delay is shared by every app.

The protocol marker stays `serviceVersion` `0.1.0`. The client does not cache the password, unlock on its own, poll, or log the value.

```ts
export type CosmicPasswordStatus = { state: "available" | "locked" | "none" };
export type CosmicPasswordValue = { password: string };

// client.cosmic, after connect with an allowed identity:
passwordStatus(email: string): Promise<CosmicPasswordStatus>;
readPassword(email: string): Promise<CosmicPasswordValue>;
```

`connect({app:{id:"horizon",name:"Horizon",kind:"cosmic"}})` or the host's allowed identity. Unlock with the existing `client.unlock`. A malformed success body becomes `unavailable` and the response is not kept as an error cause.
