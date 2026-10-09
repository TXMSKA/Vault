#!/usr/bin/env node
import { open, rm } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, findService, installedApp, resolveHome, readCapped, VaultClientError } from "../../client/src/index.ts";
import type { Client, ImportFormat, Backup } from "../../client/src/types.ts";
import { atomicJson } from "../../client/src/files.ts";
import { prepareHome } from "../../client/src/private.ts";
import { serve } from "../../service/src/main.ts";
import { appIdPattern } from "../../client/src/paths.ts";
import { hiddenPrompt } from "./prompt.ts";
import { AGENTS, approve, run, runOptions, visible } from "./run.ts";
import { copy, yes } from "./copy.ts";
import { installLauncher } from "./launcher.ts";
import { appFile, install, layout, uninstall } from "./install.ts";
import { unlocked } from "./unlock.ts";
import { settingLines, withSetting } from "./settings.ts";
const usage = () => copy(
  "vault status\nvault create --kit <file.txt>\nvault unlock [--terminal]\nvault recover --kit <file.txt>\nvault lock\nvault apps [allow|revoke <id>]\nvault settings\nvault settings set <key> <value>\nvault run --project <name> [--agent <id>] -- <command> [args...]\nvault run --project <name> [--agent <id>] --batch <file.json>\nvault run --attach <request> [--agent <id>]\nvault approve [--terminal]\nvault reject <request>\nvault import <file> --from chrome|edge|firefox|bitwarden|1password|keepass\nvault import <file.env> --from dotenv --project <name>\nvault export <file>\nvault restore <file>\nvault sync status\nvault sync setup <folder>\nvault sync join <folder> [--recovery]\nvault sync now\nvault sync conflicts\nvault sync restore <id>\nvault sync dismiss <id>\nvault sync leave\nvault install [--app <path>]\nvault uninstall [--remove-data]\nvault dev-install\nvault serve",
  "vault status: consultar el estado\nvault create --kit <archivo.txt>: crear la bóveda y guardar el kit\nvault unlock [--terminal]: desbloquear\nvault recover --kit <archivo.txt>: recuperar y guardar un kit nuevo\nvault lock: bloquear\nvault apps [allow|revoke <id>]: listar, permitir o revocar apps\nvault settings: ver los ajustes\nvault settings set <clave> <valor>: cambiar un ajuste\nvault run --project <nombre> [--agent <id>] -- <comando> [args...]: pedir que se ejecute con las variables del proyecto\nvault run --project <nombre> [--agent <id>] --batch <archivo.json>: pedir varios comandos juntos\nvault run --attach <pedido> [--agent <id>]: volver a seguir un pedido\nvault approve [--terminal]: ver los pedidos que esperan y aprobarlos o rechazarlos\nvault reject <pedido>: rechazar un pedido o detenerlo\nvault import <archivo> --from chrome|edge|firefox|bitwarden|1password|keepass: importar\nvault import <archivo.env> --from dotenv --project <nombre>: guardar las variables de un proyecto\nvault export <archivo>: guardar una copia cifrada\nvault restore <archivo>: restaurar una copia cifrada\nvault sync status: consultar la sincronización\nvault sync setup <carpeta>: configurar la carpeta compartida\nvault sync join <carpeta> [--recovery]: unir esta computadora\nvault sync now: sincronizar ahora\nvault sync conflicts: ver los conflictos\nvault sync restore <id>: restaurar una versión guardada\nvault sync dismiss <id>: descartar una versión guardada\nvault sync leave: dejar de sincronizar\nvault install [--app <ruta>]: instalar Vault desde esta copia\nvault uninstall [--remove-data]: desinstalar Vault y conservar los datos, o borrarlos también\nvault dev-install: guardar la instalación de desarrollo\nvault serve: ejecutar el servicio");
const messages: Record<string, [string, string]> = {
  sync_existing: ["This computer already has a vault. Export and restore it instead.", "Esta computadora ya tiene una bóveda. Exportala y restaurala."],
  sync_unconfigured: ["Set up sync first.", "Primero configurá la sincronización."],
  locked: ["Vault is locked. Run vault unlock.", "Vault está bloqueado. Ejecutá vault unlock."],
  unlock_expired: ["Nobody unlocked Vault in time. Try again.", "Nadie desbloqueó Vault a tiempo. Volvé a intentar."],
  not_installed: ["Run vault dev-install first.", "Primero ejecutá vault dev-install."],
  pending: ["This app is awaiting approval.", "Esta app espera autorización."],
  revoked: ["This app's access was revoked.", "Se revocó el acceso de esta app."],
  forbidden: ["This app does not have permission.", "Esta app no tiene permiso."],
  terminal_required: ["A terminal is required for input and value access.", "Se necesita una terminal para ingresar datos y acceder a valores."],
  cancelled: ["Cancelled.", "Cancelado."],
  not_found: ["Entry or field not found.", "No se encontró la entrada o el campo."],
  invalid: ["Invalid input. Run vault help.", "Revisá los datos. Ejecutá vault help."],
  unsafe_location: ["The data location cannot be made private.", "No se pudo proteger la carpeta de datos."],
  path_failed: ["The vault command could not be added to PATH.", "No se pudo agregar el comando vault al PATH."],
  path_remove_failed: ["The vault command could not be removed from PATH.", "No se pudo quitar el comando vault del PATH."],
  not_packaged: ["Run vault install from an installed copy of Vault.", "Ejecutá vault install desde una copia instalada de Vault."],
  limited: ["The limit was reached. Try again later.", "Se alcanzó el límite. Volvé a intentar más tarde."],
  rate_limited: ["Too many requests. Try again later.", "Demasiadas solicitudes. Volvé a intentar más tarde."],
  conflict: ["The data changed or already exists.", "Los datos cambiaron o ya existen."],
  not_verified: ["Vault could not confirm it is you. Nothing ran.", "Vault no pudo confirmar que sos vos. No se ejecutó nada."],
  hello_unavailable: ["Windows Hello is not available for Vault here. Type the master password instead.", "Windows Hello no está disponible para Vault acá. Escribí la contraseña maestra."],
  expired: ["The request expired. Nothing ran.", "El pedido venció. No se ejecutó nada."],
  not_pending: ["That request was already answered.", "Ese pedido ya tuvo respuesta."],
  run_not_found: ["Vault has no request with that id. It ended more than 10 minutes ago, or the service restarted.", "Vault no tiene un pedido con ese id. Terminó hace más de 10 minutos o el servicio se reinició."],
  busy: ["Vault is busy. Try again in a moment.", "Vault está ocupado. Volvé a intentar en un momento."],
  too_large: ["The data is too large.", "Los datos son demasiado grandes."],
};
/** `write` and `error` print a line; `out` and `err` pass a command's output through as it came. */
export type CliIO = { isTTY(): boolean; ask(label: string): Promise<string>; write(text: string): void; error(text: string): void; out(text: string): void; err(text: string): void };
const terminal: CliIO = { isTTY: () => !!process.stdin.isTTY, ask: hiddenPrompt, write: text => process.stdout.write(`${text}\n`), error: text => process.stderr.write(`${text}\n`), out: text => process.stdout.write(text), err: text => process.stderr.write(text) };
async function confirmValues(io: CliIO) {
  if (!io.isTTY()) throw new VaultClientError("terminal_required");
  const answer = await io.ask(copy("Allow this command to read a value? (y/n): ", "¿Permitir que este comando lea un valor? (s/n): "));
  if (!yes(answer)) throw new VaultClientError("cancelled");
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
    // --terminal keeps the password and approval prompts in this terminal even when the Vault app is installed; after "--" it belongs to the command.
    const cut = args.indexOf("--"), head = cut < 0 ? args : args.slice(0, cut), flagged = head.filter(arg => arg === "--terminal").length;
    if (flagged > 1) throw new VaultClientError("invalid");
    if (flagged) args = [...head.filter(arg => arg !== "--terminal"), ...args.slice(head.length)];
    const [command = "help", sub, third] = args;
    if (flagged && !["unlock", "approve", "get", "import", "export", "restore", "run", "sync"].includes(command)) throw new VaultClientError("invalid");
    if (command === "help" && args.length <= 1) { io.write(`${usage()}\n${copy("vault get <entry-id> [field-id] [--reveal]", "vault get <id-entrada> [id-campo] [--reveal]: consultar un campo")}\n${copy("--terminal: ask for the password and the approvals in this terminal even when the Vault app is installed; it goes on unlock, get, import, export, restore, run, approve and sync.", "--terminal: pedir la contraseña y las aprobaciones en esta terminal aunque la app de Vault esté instalada; va en unlock, get, import, export, restore, run, approve y sync.")}`); return 0; }
    if (command === "serve" && args.length === 1) { await serve(); return 0; }
    if (command === "dev-install" && args.length === 1) {
      prepareHome(home); await atomicJson(join(home, "install.json"), { version: 1, command: process.execPath, args: [fileURLToPath(new URL(`../../service/src/main${extname(import.meta.url)}`, import.meta.url))], ...process.platform === "win32" ? { helper: fileURLToPath(new URL("../../helper/bin/vault-helper.exe", import.meta.url)) } : {} });
      const manual = await installLauncher(home, fileURLToPath(import.meta.url));
      io.write(manual ? copy(`Development installation saved. Add ${manual} to PATH to use vault.`, `Se guardó la instalación de desarrollo. Agregá ${manual} al PATH para usar vault.`) : copy("Development installation saved. Open a new terminal to use vault.", "Se guardó la instalación de desarrollo. Abrí una terminal nueva para usar vault.")); return 0;
    }
    if (command === "install" && (args.length === 1 || args.length === 3 && sub === "--app")) {
      const place = layout(); if (!place) throw new VaultClientError("not_packaged");
      const manual = await install(home, place, args.length === 3 ? appFile(third) : undefined);
      io.write(manual ? copy(`Vault is installed. Add ${manual} to PATH to use vault.`, `Vault quedó instalado. Agregá ${manual} al PATH para usar vault.`) : copy("Vault is installed. Open a new terminal to use vault.", "Vault quedó instalado. Abrí una terminal nueva para usar vault.")); return 0;
    }
    if (command === "uninstall" && (args.length === 1 || args.length === 2 && sub === "--remove-data")) {
      const wipe = args.length === 2, word = copy("DELETE", "BORRAR");
      if (wipe && !io.isTTY()) throw new VaultClientError("terminal_required");
      if (wipe && (await io.ask(copy(`This deletes ${visible(home)}, with your vault and all its data, for good. Type ${word} to continue: `, `Esto borra ${visible(home)}, con tu bóveda y todos sus datos, para siempre. Escribí ${word} para seguir: `))).trim() !== word) throw new VaultClientError("cancelled");
      const manual = await uninstall(home, wipe);
      io.write(wipe ? copy("Vault is uninstalled and its data deleted.", "Se desinstaló Vault y se borraron sus datos.") : copy("Vault is uninstalled. Your data was kept.", "Se desinstaló Vault. Se conservaron tus datos."));
      if (manual) io.write(copy(`Remove ${manual} from PATH if you added it.`, `Quitá ${manual} del PATH si lo agregaste.`)); return 0;
    }
    if (command === "status" && args.length === 1 && !await findService(home)) { io.write(copy("Vault is stopped.", "Vault está detenido.")); return 0; }
    const options = command === "run" ? runOptions(args, appIdPattern) : undefined, dotenv = command === "import" && args.length === 6 && third === "--from" && args[3] === "dotenv" && args[4] === "--project";
    const syncing = command === "sync" && (["status", "now", "conflicts", "leave"].includes(sub) && args.length === 2 || ["setup", "restore", "dismiss"].includes(sub) && args.length === 3 || sub === "join" && (args.length === 3 || args.length === 4 && args[3] === "--recovery"));
    const valid = syncing || ["status", "unlock", "lock", "approve"].includes(command) && args.length === 1 || ["create", "recover"].includes(command) && args.length === 3 && sub === "--kit" || command === "apps" && (args.length === 1 || args.length === 3 && ["allow", "revoke"].includes(sub)) || command === "settings" && (args.length === 1 || args.length === 4 && sub === "set") || !!options || dotenv || command === "import" && args.length === 4 && third === "--from" && ["chrome", "edge", "firefox", "bitwarden", "1password", "keepass"].includes(args[3]) || ["export", "restore", "reject"].includes(command) && args.length === 2;
    const get = command === "get" && (args.length === 2 || args.length === 3 || args.length === 4 && args[3] === "--reveal");
    if (!valid && !get) throw new VaultClientError("invalid");
    // Where a command needs the person's password or approval, an installed Vault app asks in its window unless --terminal was given.
    const asks = ["unlock", "approve", "get", "import", "export", "restore", "run"].includes(command) || syncing && ["setup", "now", "conflicts", "restore", "dismiss"].includes(sub);
    if (flagged && !asks) throw new VaultClientError("invalid");
    const viaApp = asks && !flagged && installedApp(home) !== undefined;
    if (command === "approve" && viaApp) { io.write(copy("Approvals happen in Vault's window.", "Las aprobaciones se hacen en la ventana de Vault.")); return 0; }
    if (get && args.at(-1) !== "--reveal") { io.write(copy("Add --reveal to print a field value after terminal confirmation.", "Agregá --reveal para mostrar el valor de un campo después de confirmar en la terminal.")); return 0; }
    if (get) await confirmValues(io);
    if (syncing && ["setup", "join"].includes(sub)) {
      if (!io.isTTY()) throw new VaultClientError("terminal_required");
      io.write(copy("Encrypted copies of every entry and attachment leave this computer for whoever syncs your chosen folder, including OneDrive. The provider cannot read them. The folder holds the vault protected by your master password, so its strength matters. Keep the folder, the master password and the recovery kit yourself.", "Se envían copias cifradas de cada entrada y adjunto a quienes sincronicen la carpeta que elijas, incluido OneDrive. El proveedor no puede leerlas. La carpeta tiene la bóveda protegida por tu contraseña maestra: su fortaleza importa. Guardá vos la carpeta, la contraseña maestra y el kit de recuperación."));
      if (!yes(await io.ask(copy("Continue? (y/n): ", "¿Seguís? (s/n): ")))) throw new VaultClientError("cancelled");
    }
    if (command === "approve" && !io.isTTY()) throw new VaultClientError("terminal_required");
    // Without a terminal, or when named, the caller is an agent: it may only propose runs for a person to approve.
    const agent = options && (options.agent !== undefined || !io.isTTY()) ? options.agent ?? "agent" : undefined;
    api = await connect({ home, app: agent ? { id: agent, name: AGENTS[agent] ?? agent, kind: "agent" } : { id: "vault-cli", name: "Vault CLI", kind: "cosmic" } });
    if (["get", "import", "export", "restore"].includes(command)) await unlocked(api, io, viaApp, `vault ${command}`);
    if (syncing) {
      if (["setup", "now", "conflicts", "restore", "dismiss"].includes(sub)) await unlocked(api, io, viaApp, "vault sync");
      if (sub === "status") {
        const status = await api.sync.status();
        io.write(copy(status.configured ? "Sync is configured." : "Sync is not configured.", status.configured ? "La sincronización está configurada." : "La sincronización no está configurada."));
        io.write(copy(`Folder: ${visible(status.folder ?? "-")}`, `Carpeta: ${visible(status.folder ?? "-")}`));
        io.write(copy(`Last synced: ${status.lastSynced ?? "-"}`, `Última sincronización: ${status.lastSynced ?? "-"}`));
        io.write(copy(`Computers: ${status.computers.join(", ") || "-"}; pending changes: ${status.pending}; conflicts: ${status.conflicts}.`, `Computadoras: ${status.computers.join(", ") || "-"}; cambios pendientes: ${status.pending}; conflictos: ${status.conflicts}.`));
        if (status.failure) io.write(copy(`Last failure: ${status.failure.writer ?? "-"} | ${status.failure.cause}`, `Última falla: ${status.failure.writer ?? "-"} | ${status.failure.cause}`));
      } else if (sub === "setup") { await api.sync.setup(resolve(third)); io.write(copy("Sync configured.", "Se configuró la sincronización.")); }
      else if (sub === "join") { const recovery = args[3] === "--recovery", secret = await io.ask(copy(recovery ? "Recovery key: " : "Master password: ", recovery ? "Clave de recuperación: " : "Contraseña maestra: ")); await api.sync.join(resolve(third), recovery ? { recovery: secret } : { password: secret }); io.write(copy("This computer joined Vault.", "Esta computadora se unió a Vault.")); }
      else if (sub === "now") { await api.sync.now(); io.write(copy("Synced.", "Se sincronizó.")); }
      else if (sub === "conflicts") { const conflicts = await api.sync.conflicts(); if (!conflicts.length) io.write(copy("No conflicts.", "No hay conflictos.")); for (const row of conflicts) io.write(`${row.id} | ${row.kind ?? copy("envelope", "bóveda")} | ${visible(row.title)} | ${row.deviceId} | ${row.time}${row.deleted ? copy(" | deleted", " | eliminada") : ""}`); }
      else if (sub === "restore") { await api.sync.restore(third); io.write(copy("Restored as a new change.", "Se restauró como un cambio nuevo.")); }
      else if (sub === "dismiss") { await api.sync.dismiss(third); io.write(copy("Dismissed.", "Se descartó.")); }
      else { if (!io.isTTY()) throw new VaultClientError("terminal_required"); const remove = yes(await io.ask(copy("Remove only this computer's writer folder too? (y/n): ", "¿Borrás también la carpeta de esta computadora? (s/n): "))); await api.sync.leave(remove); io.write(copy("Sync disconnected on this computer.", "Se desconectó la sincronización en esta computadora.")); }
    }
    else if (command === "status") { const status = await api.status(); io.write(copy(`Vault is ${status.created ? status.unlocked ? "unlocked" : "locked" : "not created"}.`, `Vault está ${status.created ? status.unlocked ? "desbloqueado" : "bloqueado" : "sin crear"}.`)); }
    else if (command === "create") {
      const password = await confirmedPassword(io); await kit(third, () => api!.create(password)); io.write(copy("Vault created. Recovery kit saved.", "Se creó Vault y se guardó el kit de recuperación."));
    } else if (command === "recover") {
      const recovery = await io.ask(copy("Recovery key: ", "Clave de recuperación: ")), password = await confirmedPassword(io);
      await kit(third, () => api!.recover(recovery, password)); io.write(copy("Master password replaced. New recovery kit saved.", "Se reemplazó la contraseña maestra y se guardó un kit nuevo."));
    } else if (command === "unlock") { if (viaApp) await unlocked(api, io, true, "vault unlock"); else await api.unlock(await io.ask(copy("Master password: ", "Contraseña maestra: "))); io.write(copy("Vault unlocked.", "Vault desbloqueado.")); }
    else if (command === "lock") { await api.lock(); io.write(copy("Vault locked.", "Vault bloqueado.")); }
    else if (command === "apps") {
      if (sub === "allow") await api.apps.allow(third); else if (sub === "revoke") await api.apps.revoke(third);
      else for (const app of await api.apps.list()) io.write(`${app.id} | ${copy(app.status, ({ granted: "autorizada", pending: "pendiente", revoked: "revocada" })[app.status])} | ${app.kinds.join(",")}${app.permissions.length ? ` | ${app.permissions.join(",")}` : ""}`);
      if (sub) io.write(copy("Saved.", "Se guardó."));
    } else if (command === "settings") {
      if (sub === "set") { await api.settings.set(withSetting(await api.settings.get(), third, args[3])); io.write(copy("Saved.", "Se guardó.")); }
      else for (const line of settingLines(await api.settings.get())) io.write(line);
    } else if (command === "run") return await run(api, io, options!, agent, viaApp);
    else if (command === "approve") return await approve(api, io);
    else if (command === "reject") { await api.runs.reject(sub); io.write(copy("Rejected.", "Rechazado.")); }
    else if (command === "get") {
      const row = await api.entries.get(sub), field = row.entry.fields.find(field => field.id === (third === "--reveal" ? "password" : third));
      if (!field) throw new VaultClientError("not_found");
      io.write(field.value);
    }
    else if (dotenv) {
      const file = resolve(sub), counts = await api.importEnv(args[5], await readCapped(file)), shown = visible(file);
      io.write(copy(`Saved in ${visible(args[5])}: ${counts.added} new, ${counts.replaced} changed, ${counts.unchanged} the same, ${counts.kept} kept from before; ${counts.skipped} lines skipped.`, `Guardado en ${visible(args[5])}: ${counts.added} nuevas, ${counts.replaced} cambiadas, ${counts.unchanged} iguales, ${counts.kept} que ya estaban; ${counts.skipped} líneas omitidas.`));
      // The file is deleted only on the person's answer; without a terminal there is nobody to ask.
      const answer = io.isTTY() ? await io.ask(copy(`Delete ${shown} now? It holds the values in plain text. (y/n): `, `¿Borrar ${shown} ahora? Tiene las variables en texto plano. (s/n): `)) : "";
      if (yes(answer)) { await rm(file); io.write(copy("Deleted.", "Se borró.")); }
      else io.write(copy(`${shown} was kept. It holds the values in plain text.`, `Se dejó ${shown}. Tiene las variables en texto plano.`));
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
