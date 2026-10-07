#!/usr/bin/env node
import { open, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, findService, resolveHome, readCapped, VaultClientError } from "../../client/src/index.ts";
import type { Client, ImportFormat, Backup } from "../../client/src/types.ts";
import { atomicJson } from "../../client/src/files.ts";
import { prepareHome } from "../../client/src/private.ts";
import { serve } from "../../service/src/main.ts";
import { hiddenPrompt } from "./prompt.ts";
import { runProject } from "./run.ts";
const spanish = () => /^es(?:[-_.]|$)/i.test(process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
const copy = (en: string, es: string) => spanish() ? es : en;
const usage = () => copy(
  "vault status\nvault create --kit <file.txt>\nvault unlock\nvault recover --kit <file.txt>\nvault lock\nvault apps [allow|revoke <id>]\nvault run --project <name> -- <command> [args...]\nvault import <file> --from chrome|edge|firefox|bitwarden|1password|keepass\nvault export <file>\nvault restore <file>\nvault dev-install\nvault serve",
  "vault status: consultar el estado\nvault create --kit <archivo.txt>: crear la bóveda y guardar el kit\nvault unlock: desbloquear\nvault recover --kit <archivo.txt>: recuperar y guardar un kit nuevo\nvault lock: bloquear\nvault apps [allow|revoke <id>]: listar, permitir o revocar apps\nvault run --project <nombre> -- <comando> [args...]: ejecutar con las variables del proyecto\nvault import <archivo> --from chrome|edge|firefox|bitwarden|1password|keepass: importar\nvault export <archivo>: guardar una copia cifrada\nvault restore <archivo>: restaurar una copia cifrada\nvault dev-install: guardar la instalación de desarrollo\nvault serve: ejecutar el servicio");
const messages: Record<string, [string, string]> = {
  locked: ["Vault is locked. Run vault unlock.", "Vault está bloqueado. Ejecutá vault unlock."],
  not_installed: ["Run vault dev-install first.", "Primero ejecutá vault dev-install."],
  pending: ["This app is awaiting approval.", "Esta app espera autorización."],
  revoked: ["This app's access was revoked.", "Se revocó el acceso de esta app."],
  forbidden: ["This app does not have permission.", "Esta app no tiene permiso."],
  terminal_required: ["A terminal is required for input and value access.", "Se necesita una terminal para ingresar datos y acceder a valores."],
  cancelled: ["Cancelled.", "Cancelado."],
  not_found: ["Entry or field not found.", "No se encontró la entrada o el campo."],
  invalid: ["Invalid input. Run vault help.", "Revisá los datos. Ejecutá vault help."],
  unsafe_location: ["The data location cannot be made private.", "No se pudo proteger la carpeta de datos."],
  limited: ["The limit was reached. Try again later.", "Se alcanzó el límite. Volvé a intentar más tarde."],
  rate_limited: ["Too many requests. Try again later.", "Demasiadas solicitudes. Volvé a intentar más tarde."],
  conflict: ["The data changed or already exists.", "Los datos cambiaron o ya existen."],
};
export type CliIO = { isTTY(): boolean; ask(label: string): Promise<string>; write(text: string): void; error(text: string): void };
const terminal: CliIO = { isTTY: () => !!process.stdin.isTTY, ask: hiddenPrompt, write: text => process.stdout.write(`${text}\n`), error: text => process.stderr.write(`${text}\n`) };
async function confirmValues(io: CliIO) {
  if (!io.isTTY()) throw new VaultClientError("terminal_required");
  const answer = await io.ask(copy("Allow this command to access a value? Type yes: ", "¿Permitir que este comando acceda a un valor? Escribí sí: "));
  if (answer.trim().toLowerCase() !== copy("yes", "sí")) throw new VaultClientError("cancelled");
}
async function confirmedPassword(io: CliIO) {
  const password = await io.ask(copy("New master password (15 to 128 characters): ", "Contraseña maestra nueva (15 a 128 caracteres): "));
  if (password.length < 15 || password.length > 128 || password !== await io.ask(copy("Confirm password: ", "Confirmá la contraseña: "))) throw new VaultClientError("invalid"); return password;
}
async function kit(filename: string, operation: () => Promise<{ recovery: string }>) {
  if (!filename.toLowerCase().endsWith(".txt")) throw new VaultClientError("invalid");
  const file = await open(resolve(filename), "wx", 0o600); let saved = false;
  try {
    const result = await operation();
    await file.writeFile(`VAULT\nRecovery kit / Kit de recuperación\n\nRecovery key / Clave de recuperación:\n${result.recovery}\n\nKeep this kit offline in a safe place. It can replace your master password.\nGuardá este kit fuera de línea en un lugar seguro. Permite reemplazar la contraseña maestra.\n\nMaster password / Contraseña maestra: ______________________________\n`); await file.sync(); saved = true;
  } finally { await file.close(); if (!saved) await rm(resolve(filename), { force: true }); }
}
export async function main(args = process.argv.slice(2), io: CliIO = terminal): Promise<number> {
  const home = resolveHome(); let api: Client | undefined;
  try {
    const [command = "help", sub, third] = args;
    if (command === "help" && args.length <= 1) { io.write(`${usage()}\n${copy("vault get <entry-id> [field-id] [--reveal]", "vault get <id-entrada> [id-campo] [--reveal]: consultar un campo")}`); return 0; }
    if (command === "serve" && args.length === 1) { await serve(); return 0; }
    if (command === "dev-install" && args.length === 1) {
      prepareHome(home); await atomicJson(join(home, "install.json"), { version: 1, command: process.execPath, args: [fileURLToPath(new URL("../../service/src/main.ts", import.meta.url))] });
      io.write(copy("Development installation saved.", "Se guardó la instalación de desarrollo.")); return 0;
    }
    if (command === "status" && args.length === 1 && !await findService(home)) { io.write(copy("Vault is stopped.", "Vault está detenido.")); return 0; }
    const valid = ["status", "unlock", "lock"].includes(command) && args.length === 1 || ["create", "recover"].includes(command) && args.length === 3 && sub === "--kit" || command === "apps" && (args.length === 1 || args.length === 3 && ["allow", "revoke"].includes(sub)) || command === "run" && sub === "--project" && args[3] === "--" && args.length >= 5 || command === "import" && args.length === 4 && third === "--from" && ["chrome", "edge", "firefox", "bitwarden", "1password", "keepass"].includes(args[3]) || ["export", "restore"].includes(command) && args.length === 2;
    const get = command === "get" && (args.length === 2 || args.length === 3 || args.length === 4 && args[3] === "--reveal");
    if (!valid && !get) throw new VaultClientError("invalid");
    if (get && args.at(-1) !== "--reveal") { io.write(copy("Add --reveal to print a field value after terminal confirmation.", "Agregá --reveal para mostrar el valor de un campo después de confirmar en la terminal.")); return 0; }
    if (command === "run" || get) await confirmValues(io);
    api = await connect({ home, app: { id: "vault-cli", name: "Vault CLI", kind: "cosmic" } });
    if (["run", "get", "import", "export", "restore"].includes(command) && !(await api.status()).unlocked) await api.unlock(await io.ask(copy("Master password: ", "Contraseña maestra: ")));
    if (command === "status") { const status = await api.status(); io.write(copy(`Vault is ${status.created ? status.unlocked ? "unlocked" : "locked" : "not created"}.`, `Vault está ${status.created ? status.unlocked ? "desbloqueado" : "bloqueado" : "sin crear"}.`)); }
    else if (command === "create") {
      const password = await confirmedPassword(io); await kit(third, () => api!.create(password)); io.write(copy("Vault created. Recovery kit saved.", "Se creó Vault y se guardó el kit de recuperación."));
    } else if (command === "recover") {
      const recovery = await io.ask(copy("Recovery key: ", "Clave de recuperación: ")), password = await confirmedPassword(io);
      await kit(third, () => api!.recover(recovery, password)); io.write(copy("Master password replaced. New recovery kit saved.", "Se reemplazó la contraseña maestra y se guardó un kit nuevo."));
    } else if (command === "unlock") { await api.unlock(await io.ask(copy("Master password: ", "Contraseña maestra: "))); io.write(copy("Vault unlocked.", "Vault desbloqueado.")); }
    else if (command === "lock") { await api.lock(); io.write(copy("Vault locked.", "Vault bloqueado.")); }
    else if (command === "apps") {
      if (sub === "allow") await api.apps.allow(third); else if (sub === "revoke") await api.apps.revoke(third);
      else for (const app of await api.apps.list()) io.write(`${app.id} | ${copy(app.status, ({ granted: "autorizada", pending: "pendiente", revoked: "revocada" })[app.status])} | ${app.kinds.join(",")}`);
      if (sub) io.write(copy("Saved.", "Se guardó."));
    } else if (command === "run") return await runProject(api, third, args.slice(4));
    else if (command === "get") {
      const row = await api.entries.get(sub), field = row.entry.fields.find(field => field.id === (third === "--reveal" ? "password" : third));
      if (!field) throw new VaultClientError("not_found");
      io.write(field.value);
    }
    else if (command === "import") { const counts = await api.import(args[3] as ImportFormat, await readCapped(resolve(sub))); io.write(copy(`Imported: ${counts.imported}; duplicates: ${counts.duplicates}; skipped: ${counts.skipped}.`, `Importados: ${counts.imported}; duplicados: ${counts.duplicates}; omitidos: ${counts.skipped}.`)); }
    else if (command === "export") {
      const file = await open(resolve(sub), "wx", 0o600);
      try { const password = await confirmedPassword(io); await file.writeFile(JSON.stringify(await api.export(password))); await file.sync(); } finally { await file.close(); }
      io.write(copy("Encrypted backup saved.", "Se guardó la copia cifrada."));
    } else if (command === "restore") {
      const backup = JSON.parse(await readCapped(resolve(sub))) as Backup, password = await io.ask(copy("Backup password: ", "Contraseña de la copia: ")); const counts = await api.restore(backup, password);
      io.write(copy(`Restored: ${counts.imported}; duplicates: ${counts.duplicates}.`, `Restaurados: ${counts.imported}; duplicados: ${counts.duplicates}.`));
    }
    return 0;
  } catch (error) { const code = error instanceof VaultClientError ? error.code : "failure", message = messages[code] ?? ["Vault could not complete the operation.", "Vault no pudo completar la operación."]; io.error(copy(...message)); return code === "invalid" ? 2 : 1; }
  finally { if (api) await api.close().catch(() => undefined); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
