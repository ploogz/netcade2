# Packages a finished Windows build of Netcade's Dolphin into one archive Netcade can install.
# Used by .github/workflows/dolphin-netcade.yml and build-windows.ps1.
param(
  [Parameter(Mandatory = $true)] [string] $DolphinDir,
  [Parameter(Mandatory = $true)] [string] $BuildName,
  [Parameter(Mandatory = $true)] [string] $Out
)
$ErrorActionPreference = 'Stop'

$bin = Join-Path $DolphinDir 'build/release/x64/Binaries'
if (-not (Test-Path (Join-Path $bin 'Dolphin.exe'))) { throw "Dolphin.exe not found in $bin. Did the build finish?" }

$stageRoot = Join-Path ([IO.Path]::GetTempPath()) "netcade-dolphin-stage-$PID"
$stage = Join-Path $stageRoot 'Dolphin-x64'
Remove-Item -Recurse -Force $stageRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

# Everything the build produced (exe, Qt libraries and plugins). Sys, licenses and qt.conf are
# links into the source tree, so copy the real files instead.
Get-ChildItem $bin -Force | Where-Object { $_.Name -notin @('Sys', 'Licenses', 'COPYING', 'qt.conf', 'build_info.txt') } |
  ForEach-Object { Copy-Item $_.FullName -Destination $stage -Recurse -Force }
Copy-Item (Join-Path $DolphinDir 'Data/Sys') (Join-Path $stage 'Sys') -Recurse -Force
Copy-Item (Join-Path $DolphinDir 'LICENSES') (Join-Path $stage 'Licenses') -Recurse -Force
Copy-Item (Join-Path $DolphinDir 'COPYING') (Join-Path $stage 'COPYING') -Force
Copy-Item (Join-Path $DolphinDir 'Source/Core/DolphinQt/qt.conf.win') (Join-Path $stage 'qt.conf') -Force

# Visual C++ runtime next to Dolphin.exe, so it runs even without the redistributable installed
if ($env:VCToolsRedistDir) {
  $crt = Get-ChildItem (Join-Path $env:VCToolsRedistDir 'x64') -Directory -Filter 'Microsoft.VC*.CRT' | Select-Object -First 1
  if ($crt) { Copy-Item (Join-Path $crt.FullName '*.dll') $stage -Force }
}

# The marker Netcade looks for, plus the source change (GPL: the modification travels with the build)
$patch = Join-Path $PSScriptRoot 'netcade.patch'
Copy-Item $patch (Join-Path $stage 'netcade.patch') -Force
@"
Netcade build of Dolphin: $BuildName
Control protocol: 1
This is Dolphin with a small patch that lets the Netcade launcher host and join NetPlay sessions.
Source: Dolphin (https://github.com/dolphin-emu/dolphin) plus netcade.patch in this folder. GPL-2.0-or-later.
"@ | Set-Content -Encoding UTF8 (Join-Path $stage 'Netcade.txt')

$Out = [IO.Path]::GetFullPath($Out)
Remove-Item -Force $Out -ErrorAction SilentlyContinue
$sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source
if (-not $sevenZip -and (Test-Path 'C:\Program Files\7-Zip\7z.exe')) { $sevenZip = 'C:\Program Files\7-Zip\7z.exe' }
if ($Out.EndsWith('.7z') -and $sevenZip) {
  & $sevenZip a -t7z -mx=7 $Out $stage | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '7-Zip failed' }
} else {
  if ($Out.EndsWith('.7z')) { $Out = [IO.Path]::ChangeExtension($Out, '.zip') }
  Compress-Archive -Path $stage -DestinationPath $Out -CompressionLevel Optimal
}
Remove-Item -Recurse -Force $stageRoot
Write-Host "Packaged: $Out ($([math]::Round((Get-Item $Out).Length / 1MB)) MB)"
