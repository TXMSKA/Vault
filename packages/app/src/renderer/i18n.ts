// The words of Vault's window, in English and in Spanish, each written on its own. Spanish is impersonal: no voseo and no tuteo.
export type Dictionary = {
  // The title bar
  lock: string; lockNow: string; menu: string; minimize: string; maximize: string; restore: string; close: string;
  // Shared
  back: string; cancel: string; reveal: string; hide: string; masterPassword: string; repeatIt: string; passwordRange: string; passwordShort: string; passwordMismatch: string;
  unavailable: string; busy: string; limited: string;
  // First run
  welcomeTitle: string; welcomeBody: string; createChoice: string; createChoiceLine: string; restoreChoice: string; restoreChoiceLine: string; continue: string;
  createTitle: string; createBody: string; createNotice: string; createButton: string;
  recoveryTitle: string; recoveryBody: string; saveSheet: string; printSheet: string; sheetSaved: string; sheetSaveFailed: string; sheetExists: string; sheetPrintFailed: string; sheetChecked: string; openVault: string; notRestored: string;
  restoreTitle: string; restoreBody: string; backupFile: string; noFile: string; choose: string; backupPassword: string; restoreNotice: string; restoreButton: string; backupWrong: string; backupInvalid: string; backupFirst: string;
  // Unlock
  lockedTitle: string; lockedBody: string; unlock: string; hello: string; useRecovery: string; lockedError: string; lockedAsks(app: string, id: string): string; lockedReason(reason: string): string;
  helloTitle: string; helloBody: string; helloFailed: string; helloUnavailable: string;
  recoveryUnlockTitle: string; recoveryUnlockBody: string; recoveryKey: string; newPassword: string; recoveryUnlockNotice: string; recoveryWrong: string;
  // Requests
  runTitle(app: string, count: number): string; runProject: string; runFolder: string; runValues(project: string): string; runShort(names: string, count: number): string; runMissing(project: string): string; runAmbiguous(project: string): string;
  expires(minutes: number): string; covers(count: number): string; approve: string; reject: string; useHello: string; usePassword: string; passwordWrong: string; requestExpired: string; requestAnswered: string;
  permissionTitle(app: string): string; permissionApp: string; permissionBody(app: string): string; allow: string; deny: string;
  // The list, until it is built
  search: string; addEntry: string; emptyTitle: string; emptyBody: string; import: string;
  // Out of reach
  outTitle: string; outBody: string; notInstalledBody: string; tryAgain: string;
  // The printed sheet
  sheetTitle: string; sheetMade(date: string, computer: string): string; sheetKey: string; sheetUseTitle: string; sheetUse: string; sheetKeepTitle: string; sheetKeep: string; sheetFoot: string;
};
const count = (n: number, one: string, many: string) => n === 1 ? one : many;
const wordsEn = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"], wordsEs = ["", "un", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];
export const en: Dictionary = {
  lock: "Lock", lockNow: "Lock Vault now", menu: "Menu", minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close",
  back: "Back", cancel: "Cancel", reveal: "Reveal", hide: "Hide", masterPassword: "Master password", repeatIt: "Repeat it", passwordRange: "15 to 128 characters.", passwordShort: "Use 15 to 128 characters.", passwordMismatch: "The two passwords are not the same.",
  unavailable: "Vault could not be reached. Try again.", busy: "Vault is busy. Try again in a moment.", limited: "Too many attempts. Wait a moment and try again.",
  welcomeTitle: "Welcome to Vault", welcomeBody: "Vault keeps your passwords encrypted on this computer and shares them only with the Cosmic apps you allow.",
  createChoice: "Create a new vault", createChoiceLine: "Start empty and import later from a browser or another manager.", restoreChoice: "Restore a backup", restoreChoiceLine: "Open an encrypted Vault backup with its password.", continue: "Continue",
  createTitle: "Choose a master password", createBody: "It unlocks Vault in every app. A long phrase you can remember works best.", createNotice: "Nobody can recover this password for you. The recovery key on the next step can.", createButton: "Create vault",
  recoveryTitle: "Your recovery key", recoveryBody: "It opens Vault if you forget the master password. It is shown only now, so save or print the recovery sheet.", saveSheet: "Save recovery sheet", printSheet: "Print",
  sheetSaved: "Recovery sheet saved.", sheetSaveFailed: "The recovery sheet could not be saved.", sheetExists: "That file already exists. Choose another name.", sheetPrintFailed: "The recovery sheet could not be printed.", sheetChecked: "I saved or printed the recovery sheet", openVault: "Open Vault",
  notRestored: "The backup could not be restored, so the vault is empty.",
  restoreTitle: "Restore a backup", restoreBody: "Choose a Vault backup and type the password it was made with.", backupFile: "Backup", noFile: "No file chosen", choose: "Choose", backupPassword: "Backup password",
  restoreNotice: "The restored vault keeps that backup's master password and gets a new recovery key.", restoreButton: "Restore", backupWrong: "That backup password is not right.", backupInvalid: "That file is not a Vault backup.", backupFirst: "Choose a backup file first.",
  lockedTitle: "Vault is locked", lockedBody: "Unlocking here unlocks Vault for every Cosmic app on this computer until it locks again.", unlock: "Unlock", hello: "Windows Hello", useRecovery: "Use recovery key",
  lockedError: "That password is not right. Try again or use the recovery key.", lockedAsks: (app, id) => `${app} (${id}) asks to unlock Vault.`, lockedReason: reason => `Reason given: ${reason}`,
  helloTitle: "Waiting for Windows Hello", helloBody: "Confirm it is you in the Windows Security window.", helloFailed: "Windows Hello could not confirm it is you. Type the master password instead.", helloUnavailable: "Windows Hello is not available for Vault here. Type the master password instead.",
  recoveryUnlockTitle: "Use the recovery key", recoveryUnlockBody: "Type the key from your recovery sheet. Then choose a new master password.", recoveryKey: "Recovery key", newPassword: "New master password",
  recoveryUnlockNotice: "Windows Hello turns off and a new recovery key replaces this one.", recoveryWrong: "That recovery key is not right.",
  runTitle: (app, n) => `${app} wants to run ${n} ${count(n, "command", "commands")}`, runProject: "Project", runFolder: "Folder", runValues: project => `They get ${project}'s values. Vault hides the values in what the commands print, but a command, or a script it runs, can still save them elsewhere.`,
  runShort: (names, n) => `${names} ${count(n, "is", "are")} shorter than 4 characters, so ${count(n, "it shows", "they show")} as ${count(n, "it is", "they are")} in the output.`,
  runMissing: project => `"${project}" is not in Vault, so approving fails.`, runAmbiguous: project => `"${project}" names more than one entry in Vault, so approving fails.`,
  expires: minutes => minutes < 1 ? "This request has expired." : `Expires in ${minutes} ${count(minutes, "minute", "minutes")}.`, covers: n => n === 1 ? "Approving covers this command only." : `Approving covers these ${n <= 10 ? wordsEn[n] : n} commands only.`,
  approve: "Approve", reject: "Reject", useHello: "Use Windows Hello", usePassword: "Use master password", passwordWrong: "That password is not right.", requestExpired: "This request has expired.", requestAnswered: "This request was already answered.",
  permissionTitle: app => `${app} asks to import passwords`, permissionApp: "App", permissionBody: app => `Allowing it lets ${app} add passwords to Vault until its access is revoked.`, allow: "Allow", deny: "Deny",
  search: "Search Vault", addEntry: "Add an entry", emptyTitle: "Your vault is empty", emptyBody: "Add your first entry, or bring passwords from a browser or another manager.", import: "Import",
  outTitle: "Vault is not available", outBody: "Vault could not be reached. Try again in a moment.", notInstalledBody: "Vault is not installed on this computer yet.", tryAgain: "Try again",
  sheetTitle: "Vault recovery sheet", sheetMade: (date, computer) => `Made on ${date} on the computer named ${computer}.`, sheetKey: "Recovery key", sheetUseTitle: "How to use it",
  sheetUse: "On Vault's locked screen, choose Use recovery key, type this key and choose a new master password. A new recovery key and sheet replace this one.", sheetKeepTitle: "Keep it safe",
  sheetKeep: "Keep this sheet offline, somewhere only you can reach. Anyone with this key and a copy of your vault can open it.", sheetFoot: "Vault does not keep a copy of this key and cannot send it again.",
};
export const es: Dictionary = {
  lock: "Bloquear", lockNow: "Bloquear Vault ahora", menu: "Menú", minimize: "Minimizar", maximize: "Maximizar", restore: "Restaurar", close: "Cerrar",
  back: "Atrás", cancel: "Cancelar", reveal: "Mostrar", hide: "Ocultar", masterPassword: "Contraseña maestra", repeatIt: "Repetirla", passwordRange: "De 15 a 128 caracteres.", passwordShort: "Debe tener de 15 a 128 caracteres.", passwordMismatch: "Las dos contraseñas no coinciden.",
  unavailable: "No se pudo conectar con Vault. Volver a intentar.", busy: "Vault está ocupado. Volver a intentar en un momento.", limited: "Demasiados intentos. Esperar un momento y volver a intentar.",
  welcomeTitle: "Bienvenido a Vault", welcomeBody: "Vault guarda las contraseñas cifradas en esta computadora y las comparte solo con las apps de Cosmic autorizadas.",
  createChoice: "Crear una bóveda nueva", createChoiceLine: "Empezar vacía e importar después desde un navegador u otro administrador.", restoreChoice: "Restaurar una copia", restoreChoiceLine: "Abrir una copia cifrada de Vault con su contraseña.", continue: "Continuar",
  createTitle: "Elegir una contraseña maestra", createBody: "Desbloquea Vault en todas las apps. Lo mejor es una frase larga y fácil de recordar.", createNotice: "Nadie puede recuperar esta contraseña. La clave de recuperación del paso siguiente sí puede.", createButton: "Crear bóveda",
  recoveryTitle: "La clave de recuperación", recoveryBody: "Abre Vault si se olvida la contraseña maestra. Se muestra solo ahora, por eso conviene guardar o imprimir la hoja de recuperación.", saveSheet: "Guardar hoja de recuperación", printSheet: "Imprimir",
  sheetSaved: "Hoja de recuperación guardada.", sheetSaveFailed: "No se pudo guardar la hoja de recuperación.", sheetExists: "Ese archivo ya existe. Elegir otro nombre.", sheetPrintFailed: "No se pudo imprimir la hoja de recuperación.", sheetChecked: "Guardé o imprimí la hoja de recuperación", openVault: "Abrir Vault",
  notRestored: "No se pudo restaurar la copia, así que la bóveda quedó vacía.",
  restoreTitle: "Restaurar una copia", restoreBody: "Elegir una copia de Vault y escribir la contraseña con la que se hizo.", backupFile: "Copia", noFile: "Ningún archivo elegido", choose: "Elegir", backupPassword: "Contraseña de la copia",
  restoreNotice: "La bóveda restaurada conserva la contraseña maestra de esa copia y recibe una clave de recuperación nueva.", restoreButton: "Restaurar", backupWrong: "Esa contraseña de la copia no es correcta.", backupInvalid: "Ese archivo no es una copia de Vault.", backupFirst: "Primero hay que elegir el archivo de la copia.",
  lockedTitle: "Vault está bloqueado", lockedBody: "Desbloquear aquí desbloquea Vault para todas las apps de Cosmic de esta computadora hasta que vuelva a bloquearse.", unlock: "Desbloquear", hello: "Windows Hello", useRecovery: "Usar clave de recuperación",
  lockedError: "Esa contraseña no es correcta. Volver a intentar o usar la clave de recuperación.", lockedAsks: (app, id) => `${app} (${id}) pide desbloquear Vault.`, lockedReason: reason => `Motivo indicado: ${reason}`,
  helloTitle: "Esperando a Windows Hello", helloBody: "Confirmar la identidad en la ventana de Seguridad de Windows.", helloFailed: "Windows Hello no pudo confirmar la identidad. Escribir la contraseña maestra.", helloUnavailable: "Windows Hello no está disponible para Vault aquí. Escribir la contraseña maestra.",
  recoveryUnlockTitle: "Usar la clave de recuperación", recoveryUnlockBody: "Escribir la clave de la hoja de recuperación. Después, elegir una contraseña maestra nueva.", recoveryKey: "Clave de recuperación", newPassword: "Contraseña maestra nueva",
  recoveryUnlockNotice: "Windows Hello se desactiva y una clave de recuperación nueva reemplaza a esta.", recoveryWrong: "Esa clave de recuperación no es correcta.",
  runTitle: (app, n) => `${app} quiere ejecutar ${n} ${count(n, "comando", "comandos")}`, runProject: "Proyecto", runFolder: "Carpeta", runValues: project => `Reciben los valores de ${project}. Vault los oculta en lo que imprimen los comandos, pero un comando, o un script que ejecute, todavía puede guardarlos en otro lugar.`,
  runShort: (names, n) => `${names} ${count(n, "tiene", "tienen")} menos de 4 caracteres, por eso ${count(n, "se ve", "se ven")} tal cual en la salida.`,
  runMissing: project => `"${project}" no está en Vault, así que aprobar falla.`, runAmbiguous: project => `"${project}" nombra más de una entrada de Vault, así que aprobar falla.`,
  expires: minutes => minutes < 1 ? "Este pedido venció." : `Vence en ${minutes} ${count(minutes, "minuto", "minutos")}.`, covers: n => n === 1 ? "Aprobar cubre solo este comando." : `Aprobar cubre solo ${n <= 10 ? `estos ${wordsEs[n]}` : `estos ${n}`} comandos.`,
  approve: "Aprobar", reject: "Rechazar", useHello: "Usar Windows Hello", usePassword: "Usar contraseña maestra", passwordWrong: "Esa contraseña no es correcta.", requestExpired: "Este pedido venció.", requestAnswered: "Este pedido ya tuvo respuesta.",
  permissionTitle: app => `${app} pide importar contraseñas`, permissionApp: "App", permissionBody: app => `Permitirlo deja que ${app} agregue contraseñas a Vault hasta que se revoque su acceso.`, allow: "Permitir", deny: "Denegar",
  search: "Buscar en Vault", addEntry: "Agregar una entrada", emptyTitle: "La bóveda está vacía", emptyBody: "Agregar la primera entrada o traer contraseñas desde un navegador u otro administrador.", import: "Importar",
  outTitle: "Vault no está disponible", outBody: "No se pudo conectar con Vault. Volver a intentar en un momento.", notInstalledBody: "Vault todavía no está instalado en esta computadora.", tryAgain: "Volver a intentar",
  sheetTitle: "Hoja de recuperación de Vault", sheetMade: (date, computer) => `Hecha el ${date} en la computadora ${computer}.`, sheetKey: "Clave de recuperación", sheetUseTitle: "Cómo usarla",
  sheetUse: "En la pantalla de bloqueo de Vault, elegir Usar clave de recuperación, escribir esta clave y elegir una contraseña maestra nueva. Una clave y una hoja nuevas reemplazan a esta.", sheetKeepTitle: "Guardarla bien",
  sheetKeep: "Guardar esta hoja fuera de línea, en un lugar al que solo se acceda personalmente. Quien tenga esta clave y una copia de la bóveda puede abrirla.", sheetFoot: "Vault no guarda copia de esta clave y no puede enviarla de nuevo.",
};
export const dictionary = (language: "en" | "es"): Dictionary => language === "es" ? es : en;
