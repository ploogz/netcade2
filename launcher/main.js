'use strict';
/**
 * Netcade launcher: main process.
 * Owns settings, the game library, the lobby connection, relay tunnels and emulator processes.
 * The renderer (UI) talks to it only through the API in preload.js.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, nativeTheme, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

// box art is served to the UI from the cover cache through this scheme
protocol.registerSchemesAsPrivileged([{ scheme: 'netcade-cover', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const { Library } = require('./lib/library');
const { matchGame, publicGame, describe } = require('./lib/romInfo');
const emulators = require('./lib/emulators');
const dolphin = require('./lib/dolphin');
const retroarch = require('./lib/retroarch');
const tunnel = require('./lib/tunnel');
const { DolphinControl, sessionReadiness, padsFromLobby, STATUS_TEXT } = require('./lib/dolphinControl');
const { LobbyClient, httpBase } = require('./lib/lobbyClient');

const APP_VERSION = app.getVersion();

/** Build-time config: CI writes the group's server address here so players never type it. */
const BUILD_CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'netcade.config.json'), 'utf8')); } catch { return {}; }
})();

/**
 * Built-in emulators: shipped inside the installer, or downloaded once on first launch into
 * <userData>/emulators when the installer didn't include them.
 */
const DOWNLOADED_VENDOR = path.join(app.getPath('userData'), 'emulators', `${emulators.OS_TAG}-${process.arch}`);
const findBundle = () => emulators.bundled({
  resourcesPath: process.resourcesPath, appPath: __dirname, isPackaged: app.isPackaged, extraDirs: [DOWNLOADED_VENDOR],
});
let BUNDLE = findBundle();
const PROTOCOL = 'netcade';

// ------------------------------------------------------------------ paths
const USER = app.getPath('userData');
const P = {
  settings: path.join(USER, 'settings.json'),
  libraryCache: path.join(USER, 'library-cache.json'),
  logs: path.join(USER, 'logs'),
  dolphinUser: path.join(USER, 'dolphin-user'),
  retroarchData: path.join(USER, 'retroarch'),
  cores: path.join(USER, 'cores'),
};

// --------------------------------------------------------------- settings
function defaultName() {
  try {
    const n = os.userInfo().username || 'Player';
    return n.charAt(0).toUpperCase() + n.slice(1, 20);
  } catch {
    return 'Player';
  }
}

const DEFAULT_SETTINGS = {
  version: 1,
  name: defaultName(),
  serverUrl: BUILD_CONFIG.defaultServerUrl || '',
  emulatorSource: 'bundled',   // 'bundled' = the copies inside Netcade, 'custom' = the player's own installs
  embeddedServer: { enabled: false, port: 8080, share: true },
  romFolders: [],
  dolphinPath: '',
  retroarchPath: '',
  n64CorePath: '',
  graphics: {
    preset: 'balanced', fullscreen: false, vsync: true, widescreen: false, showFps: false,
    // macOS has no native Vulkan, so the OpenGL renderer is the safe default there
    n64Renderer: process.platform === 'darwin' ? 'gliden64' : 'parallel', n64Scale: 2, gcBackend: 'auto', gcScale: 2,
  },
  controls: {
    n64: { mode: 'keyboard', keyboard: {}, gamepad: {} },
    gc: { mode: 'keyboard', keyboard: {}, gamepad: {}, device: { kind: process.platform === 'win32' ? 'xinput' : 'sdl', index: 0, name: '' } },
  },
  chatKey: 'Tab',
  overlayLayout: 'auto',
  unpackCacheGB: 20,
  gameNames: {},               // your own names for games (by fingerprint)
  gameLinks: {},               // remembered "Get the game" links (by fingerprint)           // space for games unpacked from .zip/.7z       // 'auto' = use the black bars beside 4:3 games, 'corners' = always corners
  netplay: { forceRelay: false, retroarchPort: 55435, dolphinPort: 2626, notify: true, gcConnection: 'relay' },
  // options from Dolphin's NetPlay window (host's choice), see lib/dolphin.js netplayOptions()
  dolphinNetplay: { ...dolphin.NETPLAY_DEFAULTS },
  favorites: [],
  recent: [],
  onboarded: false,
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

let settings = loadSettings();

function loadSettings() {
  try {
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(P.settings, 'utf8')));
  } catch {
    return deepMerge(DEFAULT_SETTINGS, {});
  }
}

function saveSettings() {
  fs.mkdirSync(USER, { recursive: true });
  const tmp = P.settings + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, P.settings);
}

// ------------------------------------------------------------------ state
const library = new Library(P.libraryCache, () => sevenZipPath());
const { ExtractCache } = require('./lib/archives');
const unpacked = new ExtractCache({
  dir: path.join(USER, 'unpacked'),
  sevenZip: () => sevenZipPath(),
  limitBytes: () => (settings.unpackCacheGB || 20) * 1024 ** 3,
  log: (...a) => log(...a),
});

/** A game ready to launch: games inside .zip/.7z are unpacked to the cache first. */
async function playable(game) {
  if (!game.archive) return game;
  setSession({ ...(session || {}), title: game.title, system: game.system, phase: 'preparing', text: `Unpacking ${game.title}…` });
  let last = -1;
  const file = await unpacked.ensure(game, (pct) => {
    if (pct !== last) { last = pct; setSession({ text: `Unpacking ${game.title}… ${pct}%` }); }
  });
  return { ...game, path: file };
}
const lobby = new LobbyClient();
let win = null;
let embedded = null;           // in-process lobby server, when enabled
let lobbyView = null;          // last lobby view from the server
let lastHasKey = '';           // avoid re-sending identical has-status
let myHas = null;
let session = null;            // the running emulator session
let chatHistory = [];          // recent lobby chat, replayed into the in-game overlay
let pendingJoin = null;        // lobby code from a netcade:// link, joined once online
let emuInfo = { dolphin: {}, retroarch: {}, n64Core: '' };
const { Overlay } = require('./lib/overlay');
let overlay = null; // created below, once log() exists

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try {
    fs.mkdirSync(P.logs, { recursive: true });
    fs.appendFileSync(path.join(P.logs, 'netcade.log'), line);
  } catch { /* ignore */ }
};

const { Covers } = require('./lib/covers');
const COVER_DIR = path.join(app.getPath('userData'), 'covers');
const coverUrl = (file) => `netcade-cover://c/${file}`;
const covers = new Covers({
  dir: COVER_DIR,
  log: (...a) => log(...a),
  onReady: (key, file) => emit('cover', { key, url: coverUrl(file) }),
});

overlay = new Overlay({
  log: (...a) => log(...a),
  onAction: (action, payload) => {
    const p = payload || {};
    if (action === 'chat' && p.text) lobby.send({ type: 'chat', text: String(p.text).slice(0, 300) });
    else if (action === 'requestPort') lobby.send({ type: 'requestPort', port: p.port });
    else if (action === 'cancelPort') lobby.send({ type: 'cancelPort', reqId: p.reqId });
    else if (action === 'spectate') lobby.send({ type: 'spectate' });
    else if (action === 'answerPort') {
      lobby.send({ type: 'answerPort', reqId: p.reqId, accept: !!p.accept });
      emit('lobby-msg', { type: 'portRequestClosed', reqId: p.reqId });
    }
  },
});

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(text, kind = 'info') {
  emit('toast', { text, kind });
}

function notify(title, body) {
  if (!settings.netplay?.notify) return;
  if (win && win.isFocused()) return;
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
  } catch { /* ignore */ }
}

function serverUrl() {
  if (settings.embeddedServer?.enabled) return `http://127.0.0.1:${settings.embeddedServer.port || 8080}`;
  return (settings.serverUrl || '').trim();
}

// ------------------------------------------------------------- first-launch emulator setup
let setup = { state: BUNDLE ? 'done' : 'idle' };

function setSetup(patch) {
  setup = { ...setup, ...patch };
  emit('setup', setup);
}

function sevenZipPath() {
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? '7za.exe' : '7za');
    if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o755); } catch { /* ignore */ } }
    return p;
  }
  try { return require('7zip-bin').path7za; } catch { return '7z'; }
}

/** Download and unpack Dolphin, RetroArch and the N64 core (one time, a few minutes). */
/** Where the Netcade build of Dolphin ships inside the installer (if this release has one). */
function netcadeDolphinArchive() {
  const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'vendor');
  return ['dolphin-netcade.7z', 'dolphin-netcade.zip'].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f)) || path.join(dir, 'dolphin-netcade.7z');
}

/**
 * Installs set up before this release have the official Dolphin; switch them to Netcade's build
 * (Dolphin only) when this release carries it. Settings, saves and controls are kept.
 */
function wantsNetcadeDolphinUpgrade() {
  if (process.platform !== 'win32' || settings.emulatorSource === 'custom' || !BUNDLE?.dolphin) return false;
  if (dolphin.isNetcadeBuild(BUNDLE.dolphin.path)) return false;
  if (!BUNDLE.dolphin.path.startsWith(DOWNLOADED_VENDOR)) return false;   // inside the installer: next installer fixes it
  let manifest = {};
  try { manifest = require('./emulators.json'); } catch { /* none */ }
  return fs.existsSync(netcadeDolphinArchive()) || !!manifest.dolphin?.netcade?.['win-x64']?.url;
}

async function runEmulatorSetup(only = null) {
  if (setup.state === 'running') return setup;
  const { fetchAll, APPROX_DOWNLOAD_MB } = require('./lib/vendorFetch');
  setSetup({ state: 'running', error: null, label: 'Starting…', got: 0, total: 0, approxMB: APPROX_DOWNLOAD_MB[emulators.OS_TAG] });
  log('emulator setup started ->', DOWNLOADED_VENDOR);
  try {
    await fetchAll({
      os: emulators.OS_TAG,
      arch: process.arch,
      outDir: DOWNLOADED_VENDOR,
      cacheDir: path.join(USER, 'download-cache'),
      sevenZip: sevenZipPath(),
      mirror: process.env.NETCADE_EMU_MIRROR || null,
      netcadeDolphinArchive: netcadeDolphinArchive(),
      only,
      log: (m) => log('[setup]', m),
      onProgress: ({ step, label, got, total }) => setSetup({ step, label, got, total }),
    });
    fs.rmSync(path.join(USER, 'download-cache'), { recursive: true, force: true });
    if (process.platform === 'win32') {
      setSetup({ label: 'Checking the Microsoft Visual C++ runtime…', got: 0, total: 0 });
      await ensureVcRuntime(path.join(DOWNLOADED_VENDOR, 'vc_redist.x64.exe'));
    }
    BUNDLE = findBundle();
    if (!BUNDLE) throw new Error('Setup finished but the emulators could not be found.');
    setSetup({ state: 'done', label: 'Ready' });
    await refreshEmulators();
    toast(only ? 'Dolphin updated. GameCube matches now start right from Netcade.' : 'Dolphin and RetroArch are set up. You\'re ready to play!');
  } catch (err) {
    log('emulator setup failed', err.stack || err.message);
    const net = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Timed out|socket hang up/i.test(err.message);
    const disk = /ENOSPC/i.test(err.message);
    const friendly = net ? 'Couldn\'t reach the download server.'
      : disk ? 'Your drive is full. Free up about 1 GB and try again.'
        : /EPERM|EACCES|EBUSY/i.test(err.message) ? 'Windows blocked a file while unpacking (often antivirus). Try again, or allow Netcade in your antivirus.'
          : err.message;
    setSetup({ state: 'error', error: friendly });
  }
  return setup;
}

/** Dolphin needs a recent VC++ 2015-2022 runtime. Install the bundled one only if missing (one UAC prompt). */
function ensureVcRuntime(installer) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', '/v', 'Bld', '/reg:64'],
      { windowsHide: true }, (err, stdout) => {
        const m = /Bld\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout || '');
        const build = m ? parseInt(m[1], 16) : 0;
        if (build >= 34433 || !fs.existsSync(installer)) return resolve(true);
        log('installing VC++ runtime (found build', build, ')');
        setSetup({ label: 'Installing the Microsoft Visual C++ runtime (click Yes if Windows asks)…' });
        const ps = `Start-Process -FilePath '${installer.replace(/'/g, "''")}' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait`;
        execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true }, (e) => {
          if (e) log('VC++ runtime install skipped/failed:', e.message);
          resolve(!e);
        });
      });
  });
}

// ------------------------------------------------------------- emulators
function useBundle(kind) {
  return settings.emulatorSource !== 'custom' && BUNDLE && BUNDLE[kind];
}
const dolphinExe = () => (useBundle('dolphin') ? BUNDLE.dolphin.path : settings.dolphinPath);
const retroarchExe = () => (useBundle('retroarch') ? BUNDLE.retroarch.path : settings.retroarchPath);
const raBundle = () => (useBundle('retroarch') ? { autoconfig: BUNDLE.autoconfig } : null);

async function refreshEmulators(autoDetect = false) {
  if (settings.emulatorSource !== 'custom' && BUNDLE) {
    const core = BUNDLE.n64Core && useBundle('retroarch') ? BUNDLE.n64Core.path : emulators.findN64Core(settings.retroarchPath, P.cores);
    emuInfo = {
      bundled: true,
      bundleBuiltAt: BUNDLE.builtAt,
      dolphin: { path: dolphinExe(), ok: emulators.exists(dolphinExe()), version: useBundle('dolphin') ? BUNDLE.dolphin.version : await emulators.version('dolphin', settings.dolphinPath), bundled: !!useBundle('dolphin') },
      retroarch: { path: retroarchExe(), ok: emulators.exists(retroarchExe()), version: useBundle('retroarch') ? BUNDLE.retroarch.version : await emulators.version('retroarch', settings.retroarchPath), bundled: !!useBundle('retroarch') },
      n64Core: core,
      n64CoreVersion: useBundle('retroarch') && BUNDLE.n64Core ? BUNDLE.n64Core.version : '',
    };
    emit('emulators', emuInfo);
    sendHello();
    return emuInfo;
  }
  return refreshCustomEmulators(autoDetect);
}

async function refreshCustomEmulators(autoDetect = false) {
  if (autoDetect || !settings.dolphinPath) {
    const d = emulators.detect('dolphin');
    if (d && !settings.dolphinPath) settings.dolphinPath = d;
  }
  if (autoDetect || !settings.retroarchPath) {
    const r = emulators.detect('retroarch');
    if (r && !settings.retroarchPath) settings.retroarchPath = r;
  }
  saveSettings();
  const [dv, rv] = await Promise.all([
    emulators.version('dolphin', settings.dolphinPath),
    emulators.version('retroarch', settings.retroarchPath),
  ]);
  const core = settings.n64CorePath && fs.existsSync(settings.n64CorePath)
    ? settings.n64CorePath
    : emulators.findN64Core(settings.retroarchPath, P.cores);
  emuInfo = {
    bundled: false,
    bundleAvailable: !!BUNDLE,
    dolphin: { path: settings.dolphinPath, ok: emulators.exists(settings.dolphinPath), version: dv },
    retroarch: { path: settings.retroarchPath, ok: emulators.exists(settings.retroarchPath), version: rv },
    n64Core: core,
  };
  emit('emulators', emuInfo);
  sendHello();
  return emuInfo;
}

// ---------------------------------------------------------------- library
async function scanLibrary() {
  const res = await library.scan(settings.romFolders, (done, total, file) => emit('library-progress', { done, total, file }));
  emit('library', { games: displayGames(), errors: res.errors });
  checkHas(true);
  return res;
}

// ----------------------------------------------------------------- lobby
function sendHello() {
  if (!serverUrl()) return;
  lobby.connect(serverUrl(), {
    name: settings.name,
    versions: {
      app: APP_VERSION,
      dolphin: emuInfo.dolphin?.version || '',
      retroarch: [emuInfo.retroarch?.version, emuInfo.n64CoreVersion].filter(Boolean).join(' · '),
    },
  });
}

function checkHas(force = false) {
  if (!lobbyView || !lobby.me) return;
  if (lobbyView.hostId === lobby.me.id) {
    myHas = { status: 'match' };
    return;
  }
  const m = matchGame(lobbyView.game, library.games, lobbyView.system);
  myHas = { status: m.status, detail: m.detail, localPath: m.local?.path };
  const key = `${lobbyView.code}|${lobbyView.game?.key}|${m.status}|${m.detail}`;
  if (force || key !== lastHasKey) {
    lastHasKey = key;
    lobby.send({ type: 'has', status: m.status, detail: m.detail });
  }
}

lobby.on('status', (s) => {
  emit('server-status', { ...s, me: lobby.me, url: serverUrl() });
  if (s.state === 'online' && pendingJoin) {
    lobby.send({ type: 'join', code: pendingJoin });
    pendingJoin = null;
  }
  if (s.state !== 'online') {
    if (lobbyView) {
      lobbyView = null;
      emit('lobby', null);
    }
  }
});

lobby.on('message', (msg) => {
  switch (msg.type) {
    case 'welcome':
      emit('server-status', { state: 'online', me: lobby.me, url: serverUrl() });
      lobby.send({ type: 'list' });
      break;
    case 'lobby': {
      const prev = lobbyView;
      lobbyView = msg.lobby;
      checkHas();
      emit('lobby', { ...lobbyView, myHas, myId: lobby.me?.id });
      overlay.push({ lobby: lobbyView, myId: lobby.me?.id });
      if (prev && lobby.me && lobbyView.hostId === lobby.me.id) {
        const joined = lobbyView.members.filter((m) => !prev.members.some((p) => p.id === m.id));
        for (const j of joined) notify('Player joined', `${j.name} joined your ${lobbyView.game?.title || ''} lobby`);
      }
      break;
    }
    case 'joined':
      lastHasKey = '';
      chatHistory = (msg.chat || []).slice(-40);
      emit('lobby-msg', msg);
      break;
    case 'left':
    case 'kicked':
      lobbyView = null;
      emit('lobby', null);
      emit('lobby-msg', msg);
      if (msg.type === 'kicked') toast('The host removed you from the lobby.', 'warn');
      break;
    case 'chat':
      emit('lobby-msg', msg);
      overlay.chat(msg);
      chatHistory.push(msg);
      if (chatHistory.length > 40) chatHistory.shift();
      if (!msg.system && msg.from !== lobby.me?.id) notify(msg.name, msg.text);
      break;
    case 'launch':
      onLaunch(msg).catch((err) => {
        log('launch failed', err.stack || err.message);
        setSession({ phase: 'error', text: err.message });
        if (msg.role === 'host') lobby.send({ type: 'endGame' });
      });
      break;
    case 'connectInfo':
      onConnectInfo(msg).catch((err) => {
        log('connect failed', err.stack || err.message);
        setSession({ phase: 'error', text: err.message });
      });
      break;
    case 'dolphinSession':
      onDolphinSession(msg).catch((err) => {
        log('dolphin guest failed', err.stack || err.message);
        setSession({ phase: 'error', text: err.message });
      });
      break;
    case 'netplayMode':
      onNetplayMode(msg).catch((e) => log('netplay mode failed', e.message));
      break;
    case 'tunnelOpen':
      if (!session || session.role !== 'host' || !lobby.me) break;
      if (msg.udp && session.system === 'gc' && session.gcConnection === 'relay') {
        // always our own Dolphin's port, never a port the server names
        hostTunnels.add(tunnel.openHostUdpTunnel({
          serverUrl: serverUrl(), pid: lobby.me.id, token: lobby.me.token, cid: msg.cid,
          localPort: settings.netplay?.dolphinPort || 2626, log,
        }));
      } else if (!msg.udp && session.system === 'n64') {
        hostTunnels.add(tunnel.openHostTunnel({
          serverUrl: serverUrl(), pid: lobby.me.id, token: lobby.me.token, cid: msg.cid,
          localPort: session.netPort, log,
        }));
      }
      break;
    case 'hostMode':
      if (session) setSession({ netMode: msg.mode });
      break;
    case 'portRequest':
      emit('lobby-msg', msg);
      overlay.request(msg);
      notify('Controller request', `${msg.fromName} wants your controller (P${msg.port})`);
      break;
    case 'portRequestClosed':
      emit('lobby-msg', msg);
      overlay.requestClosed(msg.reqId);
      break;
    case 'info':
      toast(msg.message);
      overlay.notice(msg.message);
      break;
    case 'error':
      emit('lobby-msg', msg);
      overlay.notice(msg.message, 'warn');
      break;
    case 'portsChanged': {
      emit('lobby-msg', msg);
      const me = lobby.me?.id;
      const mine = msg.changes.find((c) => c.id === me);
      if (mine && !msg.live) overlay.notice(mine.to ? `You'll be player ${mine.to} when the game restarts` : 'You\'ll watch from the next game');
      break;
    }
    case 'tournamentDone':
      emit('lobby-msg', msg);
      overlay.notice(`🏆 ${msg.name} wins the tournament!`, 'info', 9000);
      break;
    case 'gameEnded':
      if (session && session.role === 'guest' && session.phase === 'waiting') {
        setSession(null);
      }
      if (msg.message) toast(msg.message);
      emit('lobby-msg', msg);
      break;
    default:
      emit('lobby-msg', msg);
  }
});

// --------------------------------------------------------------- sessions
const hostTunnels = new Set();

function gcConnection() {
  const n = settings.netplay || {};
  if (['relay', 'traversal', 'direct'].includes(n.gcConnection)) return n.gcConnection;
  return n.dolphinDirect ? 'direct' : 'relay';
}

function setSession(patch) {
  if (patch === null) {
    if (session?.tunnel) session.tunnel.close();
    if (gcRun) { gcRun.control.close(); gcRun = null; }
    for (const t of hostTunnels) t.close();
    hostTunnels.clear();
    session = null;
    overlay.hide();
  } else {
    session = { ...(session || {}), ...patch };
  }
  emit('session', session ? { ...session, child: undefined, tunnel: undefined } : null);
}

function requireEmulator(system) {
  if (system === 'gc') {
    if (!emulators.exists(dolphinExe())) throw new Error('Dolphin is not set up yet. Open Settings → Emulators.');
  } else {
    if (!emulators.exists(retroarchExe())) throw new Error('RetroArch is not set up yet. Open Settings → Emulators.');
    if (!emuInfo.n64Core) throw new Error('The N64 core is missing. Open Settings → Emulators and click "Install N64 core".');
  }
}

function trackRecent(key) {
  settings.recent = [{ key, t: Date.now() }, ...(settings.recent || []).filter((r) => r.key !== key)].slice(0, 20);
  saveSettings();
  emit('settings', settings);
}

function spawnTracked(system, exe, args, extra) {
  const logFile = path.join(P.logs, `${system === 'gc' ? 'dolphin' : 'retroarch'}-last.log`);
  const folders = [USER, ...settings.romFolders];
  const child = emulators.launch(exe, args, { logFile, folders, env: extra?.env });
  child.on('error', (err) => {
    log('spawn error', err.message);
    toast(`Could not start the emulator: ${err.message}`, 'error');
  });
  child.on('exit', (code) => {
    log(`${system} exited with ${code}`);
    if (system === 'gc') checkDolphinControls();
    if (session && session.child === child) {
      const wasHost = session.role === 'host';
      setSession(null);
      if (wasHost && lobbyView && lobbyView.state !== 'waiting') lobby.send({ type: 'endGame' });
      if (code && code !== 0 && extra?.warnOnCrash !== false) toast(`The emulator closed unexpectedly (code ${code}). Logs: Settings → Open logs.`, 'warn');
    }
  });
  return child;
}

// ------------------------------------------------------- controls changed inside Dolphin
// Netcade writes GameCube port 1 on every launch. If the player remapped it in Dolphin, ask
// whether to keep that instead of silently overwriting it next time.
let padWritten = null;
let padPending = null;

function checkDolphinControls() {
  const before = padWritten;
  padWritten = null;
  if (!before) return;
  const now = dolphin.readControls(P.dolphinUser);
  if (!dolphin.controlsChanged(before, now)) return;
  padPending = now;
  log('controls changed in Dolphin:', now.section.Device || '(no device)', 'SI', now.siDevice);
  emit('controls-dolphin', {
    device: now.section.Device || '',
    adapter: now.siDevice === dolphin.SI_ADAPTER,
    again: !!settings.controls.gc.useDolphin,
  });
}

handle('controls:keepDolphin', async (keep) => {
  const pending = padPending;
  padPending = null;
  if (!keep || !pending) return settings;
  settings.controls.gc.useDolphin = true;
  settings.controls.gc.dolphinPad = { section: pending.section, siDevice: pending.siDevice, savedAt: Date.now() };
  saveSettings();
  emit('settings', settings);
  return settings;
});

async function playSolo(key) {
  let game = library.byKey(key);
  if (!game) throw new Error('That game is no longer in your library. Try rescanning.');
  if (session) throw new Error('An emulator session is already running.');
  requireEmulator(game.system);
  game = await playable(game);
  trackRecent(key);
  if (game.system === 'gc') {
    padWritten = dolphin.prepare({ userDir: P.dolphinUser, mode: 'solo', platform: process.platform, settings, game, romFolders: settings.romFolders }).controls;
    const child = spawnTracked('gc', dolphinExe(), dolphin.args({ userDir: P.dolphinUser, mode: 'solo', game }));
    setSession({ system: 'gc', role: 'solo', phase: 'playing', title: game.title, child, text: 'Playing solo in Dolphin.' });
  } else {
    const { appendConfig, baseConfig } = retroarch.prepare({ bundle: raBundle(), dataDir: P.retroarchData, mode: 'solo', settings, nickname: settings.name });
    const child = spawnTracked('n64', retroarchExe(), retroarch.args({ corePath: emuInfo.n64Core, romPath: game.path, appendConfig, baseConfig }));
    setSession({ system: 'n64', role: 'solo', phase: 'playing', title: game.title, child, text: 'Playing solo. Hold Right Ctrl + Esc to quit, Right Ctrl + F for fullscreen.' });
  }
}

async function onLaunch(msg) {
  if (session && session.child) {
    try { session.child.kill(); } catch { /* ignore */ }
    setSession(null);
  }
  let game = library.byKey(msg.game.key);
  if (!game) {
    if (msg.spectate) {
      // watching needs the same game too (each PC runs its own copy); stay in the lobby chat instead
      toast(`You need ${describe(msg.game)} to watch this match. You're still in the lobby chat.`, 'warn');
      return;
    }
    throw new Error(`You don't have the exact game this lobby needs (${describe(msg.game)}).`);
  }
  requireEmulator(msg.system);
  game = await playable(game);
  trackRecent(game.key);
  notify(msg.spectate ? 'Match starting (watching)' : 'Match starting', `${msg.game.title} is launching`);
  const base = {
    system: msg.system, role: msg.role, title: game.title, code: msg.code, inputDelay: msg.inputDelay, game,
    hostOptions: msg.hostOptions, port: msg.port, spectate: !!msg.spectate,
    cmdPort: msg.system === 'n64' ? 55400 + Math.floor(Math.random() * 500) : 0,
    playing: !msg.spectate,
  };
  overlay.show(base, {
    fullscreen: !!settings.graphics?.fullscreen,
    aspect: gameAspect(msg.system, msg.hostOptions),
    layout: settings.overlayLayout || 'auto',
    history: chatHistory,
  });

  if (msg.system === 'gc') {
    if (msg.role === 'host') {
      const conn = msg.hostOptions?.gcConnection || 'traversal';
      const { exclusive, controls } = dolphin.prepare({
        userDir: P.dolphinUser, mode: 'host', platform: process.platform, settings, game,
        romFolders: settings.romFolders, lobbyCode: msg.code, indexUrl: `${httpBase(serverUrl())}/dolphin`,
        nickname: myLobbyName(), inputDelay: msg.inputDelay, gcConnection: conn,
      });
      padWritten = controls;
      if (netcadeDolphin()) {
        await startNetcadeDolphin('host', game, { ...base, gcConnection: conn, netMode: conn === 'relay' ? 'relay' : undefined });
        return;
      }
      const child = spawnTracked('gc', dolphinExe(), dolphin.args({ userDir: P.dolphinUser, mode: 'host' }));
      setSession({
        ...base, child, phase: 'dolphin', gcConnection: conn, netMode: conn === 'relay' ? 'relay' : undefined,
        steps: dolphin.instructions('host', exclusive, portLayout(), false, conn),
        text: 'Dolphin is open. Start hosting from its NetPlay window.',
      });
    } else {
      setSession({ ...base, phase: 'waiting', text: 'Waiting for the host to open their Dolphin session…' });
    }
    return;
  }

  // N64 / RetroArch
  if (msg.role === 'host') {
    const port = settings.netplay?.retroarchPort || 55435;
    const { appendConfig, baseConfig } = retroarch.prepare({ bundle: raBundle(),
      dataDir: P.retroarchData, mode: 'host', settings, nickname: settings.name,
      inputDelay: msg.inputDelay, hostOptions: msg.hostOptions, port: base.port, spectate: base.spectate, cmdPort: base.cmdPort,
    });
    const child = spawnTracked('n64', retroarchExe(), retroarch.args({
      corePath: emuInfo.n64Core, romPath: game.path, appendConfig, baseConfig, nickname: settings.name, net: { role: 'host', port },
    }));
    setSession({ ...base, child, netPort: port, phase: 'starting', text: 'Starting RetroArch and opening the netplay port…' });
    const up = await tunnel.waitForPort(port, 45000, () => session && session.child === child && child.exitCode === null);
    if (!session || session.child !== child) return;
    if (!up) throw new Error(`RetroArch did not open netplay port ${port}. Is something else using it?`);
    lobby.send({ type: 'hostReady', port, lanIps: emulators.lanAddresses() });
    setSession({ phase: 'playing', text: `Hosting${base.spectate ? ' (watching)' : ` as P${base.port}`}. Players are connecting. Hold Right Ctrl + Esc to quit.` });
  } else {
    setSession({ ...base, phase: 'waiting', text: 'Waiting for the host\'s emulator to come online…' });
  }
}

async function onConnectInfo(msg) {
  if (!session || session.role !== 'guest' || session.system !== 'n64' || session.child) return;
  const { game } = session;
  const { appendConfig, baseConfig } = retroarch.prepare({ bundle: raBundle(),
    dataDir: P.retroarchData, mode: 'guest', settings, nickname: settings.name,
    inputDelay: session.inputDelay, hostOptions: session.hostOptions,
    port: session.port, spectate: session.spectate, cmdPort: session.cmdPort,
  });
  let ip = msg.ip;
  let port = msg.port;
  let tun = null;
  if (msg.mode === 'relay') {
    tun = await tunnel.startGuest({ serverUrl: serverUrl(), pid: lobby.me.id, token: lobby.me.token, log });
    ip = '127.0.0.1';
    port = tun.port;
  }
  const child = spawnTracked('n64', retroarchExe(), retroarch.args({
    corePath: emuInfo.n64Core, romPath: game.path, appendConfig, baseConfig, nickname: settings.name, net: { role: 'guest', ip, port },
  }));
  setSession({
    child, tunnel: tun, netMode: msg.mode, phase: 'playing',
    text: `${session.spectate ? 'Watching' : `Playing as P${session.port}`}, ${msg.mode === 'relay' ? 'through the relay' : 'connected directly to the host'}. Hold Right Ctrl + Esc to quit.`,
  });
}

async function onDolphinSession(msg) {
  if (!session || session.role !== 'guest' || session.system !== 'gc') return;
  if (session.child) {
    if (gcRun) return;   // Netcade's Dolphin keeps its own connection; nothing to click
    if (msg.relay) {
      // same relay port as before; Dolphin just has to connect again
      setSession({ text: 'Host restarted their session. Click Connect in Dolphin again.' });
    } else {
      // Dolphin is already open: show the new code so they can paste it
      setSession({ hostCode: msg.hostCode, text: `Host restarted their session. New host code: ${msg.hostCode}` });
    }
    return;
  }
  let target = { hostCode: msg.hostCode, method: msg.method, port: msg.port };
  let tun = null;
  if (msg.relay) {
    // Dolphin "direct connects" to Netcade on this PC; packets travel through the lobby server
    tun = await tunnel.startGuestUdp({ serverUrl: serverUrl(), pid: lobby.me.id, token: lobby.me.token, log });
    if (!session || session.child) { tun.close(); return; }
    target = { hostCode: '127.0.0.1', method: 'direct', port: tun.port };
  }
  padWritten = dolphin.prepare({
    userDir: P.dolphinUser, mode: 'guest', platform: process.platform, settings, game: session.game,
    // the game's own folder is included so Dolphin also sees games unpacked from archives
    romFolders: [...settings.romFolders, path.dirname(session.game.path)], indexUrl: `${httpBase(serverUrl())}/dolphin`, nickname: myLobbyName(),
    inputDelay: session.inputDelay, ...target,
  }).controls;
  if (netcadeDolphin()) {
    await startNetcadeDolphin('guest', session.game, { tunnel: tun, netMode: msg.relay ? 'relay' : undefined });
    return;
  }
  const child = spawnTracked('gc', dolphinExe(), dolphin.args({ userDir: P.dolphinUser, mode: 'guest' }));
  const conn = msg.relay ? 'relay' : 'traversal';
  setSession({
    child, tunnel: tun, netMode: msg.relay ? 'relay' : undefined, hostCode: msg.relay ? '' : msg.hostCode, phase: 'dolphin',
    steps: dolphin.instructions('guest', false, [], session.spectate, conn),
    text: session.spectate ? 'Dolphin is open. You\'re watching this match.'
      : msg.relay ? `Dolphin is open and set to connect through Netcade. You're P${session.port}.`
        : `Dolphin is open with the host's code filled in. You're P${session.port}.`,
  });
}

/** Shape of the game picture, so the overlay knows whether there are black bars beside it. */
function gameAspect(system, hostOptions) {
  const g = settings.graphics || {};
  if (system === 'gc') return g.widescreen ? 16 / 9 : 4 / 3;
  const renderer = hostOptions?.n64Renderer || g.n64Renderer;
  return renderer === 'gliden64' && g.widescreen ? 16 / 9 : 4 / 3;
}

// ------------------------------------------------------- Netcade's Dolphin build
// Dolphin hosts/joins by itself and reports back over a local link; Netcade starts the game once
// everyone is in, with controller ports taken from the lobby. Dolphin's NetPlay window stays
// hidden (players can still open it from the lobby for anything Netcade doesn't show).
let gcRun = null;   // { control, child, starting, autoStarted, rechecks, lastRecheck, manualSent, hostingSince }

const netcadeDolphin = () => dolphin.isNetcadeBuild(dolphinExe());

/** My name as the lobby shows it; Dolphin uses the same name so Netcade can match players. */
function myLobbyName() {
  return lobbyView?.members.find((m) => m.id === lobby.me?.id)?.name || settings.name || 'Player';
}

async function startNetcadeDolphin(role, game, patch) {
  const control = new DolphinControl({ log });
  await control.listen();
  const child = spawnTracked('gc', dolphinExe(),
    dolphin.args({ userDir: P.dolphinUser, mode: role, netcade: { game: game.path, port: control.port } }),
    { env: { NETCADE_TOKEN: control.token } });
  gcRun = { control, child, starting: false, autoStarted: false, rechecks: 0, lastRecheck: 0, manualSent: false, hostingSince: 0 };
  // host: also check on a timer, since Dolphin only reports when something changes
  const tick = role === 'host' ? setInterval(() => {
    if (gcRun?.child === child && session?.dolphin && !session.dolphin.running) hostSessionTick(session.readiness);
  }, 2000) : null;
  child.on('exit', () => { clearInterval(tick); control.close(); });
  const alive = () => gcRun && gcRun.child === child && session;
  control.on('connected', () => { if (alive()) setSession({ dolphinLinked: true }); });
  control.on('state', (s) => { if (alive()) onDolphinState(s); });
  control.on('msg', ({ text, color }) => {
    if (!alive()) return;
    setSession({ dolphinLog: [...(session.dolphinLog || []), { text, color, t: Date.now() }].slice(-8) });
  });
  control.on('event', (e) => { if (alive()) onDolphinEvent(e); });
  control.on('closed', () => {
    if (alive() && child.exitCode === null) {
      setSession({ dolphinLinked: false, text: 'Lost the link to Dolphin. Its NetPlay window is open so you can carry on there.' });
    }
  });
  setSession({
    ...patch, child, netcade: true, phase: 'connecting', started: false, dolphin: null, dolphinLog: [],
    steps: null, text: role === 'host' ? 'Starting the GameCube session…' : 'Joining the host\'s session…',
  });
}

/** Lobby members who will be in the Dolphin session (everyone with the game, watchers included). */
function expectedInDolphin() {
  return (lobbyView?.members || []).filter((m) => m.has?.status === 'match' || m.isHost).map((m) => m.name);
}

function listNames(names) {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function onDolphinState(s) {
  const players = (s.players || []).map((p) => ({ name: p.name, status: p.status, ping: p.ping, port: p.port, host: !!p.host }));
  const dolphinState = {
    hosting: !!s.hosting, players, buffer: s.buffer, hia: !!s.hostInputAuthority, running: !!s.running,
    options: s.options || {}, optionsEditable: !!s.optionsEditable, windowVisible: !!s.windowVisible,
  };
  const patch = { dolphin: dolphinState };
  if (s.running) {
    patch.phase = 'playing';
  } else if (session.role === 'host') {
    if (s.hosting && !gcRun.hostingSince) gcRun.hostingSince = Date.now();
    const expected = expectedInDolphin();
    const r = sessionReadiness(expected, players);
    patch.readiness = { ...r, total: expected.length, inSession: expected.length - r.waiting.length };
    if (!session.started || !gcRun.autoStarted) {
      patch.text = r.ready ? 'Everyone is in. Starting…'
        : r.wrong.length ? `${r.wrong[0].name} ${STATUS_TEXT[r.wrong[0].status] || 'can\'t play yet'}.`
          : `Waiting for ${listNames(r.waiting)} to connect (${expected.length - r.waiting.length}/${expected.length})…`;
    }
  } else if (!session.started) {
    const me = myLobbyName();
    patch.text = players.some((p) => p.name === me) ? 'Connected. Waiting for the game to start…' : 'Joining the host\'s session…';
  }
  setSession(patch);
  if (session.role === 'host' && !s.running) hostSessionTick(patch.readiness);
}

function hostSessionTick(readiness) {
  const run = gcRun;
  if (!run || !session.dolphin?.hosting) return;
  // Dolphin registers with the lobby server itself; if that hasn't reached guests after a few
  // seconds (e.g. it couldn't look up its address), tell them ourselves: the relay needs no address
  if (session.gcConnection === 'relay' && !run.manualSent && lobbyView && !lobbyView.dolphin && Date.now() - run.hostingSince > 5000) {
    run.manualSent = true;
    lobby.send({ type: 'dolphinManual', relay: true });
  }
  // someone shows "doesn't have the game" though their Netcade found it: their Dolphin may still
  // have been loading its game list; ask everyone to look again (a few times at most)
  if (readiness && readiness.wrong.some((w) => w.status === 'missing' || w.status === 'unknown') && run.rechecks < 5 && Date.now() - run.lastRecheck > 4000) {
    run.rechecks++;
    run.lastRecheck = Date.now();
    run.control.send('recheck');
  }
  if (readiness?.ready && !run.autoStarted) startDolphinGame(false);
}

const START_ERRORS = {
  'not-all-have-game': 'Not everyone has the game yet.',
  'strict-sync-needs-fixed-resolution': '"Strict settings sync" needs a fixed graphics resolution (not Auto). Change it in Settings → Graphics, or turn strict sync off.',
  'game-not-in-list': 'Dolphin can\'t find your copy of the game.',
  'already-running': 'The game is already running.',
  'not-host': 'Only the host can start the game.',
};

/** Put players on the lobby's controller ports and start (force: even if someone isn't ready). */
async function startDolphinGame(force) {
  const run = gcRun;
  if (!run || run.starting || !run.control.connected || session?.role !== 'host') return { ok: false, error: 'not-ready' };
  run.starting = true;
  try {
    await run.control.send('pads', { ports: padsFromLobby(lobbyView?.members, lobbyView?.maxPlayers) });
    const r = await run.control.send('start', { force: !!force });
    if (gcRun !== run) return r;
    if (r.ok) {
      run.autoStarted = true;
      // Dolphin's "started" event can arrive before this reply; don't overwrite it
      setSession(session.started ? { startError: null } : { text: 'Starting the game…', startError: null });
    } else {
      if (r.error !== 'not-all-have-game') run.autoStarted = true;   // don't keep retrying a hard error
      setSession({ text: START_ERRORS[r.error] || `Dolphin couldn't start the game (${r.error}).`, startError: r.error });
    }
    return r;
  } finally {
    run.starting = false;
  }
}

function onDolphinEvent({ ev, detail }) {
  const host = session.role === 'host';
  switch (ev) {
    case 'started':
      setSession({ phase: 'playing', started: true, startError: null,
        text: session.spectate ? 'Watching. Enjoy the match!' : `Playing as P${session.port}. Press Esc in Dolphin to stop.` });
      overlay.notice('Game on!');
      break;
    case 'stopped':
      setSession({ text: host ? 'The game stopped. Press "Play again" to start another round.' : 'The game stopped. Waiting for the host…' });
      break;
    case 'desync': {
      const [who] = String(detail).split('@');
      overlay.notice(`Possible desync: ${who || 'a player'} may be out of sync. Restarting the game fixes it.`, 'warn', 9000);
      toast(`Possible desync with ${who || 'a player'}. If the game looks different for anyone, restart it.`, 'warn');
      break;
    }
    case 'lost':
      setSession({ text: 'Lost the connection to the host\'s session.' });
      break;
    case 'error':
      setSession({ text: `Couldn't connect to the host: ${detail || 'no reply'}.` });
      break;
    case 'failed':
      setSession({ text: detail === 'unreadable-game' ? 'Dolphin couldn\'t read your game file.'
        : detail === 'host' ? 'Dolphin couldn\'t open the session. Is another Dolphin hosting on this PC?'
          : 'Couldn\'t join the host\'s session. Try leaving and rejoining the lobby.' });
      break;
    case 'gameNotListed':
      setSession({ text: 'Dolphin is still looking for your game. Going ahead anyway…' });
      break;
    case 'startAborted':
      if (gcRun) gcRun.autoStarted = true;
      setSession({ text: 'Starting was cancelled. Press "Start now" to try again.' });
      break;
    case 'indexFailed':
      if (host && session.gcConnection === 'relay' && gcRun && !gcRun.manualSent) {
        gcRun.manualSent = true;
        lobby.send({ type: 'dolphinManual', relay: true });
      }
      break;
    default:
  }
}

const DOLPHIN_CMDS = new Set(['show', 'hide', 'buffer', 'options', 'recheck']);
handle('dolphin:cmd', async (cmd, args) => {
  if (!gcRun || !gcRun.control.connected) throw new Error('Dolphin isn\'t running in Netcade mode right now.');
  if (cmd === 'start') return startDolphinGame(!!args?.force);
  if (!DOLPHIN_CMDS.has(cmd)) throw new Error('not allowed');
  const r = await gcRun.control.send(cmd, args || {});
  if (!r.ok && r.error) throw new Error(r.error === 'host-only-before-start' ? 'Only the host can change that, before the game starts.' : r.error);
  return r;
});

/** NetPlay window options (host). Saved for next time and applied live if a session is open. */
handle('dolphin:setOptions', async (opts) => {
  const clean = dolphin.netplayOptions({ dolphinNetplay: { ...settings.dolphinNetplay, ...(opts || {}) } });
  settings.dolphinNetplay = clean;
  saveSettings();
  emit('settings', settings);
  if (gcRun?.control.connected && session?.role === 'host' && session.dolphin?.optionsEditable) {
    await gcRun.control.send('options', { options: clean });
  }
  return settings;
});

/** Lobby controller layout, for Dolphin's Assign Controller Ports step. */
function portLayout() {
  if (!lobbyView) return [];
  return lobbyView.members.filter((m) => m.port).map((m) => ({ port: m.port, name: m.name }));
}

/** Live port swap during an N64 match: switch our RetroArch between playing and watching. */
async function onNetplayMode(msg) {
  if (!session || session.system !== 'n64' || !session.cmdPort || !session.child) return;
  const wantPlay = msg.mode === 'play';
  if (session.playing === wantPlay) return;      // NETPLAY_GAME_WATCH toggles, so only send on a real change
  const ok = await retroarch.sendCommand(session.cmdPort, 'NETPLAY_GAME_WATCH');
  log('netplay mode ->', msg.mode, ok ? 'sent' : 'failed');
  setSession({
    playing: wantPlay, spectate: !wantPlay, port: wantPlay ? msg.port : null,
    text: wantPlay ? `You're in! Playing as P${msg.port}.` : 'You\'re watching now.',
  });
  overlay.notice(wantPlay ? `You're in: player ${msg.port}` : 'You\'re watching now');
}

function stopSession() {
  if (session?.child) {
    try { session.child.kill(); } catch { /* ignore */ }
  }
  if (session?.role === 'host' && lobbyView && lobbyView.state !== 'waiting') lobby.send({ type: 'endGame' });
  setSession(null);
}

// -------------------------------------------------------- embedded server
const { ShareTunnel } = require('./lib/shareTunnel');
const share = new ShareTunnel({ binDir: path.join(app.getPath('userData'), 'bin'), log });
share.on('status', (st) => emit('share', st));

async function applyEmbeddedServer() {
  const want = !!settings.embeddedServer?.enabled;
  if (!want && embedded) {
    share.stop();
    await embedded.close();
    embedded = null;
  }
  if (want && !embedded) {
    const { createServer } = require('./lib/server-embedded');
    embedded = createServer({ log: (...a) => log('[server]', ...a) });
    try {
      await embedded.listen(settings.embeddedServer.port || 8080, '0.0.0.0');
    } catch (err) {
      embedded = null;
      toast(`Could not start the local server: ${err.message}`, 'error');
    }
  }
  // internet sharing through a free Cloudflare tunnel
  const wantShare = !!(embedded && settings.embeddedServer?.share);
  if (wantShare && share.status.state === 'off') share.start(settings.embeddedServer.port || 8080);
  if (!wantShare && share.status.state !== 'off') share.stop();
}

/** Address friends should use for this player's current server. */
function inviteServer() {
  if (settings.embeddedServer?.enabled) {
    if (share.status.url) return share.status.url;
    const ip = emulators.lanAddresses()[0];
    return ip ? `http://${ip}:${settings.embeddedServer.port || 8080}` : '';
  }
  return (settings.serverUrl || '').trim();
}

/**
 * Join from an invite: a netcade:// link, or the whole invite message pasted into the join box.
 * If the invite names a different server, switch to it first, then join once connected.
 */
function joinFromInvite(text) {
  let { code, server } = require('./lib/invite').parseInvite(text);
  if (!code) throw new Error('No lobby code found in that invite.');
  const current = serverUrl().replace(/\/+$/, '');
  if (server && server !== current) {
    settings.serverUrl = server;
    settings.embeddedServer = { ...settings.embeddedServer, enabled: false };
    saveSettings();
    emit('settings', settings);
    applyEmbeddedServer().catch(() => {});
    pendingJoin = code;
    lobby.disconnect();
    sendHello();
    return { code, server, switched: true };
  }
  if (lobby.state === 'online') lobby.send({ type: 'join', code });
  else { pendingJoin = code; sendHello(); }
  return { code, server: current, switched: false };
}

// ------------------------------------------------------------------- misc
/**
 * macOS marks everything in a downloaded app as quarantined. Once the player has opened
 * Netcade, the built-in emulators inside it are trusted too, so clear the flag on them
 * (otherwise macOS may block them the first time Netcade launches them).
 */
function clearMacQuarantine() {
  if (process.platform !== 'darwin' || !BUNDLE || !app.isPackaged) return;
  require('child_process').execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', BUNDLE.dir], () => {});
}

function testServer(url) {
  return new Promise((resolve) => {
    let base;
    try { base = httpBase(url); } catch { return resolve({ ok: false, error: 'Invalid address' }); }
    const mod = base.startsWith('https') ? https : http;
    const req = mod.get(`${base}/health`, { timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({ ok: j.name === 'netcade-server', info: j, error: j.name === 'netcade-server' ? null : 'That address is not a Netcade server' });
        } catch {
          resolve({ ok: false, error: 'That address is not a Netcade server' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function handleProtocolUrl(url) {
  if (!/^netcade:\/\/join\//i.test(String(url || ''))) return;
  try { joinFromInvite(url); } catch (err) { toast(err.message, 'error'); }
  emit('navigate', 'online');
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}

// --------------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      log(`ipc ${channel} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

/** Library entries as shown in the UI and lobbies: with your own names applied. */
function displayGames() {
  return library.unique().map((g) => withName(g));
}
function withName(g) {
  const name = settings.gameNames?.[g.key];
  return name ? { ...g, title: name, originalTitle: g.title } : g;
}

function cachedCovers() {
  const out = {};
  for (const g of library.games) {
    const f = covers.cached(g.key);
    if (f) out[g.key] = coverUrl(f);
  }
  return out;
}

handle('covers:request', async (list) => {
  const games = (Array.isArray(list) ? list : []).slice(0, 500).map((g) => {
    const local = library.byKey(g.key);
    return local
      ? { key: local.key, system: local.system, title: local.title, region: local.region, rev: local.rev, file: local.file }
      : { key: String(g.key || ''), system: g.system, title: String(g.title || ''), region: String(g.region || ''), rev: +g.rev || 0 };
  });
  covers.request(games);
});

handle('state:get', async () => ({
  covers: cachedCovers(),
  settings,
  games: displayGames(),
  errors: library.errors,
  emulators: emuInfo,
  server: { state: lobby.state, me: lobby.me, url: serverUrl() },
  lobby: lobbyView ? { ...lobbyView, myHas, myId: lobby.me?.id } : null,
  session: session ? { ...session, child: undefined, tunnel: undefined } : null,
  platform: process.platform,
  appVersion: APP_VERSION,
  lanIps: emulators.lanAddresses(),
  downloadPages: emulators.DOWNLOAD_PAGES,
  setup,
  share: share.status,
  bundle: BUNDLE ? { builtAt: BUNDLE.builtAt, dolphin: BUNDLE.dolphin?.version, retroarch: BUNDLE.retroarch?.version, n64Core: BUNDLE.n64Core?.version } : null,
  defaultServerUrl: BUILD_CONFIG.defaultServerUrl || '',
}));

handle('settings:set', async (patch) => {
  const before = { name: settings.name, url: serverUrl(), emb: JSON.stringify(settings.embeddedServer), folders: JSON.stringify(settings.romFolders) };
  // arrays and control maps are replaced, not merged
  settings = deepMerge(settings, patch);
  for (const key of ['romFolders', 'favorites', 'recent']) if (patch && Array.isArray(patch[key])) settings[key] = patch[key];
  if (patch?.controls) {
    for (const sys of ['n64', 'gc']) {
      for (const mode of ['keyboard', 'gamepad']) {
        if (patch.controls[sys]?.[mode]) settings.controls[sys][mode] = patch.controls[sys][mode];
      }
    }
    const gc = patch.controls.gc;
    if (gc?.device) settings.controls.gc.device = { ...gc.device };   // a new pick replaces the old one
    // changing controls in Netcade means "use Netcade's controls" again
    if (gc && gc.useDolphin === undefined && (gc.mode || gc.keyboard || gc.gamepad || gc.device)) settings.controls.gc.useDolphin = false;
  }
  saveSettings();
  overlay.setChatKey(settings.chatKey);
  overlay.setLayout(settings.overlayLayout || 'auto');
  if (JSON.stringify(settings.embeddedServer) !== before.emb) await applyEmbeddedServer();
  if (settings.name !== before.name || serverUrl() !== before.url) {
    if (serverUrl() !== before.url) lobby.disconnect();
    sendHello();
  }
  if (JSON.stringify(settings.romFolders) !== before.folders) scanLibrary();
  if (patch && patch.emulatorSource !== undefined) {
    await refreshEmulators();
    if (patch.emulatorSource === 'bundled' && !BUNDLE) runEmulatorSetup();
  }
  emit('settings', settings);
  return settings;
});

handle('library:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder with your N64 / GameCube games', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return settings.romFolders;
  settings.romFolders = [...new Set([...settings.romFolders, ...r.filePaths])];
  saveSettings();
  emit('settings', settings);
  scanLibrary();
  return settings.romFolders;
});

handle('library:removeFolder', async (folder) => {
  settings.romFolders = settings.romFolders.filter((f) => f !== folder);
  saveSettings();
  emit('settings', settings);
  scanLibrary();
  return settings.romFolders;
});

handle('library:rescan', () => scanLibrary());

handle('library:favorite', async (key) => {
  const fav = new Set(settings.favorites);
  if (fav.has(key)) fav.delete(key); else fav.add(key);
  settings.favorites = [...fav];
  saveSettings();
  emit('settings', settings);
  return settings.favorites;
});

handle('library:reveal', async (key) => {
  const g = library.byKey(key);
  if (g) shell.showItemInFolder(g.path);
});

handle('emu:browse', async (kind) => {
  const filters = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [];
  const title = kind === 'core' ? 'Choose mupen64plus_next_libretro core file'
    : kind === 'dolphin' ? 'Find Dolphin (Dolphin.exe / Dolphin.app)' : 'Find RetroArch (retroarch.exe / RetroArch.app)';
  const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: kind === 'core' ? [] : filters });
  if (r.canceled || !r.filePaths[0]) return emuInfo;
  let p = r.filePaths[0];
  if (process.platform === 'darwin' && p.endsWith('.app')) p = path.join(p, 'Contents', 'MacOS', kind === 'dolphin' ? 'Dolphin' : 'RetroArch');
  settings.emulatorSource = 'custom';   // choosing a file means "use my own install"
  if (kind === 'dolphin') settings.dolphinPath = p;
  else if (kind === 'retroarch') settings.retroarchPath = p;
  else settings.n64CorePath = p;
  saveSettings();
  return refreshEmulators();
});

handle('emu:detect', async () => {
  settings.dolphinPath = emulators.exists(settings.dolphinPath) ? settings.dolphinPath : '';
  settings.retroarchPath = emulators.exists(settings.retroarchPath) ? settings.retroarchPath : '';
  return refreshEmulators(true);
});

handle('emu:setup', () => runEmulatorSetup());

// ------------------------------------------------- "Get the game" links
const source = require('./lib/source');
function rememberLink(key, link) {
  const clean = source.cleanUrl(link);
  if (link !== undefined) {
    settings.gameLinks = { ...(settings.gameLinks || {}) };
    if (clean) settings.gameLinks[key] = clean; else delete settings.gameLinks[key];
    saveSettings();
  }
  return clean;
}
/** Saved link for a game, plus a suggestion read from the downloaded file's "where from" note. */
handle('games:link', async (key) => {
  const g = library.byKey(key);
  const saved = settings.gameLinks?.[key] || '';
  let suggested = '';
  if (g) {
    // check every copy (unpacked file, zips) since any of them may carry the note
    for (const copy of library.games.filter((x) => x.key === key)) {
      suggested = await source.suggestFor(copy);
      if (suggested) break;
    }
  }
  return { saved, suggested, suggestedDomain: source.domainOf(suggested) };
});
/** Host: set or clear the link on the current lobby (remembered for this game). */
handle('lobby:setLink', async (link) => {
  if (!lobbyView) throw new Error('Not in a lobby.');
  const clean = rememberLink(lobbyView.game.key, link);
  if (link && !clean) throw new Error('That doesn\'t look like a web address (it should start with https://).');
  lobby.send({ type: 'setOptions', gameLink: clean });
  return clean;
});

// ------------------------------------------------- rename + custom covers
handle('games:rename', async (key, name) => {
  const clean = String(name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  settings.gameNames = { ...(settings.gameNames || {}) };
  if (clean) settings.gameNames[key] = clean; else delete settings.gameNames[key];
  saveSettings();
  emit('library', { games: displayGames(), errors: library.errors });
  return clean;
});
handle('games:coverFile', async (key) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a cover image', properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = await covers.setCustomFromFile(key, r.filePaths[0]);
  return coverUrl(file);
});
handle('games:coverUrl', async (key, url) => {
  const clean = source.cleanUrl(url);
  if (!clean) throw new Error('Paste a web address of an image (starting with https://).');
  const file = await covers.setCustomFromUrl(key, clean);
  return coverUrl(file);
});
handle('games:coverReset', async (key) => {
  covers.reset(key);
  const g = library.byKey(key);
  if (g) covers.request([{ key: g.key, system: g.system, title: g.title, region: g.region, rev: g.rev, file: g.file }]);
  return true;
});
handle('unpacked:info', async () => ({ bytes: unpacked.sizeBytes() }));
handle('unpacked:clear', async () => { unpacked.clear(); return { bytes: 0 }; });

handle('emu:installCore', async () => {
  const dest = await emulators.installN64Core(P.cores, (got, total) => emit('core-progress', { got, total }));
  settings.n64CorePath = dest;
  saveSettings();
  return refreshEmulators();
});

handle('play:solo', (key) => playSolo(key));
handle('session:stop', () => stopSession());

handle('lobby:create', async ({ key, public: isPublic, maxPlayers, password, forceRelay, link }) => {
  const g = library.byKey(key);
  if (!g) throw new Error('Pick a game from your library first.');
  const clean = rememberLink(key, link);
  if (!lobby.send({ type: 'create', system: g.system, game: { ...publicGame(withName(g)), link: clean }, public: !!isPublic, maxPlayers, password, forceRelay: forceRelay ?? settings.netplay.forceRelay })) {
    throw new Error('Not connected to the server. Check Settings → Online.');
  }
});

handle('lobby:setGame', async (key) => {
  const g = library.byKey(key);
  if (!g) throw new Error('Game not found');
  lobby.send({ type: 'setGame', system: g.system, game: { ...publicGame(withName(g)), link: settings.gameLinks?.[key] || '' } });
});

handle('lobby:send', async (msg) => {
  if (!msg || typeof msg.type !== 'string') throw new Error('bad message');
  const allowed = ['list', 'join', 'leave', 'chat', 'ready', 'kick', 'setOptions', 'start', 'endGame', 'dolphinManual',
    'requestPort', 'answerPort', 'cancelPort', 'spectate', 'setPort', 'tCreate', 'tSetup', 'tReport', 'tUndo', 'tEnd'];
  if (msg.type === 'answerPort') overlay.requestClosed(msg.reqId);
  if (!allowed.includes(msg.type)) throw new Error('not allowed');
  if (msg.type === 'start') msg.hostOptions = { n64Renderer: settings.graphics.n64Renderer, gcConnection: gcConnection() };
  if (!lobby.send(msg)) throw new Error('Not connected to the server.');
});

handle('server:test', (url) => testServer(url));
handle('server:reconnect', async () => { lobby.disconnect(); sendHello(); });
handle('lobby:joinInvite', async (text) => joinFromInvite(text));
handle('lobby:inviteServer', async () => inviteServer());
handle('share:retry', async () => {
  share.stop();
  await applyEmbeddedServer();
  return share.status;
});

handle('app:openExternal', async (url) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});
handle('app:openPath', async (which) => {
  const target = { logs: P.logs, data: USER, dolphin: P.dolphinUser, retroarch: P.retroarchData }[which];
  if (target) {
    fs.mkdirSync(target, { recursive: true });
    await shell.openPath(target);
  }
});
handle('app:copy', async (text) => clipboard.writeText(String(text)));

// -------------------------------------------------------------- lifecycle
function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b0d14',
    title: 'Netcade',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleProtocolUrl(url);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
    protocol.handle('netcade-cover', (req) => {
      const name = path.basename(new URL(req.url).pathname);
      if (!/^[0-9a-f]{20}(-c\d+)?\.(png|jpg|webp|gif)$/.test(name)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(COVER_DIR, name)).toString());
    });
    createWindow();
    overlay.setChatKey(settings.chatKey);
    clearMacQuarantine();
    await applyEmbeddedServer();
    refreshEmulators().catch((e) => log('emu refresh failed', e.message));
    if (!BUNDLE && settings.emulatorSource !== 'custom') runEmulatorSetup();
    else if (wantsNetcadeDolphinUpgrade()) {
      log('switching to the Netcade build of Dolphin');
      runEmulatorSetup(['dolphin']);
    }
    if (settings.romFolders.length) scanLibrary().catch((e) => log('scan failed', e.message));
    sendHello();
    const url = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleProtocolUrl(url);
    try {
      if (app.isPackaged) {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }
    } catch { /* updater optional */ }
  });

  app.on('will-quit', () => {
    try { require('electron').globalShortcut.unregisterAll(); } catch { /* ignore */ }
  });
  app.on('window-all-closed', () => {
    share.stop();
    if (session?.child) { try { session.child.kill(); } catch { /* ignore */ } }
    app.quit();
  });
  app.on('activate', () => {
    if (!win) createWindow();
  });
}
