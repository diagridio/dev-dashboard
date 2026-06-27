# Install dev-dashboard to %LOCALAPPDATA%\Programs\dev-dashboard (no admin).
#   iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
# Env: $env:VERSION = 'vX.Y.Z' (default latest); $env:DRY_RUN = '1'
$ErrorActionPreference = 'Stop'
$repo = 'diagridio/dev-dashboard'
$binDir = Join-Path $env:LOCALAPPDATA 'Programs\dev-dashboard'

# There is no native windows/arm64 build (go-winjob cannot compile for it).
# Windows 11 on ARM runs x64 binaries via built-in emulation, so we always
# download the amd64 archive.  Print an informational note on ARM64 hosts.
$isArm64 = ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')
if ($isArm64) {
    Write-Host "note: no native windows/arm64 build; installing the x64 build (runs via Windows ARM x64 emulation)."
}
$file_arch = 'amd64'

$version = $env:VERSION
if (-not $version) {
    $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
    $version = $rel.tag_name
}
$num = $version.TrimStart('v')
$file = "dev-dashboard_${num}_windows_${file_arch}.zip"
$url = "https://github.com/$repo/releases/download/$version/$file"

if ($env:DRY_RUN -eq '1') { Write-Output $url; exit 0 }

Write-Host "downloading $file ..."
try {
    $tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid()))
    Invoke-WebRequest $url -OutFile (Join-Path $tmp $file)
    Expand-Archive -Path (Join-Path $tmp $file) -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item (Join-Path $tmp 'dev-dashboard.exe') (Join-Path $binDir 'dev-dashboard.exe') -Force
    Write-Host "installed dev-dashboard $version -> $binDir\dev-dashboard.exe"
} finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp }
}

if (($env:PATH -split ';') -notcontains $binDir) {
    Write-Host "note: $binDir is not on your PATH. Add it (user scope):"
    Write-Host "  setx PATH `"$binDir;`$env:PATH`""
}
