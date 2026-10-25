'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const { WebSocket } = require('ws');
const { createServer } = require('../server');

function client(base, headers) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', headers ? { headers } : undefined);
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t }));
    inbox.push(m);
    for (const w of waiters.slice()) {
      const i = inbox.findIndex(w.pred);
      if (i >= 0) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(inbox.splice(i, 1)[0]);
      }
    }
  });
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, pred = () => true, timeout = 4000) {
      const p = (m) => m.type === type && pred(m);
      const i = inbox.findIndex(p);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred: p, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeout);
      });
    },
    open: () => new Promise((r) => ws.once('open', r)),
    close: () => ws.close(),
  };
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

const N64_GAME = { key: 'md5:abc', title: 'Test Kart 64', region: 'USA', rev: 0, id: 'NTKE' };
const GC_GAME = { key: 'gc:GTEST01:0:0', title: 'Test Melee', region: 'USA', rev: 2, id: 'GTEST01' };

async function setup(probeResult = false) {
  const srv = createServer({ log: () => {}, probe: async () => probeResult });
  const addr = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  return { srv, base };
}

test('lobby create, join, ready, has-check and start', async () => {
  const { srv, base } = await setup();
  const host = client(base); await host.open();
  const guest = client(base); await guest.open();
  const hw = await host.next('welcome');
  const gw = await guest.next('welcome');
  host.send({ type: 'hello', name: 'Matt', versions: { retroarch: '1.20.0' } });
  guest.send({ type: 'hello', name: 'Sam', versions: { retroarch: '1.20.0' } });

  host.send({ type: 'create', system: 'n64', game: N64_GAME, public: true, maxPlayers: 4 });
  const joined = await host.next('joined');
  assert.match(joined.code, /^[A-Z2-9]{6}$/);

  guest.send({ type: 'list' });
  const list = await guest.next('lobbies');
  assert.equal(list.list[0].code, joined.code);
  assert.equal(list.list[0].title, 'Test Kart 64');

  guest.send({ type: 'join', code: joined.code.toLowerCase() });
  await guest.next('joined');
  guest.send({ type: 'has', status: 'match' });

  // host can't start until guest is ready
  host.send({ type: 'start' });
  const err = await host.next('error');
  assert.match(err.message, /Sam/);

  guest.send({ type: 'ready', ready: true });
  const view = await host.next('lobby', (m) => m.lobby.members.length === 2 && m.lobby.members[1].ready);
  assert.equal(view.lobby.members[1].has.status, 'match');
  assert.equal(view.lobby.members[0].isHost, true);
  assert.equal(view.lobby.members[1].port, 2);

  host.send({ type: 'start' });
  const hl = await host.next('launch');
  const gl = await guest.next('launch');
  assert.equal(hl.role, 'host');
  assert.equal(gl.role, 'guest');
  assert.equal(gl.port, 2);
  assert.ok(gl.inputDelay >= 1);

  // no LAN address to offer -> relay
  host.send({ type: 'hostReady', port: 55435 });
  const ci = await guest.next('connectInfo');
  assert.equal(ci.mode, 'relay');
  assert.ok(hw.token && gw.token);

  host.close(); guest.close();
  await srv.close();
});

test('direct mode and same-household LAN fallback', async () => {
  const { srv, base } = await setup(true);
  const host = client(base); await host.open(); await host.next('welcome');
  const guest = client(base); await guest.open(); await guest.next('welcome');
  host.send({ type: 'create', system: 'n64', game: N64_GAME });
  const { code } = await host.next('joined');
  guest.send({ type: 'join', code });
  await guest.next('joined');
  guest.send({ type: 'ready', ready: true });
  await host.next('lobby', (m) => m.lobby.members[1]?.ready);
  host.send({ type: 'start' });
  await guest.next('launch');
  host.send({ type: 'hostReady', port: 55435, lanIps: ['192.168.1.20'] });
  const ci = await guest.next('connectInfo');
  assert.equal(ci.mode, 'direct');
  // both test clients share 127.0.0.1, so the guest gets the host's LAN IP
  assert.equal(ci.ip, '192.168.1.20');
  host.close(); guest.close();
  await srv.close();
});

test('password, kick and host migration', async () => {
  const { srv, base } = await setup();
  const a = client(base); await a.open(); const aw = await a.next('welcome');
  const b = client(base); await b.open(); const bw = await b.next('welcome');
  const c = client(base); await c.open(); await c.next('welcome');
  a.send({ type: 'hello', name: 'A' }); b.send({ type: 'hello', name: 'B' }); c.send({ type: 'hello', name: 'C' });
  a.send({ type: 'create', system: 'gc', game: GC_GAME, password: 'pw' });
  const { code } = await a.next('joined');
  b.send({ type: 'join', code });
  const e = await b.next('error');
  assert.equal(e.needPassword, true);
  b.send({ type: 'join', code, password: 'pw' });
  await b.next('joined');
  c.send({ type: 'join', code, password: 'pw' });
  await c.next('joined');
  a.send({ type: 'kick', id: bw.id });
  await b.next('kicked');
  a.close();
  const v = await c.next('lobby', (m) => m.lobby.members.length === 1);
  assert.notEqual(v.lobby.hostId, aw.id);
  assert.equal(v.lobby.members[0].isHost, true);
  b.close(); c.close();
  await srv.close();
});

test('Dolphin session index pushes host code to guests', async () => {
  const { srv, base } = await setup();
  const host = client(base); await host.open(); await host.next('welcome');
  const guest = client(base); await guest.open(); await guest.next('welcome');
  host.send({ type: 'create', system: 'gc', game: GC_GAME });
  const { code } = await host.next('joined');
  guest.send({ type: 'join', code });
  await guest.next('joined');

  // before the match starts, Dolphin registrations are refused
  let r = await get(`${base}/dolphin/v0/session/add?name=${code}&region=NA&game=x&password=0&method=traversal&server_id=abcd1234&in_game=0&port=2626&player_count=1&version=5.0`);
  assert.equal(r.status, 'MATCH_NOT_STARTED');

  guest.send({ type: 'ready', ready: true });
  await host.next('lobby', (m) => m.lobby.members[1]?.ready);
  host.send({ type: 'start' });
  await guest.next('launch');

  r = await get(`${base}/dolphin/v0/session/add?name=${code.toLowerCase()}&region=NA&game=Test%20Melee&password=0&method=traversal&server_id=abcd1234&in_game=0&port=2626&player_count=1&version=5.0-21000`);
  assert.equal(r.status, 'OK');
  assert.ok(r.secret);
  const ds = await guest.next('dolphinSession');
  assert.equal(ds.hostCode, 'abcd1234');
  assert.equal(ds.method, 'traversal');

  const list = await get(`${base}/dolphin/v0/list?name=${code}`);
  assert.equal(list.status, 'OK');
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].server_id, 'abcd1234');
  // private lobby must not show without its code
  const publicList = await get(`${base}/dolphin/v0/list`);
  assert.equal(publicList.sessions.length, 0);

  r = await get(`${base}/dolphin/v0/session/active?secret=${r.secret}&player_count=2&game=x&in_game=1`);
  assert.equal(r.status, 'OK');
  const bad = await get(`${base}/dolphin/v0/session/active?secret=nope&player_count=2&game=x&in_game=1`);
  assert.equal(bad.status, 'BAD_SECRET');

  const add2 = await get(`${base}/dolphin/v0/session/add?name=ZZZZZZ&region=NA&game=x&password=0&method=traversal&server_id=x&in_game=0&port=1&player_count=1&version=1`);
  assert.equal(add2.status, 'NOT_A_NETCADE_LOBBY');
  host.close(); guest.close();
  await srv.close();
});

test('relay tunnels TCP traffic between guest and host', async () => {
  const { srv, base } = await setup(false);
  // stand-in for the host's RetroArch: an echo server that uppercases
  const echo = net.createServer((s) => s.on('data', (d) => s.write(d.toString().toUpperCase())));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;

  const host = client(base); await host.open(); const hw = await host.next('welcome');
  const guest = client(base); await guest.open(); const gw = await guest.next('welcome');
  host.send({ type: 'create', system: 'n64', game: N64_GAME });
  const { code } = await host.next('joined');
  guest.send({ type: 'join', code }); await guest.next('joined');
  guest.send({ type: 'ready', ready: true });
  await host.next('lobby', (m) => m.lobby.members[1]?.ready);
  host.send({ type: 'start' });
  await guest.next('launch');
  host.send({ type: 'hostReady', port: echoPort });
  const ci = await guest.next('connectInfo');
  assert.equal(ci.mode, 'relay');

  const wsBase = base.replace('http', 'ws');
  const gws = new WebSocket(`${wsBase}/relay?role=guest&pid=${gw.id}&token=${gw.token}`);
  await new Promise((r) => gws.once('open', r));
  gws.send(Buffer.from('hello netplay'));   // sent before the host side even exists: must be buffered

  const open = await host.next('tunnelOpen');
  // listeners must be attached before 'open': buffered data can arrive with the upgrade response
  const tcp = net.connect(echoPort, '127.0.0.1');
  const hws = new WebSocket(`${wsBase}/relay?role=host&cid=${open.cid}&pid=${hw.id}&token=${hw.token}`);
  hws.on('message', (d) => tcp.write(d));
  tcp.on('data', (d) => hws.send(d));
  await new Promise((r) => hws.once('open', r));

  const reply = await new Promise((r) => gws.once('message', (d) => r(d.toString())));
  assert.equal(reply, 'HELLO NETPLAY');

  // bad token is rejected
  const evil = new WebSocket(`${wsBase}/relay?role=guest&pid=${gw.id}&token=wrong`);
  const closeCode = await new Promise((r) => evil.once('close', (c) => r(c)));
  assert.equal(closeCode, 4001);

  gws.close(); hws.close(); tcp.destroy(); echo.close();
  host.close(); guest.close();
  await srv.close();
});

test('server behind a tunnel on the host PC: remote guests use the relay, LAN guests go direct', async () => {
  let probed = 0;
  const srv = createServer({ log: () => {}, probe: async () => { probed++; return true; } });
  const addr = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const host = client(base); await host.open(); await host.next('welcome');                       // host on the same PC
  const remote = client(base, { 'cf-connecting-ip': '203.0.113.9' }); await remote.open(); await remote.next('welcome'); // via tunnel
  const lan = client(base, { 'cf-connecting-ip': '192.168.1.44' }); await lan.open(); await lan.next('welcome');
  host.send({ type: 'create', system: 'n64', game: N64_GAME });
  const { code } = await host.next('joined');
  for (const c of [remote, lan]) { c.send({ type: 'join', code }); await c.next('joined'); c.send({ type: 'ready', ready: true }); }
  await host.next('lobby', (m) => m.lobby.members.length === 3 && m.lobby.members.every((x) => x.isHost || x.ready));
  host.send({ type: 'start' });
  await remote.next('launch'); await lan.next('launch');
  host.send({ type: 'hostReady', port: 55435, lanIps: ['192.168.1.20'] });
  const r = await remote.next('connectInfo');
  const l = await lan.next('connectInfo');
  assert.equal(r.mode, 'relay', 'internet guest must not be sent a LAN address');
  assert.equal(l.mode, 'direct');
  assert.equal(l.ip, '192.168.1.20');
  assert.equal(probed, 0, 'no point probing a private host address');
  host.close(); remote.close(); lan.close();
  await srv.close();
});

test('GameCube relay: UDP packets pass whole through the server, one tunnel per guest, host IP kept private', async () => {
  const dgram = require('dgram');
  const { srv, base } = await setup(false);
  const wsBase = base.replace('http', 'ws');
  const host = client(base); await host.open(); const hw = await host.next('welcome');
  const guest = client(base); await guest.open(); const gw = await guest.next('welcome');
  host.send({ type: 'create', system: 'gc', game: GC_GAME });
  const { code } = await host.next('joined');
  guest.send({ type: 'join', code }); await guest.next('joined');

  // before a match there is nothing to relay to
  const early = new WebSocket(`${wsBase}/relay?role=guest&pid=${gw.id}&token=${gw.token}`);
  assert.equal(await new Promise((r) => early.once('close', (c) => r(c))), 4002);

  guest.send({ type: 'ready', ready: true });
  await host.next('lobby', (m) => m.lobby.members[1]?.ready);
  host.send({ type: 'start', hostOptions: { gcConnection: 'relay' } });
  await guest.next('launch');
  // the host's Dolphin registers with the index as a direct-IP session
  const add = await get(`${base}/dolphin/v0/session/add?name=${code}&region=NA&game=Melee&password=0&method=direct&server_id=203.0.113.9&in_game=0&port=2626&player_count=1&version=5.0`);
  assert.equal(add.status, 'OK');
  const ds = await guest.next('dolphinSession');
  assert.equal(ds.relay, true);
  assert.equal(ds.hostCode, '');
  const view = (await guest.next('lobby', (m) => m.lobby.dolphin)).lobby;
  assert.deepEqual([view.dolphin.relay, view.dolphin.hostCode], [true, '']);
  const note = await guest.next('chat', (m) => m.system && /Dolphin session/.test(m.text));
  assert.match(note.text, /through Netcade/);
  assert.ok(!note.text.includes('203.0.113.9'));

  // stand-in for the host's Dolphin: UDP echo that tags replies
  const dolphin = dgram.createSocket('udp4');
  dolphin.on('message', (d, r) => dolphin.send(Buffer.concat([Buffer.from('ack:'), d]), r.port, r.address));
  await new Promise((r) => dolphin.bind(0, '127.0.0.1', r));
  const dPort = dolphin.address().port;
  const hostSockets = [];
  const pair = async () => {
    const gws = new WebSocket(`${wsBase}/relay?role=guest&pid=${gw.id}&token=${gw.token}`);
    await new Promise((r) => gws.once('open', r));
    gws.send(Buffer.from('packet-1'));
    gws.send(Buffer.from('packet-2'));
    const open = await host.next('tunnelOpen');
    assert.equal(open.udp, true);
    const u = dgram.createSocket('udp4');
    await new Promise((r) => u.bind(0, '127.0.0.1', r));
    hostSockets.push(u);
    const hws = new WebSocket(`${wsBase}/relay?role=host&cid=${open.cid}&pid=${hw.id}&token=${hw.token}`);
    hws.on('message', (d) => u.send(d, dPort, '127.0.0.1'));
    u.on('message', (d) => hws.send(d));
    const got = [];
    await new Promise((r) => gws.on('message', (d) => { got.push(d.toString()); if (got.length === 2) r(); }));
    return { gws, hws, got };
  };
  const a = await pair();
  assert.deepEqual(a.got.sort(), ['ack:packet-1', 'ack:packet-2'], 'each packet arrives separately, not merged');
  const b = await pair();   // a second Dolphin connection (or second guest) gets its own tunnel
  assert.deepEqual(b.got.sort(), ['ack:packet-1', 'ack:packet-2']);

  for (const t of [a, b]) { t.gws.close(); t.hws.close(); }
  for (const u of hostSockets) u.close();
  dolphin.close(); host.close(); guest.close();
  await srv.close();
});

test('GameCube traversal mode still hands out the host code', async () => {
  const { srv, base } = await setup(false);
  const host = client(base); await host.open(); await host.next('welcome');
  const guest = client(base); await guest.open(); await guest.next('welcome');
  host.send({ type: 'create', system: 'gc', game: GC_GAME });
  const { code } = await host.next('joined');
  guest.send({ type: 'join', code }); await guest.next('joined');
  guest.send({ type: 'ready', ready: true });
  await host.next('lobby', (m) => m.lobby.members[1]?.ready);
  host.send({ type: 'start', hostOptions: { gcConnection: 'traversal' } });
  await guest.next('launch');
  await get(`${base}/dolphin/v0/session/add?name=${code}&region=NA&game=Melee&password=0&method=traversal&server_id=abcd1234&in_game=0&port=2626&player_count=1&version=5.0`);
  const ds = await guest.next('dolphinSession');
  assert.equal(ds.hostCode, 'abcd1234');
  assert.ok(!ds.relay);
  host.close(); guest.close();
  await srv.close();
});
