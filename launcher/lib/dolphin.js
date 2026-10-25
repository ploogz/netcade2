'use strict';
/**
 * Dolphin integration.
 *
 * Netcade runs Dolphin with its own user folder (-u) so it never disturbs the player's normal
 * Dolphin setup. Before each launch it writes:
 *   - Config/Dolphin.ini : game folders, graphics backend, fullscreen, and the [NetPlay] section
 *   - Config/GFX.ini     : resolution, widescreen hack, async shaders, vsync
 *   - Config/GCPadNew.ini: the player's controls (from the lobby's Controls panel)
 *
 * Online play uses Dolphin's own netplay (traversal + UPnP for NAT). The [NetPlay] IndexServer is
 * pointed at the Netcade server and the session name is the lobby code, so the moment the host
 * presses "Host" in Dolphin, every guest's launcher receives the host code automatically.
 */
const fs = require('fs');
const path = require('path');
const ini = require('./ini');
const { dolphinGCPad, resolve } = require('./inputMaps');

const BACKENDS = {
  auto: { win32: 'D3D12', darwin: 'Metal', linux: 'Vulkan' },
  vulkan: 'Vulkan', d3d12: 'D3D12', metal: 'Metal', opengl: 'OGL',
};

function backendFor(setting, platform) {
  if (!setting || setting === 'auto') return BACKENDS.auto[platform] || 'Vulkan';
  return BACKENDS[setting] || 'Vulkan';
}

/**
 * Put the hosted game alone in a folder so it is the only entry in Dolphin's "Host" list.
 * Uses a hard link (no copy, no admin rights) and falls back to the game's own folder.
 */
function soloFolderFor(gamePath, sessionDir) {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    const linkPath = path.join(sessionDir, path.basename(gamePath));
    try {
      fs.linkSync(gamePath, linkPath);
      return { folder: sessionDir, recursive: false, exclusive: true };
    } catch {
      fs.symlinkSync(gamePath, linkPath);
      return { folder: sessionDir, recursive: false, exclusive: true };
    }
  } catch {
    return { folder: path.dirname(gamePath), recursive: false, exclusive: false };
  }
}

/**
 * Write all Dolphin config for a launch.
 * opts: { userDir, mode: 'solo'|'host'|'guest', platform, settings, game, romFolders,
 *         lobbyCode, indexUrl, nickname, inputDelay, hostCode, method, port, gcConnection }
 */
function prepare(opts) {
  const { userDir, mode, platform, settings } = opts;
  const cfgDir = path.join(userDir, 'Config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const g = settings.graphics || {};

  // ----- game folders
  let folders = (opts.romFolders || []).slice();
  let recursive = true;
  let exclusive = false;
  if (mode === 'host' && opts.game) {
    const solo = soloFolderFor(opts.game.path, path.join(userDir, 'NetcadeSession'));
    folders = [solo.folder];
    recursive = solo.recursive;
    exclusive = solo.exclusive;
  }
  const general = { ISOPaths: folders.length, RecursiveISOPaths: recursive ? 'True' : 'False' };
  for (let i = 0; i < 32; i++) general[`ISOPath${i}`] = i < folders.length ? folders[i] : null;

  // ----- netplay
  const np = netplayOptions(settings);
  const netplay = {
    Nickname: (opts.nickname || 'Player').replace(/[\r\n]/g, ' '),
    UseUPNP: 'True',
    // the NetPlay window's options (Data / Network / Other menus), set from Netcade
    SyncSaves: np.savedata !== 'none' ? 'True' : 'False',
    WriteSaveData: np.savedata === 'write' ? 'True' : 'False',
    SyncAllWiiSaves: np.syncAllWii ? 'True' : 'False',
    SyncCodes: np.syncCodes ? 'True' : 'False',
    StrictSettingsSync: np.strictSync ? 'True' : 'False',
    RecordInputs: np.recordInputs ? 'True' : 'False',
    GolfModeOverlay: np.golfOverlay ? 'True' : 'False',
    HideRemoteGBAs: np.hideRemoteGbas ? 'True' : 'False',
    NetworkMode: np.networkMode,
    BufferSize: Math.max(1, Math.min(20, (opts.inputDelay | 0) || 4)),
    TraversalServer: 'stun.dolphin-emu.org',
    TraversalPort: 6262,
  };
  if (mode === 'host') {
    // relay: Dolphin hosts on a plain local port and Netcade carries guests' packets to it, so
    // nothing needs to get through the router (and UPnP would only slow hosting down)
    const conn = opts.gcConnection || 'traversal';
    if (conn === 'relay') netplay.UseUPNP = 'False';
    Object.assign(netplay, {
      TraversalChoice: conn === 'traversal' ? 'traversal' : 'direct',
      UseIndex: 'True',
      IndexName: opts.lobbyCode,
      IndexRegion: 'NA',
      IndexPassword: '',
      IndexServer: opts.indexUrl,
      HostPort: settings.netplay?.dolphinPort || 2626,
    });
  } else if (mode === 'guest') {
    const direct = opts.method === 'direct';
    Object.assign(netplay, {
      TraversalChoice: direct ? 'direct' : 'traversal',
      HostCode: direct ? '00000000' : opts.hostCode || '00000000',
      Address: direct ? String(opts.hostCode || '').split(':')[0] : '127.0.0.1',
      ConnectPort: opts.port || 2626,
      IndexServer: opts.indexUrl,
      UseIndex: 'False',
    });
  }

  // controller first: it decides what's plugged into GameCube port 1 (pad or adapter)
  const controls = writeControls(cfgDir, settings, platform);

  ini.updateFile(path.join(cfgDir, 'Dolphin.ini'), {
    General: general,
    Core: { GFXBackend: backendFor(g.gcBackend, platform), SIDevice0: controls.siDevice },
    Display: { Fullscreen: g.fullscreen ? 'True' : 'False', RenderToMain: 'False' },
    Interface: { ConfirmStop: 'False', PauseOnFocusLost: 'False', ShowActiveTitle: 'True' },
    // controllers keep working while Netcade's chat box has the keyboard
    Input: { BackgroundInput: 'True' },
    Analytics: { Enabled: 'False', PermissionAsked: 'True' },
    NetPlay: netplay,
  });

  ini.updateFile(path.join(cfgDir, 'GFX.ini'), {
    Settings: {
      InternalResolution: Math.max(1, Math.min(8, g.gcScale || 2)),
      wideScreenHack: g.widescreen ? 'True' : 'False',
      ShaderCompilationMode: 2,            // async ubershaders: no stutter while shaders compile
      WaitForShadersBeforeStarting: 'True',
      ShowFPS: g.showFps ? 'True' : 'False',
      // borderless fullscreen so Netcade's in-game overlay can draw on top
      BorderlessFullscreen: 'True',
    },
    Hardware: { VSync: g.vsync === false ? 'False' : 'True' },
  });

  return { exclusive, folders, controls };
}

// Dolphin's SI device ids for GameCube port 1
const SI_STANDARD = 6;    // emulated standard controller (keyboard or any pad)
const SI_ADAPTER = 12;    // real GameCube controllers via a Nintendo / Mayflash adapter

/**
 * Write GameCube port 1's controls. Returns { section, siDevice } as written, so Netcade can tell
 * afterwards whether the player changed them inside Dolphin.
 *  - controls the player chose to keep from Dolphin are written back exactly as Dolphin saved them
 *  - otherwise they come from Netcade's Controls page (keyboard, a controller, or the adapter)
 */
function writeControls(cfgDir, settings, platform) {
  const c = settings.controls?.gc || {};
  const kept = c.useDolphin && c.dolphinPad && c.dolphinPad.section && Object.keys(c.dolphinPad.section).length;
  let section;
  let siDevice;
  if (kept) {
    section = { ...c.dolphinPad.section };
    siDevice = Number.isInteger(c.dolphinPad.siDevice) ? c.dolphinPad.siDevice : SI_STANDARD;
  } else {
    section = netcadePad(c, platform);
    siDevice = c.mode === 'gamepad' && c.device?.kind === 'adapter' ? SI_ADAPTER : SI_STANDARD;
  }
  ini.updateFile(path.join(cfgDir, 'GCPadNew.ini'), {}, { GCPad1: section });
  return { section, siDevice };
}

function netcadePad(c, platform) {
  const mode = c.mode === 'gamepad' ? 'gamepad' : 'keyboard';
  const map = resolve('gc', mode, c[mode]);
  const dev = mode === 'keyboard'
    ? { kind: 'keyboard' }
    : c.device?.kind === 'sdl' || (platform !== 'win32')
      ? { kind: 'sdl', index: c.device?.index | 0, name: c.device?.name || 'Controller' }
      : { kind: 'xinput', index: c.device?.index | 0 };
  return ini.linesToObject(dolphinGCPad(map, dev, platform));
}

/** Port 1's controls as Dolphin has them on disk now. */
function readControls(userDir) {
  const cfgDir = path.join(userDir, 'Config');
  const read = (f) => { try { return ini.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8')); } catch { return null; } };
  const pad = read('GCPadNew.ini');
  const main = read('Dolphin.ini');
  const section = pad && pad.sections.get('GCPad1') ? Object.fromEntries(pad.sections.get('GCPad1')) : {};
  const si = parseInt(main?.sections.get('Core')?.get('SIDevice0'), 10);
  return { section, siDevice: Number.isInteger(si) ? si : SI_STANDARD };
}

// Keys that hold bindings. Dolphin also saves calibration, dead zones etc.; those don't count as
// "changed your controls" on their own (but are kept along with the rest if the player keeps them).
const BINDING_KEY = /^(Device|Buttons\/.+|(Main Stick|C-Stick)\/(Up|Down|Left|Right|Modifier)|Triggers\/(L|R|L-Analog|R-Analog)|D-Pad\/.+|Rumble\/Motor)$/;
const normExpr = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Did the player change port 1 inside Dolphin since Netcade wrote `before`? */
function controlsChanged(before, after) {
  if (!before || !after) return false;
  if (before.siDevice !== after.siDevice) return true;
  // Dolphin leaves empty bindings out of the file, so a missing key equals ''
  const keys = new Set([...Object.keys(before.section), ...Object.keys(after.section)].filter((k) => BINDING_KEY.test(k)));
  for (const k of keys) {
    if (normExpr(before.section[k]) !== normExpr(after.section[k])) return true;
  }
  return false;
}

/** Command-line arguments for each launch mode. */
function args(opts) {
  const a = ['-u', opts.userDir];
  if (opts.mode === 'solo') {
    a.push('-b', '-e', opts.game.path);
  }
  if (opts.netcade && (opts.mode === 'host' || opts.mode === 'guest')) {
    // Netcade's Dolphin build: host or join straight away, driven over the control link
    a.push(opts.mode === 'host' ? '--netcade-host' : '--netcade-join', opts.netcade.game);
    if (opts.netcade.port) a.push('--netcade-control', String(opts.netcade.port));
  }
  // otherwise host/guest open Dolphin's main window; netplay starts from Tools -> Start NetPlay Session
  return a;
}

/** The NetPlay window's options, with Dolphin's defaults where Netcade has nothing saved. */
const NETPLAY_DEFAULTS = {
  networkMode: 'fixeddelay', savedata: 'write', syncCodes: true, strictSync: false,
  recordInputs: false, syncAllWii: false, golfOverlay: true, hideRemoteGbas: false,
};
function netplayOptions(settings) {
  const o = { ...NETPLAY_DEFAULTS, ...(settings.dolphinNetplay || {}) };
  if (!['fixeddelay', 'hostinputauthority', 'golf'].includes(o.networkMode)) o.networkMode = 'fixeddelay';
  if (!['none', 'load', 'write'].includes(o.savedata)) o.savedata = 'write';
  return o;
}

/**
 * Is this Netcade's own Dolphin build (can host/join on command, hidden NetPlay window)?
 * The build ships a Netcade.txt next to Dolphin.exe.
 */
function isNetcadeBuild(exe) {
  if (!exe || exe.startsWith('flatpak:')) return false;
  const dir = path.dirname(exe);
  return [path.join(dir, 'Netcade.txt'), path.join(dir, '..', 'Resources', 'Netcade.txt')].some((f) => fs.existsSync(f));
}

/** Plain-language steps shown in the launcher while Dolphin is open. */
/**
 * layout: [{ port, name }] from the lobby (players only). Dolphin hands out controllers to
 * whoever connects first, so the host matches the lobby with "Assign Controller Ports".
 */
function instructions(mode, exclusive, layout = [], spectating = false, conn = 'traversal') {
  if (mode === 'host') {
    const steps = [
      'In Dolphin, open Tools → Start NetPlay Session…',
      conn === 'relay'
        ? 'Go to the Host tab. Leave Connection Type on "Direct Connection" (Netcade carries your friends\' connection).'
        : 'Go to the Host tab. Netcade already filled in everything.',
      exclusive ? 'Double-click your game (it is the only one listed).' : 'Double-click your game in the list.',
    ];
    if (layout.length) {
      steps.push(`When everyone has joined, click Assign Controller Ports and set: ${layout.map((l) => `Port ${l.port}: ${l.name}`).join(', ')}. Leave spectators unassigned.`);
    }
    steps.push('Press Start in Dolphin\'s NetPlay window.');
    steps.push('Game running below full speed? Raise "Buffer" in the NetPlay window by 2 at a time (it works mid-game) until it\'s smooth.');
    return steps;
  }
  const fill = conn === 'relay'
    ? 'Stay on the Connect tab with "Direct Connection". The address 127.0.0.1 is Netcade\'s relay, already filled in.'
    : 'Stay on the Connect tab. The host code is already filled in.';
  if (spectating) {
    return [
      'In Dolphin, open Tools → Start NetPlay Session…',
      fill,
      'Click Connect. You\'re watching: the host leaves you without a controller.',
    ];
  }
  return [
    'In Dolphin, open Tools → Start NetPlay Session…',
    fill,
    'Click Connect, then wait for the host to press Start.',
  ];
}

module.exports = { prepare, args, instructions, writeControls, readControls, controlsChanged, backendFor, netplayOptions, isNetcadeBuild, NETPLAY_DEFAULTS, SI_ADAPTER, SI_STANDARD };
