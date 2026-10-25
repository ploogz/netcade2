# Builds Netcade's Dolphin on your own Windows PC (no GitHub needed).
#
# Needs, once:
#   - Git for Windows                       https://git-scm.com/download/win
#   - Visual Studio 2022 Community (free)   https://visualstudio.microsoft.com/vs/community/
#     with the "Desktop development with C++" workload (includes CMake and Ninja)
#
# Run build-windows.bat (double-click). The result is dolphin-netcade.zip (or .7z) next to this
# script. Send it to whoever builds Netcade installers, or put it in launcher/vendor/.
param(
  [string] $DolphinTag = '2609a',
  [string] $BuildName = '2609a-netcade1',
  [string] $WorkDir = (Join-Path $env:LOCALAPPDATA 'NetcadeDolphinBuild')
)
$ErrorActionPreference = 'Stop'
function Step($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }

Step 'Checking tools'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is not installed. Get it from https://git-scm.com/download/win and run this again.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'Visual Studio is not installed. Install Visual Studio 2022 Community with "Desktop development with C++".' }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio is missing the C++ tools. In the Visual Studio Installer, add "Desktop development with C++".' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'

New-Item -ItemType Directory -Force $WorkDir | Out-Null
$src = Join-Path $WorkDir "dolphin-$DolphinTag"

Step "Downloading Dolphin $DolphinTag and its libraries (about 2 GB, first time only)"
if (-not (Test-Path (Join-Path $src '.git'))) {
  git clone --depth 1 --branch $DolphinTag --recurse-submodules --shallow-submodules https://github.com/dolphin-emu/dolphin.git $src
  if ($LASTEXITCODE -ne 0) { throw 'Downloading Dolphin failed. Check your internet connection and try again.' }
} else {
  git -C $src checkout -- .
  git -C $src clean -fdq Source
  git -C $src submodule update --init --recursive --depth 1
}

Step 'Applying the Netcade patch'
git -C $src apply --whitespace=nowarn (Join-Path $PSScriptRoot 'netcade.patch')
if ($LASTEXITCODE -ne 0) { throw 'The patch does not apply to this Dolphin version.' }

Step 'Building (45-90 minutes the first time; later builds are much faster)'
$cmd = "`"$vcvars`" && cd /d `"$src`" && cmake --preset ninja-release-x64 -DENABLE_AUTOUPDATE=OFF -DENABLE_ANALYTICS=OFF -DUSE_DISCORD_PRESENCE=OFF && cmake --build --preset ninja-build-release-x64"
cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw 'The build failed. Scroll up for the first "error" line.' }

Step 'Packaging'
# vcvars sets VCToolsRedistDir only inside its own shell; find it again for the runtime DLLs
$redist = Get-ChildItem (Join-Path $vs 'VC\Redist\MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if ($redist) { $env:VCToolsRedistDir = $redist.FullName + '\' }
$out = Join-Path $PSScriptRoot 'dolphin-netcade.7z'
& (Join-Path $PSScriptRoot 'package-windows.ps1') -DolphinDir $src -BuildName $BuildName -Out $out

Step 'Done'
Write-Host 'Your Netcade build of Dolphin is next to this script (dolphin-netcade.7z or .zip).' -ForegroundColor Green
