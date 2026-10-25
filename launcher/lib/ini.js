'use strict';
/**
 * Minimal INI read/merge/write that preserves sections and keys we don't touch,
 * so Netcade never clobbers settings the user changed inside Dolphin.
 */
const fs = require('fs');
const path = require('path');

function parse(text) {
  const sections = new Map(); // name -> Map(key -> value)
  const order = [];
  let cur = null;
  const ensure = (name) => {
    if (!sections.has(name)) {
      sections.set(name, new Map());
      order.push(name);
    }
    return sections.get(name);
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      cur = ensure(sec[1]);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    (cur || ensure('')).set(key, val);
  }
  return { sections, order };
}

function stringify(ini) {
  const out = [];
  for (const name of ini.order) {
    const s = ini.sections.get(name);
    if (!s || s.size === 0) continue;
    if (name) out.push(`[${name}]`);
    for (const [k, v] of s) out.push(`${k} = ${v}`);
  }
  return out.join('\n') + '\n';
}

/** patch: { Section: { Key: value | null(delete) } } */
function merge(ini, patch) {
  for (const [name, kv] of Object.entries(patch)) {
    if (!ini.sections.has(name)) {
      ini.sections.set(name, new Map());
      ini.order.push(name);
    }
    const s = ini.sections.get(name);
    for (const [k, v] of Object.entries(kv)) {
      if (v === null || v === undefined) s.delete(k);
      else s.set(k, String(v));
    }
  }
  return ini;
}

/** Remove every key from a section (used to replace a whole section). */
function replaceSection(ini, name, kv) {
  if (!ini.sections.has(name)) ini.order.push(name);
  ini.sections.set(name, new Map(Object.entries(kv).map(([k, v]) => [k, String(v)])));
  return ini;
}

function updateFile(file, patch, replace = {}) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const ini = parse(text);
  merge(ini, patch);
  for (const [name, kv] of Object.entries(replace)) replaceSection(ini, name, kv);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(ini));
  return ini;
}

/** Turn "Key = Value" lines (as produced by inputMaps.dolphinGCPad) into an object. */
function linesToObject(text) {
  const o = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) o[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return o;
}

module.exports = { parse, stringify, merge, replaceSection, updateFile, linesToObject };
