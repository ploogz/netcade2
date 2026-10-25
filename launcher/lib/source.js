'use strict';
/**
 * Where did a downloaded file come from? Browsers leave a note on files they save:
 *   - Windows: the "Mark of the Web", a hidden Zone.Identifier stream with ReferrerUrl / HostUrl
 *   - macOS:   the kMDItemWhereFroms attribute (Finder's Get Info → "Where from")
 *   - Linux:   user.xdg.referrer.url / user.xdg.origin.url extended attributes (Chrome, Firefox)
 * Netcade only uses this to *suggest* a "Get the game" link; the host confirms before it's shown.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SEARCH_HOSTS = /(^|\.)(google|bing|duckduckgo|yahoo|baidu|yandex)\.[a-z.]+$/i;

/** http(s) URLs only, trimmed, with a sane length. Returns '' for anything else. */
function cleanUrl(u) {
  const s = String(u || '').trim();
  if (s.length > 500) return '';
  try {
    const url = new URL(s);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname || url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Prefer the page you were on (has instructions) over the raw file URL, unless it was a search page. */
function pick(page, file) {
  const p = cleanUrl(page);
  const f = cleanUrl(file);
  if (p && !SEARCH_HOSTS.test(new URL(p).hostname)) return p;
  return f || p || '';
}

/** Parse the text of a Windows Zone.Identifier stream. */
function parseZoneIdentifier(text) {
  const get = (k) => (new RegExp(`^${k}=(.*)$`, 'mi').exec(String(text || '')) || [])[1] || '';
  return pick(get('ReferrerUrl'), get('HostUrl'));
}

/** Parse `mdls -raw -name kMDItemWhereFroms` output: ("file url", "page url"). */
function parseWhereFroms(text) {
  const urls = [...String(text || '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return pick(urls[1], urls[0]);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Read a Linux extended attribute: getfattr if installed, otherwise Python (present on most distros). */
async function linuxAttr(file, name) {
  const v = await run('getfattr', ['--only-values', '-n', name, file]);
  if (v) return v;
  return run('python3', ['-c', 'import os,sys\ntry: print(os.getxattr(sys.argv[1], sys.argv[2]).decode())\nexcept OSError: pass', file, name]);
}

/** The recorded source of one file, or ''. */
async function sourceOf(file) {
  try {
    if (process.platform === 'win32') {
      const text = await fs.promises.readFile(`${file}:Zone.Identifier`, 'utf8').catch(() => '');
      return parseZoneIdentifier(text);
    }
    if (process.platform === 'darwin') {
      return parseWhereFroms(await run('/usr/bin/mdls', ['-raw', '-name', 'kMDItemWhereFroms', file]));
    }
    return pick(await linuxAttr(file, 'user.xdg.referrer.url'), await linuxAttr(file, 'user.xdg.origin.url'));
  } catch {
    return '';
  }
}

/**
 * Suggested link for a library game: the note on its file (or on the archive it's in); for an
 * unpacked file, also the note on a same-named .zip/.7z next to it or in the Downloads folder.
 */
async function suggestFor(game) {
  if (!game) return '';
  const direct = await sourceOf(game.path);
  if (direct) return direct;
  if (game.archive) return '';
  const stem = path.basename(game.path, path.extname(game.path));
  const dirs = [path.dirname(game.path), path.join(os.homedir(), 'Downloads')];
  for (const d of dirs) {
    for (const ext of ['.zip', '.7z']) {
      const candidate = path.join(d, stem + ext);
      if (fs.existsSync(candidate)) {
        const u = await sourceOf(candidate);
        if (u) return u;
      }
    }
  }
  return '';
}

module.exports = { cleanUrl, domainOf, pick, parseZoneIdentifier, parseWhereFroms, sourceOf, suggestFor };
