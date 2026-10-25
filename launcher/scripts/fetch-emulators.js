#!/usr/bin/env node
/**
 * Build-time bundling: downloads the emulators into vendor/<os>-<arch>/ so electron-builder packs
 * them into the installer. (Installers built without this step download them on first launch.)
 *
 *   node scripts/fetch-emulators.js                      # current OS, all arches it builds
 *   node scripts/fetch-emulators.js --os win --arch x64
 *   node scripts/fetch-emulators.js --cache ~/netcade-downloads
 *   node scripts/fetch-emulators.js --offline-dir ./archives      # files you downloaded yourself
 *   node scripts/fetch-emulators.js --only dolphin,core
 */
'use strict';
const os = require('os');
const path = require('path');
const { fetchAll } = require('../lib/vendorFetch');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const HOST_OS = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const TARGET_OS = opt('os', HOST_OS);
const ARCHES = opt('arch', TARGET_OS === 'mac' ? 'x64,arm64' : 'x64').split(',');

function sevenZip() {
  try { return require('7zip-bin').path7za; } catch { return '7z'; }
}

(async () => {
  if (!['win', 'mac', 'linux'].includes(TARGET_OS)) throw new Error(`unknown --os ${TARGET_OS}`);
  for (const arch of ARCHES) {
    const outDir = path.join(__dirname, '..', 'vendor', `${TARGET_OS}-${arch}`);
    console.log(`[fetch-emulators] === ${TARGET_OS}-${arch} -> ${outDir}`);
    let lastPct = -1;
    const info = await fetchAll({
      os: TARGET_OS,
      arch,
      outDir,
      cacheDir: path.resolve(opt('cache', process.env.NETCADE_EMU_CACHE || path.join(os.tmpdir(), 'netcade-emulator-cache'))),
      offlineDir: opt('offline-dir', null),
      only: opt('only', null)?.split(','),
      sevenZip: sevenZip(),
      log: (m) => console.log(`[fetch-emulators] ${m}`),
      onProgress: ({ got, total }) => {
        const pct = total ? Math.floor((got / total) * 10) * 10 : -1;
        if (pct >= 0 && pct !== lastPct) { lastPct = pct; process.stdout.write(` ${pct}%`); if (pct === 100) process.stdout.write('\n'); }
      },
    });
    console.log(`[fetch-emulators] manifest: ${JSON.stringify(info)}`);
  }
})().catch((err) => {
  console.error(`\n[fetch-emulators] ERROR: ${err.message}\n`);
  process.exit(1);
});
