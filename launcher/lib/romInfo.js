'use strict';
/**
 * Reads identifying information from N64 ROMs and GameCube disc images.
 *
 * N64: hashes the ROM after normalising byte order (.z64/.v64/.n64 all hash the same),
 *      so two players with the same dump match even if their files are in different formats.
 * GC:  reads the disc header (game ID, revision, disc number) from ISO/GCM, RVZ/WIA and CISO
 *      without decompressing anything, so scanning a library of 1.4 GB images is instant.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const N64_EXT = new Set(['.z64', '.n64', '.v64']);
const GC_EXT = new Set(['.iso', '.gcm', '.rvz', '.wia', '.ciso', '.gcz']);

const N64_REGIONS = {
  A: 'World', B: 'Brazil', C: 'China', D: 'Germany', E: 'USA', F: 'France', G: 'Gateway',
  H: 'Netherlands', I: 'Italy', J: 'Japan', K: 'Korea', L: 'Gateway', N: 'Canada',
  P: 'Europe', S: 'Spain', U: 'Australia', W: 'Scandinavia', X: 'Europe', Y: 'Europe', Z: 'Europe',
};
const GC_REGIONS = {
  E: 'USA', J: 'Japan', P: 'Europe', D: 'Germany', F: 'France', I: 'Italy', S: 'Spain',
  K: 'Korea', U: 'Australia', X: 'Europe', Y: 'Europe', Z: 'Europe', H: 'Netherlands', R: 'Russia', W: 'Taiwan',
};

function systemForFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (N64_EXT.has(ext)) return 'n64';
  if (GC_EXT.has(ext)) return 'gc';
  return null;
}

/** Detect N64 byte order from the first 4 bytes. */
function n64Format(head) {
  const m = head.readUInt32BE(0);
  if (m === 0x80371240) return 'z64'; // big endian (native)
  if (m === 0x37804012) return 'v64'; // byte-swapped
  if (m === 0x40123780) return 'n64'; // little endian
  return null;
}

/** Convert any N64 dump to big-endian (.z64) order, in place. */
function toZ64(buf, format) {
  if (format === 'v64') {
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const a = buf[i]; buf[i] = buf[i + 1]; buf[i + 1] = a;
    }
  } else if (format === 'n64') {
    for (let i = 0; i + 3 < buf.length; i += 4) {
      const a = buf[i], b = buf[i + 1];
      buf[i] = buf[i + 3]; buf[i + 1] = buf[i + 2]; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  return buf;
}

function asciiClean(buf) {
  return buf.toString('latin1').replace(/\0.*$/s, '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Super Mario 64 (USA) [!].z64" -> "Super Mario 64" */
function titleFromFilename(file) {
  let base = path.basename(file, path.extname(file));
  base = base.replace(/\s*[([{][^)\]}]*[)\]}]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  // "Legend of Zelda, The - Ocarina" -> "The Legend of Zelda - Ocarina"
  base = base.replace(/^(.+?), (The|A|An)(\b.*)$/i, '$2 $1$3');
  return base;
}

/** Prefer a descriptive filename; fall back to the internal name for things like "sm64.z64". */
function pickTitle(fnTitle, headerName) {
  const descriptive = /\s/.test(fnTitle) || fnTitle.length >= 10;
  if (descriptive || !headerName) return fnTitle || headerName || 'Unknown game';
  if (headerName === headerName.toUpperCase()) {
    return headerName.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }
  return headerName;
}

function readN64(file, buf) {
  const format = n64Format(buf);
  if (!format) throw new Error('not an N64 ROM (bad header)');
  toZ64(buf, format);
  return n64Info(file, buf, crypto.createHash('md5').update(buf).digest('hex'), format);
}

/** N64 description from the big-endian header bytes and the whole-ROM md5 (also used for archives). */
function n64Info(file, buf, md5, format) {
  const headerName = asciiClean(buf.subarray(0x20, 0x34));
  const cat = String.fromCharCode(buf[0x3b]);
  const id = asciiClean(buf.subarray(0x3c, 0x3e));
  const regionCode = String.fromCharCode(buf[0x3e]);
  const rev = buf[0x3f];
  const crc1 = buf.readUInt32BE(0x10).toString(16).padStart(8, '0').toUpperCase();
  const crc2 = buf.readUInt32BE(0x14).toString(16).padStart(8, '0').toUpperCase();
  const fnTitle = titleFromFilename(file);
  return {
    system: 'n64',
    format,
    key: `n64:${md5}`,
    md5,
    crc: `${crc1}-${crc2}`,
    id: /^[A-Z0-9]{2}$/.test(id) ? `${cat}${id}${regionCode}` : '',
    headerName,
    title: pickTitle(fnTitle, headerName),
    region: N64_REGIONS[regionCode] || (regionCode.trim() ? regionCode : 'Unknown'),
    rev,
    disc: 0,
    verified: true,
  };
}

/** Locate the 0x440-byte GameCube disc header inside a container format. */
function gcHeaderOffset(head) {
  const magic4 = head.subarray(0, 4).toString('latin1');
  if (magic4 === 'RVZ\x01' || magic4 === 'WIA\x01') return { offset: 0x58, container: magic4.slice(0, 3).toLowerCase() };
  if (magic4 === 'CISO') return { offset: 0x8000, container: 'ciso' };
  if (head.readUInt32LE(0) === 0xb10bc001) return { offset: -1, container: 'gcz' };
  return { offset: 0, container: 'iso' };
}

async function readGC(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(GC_HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    return gcInfoFromHead(file, head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

const GC_HEAD_BYTES = 0x8000 + 0x440;

/** GameCube description from the first bytes of a disc image (also used for archives). */
function gcInfoFromHead(file, head) {
  {
    if (head.length < 0x60) throw new Error('file too small');
    const { offset, container } = gcHeaderOffset(head);
    const fnTitle = titleFromFilename(file);
    if (offset < 0) {
      // GCZ is block-compressed; we can't cheaply read the header. Fall back to the filename.
      return {
        system: 'gc', format: container, key: `gcfile:${fnTitle.toLowerCase()}`, id: '', headerName: '',
        title: fnTitle, region: 'Unknown', rev: 0, disc: 0, verified: false,
      };
    }
    const h = head.subarray(offset, offset + 0x440);
    if (h.length < 0x60) throw new Error('truncated header');
    const id = asciiClean(h.subarray(0, 6));
    const disc = h[6];
    const rev = h[7];
    const gcMagic = h.readUInt32BE(0x1c);
    const wiiMagic = h.readUInt32BE(0x18);
    if (wiiMagic === 0x5d1c9ea3) throw new Error('this is a Wii disc');
    if (gcMagic !== 0xc2339f3d) throw new Error('not a GameCube disc (bad magic)');
    if (!/^[A-Z0-9]{6}$/.test(id)) throw new Error('bad game ID');
    const headerName = asciiClean(h.subarray(0x20, 0x60));
    return {
      system: 'gc',
      format: container,
      key: `gc:${id}:${rev}:${disc}`,
      id,
      headerName,
      title: pickTitle(fnTitle, headerName),
      region: GC_REGIONS[id[3]] || 'Unknown',
      rev,
      disc,
      verified: true,
    };
  }
}

/** Main entry: returns a description of the game in `file`, or throws. */
async function readRomInfo(file) {
  const system = systemForFile(file);
  if (!system) throw new Error('unsupported file type');
  const stat = await fs.promises.stat(file);
  let info;
  if (system === 'n64') {
    if (stat.size > 128 * 1024 * 1024) throw new Error('too large for an N64 ROM');
    const buf = await fs.promises.readFile(file);
    info = readN64(file, buf);
  } else {
    info = await readGC(file);
  }
  return { ...info, path: file, size: stat.size, mtimeMs: stat.mtimeMs, file: path.basename(file) };
}

/** Human description of a game identity, used in "you need X" messages. */
function describe(g) {
  if (!g) return 'unknown';
  const parts = [g.region || '?'];
  if (g.rev) parts.push(`Rev ${g.rev}`);
  if (g.disc) parts.push(`Disc ${g.disc + 1}`);
  return `${g.title} (${parts.join(', ')})`;
}

/**
 * Compare the lobby's game to the local library.
 * Returns { status: 'match'|'mismatch'|'missing', local?, detail }
 */
function matchGame(lobbyGame, library, system) {
  if (!lobbyGame) return { status: 'missing', detail: 'No game selected' };
  const exact = library.find((g) => g.key === lobbyGame.key);
  if (exact) return { status: 'match', local: exact, detail: describe(exact) };
  // near-misses so we can tell the player exactly what's different
  const sameSystem = library.filter((g) => g.system === system);
  let near = null;
  if (system === 'gc' && lobbyGame.id) {
    near = sameSystem.find((g) => g.id === lobbyGame.id) ||
      sameSystem.find((g) => g.id && g.id.slice(0, 3) === lobbyGame.id.slice(0, 3));
  } else if (system === 'n64' && lobbyGame.id) {
    near = sameSystem.find((g) => g.id === lobbyGame.id) ||
      sameSystem.find((g) => g.id && g.id.slice(1, 3) === lobbyGame.id.slice(1, 3));
  }
  if (!near) {
    const t = (lobbyGame.title || '').toLowerCase();
    near = sameSystem.find((g) => g.title.toLowerCase() === t);
  }
  if (near) {
    const why = [];
    if (near.region !== lobbyGame.region) why.push(`region ${near.region} vs ${lobbyGame.region}`);
    if ((near.rev || 0) !== (lobbyGame.rev || 0)) why.push(`Rev ${near.rev || 0} vs Rev ${lobbyGame.rev || 0}`);
    if (!why.length) why.push('different dump (hack, patch or bad dump?)');
    return {
      status: 'mismatch',
      local: near,
      detail: `You have a different version: ${why.join(', ')}. Needed: ${describe(lobbyGame)}`,
    };
  }
  return { status: 'missing', detail: `Not in your library. Needed: ${describe(lobbyGame)}` };
}

/** What we tell the lobby about a game we host. Never includes the path. */
function publicGame(g) {
  return { key: g.key, title: g.title, region: g.region, rev: g.rev || 0, id: g.id || '', size: g.size || 0 };
}

module.exports = {
  n64Info, gcInfoFromHead, GC_HEAD_BYTES, asciiClean,
  readRomInfo, systemForFile, n64Format, toZ64, titleFromFilename, matchGame, publicGame, describe,
  N64_EXT, GC_EXT,
};
