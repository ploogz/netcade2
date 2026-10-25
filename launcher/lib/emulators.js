'use strict';
/**
 * Finding, versioning and launching the emulators Netcade drives:
 *   - Dolphin (GameCube)   https://dolphin-emu.org/download/
 *   - RetroArch + Mupen64Plus-Next core (N64)   https://www.retroarch.com/?page=platforms
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFile } = require('child_process');

const PLATFORM = process.platform;
const HOME = os.homedir();

const DOWNLOAD_PAGES = {
  dolphin: 'https://dolphin-emu.org/download/',
  retroarch: 'https://www.retroarch.com/?page=platforms',
};

const FLATPAK_IDS = { dolphin: 'org.DolphinEmu.dolphin-emu', retroarch: 'org.libretro.RetroArch' };

function env(name) {
  return process.env[name] || '';
}

function candidates(kind) {
  const pf = env('ProgramFiles') || 'C:\\Program Files';
  const pf86 = env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
  const local = env('LOCALAPPDATA');
  const roaming = env('APPDATA');
  if (PLATFORM === 'win32') {
    if (kind === 'dolphin') {
      return [
        path.join(pf, 'Dolphin', 'Dolphin.exe'),
        path.join(pf, 'Dolphin-x64', 'Dolphin.exe'),
        path.join(local, 'Programs', 'Dolphin', 'Dolphin.exe'),
        path.join(HOME, 'Dolphin-x64', 'Dolphin.exe'),
        path.join(HOME, 'Downloads', 'Dolphin-x64', 'Dolphin.exe'),
        path.join(HOME, 'Desktop', 'Dolphin-x64', 'Dolphin.exe'),
        'C:\\Dolphin-x64\\Dolphin.exe',
        'C:\\Emulators\\Dolphin-x64\\Dolphin.exe',
      ];
    }
    return [
      'C:\\RetroArch-Win64\\retroarch.exe',
      path.join(roaming, 'RetroArch', 'retroarch.exe'),
      path.join(pf, 'RetroArch', 'retroarch.exe'),
      path.join(pf, 'RetroArch-Win64', 'retroarch.exe'),
      path.join(pf86, 'Steam', 'steamapps', 'common', 'RetroArch', 'retroarch.exe'),
      path.join(HOME, 'RetroArch-Win64', 'retroarch.exe'),
      'C:\\Emulators\\RetroArch-Win64\\retroarch.exe',
    ];
  }
  if (PLATFORM === 'darwin') {
    if (kind === 'dolphin') return ['/Applications/Dolphin.app/Contents/MacOS/Dolphin', path.join(HOME, 'Applications/Dolphin.app/Contents/MacOS/Dolphin')];
    return ['/Applications/RetroArch.app/Contents/MacOS/RetroArch', path.join(HOME, 'Applications/RetroArch.app/Contents/MacOS/RetroArch')];
  }
  // linux
  if (kind === 'dolphin') return ['/usr/bin/dolphin-emu', '/usr/local/bin/dolphin-emu', '/usr/games/dolphin-emu', path.join(HOME, '.local/bin/dolphin-emu')];
  return ['/usr/bin/retroarch', '/usr/local/bin/retroarch', '/usr/games/retroarch', path.join(HOME, '.local/bin/retroarch'),
    path.join(HOME, '.steam/steam/steamapps/common/RetroArch/retroarch')];
}

function flatpakInstalled(id) {
  if (PLATFORM !== 'linux') return false;
  return [path.join(HOME, '.local/share/flatpak/app', id), path.join('/var/lib/flatpak/app', id)].some((p) => fs.existsSync(p));
}

/** Returns a path, "flatpak:<id>", or '' if nothing found. */
function detect(kind) {
  for (const c of candidates(kind)) {
    try {
      if (c && fs.statSync(c).isFile()) return c;
    } catch { /* keep looking */ }
  }
  if (flatpakInstalled(FLATPAK_IDS[kind])) return `flatpak:${FLATPAK_IDS[kind]}`;
  return '';
}

function exists(exe) {
  if (!exe) return false;
  if (exe.startsWith('flatpak:')) return flatpakInstalled(exe.slice(8));
  try {
    return fs.statSync(exe).isFile();
  } catch {
    return false;
  }
}

/** Build [cmd, args] for an exe setting, wrapping flatpak apps with access to the folders we use. */
function command(exe, args, extraFolders = []) {
  if (exe.startsWith('flatpak:')) {
    const fsArgs = [...new Set(extraFolders.filter(Boolean))].map((f) => `--filesystem=${f}`);
    return ['flatpak', ['run', ...fsArgs, exe.slice(8), ...args]];
  }
  return [exe, args];
}

function run(exe, args, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const [cmd, a] = command(exe, args);
    execFile(cmd, a, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve(`${stdout || ''}\n${stderr || ''}`.trim());
    });
  });
}

function winFileVersion(exe) {
  if (PLATFORM !== 'win32' || exe.startsWith('flatpak:')) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

async function version(kind, exe) {
  if (!exists(exe)) return '';
  let out = await run(exe, ['--version']);
  let m = kind === 'retroarch'
    ? /v?(\d+\.\d+\.\d+[\w.-]*)/.exec(out)
    : /(\d+\.\d+(?:-\d+)?(?:-dirty)?)/.exec(out);
  if (m) return m[1];
  out = await winFileVersion(exe);
  m = /(\d+[\d.\-]+\w*)/.exec(out);
  return m ? m[1] : '';
}

// ------------------------------------------------------------- N64 core
const CORE_FILE = PLATFORM === 'win32' ? 'mupen64plus_next_libretro.dll'
  : PLATFORM === 'darwin' ? 'mupen64plus_next_libretro.dylib' : 'mupen64plus_next_libretro.so';

function coreDownloadUrl() {
  if (PLATFORM === 'win32') return `https://buildbot.libretro.com/nightly/windows/x86_64/latest/${CORE_FILE}.zip`;
  if (PLATFORM === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    return `https://buildbot.libretro.com/nightly/apple/osx/${arch}/latest/${CORE_FILE}.zip`;
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `https://buildbot.libretro.com/nightly/linux/${arch}/latest/${CORE_FILE}.zip`;
}

function findN64Core(retroarchExe, ownCoresDir) {
  const list = [path.join(ownCoresDir, CORE_FILE)];
  if (retroarchExe && !retroarchExe.startsWith('flatpak:')) {
    const dir = path.dirname(retroarchExe);
    list.push(path.join(dir, 'cores', CORE_FILE));
    if (PLATFORM === 'darwin') list.push(path.join(HOME, 'Library/Application Support/RetroArch/cores', CORE_FILE));
  }
  if (PLATFORM === 'win32') list.push(path.join(env('APPDATA'), 'RetroArch', 'cores', CORE_FILE));
  if (PLATFORM === 'linux') {
    list.push(path.join(HOME, '.config/retroarch/cores', CORE_FILE), `/usr/lib/libretro/${CORE_FILE}`,
      `/usr/lib/x86_64-linux-gnu/libretro/${CORE_FILE}`, `/usr/lib64/libretro/${CORE_FILE}`,
      path.join(HOME, '.var/app/org.libretro.RetroArch/config/retroarch/cores', CORE_FILE));
  }
  return list.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || '';
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Netcade' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed (HTTP ${res.statusCode})`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress) onProgress(got, total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function installN64Core(coresDir, onProgress) {
  const AdmZip = require('adm-zip');
  fs.mkdirSync(coresDir, { recursive: true });
  const tmp = path.join(coresDir, `${CORE_FILE}.zip.part`);
  await download(coreDownloadUrl(), tmp, onProgress);
  const zip = new AdmZip(tmp);
  const entry = zip.getEntries().find((e) => path.basename(e.entryName) === CORE_FILE);
  if (!entry) throw new Error('Core archive did not contain the expected file.');
  fs.writeFileSync(path.join(coresDir, CORE_FILE), entry.getData());
  fs.unlinkSync(tmp);
  return path.join(coresDir, CORE_FILE);
}

/**
 * Spawn an emulator. Output goes to a log file so problems can be diagnosed later.
 * Returns the ChildProcess.
 */
function launch(exe, args, { logFile, folders = [], cwd, env } = {}) {
  const [cmd, a] = command(exe, args, folders);
  let out = 'ignore';
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.openSync(logFile, 'w');
    fs.writeSync(out, `> ${cmd} ${a.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}\n\n`);
  }
  const child = spawn(cmd, a, {
    cwd: cwd || (exe.startsWith('flatpak:') ? undefined : path.dirname(exe)),
    stdio: ['ignore', out, out],
    windowsHide: false,
    detached: false,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (typeof out === 'number') child.on('exit', () => { try { fs.closeSync(out); } catch { /* ignore */ } });
  return child;
}

// ------------------------------------------------------------- bundled emulators
const OS_TAG = { win32: 'win', darwin: 'mac', linux: 'linux' }[PLATFORM];

/**
 * Emulators shipped inside the installer (see scripts/fetch-emulators.js).
 * Packaged app: <resources>/vendor. Development: launcher/vendor/<os>-<arch>.
 * Returns null when no bundle is present.
 */
function bundled({ resourcesPath, appPath, isPackaged, extraDirs = [] }) {
  const dirs = [
    ...(isPackaged ? [path.join(resourcesPath, 'vendor')] : [path.join(appPath, 'vendor', `${OS_TAG}-${process.arch}`)]),
    ...extraDirs,
  ];
  for (const dir of dirs) {
    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      continue;
    }
    const abs = (rel) => (rel ? path.join(dir, rel) : '');
    const ok = (p) => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    };
    const out = {
      dir,
      dolphin: m.dolphin && ok(abs(m.dolphin.exe)) ? { path: abs(m.dolphin.exe), version: m.dolphin.version } : null,
      retroarch: m.retroarch && ok(abs(m.retroarch.exe)) ? { path: abs(m.retroarch.exe), version: m.retroarch.version } : null,
      n64Core: m.n64core && ok(abs(m.n64core.file)) ? { path: abs(m.n64core.file), version: m.n64core.version, sha1: m.n64core.sha1 } : null,
      autoconfig: m.autoconfig ? abs(m.autoconfig.dir) : '',
      builtAt: m.builtAt,
    };
    // AppImage contents lose the executable bit in some archive tools; restore it
    for (const e of [out.dolphin, out.retroarch]) {
      if (e && PLATFORM !== 'win32') { try { fs.chmodSync(e.path, 0o755); } catch { /* read-only install */ } }
    }
    if (out.dolphin || out.retroarch) return out;
  }
  return null;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

module.exports = {
  OS_TAG,
  PLATFORM, DOWNLOAD_PAGES, CORE_FILE, detect, exists, version, command, launch,
  findN64Core, installN64Core, coreDownloadUrl, lanAddresses, bundled,
};
