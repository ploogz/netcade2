# Netcade's Dolphin build

Official Dolphin only starts NetPlay from its own windows, so GameCube matches used to need clicks
in Dolphin (Host / Connect / Assign Controller Ports / Start). This folder holds a small patch that
lets Netcade drive Dolphin's NetPlay instead:

- `--netcade-host <game>` / `--netcade-join <game>`: host or join right away (after the game shows up
  in Dolphin's game list, so everyone is recognised as having it)
- `--netcade-control <port>` (+ `NETCADE_TOKEN` in the environment): a local link to Netcade, one JSON
  object per line. Dolphin reports players, game checks, pings, buffer, options and its NetPlay log;
  Netcade sends `start`, `pads` (controller ports from the lobby), `buffer`, `options`, `show`/`hide`
  (the NetPlay window), `recheck`, `kick`, `chat`
- The NetPlay window stays hidden while the link is up. Every option in it can be set from Netcade,
  and players can open the window itself from the lobby at any time. If Netcade goes away, the window
  appears and the session carries on as normal Dolphin NetPlay.

The patch touches only the Qt front end (`Source/Core/DolphinQt`, plus three command-line options in
`Source/Core/UICommon/CommandLineParse.cpp`). Emulation and the NetPlay protocol are unchanged, so
everyone in a lobby just needs the same build, as with any Dolphin version.

| File | What it is |
|---|---|
| `netcade.patch` | The change, against Dolphin `2609a` (the version in `launcher/emulators.json`) |
| `build-windows.bat` / `.ps1` | Build it on your own Windows PC (Git + free Visual Studio 2022 Community) |
| `package-windows.ps1` | Packs a finished build into `dolphin-netcade.7z` (adds `Netcade.txt`, licences, the patch) |
| `../.github/workflows/dolphin-netcade.yml` | The same build on GitHub's computers: Actions tab → "Build Netcade Dolphin" → Run |

## Getting the build to players

Pick one:

1. **Inside the installer:** copy `dolphin-netcade.7z` (or `.zip`) into `launcher/vendor/` and build
   the installer. New installs use it; existing installs switch to it on their next start (Dolphin
   only, settings and saves are kept).
2. **Download link:** put the link to the file (for example the GitHub Release asset the workflow
   prints) in `launcher/emulators.json` → `dolphin.netcade.win-x64.url`, then build the installer.

Netcade recognises the build by the `Netcade.txt` file next to `Dolphin.exe`. Without it (official
Dolphin, or "Use my own Dolphin" in Settings), Netcade falls back to the step-by-step instructions.

## Updating to a new Dolphin release

Change the tag in `emulators.json`, the workflow inputs and `build-windows.ps1`, then check the patch
still applies (`git apply --check netcade.patch` in a Dolphin checkout of that tag). Fix any conflicts,
regenerate the patch with `git diff`, rebuild, and bump `dolphin.netcade.version`.

## Licence

Dolphin is GPL-2.0-or-later; so is this patch. Each build carries `netcade.patch` and Dolphin's
licences, and the unmodified source is at https://github.com/dolphin-emu/dolphin (tag `2609a`).
