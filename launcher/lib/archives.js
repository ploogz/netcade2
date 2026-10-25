'use strict';
/**
 * Games inside .zip and .7z archives, using the 7-Zip that ships with Netcade.
 *
 *  - scan:    list an archive and identify each N64/GameCube game in it without unpacking to disk
 *             (N64 ROMs are streamed through a hash; GameCube only needs the first 33 KB).
 *             A zipped game gets the same fingerprint as the unpacked file, so lobby matching works.
 *  - extract: unpack one game into Netcade's cache right before it is played (see ExtractCache).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { n64Format, n64Info, gcInfoFromHead, GC_HEAD_BYTES, N64_EXT, GC_EXT } = require('./romInfo');

const ARCHIVE_EXT = new Set(['.zip', '.7z']);
const isArchive = (file) => ARCHIVE_EXT.has(path.extname(file).toLowerCase());

function gameSystem(name) {
  const ext = path.extname(name).toLowerCase();
  if (N64_EXT.has(ext)) return 'n64';
  if (GC_EXT.has(ext)) return 'gc';
  return null;
}

/** [{ name, size }] of the files in an archive. */
function list(sevenZip, archive) {
  return new Promise((resolve, reject) => {
    execFile(sevenZip, ['l', '-slt', '-ba', '-sccUTF-8', archive], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error(`Can't read archive: ${String(err.message).split('\n')[0]}`));
      const out = [];
      for (const block of stdout.split(/\r?\n\r?\n/)) {
        const f = {};
        for (const line of block.split(/\r?\n/)) {
          const i = line.indexOf(' = ');
          if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 3);
        }
        if (!f.Path || f.Folder === '+' || /D/.test(f.Attributes || '')) continue;
        out.push({ name: f.Path, size: +f.Size || 0 });
      }
      resolve(out);
    });
  });
}

/** Stream one entry's bytes to onChunk(buf); onChunk returning false stops early. */
function streamEntry(sevenZip, archive, entry, onChunk) {
  return new Promise((resolve, reject) => {
    const p = spawn(sevenZip, ['e', '-so', '-bd', '-sccUTF-8', archive, entry], { windowsHide: true });
    let stopped = false;
    let err = '';
    p.stdout.on('data', (d) => {
      if (stopped) return;
      if (onChunk(d) === false) {
        stopped = true;
        p.kill();
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (stopped || code === 0) resolve();
      else reject(new Error(`Can't read ${entry} from archive${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
    });
  });
}

/** Byte-swaps N64 dumps to big-endian on the fly, across chunk boundaries. */
function n64Normalizer(format) {
  let carry = Buffer.alloc(0);
  return (chunk, final) => {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const usable = final ? buf.length : buf.length - (buf.length % 4);
    carry = Buffer.from(buf.subarray(usable));
    buf = Buffer.from(buf.subarray(0, usable));
    if (format === 'v64') for (let i = 0; i + 1 < buf.length; i += 2) { const a = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = a; }
    if (format === 'n64') for (let i = 0; i + 3 < buf.length; i += 4) { const a = buf[i], b = buf[i + 1]; buf[i] = buf[i + 3]; buf[i + 1] = buf[i + 2]; buf[i + 2] = b; buf[i + 3] = a; }
    return buf;
  };
}

async function identifyN64(sevenZip, archive, entry) {
  const hash = crypto.createHash('md5');
  let head = Buffer.alloc(0);
  let format = null;
  let norm = null;
  let total = 0;
  let pending = Buffer.alloc(0);
  let tooBig = false;
  await streamEntry(sevenZip, archive, entry.name, (chunk) => {
    total += chunk.length;
    if (total > 128 * 1024 * 1024) { tooBig = true; return false; }
    if (!format) {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return true;
      format = n64Format(pending);
      if (!format) return false;
      norm = n64Normalizer(format);
      chunk = pending;
    }
    const out = norm(chunk, false);
    if (head.length < 0x1000) head = Buffer.concat([head, out]).subarray(0, 0x1000);
    hash.update(out);
    return true;
  });
  if (tooBig) throw new Error('too large for an N64 ROM');
  if (!format) throw new Error('not an N64 ROM (bad header)');
  const tail = norm(Buffer.alloc(0), true);
  if (tail.length) hash.update(tail);
  return n64Info(entry.name, head, hash.digest('hex'), format);
}

async function identifyGC(sevenZip, archive, entry) {
  let head = Buffer.alloc(0);
  await streamEntry(sevenZip, archive, entry.name, (chunk) => {
    head = Buffer.concat([head, chunk]);
    return head.length < GC_HEAD_BYTES;
  });
  return gcInfoFromHead(entry.name, head.subarray(0, GC_HEAD_BYTES));
}

/**
 * Every game in an archive: [{ ...gameInfo, path: archive, entry, archive: true }] plus errors.
 * Non-game files inside (readme.txt, etc.) are ignored.
 */
async function scanArchive(sevenZip, archive) {
  const stat = await fs.promises.stat(archive);
  const entries = (await list(sevenZip, archive)).filter((e) => gameSystem(e.name));
  const games = [];
  const errors = [];
  for (const e of entries) {
    try {
      const info = gameSystem(e.name) === 'n64' ? await identifyN64(sevenZip, archive, e) : await identifyGC(sevenZip, archive, e);
      games.push({
        ...info,
        path: archive,
        entry: e.name,
        archive: true,
        size: e.size,
        mtimeMs: stat.mtimeMs,
        file: path.basename(e.name),
      });
    } catch (err) {
      errors.push({ file: `${archive} → ${e.name}`, error: err.message });
    }
  }
  return { games, errors };
}

/** Unpack one entry into outDir; onProgress(percent). Resolves to the unpacked file path. */
function extractEntry(sevenZip, archive, entry, outDir, onProgress = () => {}) {
  fs.mkdirSync(outDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(sevenZip, ['e', '-y', '-bsp1', '-bso0', '-sccUTF-8', `-o${outDir}`, archive, entry], { windowsHide: true });
    let err = '';
    const onOut = (d) => {
      const m = String(d).match(/(\d{1,3})%/g);
      if (m) onProgress(Math.min(100, parseInt(m[m.length - 1], 10)));
    };
    p.stdout.on('data', onOut);
    p.stderr.on('data', (d) => { err += d; onOut(d); });
    p.on('error', reject);
    p.on('close', (code) => {
      const out = path.join(outDir, path.basename(entry));
      if (code === 0 && fs.existsSync(out)) resolve(out);
      else reject(new Error(`Couldn't unpack ${path.basename(entry)}${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
    });
  });
}

/**
 * Cache of unpacked archive games, trimmed to a size limit by least recently played.
 */
class ExtractCache {
  constructor({ dir, sevenZip, limitBytes = () => 20 * 1024 ** 3, log = () => {} }) {
    this.dir = dir;
    this.sevenZip = sevenZip;
    this.limitBytes = limitBytes;
    this.log = log;
    this.busy = new Map();
  }

  slotFor(game) {
    return path.join(this.dir, crypto.createHash('sha1').update(`${game.path}|${game.entry}`).digest('hex').slice(0, 16));
  }

  /** Path of a playable file for `game`; unpacks archived games first. */
  async ensure(game, onProgress = () => {}) {
    if (!game.archive) return game.path;
    const slot = this.slotFor(game);
    const out = path.join(slot, path.basename(game.entry));
    try {
      const st = fs.statSync(out);
      if (st.size === game.size || !game.size) {
        const now = new Date();
        fs.utimesSync(slot, now, now);
        return out;
      }
    } catch { /* not unpacked yet */ }
    if (this.busy.has(slot)) return this.busy.get(slot);
    const job = (async () => {
      fs.rmSync(slot, { recursive: true, force: true });
      this.log('unpacking', game.entry, 'from', game.path);
      const file = await extractEntry(this.sevenZip(), game.path, game.entry, slot, onProgress);
      this.trim(slot);
      return file;
    })().finally(() => this.busy.delete(slot));
    this.busy.set(slot, job);
    return job;
  }

  /** Remove least-recently-used unpacked games until the cache fits (never the one just used). */
  trim(keep) {
    let entries;
    try {
      entries = fs.readdirSync(this.dir).map((n) => {
        const p = path.join(this.dir, n);
        let size = 0;
        for (const f of fs.readdirSync(p)) size += fs.statSync(path.join(p, f)).size;
        return { p, size, used: fs.statSync(p).mtimeMs };
      });
    } catch { return; }
    let total = entries.reduce((a, e) => a + e.size, 0);
    const limit = this.limitBytes();
    for (const e of entries.sort((a, b) => a.used - b.used)) {
      if (total <= limit) break;
      if (e.p === keep) continue;
      fs.rmSync(e.p, { recursive: true, force: true });
      total -= e.size;
      this.log('cache: removed', path.basename(e.p));
    }
  }

  sizeBytes() {
    try {
      return fs.readdirSync(this.dir).reduce((a, n) => {
        const p = path.join(this.dir, n);
        return a + fs.readdirSync(p).reduce((b, f) => b + fs.statSync(path.join(p, f)).size, 0);
      }, 0);
    } catch { return 0; }
  }

  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

module.exports = { isArchive, scanArchive, list, extractEntry, ExtractCache, ARCHIVE_EXT };
