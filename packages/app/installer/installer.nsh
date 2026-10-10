; Vault's additions to the installer and the uninstaller; electron-builder includes this file in both builds.
; Before files are replaced, an installed copy's service is stopped through its own command, so that no file is locked. After the files are
; copied, the installed copy is recorded for the command line, the service and the app. The uninstaller stops the service again. The vault data is
; never touched. Every command runs hidden, with every path quoted. This file is saved as UTF-8 with a byte order mark, which NSIS needs for the accents.
;
; Replacing customCheckAppRunning also drops the process helpers electron-builder includes only without it, so they are included here.
!include "getProcessInfo.nsh"
Var pid

!macro customHeader
  LangString vaultCannotStop ${LANG_ENGLISH} "Vault could not be stopped. Close anything that uses it and run the installer again."
  LangString vaultCannotStop ${LANG_SPANISHINTERNATIONAL} "No se pudo detener Vault. Cerrar lo que lo usa y ejecutar el instalador de nuevo."
  LangString vaultCannotLink ${LANG_ENGLISH} "The installation did not finish: Vault could not be linked to its command line, its service and its app. Run the installer again."
  LangString vaultCannotLink ${LANG_SPANISHINTERNATIONAL} "La instalación no terminó: no se pudo enlazar Vault con su línea de comandos, su servicio y su app. Ejecutar el instalador de nuevo."
  LangString vaultCannotUninstall ${LANG_ENGLISH} "Vault could not be stopped, so it was not removed. Close anything that uses it and run the uninstaller again."
  LangString vaultCannotUninstall ${LANG_SPANISHINTERNATIONAL} "No se pudo detener Vault, por lo que no se quitó. Cerrar lo que lo usa y ejecutar el desinstalador de nuevo."
  ; electron-builder's own Spanish for these messages speaks to the person in the second person. These definitions come after its own, and NSIS keeps the last
  ; one; it warns about the second definition (6030), and electron-builder turns warnings into errors, so that one warning is off for these lines only.
  !pragma warning disable 6030
  LangString appRunning ${LANG_SPANISHINTERNATIONAL} "${PRODUCT_NAME} está abierto.$\r$\nSeleccionar Aceptar para cerrarlo.$\r$\nSi no se cierra, cerrarlo manualmente."
  LangString appCannotBeClosed ${LANG_SPANISHINTERNATIONAL} "No se puede cerrar ${PRODUCT_NAME}.$\r$\nCerrarlo manualmente y seleccionar Reintentar para continuar."
  LangString appClosing ${LANG_SPANISHINTERNATIONAL} "Cerrando ${PRODUCT_NAME}..."
  LangString decompressionFailed ${LANG_SPANISHINTERNATIONAL} "No se pudieron descomprimir los archivos. Ejecutar el instalador de nuevo."
  LangString uninstallFailed ${LANG_SPANISHINTERNATIONAL} "No se pudieron desinstalar los archivos de la versión anterior. Ejecutar el instalador de nuevo."
  !pragma warning enable 6030
!macroend

; vault uninstall: ends the service, takes the launcher off the Path and forgets the installation, and keeps the vault data.
!macro vaultStopService
  ${if} ${FileExists} "$INSTDIR\node.exe"
  ${andIf} ${FileExists} "$INSTDIR\lib\cli\src\main.js"
    nsExec::ExecToStack '"$INSTDIR\node.exe" "$INSTDIR\lib\cli\src\main.js" uninstall'
    Pop $0
    Pop $1
    ${if} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "$(vaultCannotStop)" /SD IDOK
      SetErrorLevel 2
      Abort
    ${endIf}
  ${endIf}
!macroend

; The default check closes a running Vault first, so that cancelling its question leaves everything as it was. The service is stopped after it.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro vaultStopService
  !endif
!macroend

; After the files are copied: vault install --app records this folder's node.exe, service, helper and Vault.exe.
!macro customInstall
  nsExec::ExecToStack '"$INSTDIR\node.exe" "$INSTDIR\lib\cli\src\main.js" install --app "$INSTDIR\Vault.exe"'
  Pop $0
  Pop $1
  ${if} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "$(vaultCannotLink)" /SD IDOK
    SetErrorLevel 2
    Abort
  ${endIf}
!macroend

!macro customUnInstall
  ${if} ${FileExists} "$INSTDIR\node.exe"
  ${andIf} ${FileExists} "$INSTDIR\lib\cli\src\main.js"
    nsExec::ExecToStack '"$INSTDIR\node.exe" "$INSTDIR\lib\cli\src\main.js" uninstall'
    Pop $0
    Pop $1
    ${if} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "$(vaultCannotUninstall)" /SD IDOK
      SetErrorLevel 2
      Abort
    ${endIf}
  ${endIf}
!macroend
