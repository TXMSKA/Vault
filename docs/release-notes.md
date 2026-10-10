# Vault {{version}}

## English

### What is in this release

- `Vault-Setup-x64.exe`: the installer for 64-bit Windows. It installs Vault for the current user, with its app and the `vault` command. It asks for no administrator rights.
- `Vault-Setup-x64.exe.blockmap` and `latest.yml`: what the app reads to find and download updates. They are not meant to be opened.
- `vault-x64.zip` and `install.ps1`: the install from a console, without the app.
- `SHA256SUMS.txt`: the SHA-256 sum of each file above.

### Install

With the installer: download `Vault-Setup-x64.exe` and run it.

From a console, without the app, in PowerShell:

```
powershell -ExecutionPolicy Bypass -c "irm https://github.com/TXMSKA/Vault/releases/latest/download/install.ps1 | iex"
```

### Checksums

```
{{checksums}}
```

### Code signing

{{signing_en}}

## Español

### Qué incluye esta versión

- `Vault-Setup-x64.exe`: el instalador para Windows de 64 bits. Instala Vault para el usuario actual, con su app y el comando `vault`. No pide permisos de administrador.
- `Vault-Setup-x64.exe.blockmap` y `latest.yml`: lo que la app lee para encontrar y descargar actualizaciones. No están pensados para abrirse.
- `vault-x64.zip` y `install.ps1`: la instalación desde una consola, sin la app.
- `SHA256SUMS.txt`: la suma SHA-256 de cada archivo anterior.

### Instalación

Con el instalador: descargar `Vault-Setup-x64.exe` y ejecutarlo.

Desde una consola, sin la app, en PowerShell:

```
powershell -ExecutionPolicy Bypass -c "irm https://github.com/TXMSKA/Vault/releases/latest/download/install.ps1 | iex"
```

### Sumas de verificación

```
{{checksums}}
```

### Firma de código

{{signing_es}}
