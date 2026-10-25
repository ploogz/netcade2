# Netcade

Plug-and-play online N64 and GameCube: lobbies, chat, controller mapping and one-click netplay.

Install Netcade, point it at your games, play. The emulators are **built into the installer**, so there is nothing else to download or configure. Under the hood, two mature open-source emulators run natively with full GPU access:

| System | Emulator | Online play |
|---|---|---|
| GameCube | Dolphin 2609a (built in) | Dolphin's own netplay (traversal + UPnP), auto-connected by Netcade |
| N64 | RetroArch 1.22.2 + Mupen64Plus-Next core (built in) | RetroArch netplay, started with one click; direct P2P or relay fallback |

Everyone on the same Netcade release has identical emulator builds, which is exactly what netplay needs.

A small lobby server (included) handles lobbies, chat, matchmaking and a relay for players behind strict routers.

> **Bring your own games.** Netcade never uploads, downloads or shares game files. Every player points Netcade at their own legally obtained copies, and the lobby checks that everyone has the exact same version before a match starts.

---

## Features

**Library**
- Scans your folders for `.z64 .n64 .v64` (N64) and `.iso .gcm .rvz .wia .ciso .gcz` (GameCube)
- Identifies games by content: N64 ROMs hash the same in any byte order; GameCube discs are identified by game ID + revision without decompressing
- Search, filters, favorites, recently played, play solo with one click
- Reads `.zip` and `.7z` files directly: drop them in your game folder as downloaded. Netcade looks inside, identifies each game (same fingerprint as the unpacked file, so lobby matching works) and unpacks it to a cache only when you play or host. The cache size is set under Settings → Zipped games (20 GB by default; least recently played games are removed first)
- Rename games and change their cover: click **⋯** on a card or right-click it. Pick an image file, paste an image address, or go back to the automatic cover
- **Get the game** links: Netcade reads the "where from" note your browser left on the downloaded file (Windows Mark of the Web, macOS "Where from", Linux `user.xdg` attributes) and suggests it as the link for that game. You confirm it when hosting; friends without the game see a **Get the game** button in the lobby. Links are remembered per game and can be changed in the edit dialog or the lobby's match settings

**Lobbies**
- 6-letter lobby codes, invite links (`netcade://join/CODE`), optional passwords, public lobby browser
- Automatic "do you have this game?" check with plain-English explanations ("you have Rev 0, lobby needs Rev 2")
- Ready checks, controller-port ordering, kick, host migration, live ping bars
- Emulator version mismatch warnings
- Chat, desktop notifications for joins, chat and match start
- Input delay: automatic from measured ping, or set manually

**Spectators and seat swaps**
- Lobbies hold up to 8 people: up to 4 on controller ports, everyone else watches the match live (watchers need the same game)
- Ask for a port; whoever holds it gets a prompt and accepts or declines. Free ports are taken instantly; the host can move anyone
- N64: swaps happen live mid-game (RetroArch switches people between playing and watching). GameCube: the new layout applies when the host restarts the game from Dolphin's NetPlay window
- People can join a running N64 match and start watching straight away

**In-game overlay**
- Always on screen during a match: who's on each controller port (with ping) and who's watching
- 4:3 games on a widescreen monitor leave black bars on each side; the player list and chat live in the left bar and requests/tournament info in the right, so nothing covers the game. With the widescreen hack (or Settings → "Always in the corners") it moves to compact corners
- Chat, the player list and swap requests float over the game. Press the chat key (Tab by default, changeable in Settings) or click 💬 to type; Enter sends and hands the keyboard back to the game
- Swap requests pop up in the corner with clickable buttons that don't take focus from the game
- Emulators run in borderless fullscreen so the overlay can draw on top; controllers keep working while you type

**Tournaments**
- Single-elimination brackets for 2 to 8 people, random or lobby-order seeding, byes handled automatically
- One game or best of 3 / 5 per match. The host lines up each match (its two players go on P1/P2, everyone else watches); either player or the host reports the winner, and the host can undo

**Box art**
- Covers from the libretro-thumbnails collection, matched by file name (No-Intro / Redump) or by title and region, cached on your PC

**Controls (also available inside every lobby)**
- Keyboard or controller profile per system
- Press-to-bind for keys, buttons and stick directions; conflict detection; live highlight as you press
- Written straight into Dolphin's `GCPadNew.ini` and RetroArch's config/remap files on each launch
- GameCube: pick which controller Dolphin uses (Xbox, PlayStation, Switch Pro, 8BitDo and others are listed by name), or a **GameCube controller adapter** for real GameCube controllers (Nintendo or Mayflash in Wii U mode; Windows needs the WinUSB driver once, see Dolphin's adapter guide)
- Changed your controls inside Dolphin instead? When Dolphin closes, Netcade notices and asks whether to keep them. Kept controls are used exactly as Dolphin saved them until you change something on the Controls page

**Networking**
- N64: host opens a port (UPnP); the server tests whether guests can reach it directly and otherwise routes through a WebSocket relay. Players in the same household are sent to the host's LAN address.
- GameCube: by default every guest connects **through Netcade**. Each Dolphin only talks to Netcade on its own PC, and Netcade carries the packets over the lobby server, so it works on any network with no port forwarding or firewall changes (and the host's IP address is never shown to guests). Hosts can switch to Dolphin's traversal server or a forwarded port under Settings → Netplay → GameCube connection. Netcade points Dolphin's session index at the lobby server, so guests are connected the moment the host starts hosting.
- Everyone uses the host's N64 renderer so games stay in sync.

**Quality of life**
- Graphics presets (Performance / Balanced / Quality), resolution scale, Vulkan / D3D12 / Metal, widescreen hack, fullscreen, V-Sync, FPS counter
- Async shader compilation for Dolphin (no stutter)
- Dolphin, RetroArch, the N64 core and 500+ controller profiles built in; optional switch to your own installs
- Netcade uses its own Dolphin user folder and a layered RetroArch config, so your normal emulator settings and saves are untouched
- Emulator shortcuts in N64 games need Right Ctrl held, so game keys never trigger them
- Run the lobby server inside the launcher ("Run server on this PC") for LAN parties
- Logs for every launch (Settings → Troubleshooting)

---

## For players

1. Install Netcade from this repo's Releases page:
   - **Windows:** `Netcade-x.y.z-win-x64.exe`
   - **macOS:** the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel)
   - **Linux:** the `.deb` (the `.AppImage` also works if your system has FUSE)
2. **Add game folder** in the Library.
3. Host a game from its card, share the code, and press **Start match** once everyone is ready.

That's it. Dolphin, RetroArch, the N64 core and controller profiles come inside installers built by GitHub Actions. A smaller installer built without them (plain `electron-builder --win`) downloads them automatically on first launch with a progress bar: about 290 MB, one time only. If the release was built with your group's server address (see below), online play works immediately; otherwise paste the address once under **Settings → Online**, or choose **Run server on this PC** for a LAN party.

Players who prefer their own Dolphin/RetroArch installs can switch under **Settings → Emulators**, but everyone in a lobby then has to match versions by hand.

**What happens when the match starts**
- **N64:** RetroArch opens on every PC and connects by itself.
- **GameCube (Netcade's Dolphin build):** nothing to click. The host's Dolphin opens the session, every guest's Dolphin joins it, and once everyone is in, Netcade puts players on the lobby's controller ports and starts the game. The match card in the lobby shows who's connected, each player's game check and ping, a live buffer control, and **Open Dolphin's NetPlay window** for anything else. Every option from that window (network mode, save data, AR/Gecko codes, strict sync, input recording, Wii saves, golf overlay, remote GBAs) is also under **Match settings → Dolphin NetPlay options**. See `dolphin-netcade/` for how the build is made.
- **GameCube (official Dolphin, or "Use my own Dolphin"):** Dolphin opens on the host's PC with everything pre-filled. The host opens **Tools → Start NetPlay Session → Host** (leave Connection Type as Netcade set it) and double-clicks the game. Guests' Dolphin then opens by itself; they open **Tools → Start NetPlay Session → Connect** and click Connect. The host then presses Start in Dolphin's NetPlay window.

Everyone in a lobby must use the **same Dolphin or RetroArch version**. The lobby shows each player's version.

---

## Run your own server

Pick whichever fits. All are free.

### 1. Built into Netcade (easiest, no account)
Click **Host** on any game. If you have no server yet, Netcade starts one on your PC and turns on
**internet sharing**, which gets a free address from Cloudflare (`https://<words>.trycloudflare.com`,
no account or router setup). Your lobby invite includes that address, so friends just paste the
invite into **Play online → Join a friend** and they're connected.
- Your PC must stay on while friends play.
- The address changes each time Netcade restarts; new invites always carry the current one.
- Toggle it under **Settings → Online → Run server on this PC**.
- Same-house friends connect directly over your home network; internet friends' N64 traffic goes through the relay.

### 2. Render (always on, free plan)
1. Put this project on GitHub (any way you like).
2. On [render.com](https://render.com): **New → Blueprint →** choose the repo. `render.yaml` sets everything up.
3. Use the address Render gives you (`https://netcade-server-xxxx.onrender.com`) in **Settings → Online → Use a server**, or bake it into installers with the `NETCADE_SERVER_URL` repository variable.

Free Render services sleep after 15 minutes without traffic and take about a minute to wake when someone connects; an active lobby keeps it awake.

### 3. Any computer that stays on
```bash
cd server && npm install && PORT=8080 node server.js
```
or with Docker: `docker build -t netcade-server server/ && docker run -d -p 8080:8080 netcade-server`.
Behind a reverse proxy (Caddy, nginx, Cloudflare), set `TRUST_PROXY=1`.

---

## Building from GitHub

1. Create a GitHub repository and push this folder to it.
2. Every push runs the tests (`.github/workflows/build.yml`).
3. Optional but recommended: add a repository variable **`NETCADE_SERVER_URL`** (repo → Settings → Secrets and variables → Actions → Variables) with your server address, e.g. `https://my-netcade.fly.dev`. Installers built afterwards have it pre-filled, so players never type it.
4. To make installers, tag a version:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
   GitHub Actions downloads the pinned emulator builds for each OS (`launcher/emulators.json`), packs them into the Windows installer, macOS `.dmg` files (Intel and Apple Silicon) and Linux `.deb` / `.AppImage`, then attaches them to a **draft** release. Publish the draft when you're happy. The server Docker image is pushed to GitHub Packages at the same time.
5. Installed copies check that Releases page for updates automatically.

### What's inside the installer

`scripts/fetch-emulators.js` assembles `vendor/<os>-<arch>/` from official sources listed in `launcher/emulators.json`:

| Component | Windows | macOS | Linux |
|---|---|---|---|
| Dolphin 2609a | official `.7z` | official universal `.dmg` | community AppImage of the same release ([pkgforge-dev/Dolphin-emu-AppImage](https://github.com/pkgforge-dev/Dolphin-emu-AppImage)), since Dolphin publishes no standalone Linux build |
| RetroArch 1.22.2 | official stable `.7z` (menu artwork and shaders removed) | official `RetroArch_Metal.dmg` | official stable AppImage |
| Mupen64Plus-Next | libretro buildbot | libretro buildbot (per architecture) | libretro buildbot |
| Controller profiles | retroarch-joypad-autoconfig | same | same |
| VC++ runtime | installed silently if missing (Dolphin needs it) | — | — |

AppImages are unpacked at build time, so players don't need FUSE. The N64 core build is identified by hash and shown next to each player's RetroArch version in lobbies, so a mismatch is visible.

**Upgrading emulators:** edit the versions/URLs in `launcher/emulators.json` and tag a new release. Netplay requires everyone to be on the same Netcade release, so tell your group to update together.

**Building locally:** `cd launcher && npm run dist` fetches the emulators for your OS (cached between runs) and builds the installer. macOS bundles must be built on a Mac, Linux bundles on Linux.

### Developing locally
```bash
cd launcher
npm install
npm start          # runs the app
npm test           # unit tests

cd ../server
npm install
npm test           # lobby, Dolphin index and relay tests
```

### Code signing
Builds are unsigned by default, so Windows SmartScreen and macOS Gatekeeper will warn on first launch ("More info → Run anyway" / right-click → Open). To sign, add the certificate secrets that [electron-builder documents](https://www.electron.build/code-signing) remove `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` from the workflow, and replace the Mac `"identity": "-"` (ad-hoc signing, which Apple Silicon requires at minimum) with your Developer ID. On macOS 15+, unsigned apps are opened via System Settings → Privacy & Security → **Open Anyway**.

---

## Project layout

```
server/                 lobby server (Node + ws)
  server.js             lobbies, chat, Dolphin session index (/dolphin/v0/*), relay (/relay)
  test/                 integration tests
launcher/               Electron desktop app
  main.js               settings, library, lobby connection, emulator sessions
  preload.js            the only bridge between UI and system
  lib/romInfo.js        N64 / GameCube identification and matching
  lib/inputMaps.js      control mapping -> Dolphin and RetroArch formats
  lib/dolphin.js        Dolphin config + launch
  lib/retroarch.js      RetroArch config + launch
  lib/tunnel.js         TCP and UDP <-> WebSocket relay
  lib/dolphinControl.js control link to Netcade's Dolphin build
  renderer/             UI (no framework)
  test/                 unit tests
dolphin-netcade/        patch + build scripts for Netcade's Dolphin build (Windows)
.github/workflows/      CI and release builds (dolphin-netcade.yml builds the Dolphin above)
```

## Troubleshooting

- **"You don't have the exact game"**: the lobby needs the same region and revision. The message tells you which one; add that file to a game folder and click Rescan.
- **Desyncs in N64 games**: make sure everyone is on the same Netcade release (the lobby flags differing RetroArch/core versions); the host's renderer is used automatically.
- **Mac: N64 renderer**: macOS has no native Vulkan, so Netcade defaults Macs to the GLideN64 renderer. If a Mac player joins a lobby whose host uses ParaLLEl-RDP and N64 fails to start, ask the host to switch to GLideN64 in Settings → Graphics.
- **Windows asks for permission during install**: that's the Microsoft Visual C++ runtime Dolphin needs, installed only if your PC doesn't already have a recent one.
- **Guests can't connect to a GameCube host** ("Could not communicate with host"): make sure the host's Settings → Netplay → GameCube connection is "Through Netcade" (the default) and that the host left Connection Type on Direct Connection in Dolphin's Host tab. If the guests' Dolphin doesn't open after the host clicks Host, the host can press "My NetPlay window is open, connect my friends" in the lobby.
- **Controller doesn't respond in a GameCube game**: on Controls → GameCube, pick your controller under "Controller for GameCube games" (press a button on it first so it shows up). If it still doesn't respond, fix it once in Dolphin → Controllers → Port 1, close Dolphin, and choose **Keep my Dolphin controls** when Netcade asks.
- **No "Get the game" suggestion**: the browser's note only survives on the file it downloaded. Unzipping with another tool, copying from a USB stick or some cloud folders drops it; paste the link once in the edit dialog instead. On Linux, reading the note needs `getfattr` or `python3`.
- **Zipped GameCube games take a while to start the first time**: the disc is unpacked to the cache once (about 1.4 GB each); later launches reuse it.
- **Logs**: Settings → Troubleshooting → Open logs (`netcade.log`, `dolphin-last.log`, `retroarch-last.log`).

## License

Netcade's own code is MIT licensed. The installers also contain unmodified copies of Dolphin (GPL-2.0-or-later), RetroArch (GPL-3.0-or-later) and Mupen64Plus-Next (GPL-2.0), which Netcade runs as separate programs. Each install includes `resources/vendor/LICENSES/THIRD_PARTY.md` with the exact versions and links to their complete source code.

If you distribute these installers publicly, the GPL requires that recipients can get the corresponding source. Linking upstream sources (as above) is the common practice; for strict compliance, also keep copies of the exact source archives for each release you publish.

No games, BIOS files or other copyrighted game data are included, and Netcade never transfers them between players. Nintendo 64 and GameCube are trademarks of Nintendo, which is not affiliated with this project.
