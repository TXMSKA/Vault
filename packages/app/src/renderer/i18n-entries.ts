// The words of the list, the entries, their forms, the menu, the settings and the tips, in English and in Spanish, each written on its own.
// Spanish is impersonal: no voseo and no tuteo. A name that takes a kind, a field or a choice looks it up and answers the name itself when it is unknown.
export type EntriesDictionary = {
  // The menu
  menuApps: string; menuImport: string; menuExport: string; menuSettings: string; menuTips: string; menuSettingsLine: string; menuTipsLine: string; inCommandLine(command: string): string;
  // The list
  clearSearch: string; noMatches: string; chooseEntry: string; entriesLabel: string; showLabel(filter: string): string; filterName(filter: string): string;
  kindName(kind: string): string; kindLine(kind: string): string; newTitle(kind: string): string; sub(kind: string, detail: string, count: number): string;
  // An open entry
  edit: string; addFavourite: string; removeFavourite: string; copyField(label: string): string; openWebsite: string; oneTimeCode: string; secondsLeft(seconds: number): string; secondsAria: string;
  clipboardNote: string; filesLabel: string; noteLabel: string; codeInvalid: string; copied(label: string): string; fieldLabel(id: string): string; deleted(title: string): string; undo: string;
  conflict: string; reload: string; entryGone: string; projectTaken(name: string): string; needName: string; badName(name: string): string; sameName(name: string): string; kb(size: number): string;
  // Forms
  save: string; deleteEntry: string; fieldPlaceholder(key: string): string; projectHint: string; unchangedHint: string;
  generate: string; makeAnother: string; lengthLabel: string; symbolsLabel: string; numbersLabel: string; uppercaseLabel: string; useGenerated: string;
  valuesLabel: string; addValue: string; removeValue: string; fieldsLabel: string; addField: string; fieldNameHolder: string; valueHolder: string; hiddenOn: string; hiddenOff: string; formName: string;
  // Questions
  deleteFilesTitle(title: string): string; deleteFilesBody: string; deleteButton: string; discardTitle: string; discardBody: string; discard: string; keepEditing: string;
  closeKeyTitle: string; closeKeyBody: string; goBack: string; closeAnyway: string;
  // Settings
  settingsTitle: string; backToList: string; idleTitle: string; idleLine: string; lastAppTitle: string; lastAppLine: string; helloLine: string; helloUnset: string; languageTitle: string; languageLine: string;
  themeTitle: string; themeLine: string; syncTitle: string; syncLine: string; comingLater: string; idleChoice(minutes: number): string; languageChoice(code: string): string; themeChoice(code: string): string;
  helloOnTitle: string; helloOnBody: string; turnOn: string;
  // The tips
  tipsWelcome: string; tipsMore: string; tipsOf(page: number): string; tipAddTitle: string; tipAddLine: string; tipCopyTitle: string; tipCopyLine: string; tipUnlockTitle: string; tipUnlockLine: string;
  tipLockTitle: string; tipLockLine: string; tipAppsTitle: string; tipAppsLine: string; tipRecoveryTitle: string; tipRecoveryLine: string; gotIt: string; more: string; done: string;
};
const pick = (table: Record<string, string>, key: unknown) => Object.hasOwn(table, String(key)) ? table[String(key)] : String(key);
const low = (value: unknown) => String(value).toLowerCase();
const plural = (n: number, one: string, many: string) => n === 1 ? one : many;

const enKind = { login: "Login", card: "Card", doc: "Document", note: "Note", key: "Key", custom: "Custom", env: "Environment" };
const enFilter = { all: "All entries", favourites: "Favourites", results: "Results", login: "Logins", card: "Cards", doc: "Documents", note: "Notes", key: "Keys", env: "Environment", custom: "Custom" };
const enLine = { login: "A website or app account", card: "A payment card", doc: "A file, kept encrypted", note: "Private text", key: "An SSH or API key", env: "Values a project loads in the terminal", custom: "Fields you name yourself" };
const enNew = { login: "New login", card: "New card", doc: "New document", note: "New note", key: "New key", env: "New environment", custom: "New custom entry" };
const enField = {
  username: "Username", password: "Password", website: "Website", bank: "Bank", number: "Number", expiry: "Expires", securityCode: "Security code", holder: "Cardholder", pin: "PIN",
  key: "Key", license: "License key", passphrase: "Passphrase", note: "Note", totp: "One-time code key", name: "Name", project: "Project", text: "Text",
};
const enHolder = {
  loginName: "Northside Gym", username: "Email or user name", password: "Type one or generate it", website: "https://", cardName: "Atlas Card", holder: "Name on the card", number: "1234 5678 9012 3456",
  expiry: "MM/YY", securityCode: "CVC", docName: "Lease contract", optional: "Optional", noteName: "Home Wi-Fi", noteText: "Only you can read this", keyName: "Build server", key: "Paste the private key",
  passphrase: "Optional", project: "sprout", customName: "Gate code", totp: "Optional",
};
export const enEntries: EntriesDictionary = {
  menuApps: "Apps", menuImport: "Import", menuExport: "Export", menuSettings: "Settings", menuTips: "Show the tips again", menuSettingsLine: "Locking, Windows Hello, language, theme", menuTipsLine: "The first-open tour",
  inCommandLine: command => `In the command line for now: ${command}`,
  clearSearch: "Clear the search", noMatches: "No entries match.", chooseEntry: "Choose an entry to see it.", entriesLabel: "Entries", showLabel: filter => `Show: ${filter}`, filterName: filter => pick(enFilter, filter),
  kindName: kind => pick(enKind, kind), kindLine: kind => pick(enLine, kind), newTitle: kind => pick(enNew, kind),
  sub: (kind, detail, count) => {
    if (kind === "env") return `Environment, ${count} ${plural(count, "value", "values")}`;
    if (kind === "custom") return `Custom, ${count} ${plural(count, "field", "fields")}`;
    if (kind === "doc") return detail ? `Document, ${detail}` : count > 1 ? `Document, ${count} files` : "Document";
    if (kind === "login") return detail || "Login";
    if (kind === "card") return detail ? `Card, ${detail}` : "Card";
    return pick(enKind, kind);
  },
  edit: "Edit", addFavourite: "Add to favourites", removeFavourite: "Remove from favourites", copyField: label => `Copy ${low(label)}`, openWebsite: "Open website", oneTimeCode: "One-time code",
  secondsLeft: seconds => `${seconds} s`, secondsAria: "Seconds left", clipboardNote: "Copied values clear from the clipboard after 30 seconds.", filesLabel: "Files", noteLabel: "Note",
  codeInvalid: "The one-time code key is not valid.", copied: label => `${label} copied. It clears in 30 seconds.`, fieldLabel: id => pick(enField, id), deleted: title => `${title} deleted.`, undo: "Undo",
  conflict: "This entry was changed somewhere else. Reload it to see the latest version.", reload: "Reload", entryGone: "This entry no longer exists.", projectTaken: name => `There is already an environment named ${name}.`,
  needName: "A name is needed.", badName: name => `${name} is not a valid name.`, sameName: name => `${name} appears twice.`, kb: size => size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`,
  save: "Save", deleteEntry: "Delete entry", fieldPlaceholder: key => pick(enHolder, key), projectHint: "The name a run asks for: vault run --project sprout.", unchangedHint: "Unchanged. Type to replace it.",
  generate: "Generate a password", makeAnother: "Make another", lengthLabel: "Length", symbolsLabel: "Symbols", numbersLabel: "Numbers", uppercaseLabel: "Uppercase", useGenerated: "Use this password",
  valuesLabel: "Values", addValue: "Add value", removeValue: "Remove value", fieldsLabel: "Fields", addField: "Add field", fieldNameHolder: "Field name", valueHolder: "Value", hiddenOn: "Hidden", hiddenOff: "Shown", formName: "Name",
  deleteFilesTitle: title => `Delete ${title}?`, deleteFilesBody: "Its files are deleted with it and cannot be restored.", deleteButton: "Delete", discardTitle: "Discard the changes?", discardBody: "Nothing has been saved yet.", discard: "Discard", keepEditing: "Keep editing",
  closeKeyTitle: "Close without saving the recovery key?", closeKeyBody: "The recovery key is shown only once. Without it, a forgotten master password cannot be recovered.", goBack: "Go back", closeAnyway: "Close anyway",
  settingsTitle: "Settings", backToList: "Back to the list", idleTitle: "Lock after idle", idleLine: "Vault locks itself when no app has used it for this long.", lastAppTitle: "Lock when the last app closes",
  lastAppLine: "Closing the last Cosmic app that uses Vault locks it.", helloLine: "Unlock with your face, fingerprint or PIN instead of the master password.", helloUnset: "Windows Hello is not set up on this computer.",
  languageTitle: "Language", languageLine: "The language of Vault's own window.", themeTitle: "Theme", themeLine: "Follow Windows, or always dark or light.", syncTitle: "Sync", syncLine: "Encrypted sync through a cloud folder you choose.", comingLater: "Coming later",
  idleChoice: minutes => minutes === 60 ? "1 hour" : minutes === 240 ? "4 hours" : `${minutes} ${plural(minutes, "minute", "minutes")}`,
  languageChoice: code => pick({ system: "System", en: "English", es: "Español" }, code), themeChoice: code => pick({ system: "System", dark: "Dark", light: "Light" }, code),
  helloOnTitle: "Turn on Windows Hello", helloOnBody: "Type the master password once. After that, Windows Hello can unlock Vault.", turnOn: "Turn on",
  tipsWelcome: "Welcome to Vault", tipsMore: "A few more things", tipsOf: page => `${page} of 2`,
  tipAddTitle: "Add or import", tipAddLine: "Add an entry with +. To bring passwords from a browser, use vault import in the command line for now.",
  tipCopyTitle: "Copy, then it clears", tipCopyLine: "Copied values leave the clipboard after 30 seconds.", tipUnlockTitle: "One unlock for every app", tipUnlockLine: "Horizon, Nova and Nebula use this vault while it is unlocked.",
  tipLockTitle: "Lock", tipLockLine: "Lock in the title bar closes Vault for every app. It also locks itself when idle.", tipAppsTitle: "Apps", tipAppsLine: "Each app sees only its own kind of entry, and you choose which apps get in with vault apps.",
  tipRecoveryTitle: "Recovery key", tipRecoveryLine: "It is the only way back in without the master password. Keep it safe.", gotIt: "Got it", more: "More", done: "Done",
};

const esKind = { login: "Inicio de sesión", card: "Tarjeta", doc: "Documento", note: "Nota", key: "Clave", custom: "Personalizada", env: "Entorno" };
const esFilter = { all: "Todas las entradas", favourites: "Favoritas", results: "Resultados", login: "Inicios de sesión", card: "Tarjetas", doc: "Documentos", note: "Notas", key: "Claves", env: "Entornos", custom: "Personalizadas" };
const esLine = { login: "Una cuenta de un sitio web o de una app", card: "Una tarjeta de pago", doc: "Un archivo, guardado con cifrado", note: "Texto privado", key: "Una clave SSH o de API", env: "Valores que un proyecto carga en la terminal", custom: "Campos con nombre propio" };
const esNew = { login: "Nuevo inicio de sesión", card: "Nueva tarjeta", doc: "Nuevo documento", note: "Nueva nota", key: "Nueva clave", env: "Nuevo entorno", custom: "Nueva entrada personalizada" };
const esField = {
  username: "Usuario", password: "Contraseña", website: "Sitio web", bank: "Banco", number: "Número", expiry: "Vencimiento", securityCode: "Código de seguridad", holder: "Titular", pin: "PIN",
  key: "Clave", license: "Clave de licencia", passphrase: "Frase de paso", note: "Nota", totp: "Clave del código de un solo uso", name: "Nombre", project: "Proyecto", text: "Texto",
};
const esHolder = {
  loginName: "Gimnasio Norte", username: "Correo o nombre de usuario", password: "Escribirla o generarla", website: "https://", cardName: "Tarjeta Atlas", holder: "Nombre que figura en la tarjeta", number: "1234 5678 9012 3456",
  expiry: "MM/AA", securityCode: "CVC", docName: "Contrato de alquiler", optional: "Opcional", noteName: "Wi-Fi de casa", noteText: "Solo se puede leer aquí", keyName: "Servidor de compilación", key: "Pegar la clave privada",
  passphrase: "Opcional", project: "sprout", customName: "Código del portón", totp: "Opcional",
};
export const esEntries: EntriesDictionary = {
  menuApps: "Apps", menuImport: "Importar", menuExport: "Exportar", menuSettings: "Ajustes", menuTips: "Mostrar los consejos otra vez", menuSettingsLine: "Bloqueo, Windows Hello, idioma y tema", menuTipsLine: "El recorrido de la primera vez",
  inCommandLine: command => `Por ahora, en la línea de comandos: ${command}`,
  clearSearch: "Borrar la búsqueda", noMatches: "Ninguna entrada coincide.", chooseEntry: "Elegir una entrada para verla.", entriesLabel: "Entradas", showLabel: filter => `Mostrar: ${filter}`, filterName: filter => pick(esFilter, filter),
  kindName: kind => pick(esKind, kind), kindLine: kind => pick(esLine, kind), newTitle: kind => pick(esNew, kind),
  sub: (kind, detail, count) => {
    if (kind === "env") return `Entorno, ${count} ${plural(count, "valor", "valores")}`;
    if (kind === "custom") return `Personalizada, ${count} ${plural(count, "campo", "campos")}`;
    if (kind === "doc") return detail ? `Documento, ${detail}` : count > 1 ? `Documento, ${count} archivos` : "Documento";
    if (kind === "login") return detail || "Inicio de sesión";
    if (kind === "card") return detail ? `Tarjeta, ${detail}` : "Tarjeta";
    return pick(esKind, kind);
  },
  edit: "Editar", addFavourite: "Agregar a favoritas", removeFavourite: "Quitar de favoritas", copyField: label => `Copiar ${low(label)}`, openWebsite: "Abrir el sitio web", oneTimeCode: "Código de un solo uso",
  secondsLeft: seconds => `${seconds} s`, secondsAria: "Segundos restantes", clipboardNote: "Los valores copiados se borran del portapapeles a los 30 segundos.", filesLabel: "Archivos", noteLabel: "Nota",
  codeInvalid: "La clave del código de un solo uso no es válida.", copied: label => `Copiado: ${low(label)}. Se borra en 30 segundos.`, fieldLabel: id => pick(esField, id), deleted: title => `Se eliminó ${title}.`, undo: "Deshacer",
  conflict: "Esta entrada se cambió en otro lugar. Volver a cargarla para ver la última versión.", reload: "Volver a cargar", entryGone: "Esta entrada ya no existe.", projectTaken: name => `Ya hay un entorno llamado ${name}.`,
  needName: "Falta el nombre.", badName: name => `${name} no es un nombre válido.`, sameName: name => `${name} está repetido.`, kb: size => size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`,
  save: "Guardar", deleteEntry: "Eliminar entrada", fieldPlaceholder: key => pick(esHolder, key), projectHint: "El nombre que pide una ejecución: vault run --project sprout.", unchangedHint: "Sin cambios. Escribir para reemplazarlo.",
  generate: "Generar una contraseña", makeAnother: "Generar otra", lengthLabel: "Longitud", symbolsLabel: "Símbolos", numbersLabel: "Números", uppercaseLabel: "Mayúsculas", useGenerated: "Usar esta contraseña",
  valuesLabel: "Valores", addValue: "Agregar valor", removeValue: "Quitar valor", fieldsLabel: "Campos", addField: "Agregar campo", fieldNameHolder: "Nombre del campo", valueHolder: "Valor", hiddenOn: "Oculto", hiddenOff: "Visible", formName: "Nombre",
  deleteFilesTitle: title => `¿Eliminar ${title}?`, deleteFilesBody: "Sus archivos se eliminan con ella y no se pueden restaurar.", deleteButton: "Eliminar", discardTitle: "¿Descartar los cambios?", discardBody: "Todavía no se guardó nada.", discard: "Descartar", keepEditing: "Seguir editando",
  closeKeyTitle: "¿Cerrar sin guardar la clave de recuperación?", closeKeyBody: "La clave se muestra una sola vez. Sin ella, una contraseña maestra olvidada no se puede recuperar.", goBack: "Volver", closeAnyway: "Cerrar de todos modos",
  settingsTitle: "Ajustes", backToList: "Volver a la lista", idleTitle: "Bloquear por inactividad", idleLine: "Vault se bloquea solo cuando ninguna app lo usó durante este tiempo.", lastAppTitle: "Bloquear al cerrar la última app",
  lastAppLine: "Cerrar la última app de Cosmic que usa Vault lo bloquea.", helloLine: "Desbloquear con el rostro, la huella o el PIN en lugar de la contraseña maestra.", helloUnset: "Windows Hello no está configurado en esta computadora.",
  languageTitle: "Idioma", languageLine: "El idioma de la ventana de Vault.", themeTitle: "Tema", themeLine: "Seguir a Windows, o usar siempre el oscuro o el claro.", syncTitle: "Sincronización", syncLine: "Sincronización cifrada mediante una carpeta en la nube a elección.", comingLater: "Próximamente",
  idleChoice: minutes => minutes === 60 ? "1 hora" : minutes === 240 ? "4 horas" : `${minutes} ${plural(minutes, "minuto", "minutos")}`,
  languageChoice: code => pick({ system: "Sistema", en: "English", es: "Español" }, code), themeChoice: code => pick({ system: "Sistema", dark: "Oscuro", light: "Claro" }, code),
  helloOnTitle: "Activar Windows Hello", helloOnBody: "Escribir la contraseña maestra una vez. Después, Windows Hello puede desbloquear Vault.", turnOn: "Activar",
  tipsWelcome: "Bienvenido a Vault", tipsMore: "Algunas cosas más", tipsOf: page => `${page} de 2`,
  tipAddTitle: "Agregar o importar", tipAddLine: "Agregar una entrada con +. Para traer contraseñas de un navegador, por ahora se usa vault import en la línea de comandos.",
  tipCopyTitle: "Copiar, y después se borra", tipCopyLine: "Los valores copiados salen del portapapeles a los 30 segundos.", tipUnlockTitle: "Un desbloqueo para todas las apps", tipUnlockLine: "Horizon, Nova y Nebula usan esta bóveda mientras está desbloqueada.",
  tipLockTitle: "Bloquear", tipLockLine: "Bloquear, en la barra de título, cierra Vault para todas las apps. También se bloquea solo cuando está inactivo.", tipAppsTitle: "Apps", tipAppsLine: "Cada app ve solo su propio tipo de entrada, y se elige qué apps entran con vault apps.",
  tipRecoveryTitle: "Clave de recuperación", tipRecoveryLine: "Es la única forma de volver a entrar sin la contraseña maestra. Conviene guardarla bien.", gotIt: "Entendido", more: "Más", done: "Listo",
};
