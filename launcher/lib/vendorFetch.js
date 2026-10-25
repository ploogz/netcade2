'use strict';
/**
 * Downloads and unpacks the emulators Netcade runs (Dolphin, RetroArch, the N64 core, controller
 * profiles and, on Windows, the VC++ runtime installer) into <outDir>, plus a manifest.json.
 *
 * Used two ways:
 *   - at build time by scripts/fetch-emulators.js (emulators packed inside the installer)
 *   - at runtime by the app on first launch, when the installer didn't include them
 *
 * Everything here is async so the app's window stays responsive while it works.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MANIFEST = require('../emulators.json');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message += `\n${stderr || ''}`;
        reject(err);
      } else resolve(stdout);
    });
  });
}

function request(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const h = { 'User-Agent': 'netcade', ...headers };
    if (url.startsWith('https://api.github.com') && process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, { headers: h }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), headers, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed (HTTP ${res.statusCode}) for ${url}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(60000, () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on('error', reject);
  });
}

async function getJson(url) {
  const res = await request(url, { Accept: 'application/vnd.github+json' });
  let body = '';
  for await (const c of res) body += c;
  return JSON.parse(body);
}

function findFile(dir, test, depth = 6) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (test(e.name, e.isDirectory())) return p;
    if (e.isDirectory() && depth > 0 && !e.name.endsWith('.app')) {
      const r = findFile(p, test, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
}

function rmMany(dir, names) {
  for (const n of names) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

function sha1(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/**
 * opts: {
 *   os: 'win'|'mac'|'linux', arch: 'x64'|'arm64', outDir,
 *   cacheDir, offlineDir, sevenZip (path to 7za), mirror (base URL, for tests),
 *   only: ['dolphin','retroarch','core','autoconfig','vcredist'],
 *   onProgress({ step, label, got, total }), log(msg)
 * }
 */
async function fetchAll(opts) {
  const target = { os: opts.os, arch: opts.arch };
  const outDir = opts.outDir;
  const log = opts.log || (() => {});
  const progress = opts.onProgress || (() => {});
  const want = (k) => !opts.only || opts.only.includes(k);
  const cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'netcade-emulator-cache');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-fetch-'));
  let step = '';
  let label = '';

  async function download(url) {
    if (opts.mirror) url = `${opts.mirror.replace(/\/$/, '')}/${new URL(url).pathname.split('/').pop()}`;
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'download';
    if (opts.offlineDir) {
      const p = path.join(opts.offlineDir, name);
      if (!fs.existsSync(p)) throw new Error(`${name} is missing from ${opts.offlineDir} (expected from ${url})`);
      return p;
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
    const dest = path.join(cacheDir, `${key}-${name}`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0 && !url.includes('/latest/')) {
      log(`cached ${name}`);
      return dest;
    }
    log(`download ${url}`);
    const res = await request(url);
    const total = +res.headers['content-length'] || 0;
    let got = 0;
    let last = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest + '.part');
      res.on('data', (c) => {
        got += c.length;
        const now = Date.now();
        if (now - last > 250) { last = now; progress({ step, label, got, total }); }
      });
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      res.on('error', reject);
    });
    progress({ step, label, got, total });
    fs.renameSync(dest + '.part', dest);
    return dest;
  }

  async function extract7z(archive, dir) {
    progress({ step, label: `${label} (unpacking)`, got: 0, total: 0 });
    fs.mkdirSync(dir, { recursive: true });
    await run(opts.sevenZip || '7z', ['x', '-y', `-o${dir}`, archive]);
  }

  function extractZip(archive, dir) {
    const AdmZip = require('adm-zip');
    new AdmZip(archive).extractAllTo(dir, true);
  }

  async function extractAppFromDmg(dmg, appName, destDir) {
    if (process.platform !== 'darwin') throw new Error('Unpacking .dmg files needs macOS.');
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-dmg-'));
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
    try {
      const app = findFile(mount, (n, isDir) => isDir && n === appName, 2);
      if (!app) throw new Error(`${appName} not found inside ${path.basename(dmg)}`);
      fs.mkdirSync(destDir, { recursive: true });
      await run('ditto', [app, path.join(destDir, appName)]);
    } finally {
      await run('hdiutil', ['detach', mount, '-force']).catch(() => {});
    }
  }

  async function unpackAppImage(appImage, destDir) {
    if (process.platform !== 'linux') throw new Error('Unpacking AppImages needs Linux.');
    const dir = fs.mkdtempSync(path.join(work, 'appimage-'));
    const copy = path.join(dir, 'app.AppImage');
    fs.copyFileSync(appImage, copy);
    fs.chmodSync(copy, 0o755);
    progress({ step, label: `${label} (unpacking)`, got: 0, total: 0 });
    await run(copy, ['--appimage-extract'], { cwd: dir });
    const root = path.join(dir, 'squashfs-root');
    if (!fs.existsSync(path.join(root, 'AppRun'))) throw new Error(`AppRun missing after extracting ${path.basename(appImage)}`);
    fs.rmSync(destDir, { recursive: true, force: true });
    copyDir(root, destDir);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  let info = {};
  try { info = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* fresh */ }
  info.builtAt = new Date().toISOString().slice(0, 10);
  info.os = target.os;
  info.arch = target.arch;

  try {
    // ------------------------------------------------------------ Dolphin
    if (want('dolphin')) {
      const m = MANIFEST.dolphin;
      step = 'dolphin';
      label = `Dolphin ${m.version}`;
      const dest = path.join(outDir, 'dolphin');
      fs.rmSync(dest, { recursive: true, force: true });
      if (target.os === 'win') {
        const tmp = fs.mkdtempSync(path.join(work, 'dolphin-'));
        // Netcade's own build when available: shipped inside the installer, or from its download link
        const ncLocal = opts.netcadeDolphinArchive && fs.existsSync(opts.netcadeDolphinArchive) ? opts.netcadeDolphinArchive : null;
        const ncUrl = m.netcade?.['win-x64']?.url || '';
        const archive = ncLocal || (ncUrl ? await download(ncUrl) : await download(m['win-x64'].url));
        await extract7z(archive, tmp);
        const exe = findFile(tmp, (n) => n === 'Dolphin.exe');
        if (!exe) throw new Error('Dolphin.exe not found in the Dolphin archive');
        copyDir(path.dirname(exe), dest);
        const netcade = fs.existsSync(path.join(dest, 'Netcade.txt'));
        info.dolphin = { version: netcade ? (m.netcade?.version || `${m.version}-netcade`) : m.version, exe: 'dolphin/Dolphin.exe', netcade };
        if (netcade) label = `Dolphin ${m.version} (Netcade build)`;
      } else if (target.os === 'mac') {
        await extractAppFromDmg(await download(m.mac.url), m.mac.app, dest);
        info.dolphin = { version: m.version, exe: `dolphin/${m.mac.exe}` };
      } else {
        const spec = m['linux-x64'];
        const releases = await getJson(opts.mirror
          ? `${opts.mirror.replace(/\/$/, '')}/releases.json`
          : `https://api.github.com/repos/${spec.github}/releases?per_page=40`);
        const rel = releases.find((r) => r.tag_name.startsWith(spec.tagPrefix));
        if (!rel) throw new Error(`No Linux build of Dolphin ${m.version} is available yet (newest: ${releases.slice(0, 3).map((r) => r.tag_name).join(', ')}).`);
        const asset = rel.assets.find((a) => new RegExp(spec.assetPattern).test(a.name));
        if (!asset) throw new Error(`Release ${rel.tag_name} has no AppImage for this computer`);
        await unpackAppImage(await download(asset.browser_download_url), dest);
        info.dolphin = { version: m.version, exe: 'dolphin/AppRun', appimageRelease: rel.tag_name };
      }
      log(`${label} ready`);
    }

    // ------------------------------------------------------------ RetroArch
    if (want('retroarch')) {
      const m = MANIFEST.retroarch;
      step = 'retroarch';
      label = `RetroArch ${m.version}`;
      const dest = path.join(outDir, 'retroarch');
      fs.rmSync(dest, { recursive: true, force: true });
      if (target.os === 'win') {
        const tmp = fs.mkdtempSync(path.join(work, 'ra-'));
        await extract7z(await download(m['win-x64'].url), tmp);
        const exe = findFile(tmp, (n) => n.toLowerCase() === 'retroarch.exe');
        if (!exe) throw new Error('retroarch.exe not found in the RetroArch archive');
        copyDir(path.dirname(exe), dest);
        // Netcade drives RetroArch directly; menu artwork, shaders and databases aren't needed
        rmMany(dest, ['assets', 'overlays', 'shaders', 'database', 'cheats', 'downloads', 'thumbnails', 'cores', 'retroarch_debug.exe']);
        info.retroarch = { version: m.version, exe: 'retroarch/retroarch.exe' };
      } else if (target.os === 'mac') {
        await extractAppFromDmg(await download(m.mac.url), m.mac.app, dest);
        info.retroarch = { version: m.version, exe: `retroarch/${m.mac.exe}` };
      } else {
        const tmp = fs.mkdtempSync(path.join(work, 'ra-'));
        await extract7z(await download(m['linux-x64'].url), tmp);
        const appImage = findFile(tmp, (n) => /\.AppImage$/.test(n));
        if (!appImage) throw new Error('RetroArch AppImage not found in the Linux archive');
        await unpackAppImage(appImage, dest);
        info.retroarch = { version: m.version, exe: 'retroarch/AppRun' };
      }
      log(`${label} ready`);
    }

    // ------------------------------------------------------------ N64 core
    if (want('core')) {
      step = 'core';
      label = 'N64 core';
      const url = MANIFEST.n64core[`${target.os}-${target.arch}`] || MANIFEST.n64core[`${target.os}-x64`];
      if (!url) throw new Error(`No N64 core for ${target.os}-${target.arch}`);
      const dir = path.join(outDir, 'cores');
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      extractZip(await download(url), dir);
      const file = fs.readdirSync(dir).find((f) => f.startsWith('mupen64plus_next_libretro'));
      if (!file) throw new Error('N64 core file missing from its zip');
      const hash = sha1(path.join(dir, file));
      info.n64core = { file: `cores/${file}`, sha1: hash, version: `${MANIFEST.n64core.name} ${hash.slice(0, 8)}`, fetchedFrom: url };
      log(`N64 core ready (${hash.slice(0, 8)})`);
    }

    // ------------------------------------------------------------ controller profiles
    if (want('autoconfig')) {
      step = 'autoconfig';
      label = 'Controller profiles';
      const m = MANIFEST.autoconfig;
      const tmp = fs.mkdtempSync(path.join(work, 'autoconfig-'));
      extractZip(await download(m.url), tmp);
      const root = findFile(tmp, (n, isDir) => isDir && n.startsWith('retroarch-joypad-autoconfig'), 1) || tmp;
      const dest = path.join(outDir, 'autoconfig');
      fs.rmSync(dest, { recursive: true, force: true });
      let count = 0;
      for (const d of m.drivers[target.os]) {
        if (fs.existsSync(path.join(root, d))) {
          copyDir(path.join(root, d), path.join(dest, d));
          count += fs.readdirSync(path.join(dest, d)).length;
        }
      }
      if (!count) throw new Error('No controller profiles were found');
      info.autoconfig = { dir: 'autoconfig', profiles: count };
      log(`${count} controller profiles ready`);
    }

    // ------------------------------------------------------------ VC++ runtime (Windows)
    if (want('vcredist') && target.os === 'win') {
      step = 'vcredist';
      label = 'Microsoft Visual C++ runtime';
      fs.copyFileSync(await download(MANIFEST.vcredist.url), path.join(outDir, 'vc_redist.x64.exe'));
      info.vcredist = 'vc_redist.x64.exe';
    }

    writeNotices(outDir, info);
    fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
    progress({ step: 'done', label: 'Done', got: 1, total: 1 });
    return info;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function writeNotices(out, info) {
  const lic = path.join(out, 'LICENSES');
  fs.mkdirSync(lic, { recursive: true });
  const lines = [
    '# Third-party software used by Netcade',
    '',
    'Netcade launches these programs as separate processes. They are free software; you can get',
    'their complete source code from the links below, and you may redistribute and modify them',
    'under their licenses.',
    '',
    `- **Dolphin ${MANIFEST.dolphin.version}** (${MANIFEST.dolphin.license}): ${MANIFEST.dolphin.source}`,
    info.dolphin?.appimageRelease ? `  - Linux build: ${MANIFEST.dolphin['linux-x64'].github} release ${info.dolphin.appimageRelease}` : null,
    `- **RetroArch ${MANIFEST.retroarch.version}** (${MANIFEST.retroarch.license}): ${MANIFEST.retroarch.source}`,
    `- **${MANIFEST.n64core.name}** (${MANIFEST.n64core.license}): ${MANIFEST.n64core.source} (build sha1 ${info.n64core?.sha1 || 'n/a'}, fetched ${info.builtAt})`,
    `- **RetroArch joypad autoconfig profiles**: ${MANIFEST.autoconfig.source}`,
    info.vcredist ? '- **Microsoft Visual C++ Redistributable**: redistributed under the Microsoft Visual Studio license terms' : null,
    '',
    'Full license texts: https://www.gnu.org/licenses/gpl-2.0.txt and https://www.gnu.org/licenses/gpl-3.0.txt',
    '',
    'No games, BIOS files or other copyrighted game data are included.',
  ].filter((x) => x !== null);
  fs.writeFileSync(path.join(lic, 'THIRD_PARTY.md'), lines.join('\n') + '\n');
}

/** Rough download size for the progress UI. */
const APPROX_DOWNLOAD_MB = { win: 280, mac: 300, linux: 290 };

module.exports = { fetchAll, APPROX_DOWNLOAD_MB };
