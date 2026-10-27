// The words of the sync page, the sign-in and joining a synced vault, in English and in Spanish. Spanish is impersonal: no voseo and no tuteo.
export type SyncDictionary = {
  setUp: string; manage: string; syncOn(origin: string): string; syncPageTitle: string; syncIntro: string;
  viaAccount: string; viaAccountLine: string; viaFolder: string; viaFolderLine: string; folderLabel: string; noFolder: string; folderFirst: string;
  signIn: string; startSync: string; signingTitle: string; signingBody: string; openAgain: string;
  signedIn: string; otherAccount: string; startBody: string; startNotice: string; takenAlert: string; takenBody: string; signOut: string;
  joinTitle: string; joinChoiceLine: string; joinBody: string; joinFolderBody: string; joinPlaceholder: string; joinRecovery: string; joinUseRecovery: string; joinUsePassword: string;
  join: string; joinWrong: string; joinWrongRecovery: string; joinEmpty: string;
  lastSynced: string; lastSyncedLine(ago: string): string; notYet: string; ago(minutes: number): string; syncNow: string; storage: string; storageLine(used: number, pool: number | null): string;
  computers: string; thisComputer: string; otherComputer: string; turnOff: string; moveToAccount: string;
  turnOffTitle: string; turnOffBody: string; removeCopies(origin: string): string; signOutToo: string; turnOffYes: string;
  moveTitle: string; moveBody: string; moveYes: string;
  lyraCanUse: string; appsTitle: string; lastRead(ago: string): string; notReadYet: string; stop(app: string): string; keyInfo: string; noApps: string;
  keyTitle(app: string): string; keyBody(app: string): string; keyApp: string;
  problemPlan: string; problemSignIn: string; problemFull: string; problemOther: string; quantumMissing: string; signInFailed: string; signInTimeout: string;
};
const bytes = (value: number, comma: boolean) => {
  const n = Number(value) || 0, [size, unit] = n >= 1e9 ? [n / 1e9, "GB"] : n >= 1e6 ? [n / 1e6, "MB"] : n >= 1e3 ? [n / 1e3, "KB"] : [n, "B"];
  const text = unit === "B" ? String(Math.round(size)) : size >= 100 ? String(Math.round(size)) : size.toFixed(1).replace(/\.0$/, "");
  return `${comma ? text.replace(".", ",") : text} ${unit}`;
};
const minutes = (value: number) => Math.max(0, Math.floor(Number(value) || 0));
export const enSync: SyncDictionary = {
  setUp: "Set up", manage: "Manage", syncOn: origin => origin === "folder" ? "On, folder" : "On, Cosmic account", syncPageTitle: "Sync",
  syncIntro: "Entries leave this computer encrypted with the vault's own key. Neither Cosmic nor any service that syncs the folder can read them.",
  viaAccount: "Cosmic account", viaAccountLine: "Sign in once; every computer signed in to the same account shares this vault. Needs a Cosmic plan that includes Vault sync.",
  viaFolder: "Folder", viaFolderLine: "A folder on this computer, or one kept in step by a sync service of choice. Vault writes only its own encrypted files there.",
  folderLabel: "Folder", noFolder: "No folder chosen", folderFirst: "Choose a folder first.",
  signIn: "Sign in", startSync: "Start sync", signingTitle: "Continue in the browser", signingBody: "The Cosmic sign-in page opened in the browser. Vault continues here once the sign-in is done.", openAgain: "Open the page again",
  signedIn: "Signed in", otherAccount: "Use another account",
  startBody: "This account has no vault yet. Starting sync puts this vault in it; other computers join it from their welcome screen with the same master password.",
  startNotice: "The master password and the recovery kit stay with you. Cosmic cannot reset them.",
  takenAlert: "This account already holds a vault from another computer, and it is not this one. Two vaults cannot share one account.",
  takenBody: "This vault stays on this computer unchanged. To move to the account's vault instead, first save an encrypted backup of this vault and check that it restores; then join the account's vault and import the backup into it.",
  signOut: "Sign out",
  joinTitle: "Join a synced vault", joinChoiceLine: "Use the vault another computer already syncs, through the Cosmic account or a folder.",
  joinBody: "This account holds a vault from another computer. Its master password opens it here.", joinFolderBody: "The master password of the vault in this folder opens it here.",
  joinPlaceholder: "The master password of that vault", joinRecovery: "Recovery key", joinUseRecovery: "Use the recovery key instead", joinUsePassword: "Use the master password instead",
  join: "Join", joinWrong: "That is not the master password of that vault.", joinWrongRecovery: "That recovery key does not open that vault.",
  joinEmpty: "This account holds no vault yet. Start sync on the computer that has the entries, then join from here.",
  lastSynced: "Last synced", lastSyncedLine: ago => `${ago}. Changes go out within seconds while Vault is unlocked.`, notYet: "Not yet",
  ago: value => { const m = minutes(value); return m < 1 ? "Just now" : m < 60 ? `${m} minute${m === 1 ? "" : "s"} ago` : m < 1440 ? `${Math.floor(m / 60)} hour${Math.floor(m / 60) === 1 ? "" : "s"} ago` : `${Math.floor(m / 1440)} day${Math.floor(m / 1440) === 1 ? "" : "s"} ago`; },
  syncNow: "Sync now", storage: "Storage",
  storageLine: (used, pool) => pool ? `${bytes(used, false)} of the account's ${bytes(pool, false)}, shared with the other Cosmic apps.` : `${bytes(used, false)} used.`,
  computers: "Computers", thisComputer: "This computer", otherComputer: "Another computer", turnOff: "Turn off sync", moveToAccount: "Move to Cosmic account",
  turnOffTitle: "Turn off sync on this computer?", turnOffBody: "The entries stay here. Other computers keep syncing without this one.",
  removeCopies: origin => origin === "folder" ? "Also remove this computer's encrypted copies from the folder" : "Also remove this computer's encrypted copies from the account",
  signOutToo: "Sign out of the Cosmic account on this computer", turnOffYes: "Turn off",
  moveTitle: "Move sync to the Cosmic account?", moveBody: "This computer stops using the folder and syncs through the Cosmic account instead. The folder's files are kept. Each other computer moves the same way.", moveYes: "Sign in and move",
  lyraCanUse: "Lyra can use this key", appsTitle: "Apps that can use it",
  lastRead: ago => `Last read ${ago === "Just now" ? "just now" : ago}`, notReadYet: "Not read yet", stop: app => `Stop ${app}`, noApps: "No app can use this key.",
  keyInfo: "An app reads the key for each request; a change here applies to its next request.",
  keyTitle: app => `${app} wants to use an API key`, keyApp: "Key",
  keyBody: app => `${app} uses this key where it was chosen in ${app}. It reads the key for each request and keeps no copy; stopping it here takes effect on its next request.`,
  problemPlan: "This Cosmic account does not include Vault sync. Changes stay on this computer and go out once the account includes it.",
  problemSignIn: "The Cosmic sign-in expired. Changes stay on this computer until it signs in again.", problemFull: "The Cosmic account's storage is full.",
  problemOther: "The last sync did not finish. Vault tries again on its own.", quantumMissing: "Cosmic accounts are not available on this computer yet.",
  signInFailed: "The sign-in did not finish. It can be tried again.", signInTimeout: "The sign-in took too long. Open the page again to retry.",
};
export const esSync: SyncDictionary = {
  setUp: "Configurar", manage: "Administrar", syncOn: origin => origin === "folder" ? "Activa, carpeta" : "Activa, cuenta Cosmic", syncPageTitle: "Sincronización",
  syncIntro: "Las entradas salen de esta computadora cifradas con la clave propia de la bóveda. Ni Cosmic ni ningún servicio que sincronice la carpeta pueden leerlas.",
  viaAccount: "Cuenta Cosmic", viaAccountLine: "Se inicia sesión una vez; cada computadora con la misma cuenta comparte esta bóveda. Requiere un plan de Cosmic que incluya la sincronización de Vault.",
  viaFolder: "Carpeta", viaFolderLine: "Una carpeta de esta computadora, o una que mantiene al día un servicio de sincronización a elección. Vault solo escribe en ella sus propios archivos cifrados.",
  folderLabel: "Carpeta", noFolder: "Ninguna carpeta elegida", folderFirst: "Primero, elegir una carpeta.",
  signIn: "Iniciar sesión", startSync: "Iniciar la sincronización", signingTitle: "Continuar en el navegador",
  signingBody: "La página de inicio de sesión de Cosmic se abrió en el navegador. Vault continúa en esta ventana cuando termina el inicio de sesión.", openAgain: "Abrir la página otra vez",
  signedIn: "Sesión iniciada", otherAccount: "Usar otra cuenta",
  startBody: "Esta cuenta todavía no tiene una bóveda. Al iniciar la sincronización, esta bóveda pasa a la cuenta; las demás computadoras se unen desde su pantalla de bienvenida con la misma contraseña maestra.",
  startNotice: "La contraseña maestra y el kit de recuperación quedan a cargo de cada persona. Cosmic no puede restablecerlos.",
  takenAlert: "Esta cuenta ya tiene una bóveda de otra computadora, y no es esta. Dos bóvedas no pueden compartir una cuenta.",
  takenBody: "Esta bóveda queda en esta computadora sin cambios. Para pasar a la bóveda de la cuenta, primero se guarda una copia cifrada de esta bóveda y se comprueba que se restaura; después se une la bóveda de la cuenta y se importa la copia en ella.",
  signOut: "Cerrar sesión",
  joinTitle: "Unirse a una bóveda sincronizada", joinChoiceLine: "Usar la bóveda que otra computadora ya sincroniza, mediante la cuenta Cosmic o una carpeta.",
  joinBody: "Esta cuenta tiene una bóveda de otra computadora. Su contraseña maestra la abre en esta computadora.", joinFolderBody: "La contraseña maestra de la bóveda de esta carpeta la abre en esta computadora.",
  joinPlaceholder: "La contraseña maestra de esa bóveda", joinRecovery: "Clave de recuperación", joinUseRecovery: "Usar la clave de recuperación", joinUsePassword: "Usar la contraseña maestra",
  join: "Unirse", joinWrong: "No es la contraseña maestra de esa bóveda.", joinWrongRecovery: "Esa clave de recuperación no abre esa bóveda.",
  joinEmpty: "Esta cuenta todavía no tiene una bóveda. Se inicia la sincronización en la computadora que tiene las entradas y después se une esta.",
  lastSynced: "Última sincronización", lastSyncedLine: ago => `${ago}. Los cambios salen en segundos mientras Vault está desbloqueado.`, notYet: "Todavía no",
  ago: value => { const m = minutes(value); return m < 1 ? "Hace un momento" : m < 60 ? `Hace ${m} minuto${m === 1 ? "" : "s"}` : m < 1440 ? `Hace ${Math.floor(m / 60)} hora${Math.floor(m / 60) === 1 ? "" : "s"}` : `Hace ${Math.floor(m / 1440)} día${Math.floor(m / 1440) === 1 ? "" : "s"}`; },
  syncNow: "Sincronizar ahora", storage: "Almacenamiento",
  storageLine: (used, pool) => pool ? `${bytes(used, true)} de los ${bytes(pool, true)} de la cuenta, compartidos con las demás apps de Cosmic.` : `${bytes(used, true)} en uso.`,
  computers: "Computadoras", thisComputer: "Esta computadora", otherComputer: "Otra computadora", turnOff: "Desactivar la sincronización", moveToAccount: "Pasar a la cuenta Cosmic",
  turnOffTitle: "¿Desactivar la sincronización en esta computadora?", turnOffBody: "Las entradas quedan en esta computadora. Las demás siguen sincronizando sin ella.",
  removeCopies: origin => origin === "folder" ? "Quitar también las copias cifradas de esta computadora de la carpeta" : "Quitar también las copias cifradas de esta computadora de la cuenta",
  signOutToo: "Cerrar la sesión de la cuenta Cosmic en esta computadora", turnOffYes: "Desactivar",
  moveTitle: "¿Pasar la sincronización a la cuenta Cosmic?", moveBody: "Esta computadora deja de usar la carpeta y sincroniza mediante la cuenta Cosmic. Los archivos de la carpeta se conservan. Cada una de las demás computadoras se pasa de la misma forma.", moveYes: "Iniciar sesión y pasar",
  lyraCanUse: "Lyra puede usar esta clave", appsTitle: "Apps que pueden usarla",
  lastRead: ago => `Última lectura: ${String(ago).toLowerCase()}`, notReadYet: "Todavía no se leyó", stop: app => `Detener ${app}`, noApps: "Ninguna app puede usar esta clave.",
  keyInfo: "Una app lee la clave en cada pedido; un cambio aquí se aplica a su próximo pedido.",
  keyTitle: app => `${app} quiere usar una clave de API`, keyApp: "Clave",
  keyBody: app => `${app} usa esta clave donde se eligió en ${app}. La lee en cada pedido y no guarda copia; detenerla aquí tiene efecto en su próximo pedido.`,
  problemPlan: "Esta cuenta Cosmic no incluye la sincronización de Vault. Los cambios quedan en esta computadora y salen cuando la cuenta la incluya.",
  problemSignIn: "La sesión de Cosmic venció. Los cambios quedan en esta computadora hasta que se inicie sesión otra vez.", problemFull: "El almacenamiento de la cuenta Cosmic está lleno.",
  problemOther: "La última sincronización no terminó. Vault vuelve a intentarlo por su cuenta.", quantumMissing: "Las cuentas Cosmic todavía no están disponibles en esta computadora.",
  signInFailed: "El inicio de sesión no terminó. Se puede intentar de nuevo.", signInTimeout: "El inicio de sesión tardó demasiado. Abrir la página otra vez para reintentar.",
};
