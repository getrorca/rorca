# Rorca installer — Windows (PowerShell)
# Usage: irm https://get.rorca.app/windows | iex
#        $env:RORCA_VERSION="v0.2.0"; irm https://get.rorca.app/windows | iex
$ErrorActionPreference = "Stop"

$Repo = "getrorca/rorca"
$Version = if ($env:RORCA_VERSION) { $env:RORCA_VERSION } else { "latest" }
$Binary = "rorca-windows-x64.exe"

# ── Resolve download URL ──
if ($Version -eq "latest") {
    $Url = "https://github.com/$Repo/releases/latest/download/$Binary"
} else {
    $Url = "https://github.com/$Repo/releases/download/$Version/$Binary"
}

# ── Install directory ──
$InstallDir = Join-Path $env:LOCALAPPDATA "rorca"
$ExePath = Join-Path $InstallDir "rorca.exe"

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# ── Download ──
Write-Host "Installing Rorca (windows/x64)..."
Write-Host "Downloading $Url..."

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $Url -OutFile $ExePath -UseBasicParsing
} catch {
    Write-Host "Error: Download failed. Check your network connection and that the release exists."
    Write-Host "  $_"
    exit 1
}

# ── Add to PATH ──
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("PATH", "$UserPath;$InstallDir", "User")
    $env:PATH = "$env:PATH;$InstallDir"
    Write-Host "Added $InstallDir to user PATH."
}

# ── Verify ──
try {
    $InstalledVersion = & $ExePath --version 2>&1
    Write-Host ""
    Write-Host "Rorca $InstalledVersion installed to $ExePath"
} catch {
    Write-Host ""
    Write-Host "Rorca installed to $ExePath"
}

Write-Host ""
Write-Host "Get started:"
Write-Host "  rorca start"
Write-Host ""
Write-Host "Note: Restart your terminal for PATH changes to take effect."
