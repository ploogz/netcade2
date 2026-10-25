'use strict';
/**
 * Game library: scans the user's folders for N64/GameCube files and caches what it learns,
 * so rescans only re-read files that changed.
 */
const fs = require('fs');
const path = require('path');
const { readRomInfo, systemForFile } = require('./romInfo');
const { isArchive, scanArchive } = require('./archives');

const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '.git', '.trash']);

class Library {
  /** sevenZip: () => path of the 7-Zip program (for .zip/.7z); omit to skip archives */
  constructor(cacheFile, sevenZip = null) {
    this.cacheFile = cacheFile;
    this.sevenZip = sevenZip;
    this.games = [];
    this.errors = [];
    this.cache = {};
    try {
      this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
      this.games = Object.values(this.cache).flatMap((g) => (g && g.games ? g.games : [g])).filter((g) => g && g.key);
    } catch {
      this.cache = {};
    }
    this.scanning = null;
  }

  async listFiles(folder, depth = 0, out = []) {
    let entries;
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(folder, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) {
          await this.listFiles(p, depth + 1, out);
        }
      } else if ((e.isFile() || e.isSymbolicLink()) && (systemForFile(e.name) || (this.sevenZip && isArchive(e.name)))) {
        out.push(p);
      }
    }
    return out;
  }

  /** Scan all folders; onProgress(done, total, file). Concurrent calls share one scan. */
  scan(folders, onProgress = () => {}) {
    if (this.scanning) return this.scanning;
    this.scanning = this._scan(folders, onProgress).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _scan(folders, onProgress) {
    const files = [];
    for (const f of folders) await this.listFiles(f, 0, files);
    const unique = [...new Set(files)];
    const nextCache = {};
    const games = [];
    const errors = [];
    let done = 0;
    for (const file of unique) {
      onProgress(done, unique.length, path.basename(file));
      try {
        const st = await fs.promises.stat(file);
        const cached = this.cache[file];
        const fresh = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs;
        if (isArchive(file)) {
          // one archive can hold several games; a zip with no games in it is simply skipped
          let entry = fresh && cached.games ? cached : null;
          if (!entry) {
            const r = await scanArchive(this.sevenZip(), file);
            entry = { archive: true, size: st.size, mtimeMs: st.mtimeMs, games: r.games };
            errors.push(...r.errors);
          }
          nextCache[file] = entry;
          games.push(...entry.games);
        } else {
          const info = fresh ? cached : await readRomInfo(file);
          nextCache[file] = info;
          games.push(info);
        }
      } catch (err) {
        errors.push({ file, error: err.message });
      }
      done++;
      // keep the UI responsive during long N64 hashing runs
      if (done % 8 === 0) await new Promise((r) => setImmediate(r));
    }
    onProgress(done, unique.length, '');
    games.sort((a, b) => a.title.localeCompare(b.title));
    this.games = games;
    this.errors = errors;
    this.cache = nextCache;
    try {
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.promises.writeFile(this.cacheFile, JSON.stringify(nextCache));
    } catch {
      /* cache is optional */
    }
    return { games, errors };
  }

  /** The game with this fingerprint, preferring an unpacked copy over one inside an archive. */
  byKey(key) {
    return this.games.find((g) => g.key === key && !g.archive) || this.games.find((g) => g.key === key) || null;
  }

  /** Library entries with duplicates (same game unpacked and zipped) folded together. */
  unique() {
    const seen = new Map();
    for (const g of this.games) {
      const prev = seen.get(g.key);
      if (!prev || (prev.archive && !g.archive)) seen.set(g.key, g);
    }
    return [...seen.values()];
  }
}

module.exports = { Library };
