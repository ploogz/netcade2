'use strict';
/**
 * Box art from the libretro-thumbnails project (https://github.com/libretro-thumbnails), which
 * names covers after No-Intro / Redump titles, e.g. "Super Mario 64 (USA).png".
 *
 * Lookup order for a game:
 *   1. its file name, which for most dumps already is the No-Intro/Redump name
 *   2. a fuzzy match on title + region against the collection's file list (cached for 2 weeks)
 * Images are cached on disk; misses are retried after a week.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const REPOS = { n64: 'Nintendo_-_Nintendo_64', gc: 'Nintendo_-_GameCube' };
const RAW = 'https://raw.githubusercontent.com/libretro-thumbnails';
const INDEX_TTL = 14 * 24 * 3600 * 1000;
const MISS_TTL = 7 * 24 * 3600 * 1000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function get(url, { json = false, maxBytes = 12 * 1024 * 1024 } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'netcade', Accept: json ? 'application/vnd.github+json' : '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        resolve(get(new URL(res.headers.location, url).toString(), { json, maxBytes }, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error(`HTTP ${res.statusCode}`);
        e.status = res.statusCode;
        reject(e);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!json) return resolve(buf);
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** libretro-thumbnails replaces these characters with underscores in file names. */
function thumbName(name) {
  return name.replace(/[&*/:`<>?\\|"]/g, '_');
}

/** "Legend of Zelda, The - Ocarina of Time (USA) (Rev 2)" -> "legendofzeldaocarinaoftime" */
function norm(title) {
  return String(title || '')
    .replace(/\s*[([].*$/, '')               // drop (Region) [tags]
    .replace(/,\s*(the|a|an)\b/gi, '')         // "Legend of Zelda, The"
    .replace(/^(the|a|an)\s+/i, '')            // "The Legend of Zelda"
    .replace(/&/g, 'and')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const REGION_WORDS = {
  USA: ['USA', 'World', 'USA, Europe'], Europe: ['Europe', 'World', 'UK', 'Germany', 'France'], Japan: ['Japan'],
  Germany: ['Germany', 'Europe'], France: ['France', 'Europe'], Australia: ['Australia', 'Europe'],
};

/** Best entry from a list of cover file names (without .png) for a game, or null. */
function bestMatch(names, game) {
  const target = norm(game.title);
  if (!target) return null;
  const wantRegions = REGION_WORDS[game.region] || [game.region || 'USA', 'USA', 'World'];
  let best = null;
  let bestScore = -Infinity;
  for (const n of names) {
    if (norm(n) !== target) continue;
    const tags = (n.match(/\(([^)]*)\)/g) || []).map((t) => t.slice(1, -1));
    let score = 0;
    const regionTag = tags[0] || '';
    const ri = wantRegions.findIndex((r) => regionTag.split(/,\s*/).includes(r) || regionTag === r);
    score += ri === 0 ? 10 : ri > 0 ? 6 - ri : 0;
    if (/\[|\b(Beta|Proto|Demo|Sample|Kiosk|Unl|Hack)\b/i.test(n)) score -= 8;
    const rev = /Rev (\d+)/.exec(n);
    if ((rev ? +rev[1] : 0) === (game.rev || 0)) score += 2;
    score -= tags.length * 0.3;               // plainer names first
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}

class Covers {
  constructor({ dir, log = () => {}, onReady = () => {} }) {
    this.dir = dir;
    this.log = log;
    this.onReady = onReady;         // (key, fileName) when a cover lands
    this.mapFile = path.join(dir, 'map.json');
    this.map = {};
    this.indexes = {};
    this.queue = [];
    this.active = 0;
    this.inFlight = new Set();
    try { this.map = JSON.parse(fs.readFileSync(this.mapFile, 'utf8')) || {}; } catch { this.map = {}; }
  }

  fileFor(key) {
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.png';
  }

  /** Cached cover file name for a game key, or null. */
  cached(key) {
    const e = this.map[key];
    if (e && e.file && fs.existsSync(path.join(this.dir, e.file))) return e.file;
    return null;
  }

  saveMap() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.mapFile, JSON.stringify(this.map));
    } catch { /* not critical */ }
  }

  // ------------------------------------------------------------ custom covers
  /** Image type from the file's first bytes; null if it isn't a supported image. */
  static imageType(buf) {
    if (buf.length < 12) return null;
    if (buf.subarray(0, 4).equals(PNG_MAGIC)) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
    return null;
  }

  saveCustom(key, buf) {
    const type = Covers.imageType(buf);
    if (!type) throw new Error('That file isn\'t a PNG, JPG, WebP or GIF image.');
    if (buf.length > 15 * 1024 * 1024) throw new Error('That image is too big (15 MB max).');
    this.removeFile(key);
    // a new name each time, so the app shows the new picture instead of a cached one
    const file = `${this.fileFor(key).replace('.png', '')}-c${Date.now() % 1e9}.${type}`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, file), buf);
    this.map[key] = { file, custom: true };
    this.saveMap();
    return file;
  }

  async setCustomFromFile(key, src) {
    const st = await fs.promises.stat(src);
    if (!st.isFile()) throw new Error('Pick an image file.');
    if (st.size > 15 * 1024 * 1024) throw new Error('That image is too big (15 MB max).');
    return this.saveCustom(key, await fs.promises.readFile(src));
  }

  async setCustomFromUrl(key, url) {
    return this.saveCustom(key, await get(url, { maxBytes: 15 * 1024 * 1024 }));
  }

  removeFile(key) {
    const e = this.map[key];
    if (e && e.file) { try { fs.unlinkSync(path.join(this.dir, e.file)); } catch { /* gone */ } }
  }

  /** Forget the cover (custom or automatic) so the automatic lookup runs again. */
  reset(key) {
    this.removeFile(key);
    delete this.map[key];
    this.saveMap();
  }

  /** games: [{ key, system, title, region, rev, file? }] */
  request(games) {
    for (const g of games) {
      if (!g || !g.key || !REPOS[g.system]) continue;
      if (this.cached(g.key)) { this.onReady(g.key, this.map[g.key].file); continue; }
      const e = this.map[g.key];
      if (e && e.miss && Date.now() - e.miss < MISS_TTL) continue;
      if (this.inFlight.has(g.key)) continue;
      this.inFlight.add(g.key);
      this.queue.push(g);
    }
    this.pump();
  }

  pump() {
    while (this.active < 3 && this.queue.length) {
      const g = this.queue.shift();
      this.active++;
      this.resolve(g)
        .then((file) => {
          if (file) {
            this.map[g.key] = { file };
            this.onReady(g.key, file);
          } else {
            this.map[g.key] = { miss: Date.now() };
          }
          this.saveMap();
        })
        .catch((err) => this.log('cover failed', g.title, err.message))
        .finally(() => {
          this.active--;
          this.inFlight.delete(g.key);
          this.pump();
        });
    }
  }

  async index(system) {
    if (this.indexes[system]) return this.indexes[system];
    const file = path.join(this.dir, `index-${system}.json`);
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - cached.fetchedAt < INDEX_TTL && cached.names?.length) {
        this.indexes[system] = new Set(cached.names);
        return this.indexes[system];
      }
    } catch { /* fetch it */ }
    const tree = await get(`https://api.github.com/repos/libretro-thumbnails/${REPOS[system]}/git/trees/master?recursive=1`, { json: true, maxBytes: 40 * 1024 * 1024 });
    const names = (tree.tree || [])
      .map((t) => t.path)
      .filter((p) => p.startsWith('Named_Boxarts/') && p.endsWith('.png'))
      .map((p) => p.slice('Named_Boxarts/'.length, -4));
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), names }));
    this.indexes[system] = new Set(names);
    return this.indexes[system];
  }

  /** Download one cover (following the collection's symlinks). Returns a PNG buffer or null. */
  async download(system, name, hops = 0) {
    const url = `${RAW}/${REPOS[system]}/master/Named_Boxarts/${encodeURIComponent(thumbName(name))}.png`;
    let buf;
    try {
      buf = await get(url);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    if (buf.subarray(0, 4).equals(PNG_MAGIC)) return buf;
    // a git symlink downloads as the text of its target, e.g. "007 - Agent Under Fire (USA).png"
    const target = buf.toString('utf8').trim();
    if (hops < 2 && buf.length < 400 && target.endsWith('.png')) {
      return this.download(system, path.posix.basename(target, '.png'), hops + 1);
    }
    return null;
  }

  async resolve(g) {
    const stem = g.file ? g.file.replace(/\.[^.]+$/, '') : '';
    let index = null;
    try { index = await this.index(g.system); } catch (e) { this.log('cover index unavailable', e.message); }
    const tries = [];
    if (stem && (!index || index.has(thumbName(stem)))) tries.push(stem);
    if (index) {
      const m = bestMatch([...index], g);
      if (m && !tries.includes(m)) tries.push(m);
    } else {
      // no list available: guess the common No-Intro form from title and region
      const base = g.title.replace(/^The (.+?)( - .*)?$/, (all, t, rest) => `${t}, The${rest || ''}`);
      tries.push(`${base} (${g.region || 'USA'})`);
    }
    for (const name of tries) {
      const png = await this.download(g.system, name);
      if (png) {
        const file = this.fileFor(g.key);
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, file), png);
        this.log('cover', g.title, '->', name);
        return file;
      }
    }
    return null;
  }
}

module.exports = { Covers, bestMatch, norm, thumbName };
