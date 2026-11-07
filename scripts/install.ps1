# Rorca user installer — Windows PowerShell
# Usage: irm https://get.rorca.app/windows | iex
#        $env:RORCA_VERSION="v0.2.0"; $env:RORCA_INSTALL_DIR="$HOME\bin"; .\install.ps1
# This installer never elevates, starts providers/editors, or changes services.
$ErrorActionPreference = "Stop"

$Repo = "getrorca/rorca"
$Version = if ($env:RORCA_VERSION) { $env:RORCA_VERSION } else { "latest" }
$InstallDir = if ($env:RORCA_INSTALL_DIR) { $env:RORCA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "rorca" }
$Binary = "rorca-win32-x64.exe"
$Url = if ($Version -eq "latest") {
    "https://github.com/$Repo/releases/latest/download/$Binary"
} else {
    "https://github.com/$Repo/releases/download/$Version/$Binary"
}

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$Destination = Join-Path $InstallDir "rorca.exe"
$Previous = Join-Path $InstallDir "rorca.previous.exe"
$Staged = Join-Path $InstallDir ".rorca.new.$PID.exe"

try {
    Write-Host "Downloading Rorca (windows/x64) from $Url..."
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $Url -OutFile $Staged -UseBasicParsing

    # Verify before replacing the working binary. This starts no provider,
    # editor, database, Task Scheduler task, or background service.
    & $Staged --version *> $null
    if ($LASTEXITCODE -ne 0) { throw "Downloaded artifact failed its version check." }

    if (Test-Path -LiteralPath $Previous) { Remove-Item -LiteralPath $Previous -Force }
    if (Test-Path -LiteralPath $Destination) { Move-Item -LiteralPath $Destination -Destination $Previous }
    try {
        Move-Item -LiteralPath $Staged -Destination $Destination
    } catch {
        if (Test-Path -LiteralPath $Previous) { Move-Item -LiteralPath $Previous -Destination $Destination }
        throw
    }

    $InstalledVersion = & $Destination --version 2>&1
    Write-Host "Rorca $InstalledVersion installed to $Destination"
    if (Test-Path -LiteralPath $Previous) { Write-Host "Previous binary retained at $Previous" }
    Write-Host "No PATH, provider, editor, or service setting was changed."
    Write-Host "Add $InstallDir to your user PATH explicitly if desired, then run 'rorca start'."
} finally {
    if (Test-Path -LiteralPath $Staged) { Remove-Item -LiteralPath $Staged -Force }
}
