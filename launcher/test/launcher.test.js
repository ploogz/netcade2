'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rom = require('../lib/romInfo');
const IM = require('../lib/inputMaps');
const ini = require('../lib/ini');
const dolphin = require('../lib/dolphin');
const retroarch = require('../lib/retroarch');
const { Library } = require('../lib/library');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-test-'));

// ---------------------------------------------------------------- fixtures
function makeZ64(name, code = 'NSME', rev = 0, size = 1024 * 1024) {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(0x80371240, 0);
  b.writeUInt32BE(0x12345678, 0x10);
  b.writeUInt32BE(0x9abcdef0, 0x14);
  Buffer.from(name.padEnd(20, ' ')).copy(b, 0x20);
  Buffer.from(code).copy(b, 0x3b);
  b[0x3f] = rev;
  for (let i = 0x1000; i < size; i += 4) b.writeUInt32BE((i * 2654435761) >>> 0, i);
  return b;
}
function toV64(b) { return rom.toZ64(Buffer.from(b), 'v64'); }   // swap is its own inverse
function toN64(b) { return rom.toZ64(Buffer.from(b), 'n64'); }

function makeGcIso(id = 'GALE01', rev = 2, name = 'Super Smash Bros Melee') {
  const b = Buffer.alloc(0x10000);
  Buffer.from(id).copy(b, 0);
  b[6] = 0; b[7] = rev;
  b.writeUInt32BE(0xc2339f3d, 0x1c);
  Buffer.from(name).copy(b, 0x20);
  return b;
}
function makeRvz(iso) {
  const b = Buffer.alloc(0x400);
  Buffer.from('RVZ\x01', 'latin1').copy(b, 0);
  iso.subarray(0, 0x80).copy(b, 0x58);
  return b;
}
function makeCiso(iso) {
  const b = Buffer.alloc(0x8000 + 0x1000);
  Buffer.from('CISO').copy(b, 0);
  iso.subarray(0, 0x440).copy(b, 0x8000);
  return b;
}

// ---------------------------------------------------------------- romInfo
test('N64 dumps in all three byte orders hash identically', async () => {
  const z = makeZ64('SUPER MARIO 64');
  const dir = path.join(tmp, 'n64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Super Mario 64 (USA).z64'), z);
  fs.writeFileSync(path.join(dir, 'sm64.v64'), toV64(z));
  fs.writeFileSync(path.join(dir, 'sm64.n64'), toN64(z));
  const a = await rom.readRomInfo(path.join(dir, 'Super Mario 64 (USA).z64'));
  const b = await rom.readRomInfo(path.join(dir, 'sm64.v64'));
  const c = await rom.readRomInfo(path.join(dir, 'sm64.n64'));
  assert.equal(a.format, 'z64');
  assert.equal(b.format, 'v64');
  assert.equal(c.format, 'n64');
  assert.equal(a.key, b.key);
  assert.equal(a.key, c.key);
  assert.equal(a.title, 'Super Mario 64');
  assert.equal(a.region, 'USA');
  assert.equal(a.id, 'NSME');
  assert.equal(b.title, 'Super Mario 64', 'short filename falls back to the header name');
});

test('GameCube header read from ISO, RVZ and CISO', async () => {
  const iso = makeGcIso();
  const dir = path.join(tmp, 'gc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Melee (USA) (Rev 2).iso'), iso);
  fs.writeFileSync(path.join(dir, 'Melee (USA) (Rev 2).rvz'), makeRvz(iso));
  fs.writeFileSync(path.join(dir, 'melee.ciso'), makeCiso(iso));
  const a = await rom.readRomInfo(path.join(dir, 'Melee (USA) (Rev 2).iso'));
  const b = await rom.readRomInfo(path.join(dir, 'Melee (USA) (Rev 2).rvz'));
  const c = await rom.readRomInfo(path.join(dir, 'melee.ciso'));
  for (const g of [a, b, c]) {
    assert.equal(g.key, 'gc:GALE01:2:0');
    assert.equal(g.region, 'USA');
    assert.equal(g.rev, 2);
  }
  assert.equal(a.title, 'Super Smash Bros Melee', 'terse filename -> disc header name');
  assert.equal(b.format, 'rvz');
  assert.equal(c.format, 'ciso');
});

test('Wii discs and junk are rejected', async () => {
  const wii = makeGcIso('RMCE01');
  wii.writeUInt32BE(0, 0x1c);
  wii.writeUInt32BE(0x5d1c9ea3, 0x18);
  const f = path.join(tmp, 'wii.iso');
  fs.writeFileSync(f, wii);
  await assert.rejects(rom.readRomInfo(f), /Wii/);
  const junk = path.join(tmp, 'junk.z64');
  fs.writeFileSync(junk, Buffer.alloc(4096));
  await assert.rejects(rom.readRomInfo(junk), /bad header/);
});

test('matchGame explains exact, version and missing cases', () => {
  const lib = [
    { system: 'gc', key: 'gc:GALE01:0:0', id: 'GALE01', title: 'Melee', region: 'USA', rev: 0 },
    { system: 'n64', key: 'n64:aaa', id: 'NSME', title: 'Super Mario 64', region: 'USA', rev: 0 },
  ];
  assert.equal(rom.matchGame({ key: 'n64:aaa', title: 'x' }, lib, 'n64').status, 'match');
  const v = rom.matchGame({ key: 'gc:GALE01:2:0', id: 'GALE01', title: 'Melee', region: 'USA', rev: 2 }, lib, 'gc');
  assert.equal(v.status, 'mismatch');
  assert.match(v.detail, /Rev 0 vs Rev 2/);
  const r = rom.matchGame({ key: 'n64:bbb', id: 'NSMJ', title: 'Super Mario 64', region: 'Japan', rev: 0 }, lib, 'n64');
  assert.equal(r.status, 'mismatch');
  assert.match(r.detail, /region USA vs Japan/);
  assert.equal(rom.matchGame({ key: 'n64:zzz', id: 'NZLE', title: 'Zelda', region: 'USA' }, lib, 'n64').status, 'missing');
});

test('library scan finds games recursively and caches results', async () => {
  const cache = path.join(tmp, 'cache.json');
  const lib = new Library(cache);
  const res = await lib.scan([tmp]);
  const keys = new Set(res.games.map((g) => g.key));
  assert.ok(keys.has('gc:GALE01:2:0'));
  assert.ok([...keys].some((k) => k.startsWith('n64:')));
  assert.ok(res.errors.length >= 2, 'wii + junk reported');
  const again = new Library(cache);
  assert.equal(again.games.length, res.games.length);
});

// ---------------------------------------------------------------- input maps
test('default bindings have no conflicts and pass validation', () => {
  for (const sys of ['n64', 'gc']) {
    for (const mode of ['keyboard', 'gamepad']) {
      const map = IM.resolve(sys, mode, {});
      assert.deepEqual(IM.conflicts(sys, map), [], `${sys}/${mode} conflicts`);
      for (const [id, bd] of Object.entries(map)) assert.equal(IM.validate(sys, mode, id, bd), null, `${sys}/${mode}/${id}`);
    }
  }
});

test('N64 rules: stick stays on left stick, only C buttons on right stick', () => {
  assert.match(IM.validate('n64', 'gamepad', 'su', { t: 'btn', i: 12 }), /left stick/);
  assert.match(IM.validate('n64', 'gamepad', 'a', { t: 'axis', i: 0, d: 1 }), /reserved/);
  assert.match(IM.validate('n64', 'gamepad', 'z', { t: 'axis', i: 2, d: 1 }), /C buttons/);
  assert.equal(IM.validate('n64', 'gamepad', 'cu', { t: 'btn', i: 3 }), null);
  assert.match(IM.validate('gc', 'keyboard', 'a', { t: 'btn', i: 0 }), /press a key/);
});

test('RetroArch keyboard config uses alt-map RetroPad slots and RetroArch key names', () => {
  const map = IM.resolve('n64', 'keyboard', { a: { t: 'key', code: 'Digit1' }, start: { t: 'key', code: 'NumpadEnter' } });
  const cfg = IM.retroarchKeyboardConfig(map);
  assert.equal(cfg.input_player1_b, 'num1');          // N64 A -> RetroPad B
  assert.equal(cfg.input_player1_y, 'j');             // N64 B -> RetroPad Y
  assert.equal(cfg.input_player1_l2, 'space');        // Z
  assert.equal(cfg.input_player1_select, 'q');        // N64 L -> Select under alt-map
  assert.equal(cfg.input_player1_r2, 'e');            // N64 R
  assert.equal(cfg.input_player1_x, 'up');            // C-Up
  assert.equal(cfg.input_player1_start, 'kp_enter');
  assert.equal(cfg.input_player1_l_y_minus, 'w');
  assert.equal(cfg.input_player1_l3, 'nul');
});

test('RetroArch remap routes physical buttons to N64 functions', () => {
  const map = IM.resolve('n64', 'gamepad', { cu: { t: 'btn', i: 3 }, a: { t: 'btn', i: 1 } });
  const { text, warnings } = IM.retroarchRemap(map);
  const get = (n) => +new RegExp(`input_player1_btn_${n} = "(-?\\d+)"`).exec(text)[1];
  assert.equal(warnings.length, 0);
  assert.equal(get('a'), 0);     // physical right face (std 1 -> RetroPad A) now gives N64 A (RetroPad B)
  assert.equal(get('x'), 9);     // physical top face -> C-Up (RetroPad X)
  assert.equal(get('y'), 1);     // physical left face -> N64 B (RetroPad Y), default
  assert.equal(get('b'), -1);    // physical bottom face no longer bound to anything
  assert.equal(get('l2'), 12);   // LT -> Z
  assert.match(text, /input_player1_stk_r_x\+ = "20"/);
});

test('Dolphin GCPad section for XInput, SDL and keyboard on each OS', () => {
  const pad = IM.resolve('gc', 'gamepad', {});
  const x = ini.linesToObject(IM.dolphinGCPad(pad, { kind: 'xinput', index: 0 }, 'win32'));
  assert.equal(x.Device, 'XInput/0/Gamepad');
  assert.equal(x['Buttons/A'], '`Button A`');
  assert.equal(x['Buttons/B'], '`Button X`');      // GC B on the left face button
  assert.equal(x['Main Stick/Up'], '`Left Y+`');   // Dolphin Y+ is up
  assert.equal(x['Main Stick/Down'], '`Left Y-`');
  assert.equal(x['C-Stick/Right'], '`Right X+`');
  assert.equal(x['Triggers/L-Analog'], '`Trigger L`');
  assert.equal(x['Rumble/Motor'], '`Motor L` | `Motor R`');
  const s = ini.linesToObject(IM.dolphinGCPad(pad, { kind: 'sdl', index: 1, name: 'PS5 Controller' }, 'linux'));
  assert.equal(s.Device, 'SDL/1/PS5 Controller');
  const kb = IM.resolve('gc', 'keyboard', { a: { t: 'key', code: 'Enter' } });
  const w = ini.linesToObject(IM.dolphinGCPad(kb, { kind: 'keyboard' }, 'win32'));
  assert.equal(w.Device, 'DInput/0/Keyboard Mouse');
  assert.equal(w['Buttons/A'], '`RETURN`');
  assert.equal(w['Main Stick/Modifier'], '`LSHIFT`');
  const m = ini.linesToObject(IM.dolphinGCPad(kb, { kind: 'keyboard' }, 'darwin'));
  assert.equal(m.Device, 'Quartz/0/Keyboard & Mouse');
  assert.equal(m['Buttons/A'], '`Return`');
  assert.equal(m['C-Stick/Up'], '`Up Arrow`');
  const l = ini.linesToObject(IM.dolphinGCPad(kb, { kind: 'keyboard' }, 'linux'));
  assert.equal(l.Device, 'XInput2/0/Virtual core pointer');
  assert.equal(l['Buttons/B'], '`j`');
  assert.equal(l['Main Stick/Modifier'], '`Shift_L`');
});

test('guessSdlName maps common controllers', () => {
  assert.equal(IM.guessSdlName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'PS5 Controller');
  assert.equal(IM.guessSdlName('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'Nintendo Switch Pro Controller');
  assert.equal(IM.guessSdlName('Some Pad (Vendor: 1234 Product: 5678)'), 'Some Pad');
});

// ---------------------------------------------------------------- config writers
test('ini merge preserves unknown keys', () => {
  const f = path.join(tmp, 'Dolphin.ini');
  fs.writeFileSync(f, '[General]\nUserKey = keep\n[Interface]\nThemeName = Clean\n');
  ini.updateFile(f, { General: { ISOPaths: 1 }, NetPlay: { Nickname: 'Matt' } });
  const parsed = ini.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(parsed.sections.get('General').get('UserKey'), 'keep');
  assert.equal(parsed.sections.get('General').get('ISOPaths'), '1');
  assert.equal(parsed.sections.get('Interface').get('ThemeName'), 'Clean');
  assert.equal(parsed.sections.get('NetPlay').get('Nickname'), 'Matt');
});

const SETTINGS = {
  graphics: { fullscreen: true, vsync: true, widescreen: false, n64Renderer: 'parallel', n64Scale: 4, gcBackend: 'auto', gcScale: 3 },
  controls: { n64: { mode: 'gamepad', keyboard: {}, gamepad: {} }, gc: { mode: 'gamepad', keyboard: {}, gamepad: {}, device: { kind: 'xinput', index: 0 } } },
  netplay: { dolphinPort: 2626 },
};

test('Dolphin host config points the session index at the lobby server', () => {
  const userDir = path.join(tmp, 'dolphin-user');
  const gamePath = path.join(tmp, 'gc', 'Melee (USA) (Rev 2).iso');
  const r = dolphin.prepare({
    userDir, mode: 'host', platform: 'win32', settings: SETTINGS, game: { path: gamePath },
    romFolders: [tmp], lobbyCode: 'ABC234', indexUrl: 'https://lobby.example/dolphin', nickname: 'Matt', inputDelay: 3,
  });
  const d = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'Dolphin.ini'), 'utf8')).sections;
  assert.equal(d.get('NetPlay').get('IndexName'), 'ABC234');
  assert.equal(d.get('NetPlay').get('IndexServer'), 'https://lobby.example/dolphin');
  assert.equal(d.get('NetPlay').get('UseIndex'), 'True');
  assert.equal(d.get('NetPlay').get('IndexPassword'), '');
  assert.equal(d.get('NetPlay').get('TraversalChoice'), 'traversal');
  assert.equal(d.get('NetPlay').get('BufferSize'), '3');
  assert.equal(d.get('Core').get('GFXBackend'), 'D3D12');
  assert.equal(d.get('Display').get('Fullscreen'), 'True');
  assert.equal(d.get('Analytics').get('PermissionAsked'), 'True');
  assert.equal(r.exclusive, true, 'hosted game linked alone into the session folder');
  assert.ok(fs.existsSync(path.join(userDir, 'NetcadeSession', 'Melee (USA) (Rev 2).iso')));
  const gfx = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'GFX.ini'), 'utf8')).sections;
  assert.equal(gfx.get('Settings').get('InternalResolution'), '3');
  assert.equal(gfx.get('Settings').get('ShaderCompilationMode'), '2');
  const pad = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'GCPadNew.ini'), 'utf8')).sections;
  assert.equal(pad.get('GCPad1').get('Device'), 'XInput/0/Gamepad');
  assert.deepEqual(dolphin.args({ userDir, mode: 'host' }), ['-u', userDir]);
});

test('Dolphin guest config pre-fills the host code', () => {
  const userDir = path.join(tmp, 'dolphin-guest');
  dolphin.prepare({
    userDir, mode: 'guest', platform: 'linux', settings: SETTINGS, romFolders: [tmp],
    indexUrl: 'https://lobby.example/dolphin', nickname: 'Sam', hostCode: '4f2a91bc', method: 'traversal', port: 2626,
  });
  const d = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'Dolphin.ini'), 'utf8')).sections;
  assert.equal(d.get('NetPlay').get('HostCode'), '4f2a91bc');
  assert.equal(d.get('NetPlay').get('TraversalChoice'), 'traversal');
  assert.equal(d.get('General').get('ISOPath0'), tmp);
  assert.equal(d.get('Core').get('GFXBackend'), 'Vulkan');
});

test('RetroArch append config and arguments', () => {
  const dataDir = path.join(tmp, 'ra');
  const r = retroarch.prepare({ dataDir, mode: 'host', settings: SETTINGS, nickname: 'Matt', inputDelay: 2, hostOptions: { n64Renderer: 'gliden64' } });
  const cfg = fs.readFileSync(r.appendConfig, 'utf8');
  assert.match(cfg, /netplay_public_announce = "false"/);
  assert.match(cfg, /netplay_input_latency_frames_min = "2"/);
  assert.match(cfg, /video_driver = "glcore"/, 'host renderer choice wins');
  assert.match(cfg, /config_save_on_exit = "false"/);
  assert.match(cfg, /input_enable_hotkey = "rctrl"/);
  const opts = fs.readFileSync(path.join(dataDir, 'netcade-core-options.opt'), 'utf8');
  assert.match(opts, /mupen64plus-alt-map = "True"/);
  assert.match(opts, /mupen64plus-rdp-plugin = "gliden64"/);
  assert.ok(fs.existsSync(path.join(dataDir, 'remaps', 'Mupen64Plus-Next', 'Mupen64Plus-Next.rmp')));
  const a = retroarch.args({ corePath: '/c.so', romPath: '/g.z64', appendConfig: r.appendConfig, nickname: 'Matt', net: { role: 'guest', ip: '1.2.3.4', port: 55435 } });
  assert.deepEqual(a, ['-L', '/c.so', '--appendconfig', r.appendConfig, '--connect', '1.2.3.4', '--port', '55435', '--nick', 'Matt', '/g.z64']);
});

// ---------------------------------------------------------------- built-in emulators
test('bundled emulators are found from the vendor manifest', () => {
  const emulators = require('../lib/emulators');
  const appPath = path.join(tmp, 'app');
  const tag = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  const v = path.join(appPath, 'vendor', `${tag}-${process.arch}`);
  fs.mkdirSync(path.join(v, 'dolphin'), { recursive: true });
  fs.mkdirSync(path.join(v, 'cores'), { recursive: true });
  fs.writeFileSync(path.join(v, 'dolphin', 'AppRun'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(v, 'cores', 'core.so'), 'x');
  fs.writeFileSync(path.join(v, 'manifest.json'), JSON.stringify({
    builtAt: '2026-10-24', dolphin: { version: '2609a', exe: 'dolphin/AppRun' },
    retroarch: { version: '1.22.2', exe: 'retroarch/missing' }, n64core: { file: 'cores/core.so', version: 'M64 1234' }, autoconfig: { dir: 'autoconfig' },
  }));
  const b = emulators.bundled({ appPath, isPackaged: false });
  assert.equal(b.dolphin.version, '2609a');
  assert.equal(b.retroarch, null, 'a listed-but-missing emulator is not offered');
  assert.equal(b.n64Core.version, 'M64 1234');
  assert.equal(emulators.bundled({ appPath: path.join(tmp, 'nothing'), isPackaged: false }), null);
  // packaged layout: <resources>/vendor
  const res = path.join(tmp, 'resources');
  fs.cpSync(v, path.join(res, 'vendor'), { recursive: true });
  assert.equal(emulators.bundled({ resourcesPath: res, isPackaged: true }).dolphin.version, '2609a');
});

test('built-in RetroArch runs on a Netcade-owned config with bundled controller profiles', () => {
  const dataDir = path.join(tmp, 'ra-bundled');
  const r = retroarch.prepare({ dataDir, mode: 'guest', settings: SETTINGS, nickname: 'Sam', bundle: { autoconfig: '/opt/netcade/vendor/autoconfig' } });
  assert.ok(r.baseConfig && fs.existsSync(r.baseConfig));
  const cfg = fs.readFileSync(r.appendConfig, 'utf8');
  assert.match(cfg, /joypad_autoconfig_dir = "\/opt\/netcade\/vendor\/autoconfig"/);
  assert.match(cfg, /menu_driver = "rgui"/);
  const a = retroarch.args({ corePath: '/c.so', romPath: '/g.z64', appendConfig: r.appendConfig, baseConfig: r.baseConfig });
  assert.deepEqual(a.slice(0, 6), ['-L', '/c.so', '--config', r.baseConfig, '--appendconfig', r.appendConfig]);
});

// ---------------------------------------------------------------- invites
test('invites are understood however they get pasted', () => {
  const { parseInvite } = require('../lib/invite');
  const msg = 'Join my Netcade game: Mario Kart 64\nCode: KVQFLK\nServer: https://brave-otter-lamp.trycloudflare.com\nCopy this whole message...';
  assert.deepEqual(parseInvite(msg), { code: 'KVQFLK', server: 'https://brave-otter-lamp.trycloudflare.com' });
  assert.deepEqual(parseInvite('kvqflk'), { code: 'KVQFLK', server: '' });
  assert.deepEqual(parseInvite('  TZFGPT '), { code: 'TZFGPT', server: '' });
  assert.deepEqual(parseInvite('netcade://join/ABC234?s=http%3A%2F%2F192.168.1.20%3A8080'), { code: 'ABC234', server: 'http://192.168.1.20:8080' });
  assert.deepEqual(parseInvite('yo join KVQFLK on https://x.trycloudflare.com/.'), { code: 'KVQFLK', server: 'https://x.trycloudflare.com' });
  assert.equal(parseInvite('hello there').code, '');
  // the same message after a single-line box removed its line breaks
  assert.deepEqual(parseInvite(msg.replace(/\n/g, '')), { code: 'KVQFLK', server: 'https://brave-otter-lamp.trycloudflare.com' });
  assert.deepEqual(parseInvite('Join my Netcade game: Mario Kart 64Code: F4M8SFServer: http://127.0.0.1:8095Copy this whole message'), { code: 'F4M8SF', server: 'http://127.0.0.1:8095' });
});

test('share tunnel reports the Cloudflare address it is given', async () => {
  const { ShareTunnel } = require('../lib/shareTunnel');
  const fake = path.join(tmp, process.platform === 'win32' ? 'cfd.cmd' : 'cfd.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "INF Requesting new quick Tunnel on trycloudflare.com..." 1>&2\necho "|  https://brave-otter-lamp.trycloudflare.com  |" 1>&2\nexec sleep 30\n');
  fs.chmodSync(fake, 0o755);
  process.env.NETCADE_CLOUDFLARED = fake;
  const t = new ShareTunnel({ binDir: tmp });
  const states = [];
  t.on('status', (s) => states.push(s.state));
  const url = await t.start(8080);
  assert.equal(url, 'https://brave-otter-lamp.trycloudflare.com');
  assert.equal(t.status.state, 'on');
  t.stop();
  assert.equal(t.status.state, 'off');
  assert.deepEqual(states.slice(0, 2), ['starting', 'on']);
  delete process.env.NETCADE_CLOUDFLARED;
});

// ---------------------------------------------------------------- ports, spectating, covers
test('RetroArch sits each player on their lobby port, or spectates', () => {
  const dataDir = path.join(tmp, 'ra-ports');
  const p3 = fs.readFileSync(retroarch.prepare({ dataDir, mode: 'guest', settings: SETTINGS, nickname: 'A', port: 3, cmdPort: 55444 }).appendConfig, 'utf8');
  assert.match(p3, /netplay_request_device_p3 = "true"/);
  assert.match(p3, /netplay_request_device_p1 = "false"/);
  assert.match(p3, /netplay_start_as_spectator = "false"/);
  assert.match(p3, /network_cmd_enable = "true"/);
  assert.match(p3, /network_cmd_port = "55444"/);
  assert.match(p3, /video_windowed_fullscreen = "true"/);
  const spec = fs.readFileSync(retroarch.prepare({ dataDir, mode: 'guest', settings: SETTINGS, nickname: 'B', spectate: true }).appendConfig, 'utf8');
  assert.match(spec, /netplay_start_as_spectator = "true"/);
  assert.doesNotMatch(spec, /netplay_request_device_p\d+ = "true"/);
});

test('Dolphin runs borderless with background controller input, and lists the port layout for the host', () => {
  const userDir = path.join(tmp, 'dolphin-ov');
  dolphin.prepare({ userDir, mode: 'guest', platform: 'win32', settings: SETTINGS, romFolders: [tmp], indexUrl: 'x', hostCode: 'abc', method: 'traversal' });
  const gfx = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'GFX.ini'), 'utf8')).sections;
  const main = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'Dolphin.ini'), 'utf8')).sections;
  assert.equal(gfx.get('Settings').get('BorderlessFullscreen'), 'True');
  assert.equal(main.get('Input').get('BackgroundInput'), 'True');
  const steps = dolphin.instructions('host', true, [{ port: 1, name: 'Matt' }, { port: 2, name: 'Sam' }]);
  assert.ok(steps.some((x) => /Assign Controller Ports.*Port 1: Matt, Port 2: Sam/.test(x)));
  assert.ok(dolphin.instructions('guest', false, [], true).some((x) => /watching/.test(x)));
});

test('box art matcher picks the right No-Intro/Redump cover', () => {
  const { bestMatch, norm, thumbName } = require('../lib/covers');
  const n64 = ['Super Mario 64 (USA)', 'Super Mario 64 (Japan)', 'Super Mario 64 (Europe) (En,Fr,De)', 'Super Mario 64 (USA) (Beta)',
    'Legend of Zelda, The - Ocarina of Time (USA)', 'Legend of Zelda, The - Ocarina of Time (USA) (Rev 2)', 'Mario Kart 64 (USA)', 'Mario Kart 64 (Europe)'];
  const gc = ['Super Smash Bros. Melee (USA) (En,Ja) (Rev 2)', 'Super Smash Bros. Melee (USA) (En,Ja)', 'Super Smash Bros. Melee (Europe) (En,Fr,De,Es,It)', 'F-Zero GX (USA)'];
  assert.equal(bestMatch(n64, { title: 'Super Mario 64', region: 'USA' }), 'Super Mario 64 (USA)');
  assert.equal(bestMatch(n64, { title: 'SUPER MARIO 64', region: 'Japan' }), 'Super Mario 64 (Japan)');
  assert.equal(bestMatch(n64, { title: 'The Legend of Zelda - Ocarina of Time', region: 'USA', rev: 2 }), 'Legend of Zelda, The - Ocarina of Time (USA) (Rev 2)');
  assert.equal(bestMatch(gc, { title: 'Super Smash Bros Melee', region: 'USA', rev: 2 }), 'Super Smash Bros. Melee (USA) (En,Ja) (Rev 2)');
  assert.equal(bestMatch(gc, { title: 'F-ZERO GX', region: 'USA' }), 'F-Zero GX (USA)');
  assert.equal(bestMatch(gc, { title: 'Wind Waker', region: 'USA' }), null);
  assert.equal(norm('Legend of Zelda, The - Ocarina of Time (USA)'), norm('The Legend of Zelda: Ocarina of Time'));
  assert.equal(thumbName('Ms. Pac-Man: Maze Madness'), 'Ms. Pac-Man_ Maze Madness');
});

// ---------------------------------------------------------------- archives
test('games inside .zip and .7z get the same fingerprint as unpacked files', async () => {
  const { scanArchive, ExtractCache } = require('../lib/archives');
  const { execFileSync } = require('child_process');
  const sz = require('7zip-bin').path7za;
  const dir = path.join(tmp, 'arch');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const z = makeZ64('MARIOKART64', 'NKTE', 0, 3 * 1024 * 1024 + 4);   // size not a chunk multiple
  fs.writeFileSync(path.join(dir, 'src', 'Mario Kart 64 (USA).z64'), z);
  fs.writeFileSync(path.join(dir, 'src', 'mk64.v64'), toV64(z));
  fs.writeFileSync(path.join(dir, 'src', 'Melee (USA) (Rev 2).iso'), makeGcIso());
  fs.writeFileSync(path.join(dir, 'src', 'readme.txt'), 'hello');
  const unpacked = await rom.readRomInfo(path.join(dir, 'src', 'Mario Kart 64 (USA).z64'));
  execFileSync(sz, ['a', '-bso0', path.join(dir, 'games.zip'), 'Mario Kart 64 (USA).z64', 'Melee (USA) (Rev 2).iso', 'readme.txt'], { cwd: path.join(dir, 'src') });
  execFileSync(sz, ['a', '-bso0', path.join(dir, 'swapped.7z'), 'mk64.v64'], { cwd: path.join(dir, 'src') });

  const zipRes = await scanArchive(sz, path.join(dir, 'games.zip'));
  assert.equal(zipRes.games.length, 2, 'readme.txt ignored, both games found');
  const mk = zipRes.games.find((g) => g.system === 'n64');
  assert.equal(mk.key, unpacked.key);
  assert.equal(mk.title, 'Mario Kart 64');
  assert.equal(mk.archive, true);
  assert.equal(mk.entry, 'Mario Kart 64 (USA).z64');
  assert.equal(mk.file, 'Mario Kart 64 (USA).z64', 'entry name is used for box art lookup');
  assert.equal(zipRes.games.find((g) => g.system === 'gc').key, 'gc:GALE01:2:0');
  const sevenRes = await scanArchive(sz, path.join(dir, 'swapped.7z'));
  assert.equal(sevenRes.games[0].key, unpacked.key, '.v64 inside .7z hashes the same as .z64');

  // library: archives scanned, duplicates folded, unpacked copy preferred
  const lib = new Library(path.join(dir, 'cache.json'), () => sz);
  await lib.scan([dir]);
  assert.equal(lib.byKey(unpacked.key).archive, undefined, 'prefers the unpacked file');
  assert.equal(lib.unique().filter((g) => g.key === unpacked.key).length, 1);

  // unpack on demand, reuse, and trim to the size limit
  let limit = 100 * 1024 * 1024;
  const cache = new ExtractCache({ dir: path.join(dir, 'cache'), sevenZip: () => sz, limitBytes: () => limit });
  const pcts = [];
  const out = await cache.ensure(mk, (p) => pcts.push(p));
  assert.equal(fs.statSync(out).size, z.length);
  assert.ok(fs.readFileSync(out).equals(z), 'unpacked bytes match');
  assert.equal(await cache.ensure(mk), out, 'second launch reuses the unpacked file');
  const gc = zipRes.games.find((g) => g.system === 'gc');
  limit = 1;                     // force a trim: the older entry goes, the one just used stays
  const gcOut = await cache.ensure(gc);
  assert.ok(fs.existsSync(gcOut));
  assert.ok(!fs.existsSync(out), 'least recently played unpacked game was removed');
});

// ---------------------------------------------------------------- download source + custom covers
test('download source notes: Windows, Mac, preferring the page over search engines', () => {
  const src = require('../lib/source');
  const zone = '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://creator.itch.io/cool-hack\r\nHostUrl=https://cdn.itch.zone/files/cool-hack.zip?sig=abc\r\n';
  assert.equal(src.parseZoneIdentifier(zone), 'https://creator.itch.io/cool-hack');
  assert.equal(src.parseZoneIdentifier('[ZoneTransfer]\nZoneId=3\nReferrerUrl=https://www.google.com/\nHostUrl=https://example.org/game.zip\n'), 'https://example.org/game.zip', 'search page skipped');
  assert.equal(src.parseZoneIdentifier('[ZoneTransfer]\nZoneId=3\n'), '');
  assert.equal(src.parseWhereFroms('(\n    "https://github.com/x/y/releases/download/v1/game.zip",\n    "https://github.com/x/y/releases"\n)'), 'https://github.com/x/y/releases');
  assert.equal(src.cleanUrl('javascript:alert(1)'), '');
  assert.equal(src.cleanUrl('file:///etc/passwd'), '');
  assert.equal(src.cleanUrl('https://user:pw@example.com/'), '');
  assert.equal(src.domainOf('https://www.smashremix.com/download'), 'smashremix.com');
});

test('custom covers: real images only, replaced cleanly, reset to automatic', async () => {
  const { Covers } = require('../lib/covers');
  const dir = path.join(tmp, 'covers-custom');
  const c = new Covers({ dir });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  fs.writeFileSync(path.join(tmp, 'pic.png'), png);
  fs.writeFileSync(path.join(tmp, 'pic.jpg'), jpg);
  fs.writeFileSync(path.join(tmp, 'notes.png'), 'definitely not an image');
  const f1 = await c.setCustomFromFile('n64:abc', path.join(tmp, 'pic.png'));
  assert.match(f1, /^[0-9a-f]{20}-c\d+\.png$/);
  const f2 = await c.setCustomFromFile('n64:abc', path.join(tmp, 'pic.jpg'));
  assert.match(f2, /\.jpg$/);
  assert.ok(!fs.existsSync(path.join(dir, f1)), 'old custom cover removed');
  assert.equal(c.cached('n64:abc'), f2);
  await assert.rejects(c.setCustomFromFile('n64:abc', path.join(tmp, 'notes.png')), /isn't a PNG, JPG/);
  c.reset('n64:abc');
  assert.equal(c.cached('n64:abc'), null);
  assert.ok(!fs.existsSync(path.join(dir, f2)));
});

// ---------------------------------------------------------------- GameCube relay, end to end
test('GameCube relay: guest Dolphin -> local UDP port -> server -> host Netcade -> host Dolphin, and back', async () => {
  const dgram = require('dgram');
  const http = require('http');
  const { WebSocket } = require('ws');
  const tunnel = require('../lib/tunnel');
  const { createServer } = require('../lib/server-embedded');
  const srv = createServer({ log: () => {}, probe: async () => false });
  const { port } = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  const connect = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t }));
      const w = waiters.find((x) => x.type === m.type);
      if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } else inbox.push(m);
    });
    const c = {
      send: (m) => ws.send(JSON.stringify(m)),
      next: (type) => {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((r) => waiters.push({ type, resolve: r }));
      },
      close: () => ws.close(),
    };
    ws.once('open', async () => { const w = await c.next('welcome'); c.id = w.id; c.token = w.token; c.send({ type: 'hello', name: 'x' }); resolve(c); });
  });
  const host = await connect();
  const guest = await connect();
  host.send({ type: 'create', system: 'gc', game: { key: 'gc:GALE01:2:0', title: 'Melee', region: 'USA', rev: 2, id: 'GALE01' } });
  const { code } = await host.next('joined');
  guest.send({ type: 'join', code }); await guest.next('joined');
  guest.send({ type: 'ready', ready: true });
  await new Promise((r) => setTimeout(r, 150));
  host.send({ type: 'start', hostOptions: { gcConnection: 'relay' } });
  await guest.next('launch');
  await new Promise((resolve) => http.get(`${base}/dolphin/v0/session/add?name=${code}&region=NA&game=Melee&password=0&method=direct&server_id=203.0.113.9&in_game=0&port=2626&player_count=1&version=5`, (res) => { res.resume(); res.on('end', resolve); }));
  const ds = await guest.next('dolphinSession');
  assert.equal(ds.relay, true);

  // host's "Dolphin": echoes every packet back with a prefix
  const hostDolphin = dgram.createSocket('udp4');
  hostDolphin.on('message', (d, r) => hostDolphin.send(Buffer.concat([Buffer.from('host:'), d]), r.port, r.address));
  await new Promise((r) => hostDolphin.bind(0, '127.0.0.1', r));
  const hostTunnels = [];
  (async () => {
    for (;;) {
      const m = await host.next('tunnelOpen');
      hostTunnels.push(tunnel.openHostUdpTunnel({ serverUrl: base, pid: host.id, token: host.token, cid: m.cid, localPort: hostDolphin.address().port }));
    }
  })();

  const g = await tunnel.startGuestUdp({ serverUrl: base, pid: guest.id, token: guest.token });
  // guest's "Dolphin": an ENet client would send from one fixed local port
  const guestDolphin = dgram.createSocket('udp4');
  await new Promise((r) => guestDolphin.bind(0, '127.0.0.1', r));
  const replies = [];
  guestDolphin.on('message', (d) => replies.push(d.toString()));
  const big = Buffer.alloc(1400, 7);
  guestDolphin.send(Buffer.from('connect'), g.port, '127.0.0.1');
  guestDolphin.send(big, g.port, '127.0.0.1');
  for (let i = 0; i < 40 && replies.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(replies.includes('host:connect'), JSON.stringify(replies));
  assert.ok(replies.some((r) => r.length === 5 + 1400), 'a full-size packet arrives in one piece');

  // a new Connect attempt from a different local port gets a fresh tunnel and still works
  const retry = dgram.createSocket('udp4');
  await new Promise((r) => retry.bind(0, '127.0.0.1', r));
  const again = new Promise((r) => retry.once('message', (d) => r(d.toString())));
  retry.send(Buffer.from('again'), g.port, '127.0.0.1');
  assert.equal(await again, 'host:again');
  assert.equal(hostTunnels.length, 2);

  g.close();
  for (const t of hostTunnels) t.close();
  guestDolphin.close(); retry.close(); hostDolphin.close();
  host.close(); guest.close();
  await srv.close();
});

test('Dolphin config: relay hosts by direct port without UPnP; guests aim at the local relay', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'dol-'));
  const settings = { graphics: {}, controls: {}, netplay: { dolphinPort: 2626 } };
  const game = { path: path.join(tmp, 'melee.iso') };
  fs.writeFileSync(game.path, 'x');
  dolphin.prepare({ userDir: dir, mode: 'host', platform: 'linux', settings, game, romFolders: [], lobbyCode: 'ABC123', indexUrl: 'http://x/dolphin', gcConnection: 'relay' });
  let cfg = fs.readFileSync(path.join(dir, 'Config', 'Dolphin.ini'), 'utf8');
  assert.match(cfg, /TraversalChoice = direct/);
  assert.match(cfg, /UseUPNP = False/);
  assert.match(cfg, /HostPort = 2626/);
  dolphin.prepare({ userDir: dir, mode: 'host', platform: 'linux', settings, game, romFolders: [], lobbyCode: 'ABC123', indexUrl: 'http://x/dolphin', gcConnection: 'traversal' });
  cfg = fs.readFileSync(path.join(dir, 'Config', 'Dolphin.ini'), 'utf8');
  assert.match(cfg, /TraversalChoice = traversal/);
  assert.match(cfg, /UseUPNP = True/);
  dolphin.prepare({ userDir: dir, mode: 'guest', platform: 'linux', settings, game, romFolders: [], indexUrl: 'http://x/dolphin', hostCode: '127.0.0.1', method: 'direct', port: 51234 });
  cfg = fs.readFileSync(path.join(dir, 'Config', 'Dolphin.ini'), 'utf8');
  assert.match(cfg, /Address = 127\.0\.0\.1/);
  assert.match(cfg, /ConnectPort = 51234/);
  assert.match(dolphin.instructions('host', true, [], false, 'relay')[1], /Direct Connection/);
});

// ---------------------------------------------------------------- GameCube controls: picker, adapter, kept Dolphin setup
test('GameCube controls: adapter, keeping what was set in Dolphin, and spotting changes', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'pad-'));
  const game = { path: path.join(tmp, 'melee2.iso') };
  fs.writeFileSync(game.path, 'x');
  const base = { graphics: {}, netplay: {} };
  const prep = (controls) => dolphin.prepare({ userDir: dir, mode: 'solo', platform: 'win32', settings: { ...base, controls: { gc: controls } }, game, romFolders: [] });
  const dolIni = () => fs.readFileSync(path.join(dir, 'Config', 'Dolphin.ini'), 'utf8');
  const padIni = () => fs.readFileSync(path.join(dir, 'Config', 'GCPadNew.ini'), 'utf8');

  // a PlayStation controller picked on the Controls page
  let r = prep({ mode: 'gamepad', gamepad: {}, device: { kind: 'sdl', index: 0, name: 'PS5 Controller' } });
  assert.match(padIni(), /Device = SDL\/0\/PS5 Controller/);
  assert.match(dolIni(), /SIDevice0 = 6/);
  assert.equal(r.controls.siDevice, 6);

  // the adapter: port 1 becomes a real GameCube controller
  r = prep({ mode: 'gamepad', gamepad: {}, device: { kind: 'adapter' } });
  assert.match(dolIni(), /SIDevice0 = 12/);
  assert.equal(r.controls.siDevice, dolphin.SI_ADAPTER);

  // untouched by Dolphin -> no change, even if Dolphin re-saves without empty keys and with its own number format
  r = prep({ mode: 'gamepad', gamepad: {}, device: { kind: 'xinput', index: 0 } });
  const written = r.controls;
  const resaved = Object.fromEntries(Object.entries(written.section).filter(([, v]) => v !== '').map(([k, v]) => [k, k.endsWith('Range') ? '50.000000000000000' : v]));
  resaved['Main Stick/Calibration'] = '100.00 101.65 108.08';
  ini.updateFile(path.join(dir, 'Config', 'GCPadNew.ini'), {}, { GCPad1: resaved });
  let now = dolphin.readControls(dir);
  assert.equal(dolphin.controlsChanged(written, now), false, 'calibration and number formatting alone are not "changed controls"');

  // player remaps in Dolphin: different device and a different A button
  ini.updateFile(path.join(dir, 'Config', 'GCPadNew.ini'), {}, { GCPad1: { ...resaved, Device: 'SDL/0/Nintendo Switch Pro Controller', 'Buttons/A': '`Button E`' } });
  now = dolphin.readControls(dir);
  assert.equal(dolphin.controlsChanged(written, now), true);

  // switching to the adapter inside Dolphin also counts
  ini.updateFile(path.join(dir, 'Config', 'Dolphin.ini'), { Core: { SIDevice0: 12 } });
  assert.equal(dolphin.controlsChanged(written, dolphin.readControls(dir)), true);

  // kept: the next launch writes Dolphin's own setup back verbatim instead of Netcade's
  const kept = { section: now.section, siDevice: 6 };
  r = prep({ mode: 'keyboard', keyboard: {}, useDolphin: true, dolphinPad: kept });
  assert.match(padIni(), /Device = SDL\/0\/Nintendo Switch Pro Controller/);
  assert.match(padIni(), /Buttons\/A = `Button E`/);
  assert.match(padIni(), /Main Stick\/Calibration = 100\.00 101\.65 108\.08/);
  assert.match(dolIni(), /SIDevice0 = 6/);
  // and no "changed" prompt right after a launch that used the kept setup
  assert.equal(dolphin.controlsChanged(r.controls, dolphin.readControls(dir)), false);

  // switching back to Netcade's controls
  prep({ mode: 'keyboard', keyboard: {}, useDolphin: false, dolphinPad: kept });
  assert.match(padIni(), /Device = DInput\/0\/Keyboard Mouse/);
});

// ---------------------------------------------------------------- Netcade's Dolphin build: control link
test('Dolphin control link: token check, state, commands and replies', async () => {
  const net = require('net');
  const { DolphinControl, sessionReadiness, padsFromLobby } = require('../lib/dolphinControl');
  const ctl = new DolphinControl();
  const port = await ctl.listen();

  // an impostor without the token is dropped
  const bad = net.connect(port, '127.0.0.1');
  await new Promise((r) => bad.once('connect', r));
  bad.write(JSON.stringify({ ev: 'hello', token: 'nope' }) + '\n');
  await new Promise((r) => bad.once('close', r));
  assert.equal(ctl.connected, false);

  // stand-in for the patched Dolphin: answers commands like the real bridge does
  const dol = net.connect(port, '127.0.0.1');
  await new Promise((r) => dol.once('connect', r));
  const got = [];
  let buf = '';
  dol.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const c = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      got.push(c);
      dol.write(JSON.stringify({ ev: 'result', cmd: c.cmd, id: c.id, ok: c.cmd !== 'start', error: c.cmd === 'start' ? 'not-all-have-game' : undefined }) + '\n');
    }
  });
  const connected = new Promise((r) => ctl.once('connected', r));
  dol.write(JSON.stringify({ ev: 'hello', token: ctl.token, version: '2609a-netcade', protocol: 1 }) + '\n');
  assert.equal((await connected).version, '2609a-netcade');

  const state = new Promise((r) => ctl.once('state', r));
  const ev = new Promise((r) => ctl.once('event', r));
  const msg = new Promise((r) => ctl.once('msg', r));
  dol.write([
    JSON.stringify({ ev: 'state', hosting: true, players: [{ name: 'Matt', status: 'ok', ping: 0, port: 1, host: true }, { name: 'Sam', status: 'missing', ping: 40, port: 0 }] }),
    JSON.stringify({ ev: 'msg', text: 'Sam has joined', color: 'darkcyan' }),
    JSON.stringify({ ev: 'desync', detail: 'Sam@1234' }),
  ].join('\n') + '\n');
  const s = await state;
  assert.equal(s.players.length, 2);
  assert.deepEqual(await ev, { ev: 'desync', detail: 'Sam@1234' });
  assert.equal((await msg).text, 'Sam has joined');

  const r1 = await ctl.send('pads', { ports: ['Matt', 'Sam', '', ''] });
  assert.equal(r1.ok, true);
  const r2 = await ctl.send('start');
  assert.deepEqual([r2.ok, r2.error], [false, 'not-all-have-game']);
  assert.deepEqual(got.map((c) => c.cmd), ['pads', 'start']);
  assert.deepEqual(got[0].ports, ['Matt', 'Sam', '', '']);
  assert.equal((await ctl.send('format-c')).error, 'unknown-command', 'only known commands go to Dolphin');

  // readiness and ports from the lobby
  assert.deepEqual(sessionReadiness(['Matt', 'Sam', 'Alex'], s.players), { ready: false, waiting: ['Alex'], wrong: [{ name: 'Sam', status: 'missing' }] });
  assert.equal(sessionReadiness(['Matt'], s.players).ready, true);
  assert.deepEqual(padsFromLobby([{ name: 'Matt', port: 1 }, { name: 'Sam', port: 3 }, { name: 'Viewer', port: null }], 4), ['Matt', '', 'Sam', '']);
  assert.deepEqual(padsFromLobby([{ name: 'Matt', port: 1 }, { name: 'Sam', port: 3 }], 2), ['Matt', '', '', ''], 'ports past the lobby size stay empty');

  const closed = new Promise((r) => ctl.once('closed', r));
  dol.destroy();
  await closed;
  ctl.close();
});

test('Dolphin launch: Netcade build arguments, NetPlay window options in Dolphin.ini, build detection', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ncd-'));
  assert.deepEqual(dolphin.args({ userDir: dir, mode: 'host', netcade: { game: '/g/melee.iso', port: 4567 } }),
    ['-u', dir, '--netcade-host', '/g/melee.iso', '--netcade-control', '4567']);
  assert.deepEqual(dolphin.args({ userDir: dir, mode: 'guest', netcade: { game: '/g/melee.iso', port: 1 } }).slice(2, 4), ['--netcade-join', '/g/melee.iso']);
  assert.deepEqual(dolphin.args({ userDir: dir, mode: 'guest' }), ['-u', dir], 'official Dolphin gets no Netcade arguments');

  const game = { path: path.join(tmp, 'melee3.iso') };
  fs.writeFileSync(game.path, 'x');
  dolphin.prepare({ userDir: dir, mode: 'host', platform: 'win32', game, romFolders: [], lobbyCode: 'ABC123', indexUrl: 'http://x/dolphin',
    settings: { graphics: {}, controls: {}, netplay: {}, dolphinNetplay: { networkMode: 'golf', savedata: 'none', syncCodes: false, recordInputs: true, strictSync: true } } });
  const cfg = fs.readFileSync(path.join(dir, 'Config', 'Dolphin.ini'), 'utf8');
  for (const line of ['NetworkMode = golf', 'SyncSaves = False', 'WriteSaveData = False', 'SyncCodes = False', 'RecordInputs = True', 'StrictSettingsSync = True', 'GolfModeOverlay = True']) {
    assert.ok(cfg.includes(line), line);
  }
  assert.deepEqual(dolphin.netplayOptions({ dolphinNetplay: { networkMode: 'bogus', savedata: 'x' } }).networkMode, 'fixeddelay');

  const exe = path.join(dir, 'Dolphin.exe');
  fs.writeFileSync(exe, '');
  assert.equal(dolphin.isNetcadeBuild(exe), false);
  fs.writeFileSync(path.join(dir, 'Netcade.txt'), 'Netcade build');
  assert.equal(dolphin.isNetcadeBuild(exe), true);
});
