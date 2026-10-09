# Installs Vault for the current user. Works in Windows PowerShell 5.1 and PowerShell 7.
#   powershell -ExecutionPolicy Bypass -c "irm https://github.com/TXMSKA/Vault/releases/latest/download/install.ps1 | iex"
# For one version, save this file and run it: .\install.ps1 -Version 0.1.0
# It downloads vault-x64.zip and SHA256SUMS.txt from the GitHub release, stops when the zip does not match its sum, unpacks the zip
# into %LOCALAPPDATA%\Programs\Vault and runs `vault install` from there. It never asks for or handles a password:
# the vault is created afterwards, in the person's own terminal, with `vault create`.
param([string]$Version)

# A script block keeps the strict mode and the error preference out of the session that runs this file.
& {
    param([string]$Version)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'

    if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'Vault needs Windows PowerShell 5.1 or PowerShell 7.' }
    if (-not $env:LOCALAPPDATA -or -not [Environment]::Is64BitOperatingSystem) { throw 'Vault installs on 64-bit Windows only.' }
    if ($Version -and $Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw "'$Version' is not a version such as 0.1.0." }
    $source = if ($Version) { "https://github.com/TXMSKA/Vault/releases/download/v$Version" } else { 'https://github.com/TXMSKA/Vault/releases/latest/download' }
    # Windows PowerShell 5.1 does not offer TLS 1.2 by default, which GitHub requires.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $work = Join-Path ([IO.Path]::GetTempPath()) ('vault-install-' + [Guid]::NewGuid().ToString('N'))
    $destination = Join-Path $env:LOCALAPPDATA 'Programs\Vault'
    $unpacked = "$destination.new"
    $retired = "$destination.old"
    $cli = 'lib\cli\src\main.js'
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $sums = Join-Path $work 'SHA256SUMS.txt'
        $zip = Join-Path $work 'vault-x64.zip'
        Write-Host "Downloading Vault from $source"
        Invoke-WebRequest -UseBasicParsing -Uri "$source/SHA256SUMS.txt" -OutFile $sums
        Invoke-WebRequest -UseBasicParsing -Uri "$source/vault-x64.zip" -OutFile $zip

        $expected = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
            if ($line -match '^([0-9A-Fa-f]{64})\s+\*?vault-x64\.zip\s*$') { $expected = $Matches[1] }
        }
        if (-not $expected) { throw 'SHA256SUMS.txt has no sum for vault-x64.zip.' }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash
        if ($actual -ne $expected) { throw 'vault-x64.zip does not match its SHA-256 sum. Nothing was installed.' }

        # The new copy is unpacked beside the old one first, so a failure here leaves the installed Vault as it was.
        if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $unpacked)

        # A running service holds the old node.exe open. The installed Vault stops it, takes its command off the Path and keeps the vault data.
        if (Test-Path -LiteralPath $destination) {
            $previous = Join-Path $destination 'node.exe'
            $previousCli = Join-Path $destination $cli
            if ((Test-Path -LiteralPath $previous) -and (Test-Path -LiteralPath $previousCli)) {
                & $previous $previousCli uninstall
                if ($LASTEXITCODE -ne 0) { throw 'The installed Vault could not be stopped. Close what uses it and run this again.' }
            }
            # Renaming the folder fails as a whole when something still holds a file in it, which deleting it piece by piece would not.
            if (Test-Path -LiteralPath $retired) { Remove-Item -LiteralPath $retired -Recurse -Force }
            Move-Item -LiteralPath $destination -Destination $retired
        }
        Move-Item -LiteralPath $unpacked -Destination $destination
        if (Test-Path -LiteralPath $retired) { Remove-Item -LiteralPath $retired -Recurse -Force -ErrorAction SilentlyContinue }

        & (Join-Path $destination 'node.exe') (Join-Path $destination $cli) install
        if ($LASTEXITCODE -ne 0) { throw 'vault install did not finish.' }
        Write-Host ''
        Write-Host 'Next, in a new terminal: vault create --kit <file.txt>'
        Write-Host 'It asks for a new master password there and saves your recovery kit in that file. Keep the kit offline.'
    }
    finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $unpacked) { Remove-Item -LiteralPath $unpacked -Recurse -Force -ErrorAction SilentlyContinue }
    }
} -Version $Version
