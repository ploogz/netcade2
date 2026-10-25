'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');
const { createServer, createBracket, findMatch, finishMatch, seedOrder } = require('../server');

function client(base, name) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const inbox = [];
  const waiters = [];
  const c = {
    ws, id: null, name,
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, pred = () => true, timeout = 4000) {
      const p = (m) => { try { return m.type === type && pred(m); } catch { return false; } };
      const i = inbox.findIndex(p);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        waiters.push({ pred: p, resolve });
        setTimeout(() => reject(new Error(`${name}: timeout waiting for ${type}`)), timeout);
      });
    },
    drain(type) { for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].type === type) inbox.splice(i, 1); },
    close: () => ws.close(),
  };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t }));
    inbox.push(m);
    for (const w of waiters.slice()) {
      const i = inbox.findIndex(w.pred);
      if (i >= 0) { waiters.splice(waiters.indexOf(w), 1); w.resolve(inbox.splice(i, 1)[0]); }
    }
  });
  c.ready = new Promise((r) => ws.once('open', r)).then(async () => {
    const w = await c.next('welcome');
    c.id = w.id;
    c.send({ type: 'hello', name });
    return c;
  });
  return c;
}

const GAME = { key: 'n64:abc', title: 'Smash 64', region: 'USA', rev: 0, id: 'NALE' };

async function lobbyOf(n, system = 'n64', maxPlayers = 4) {
  const srv = createServer({ log: () => {}, probe: async () => true });
  const addr = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(await client(base, `P${i}`).ready);
  cs[0].send({ type: 'create', system, game: { ...GAME, key: system === 'gc' ? 'gc:GALE01:2:0' : GAME.key }, maxPlayers });
  const { code } = await cs[0].next('joined');
  for (const c of cs.slice(1)) { c.send({ type: 'join', code }); await c.next('joined'); }
  const last = await cs[0].next('lobby', (m) => m.lobby.members.length === n);
  return { srv, cs, code, view: last.lobby, async latest(c = cs[0], pred = () => true) { return (await c.next('lobby', (m) => pred(m.lobby))).lobby; } };
}

const byName = (view, name) => view.members.find((m) => m.name === name);

test('8 people: 4 on controller ports, 4 spectators, 9th turned away', async () => {
  const L = await lobbyOf(8);
  assert.deepEqual(L.view.members.map((m) => m.port), [1, 2, 3, 4, null, null, null, null]);
  assert.equal(L.view.members.filter((m) => m.spectator).length, 4);
  const extra = await client(`http://127.0.0.1:${L.srv.httpServer.address().port}`, 'P8').ready;
  extra.send({ type: 'join', code: L.code });
  const err = await extra.next('error');
  assert.match(err.message, /full \(8 people\)/);
  // spectators can't ready
  L.cs[5].send({ type: 'ready', ready: true });
  assert.match((await L.cs[5].next('error')).message, /Spectators/);
  // start needs only port holders ready
  for (const c of L.cs.slice(1, 4)) c.send({ type: 'ready', ready: true });
  await L.latest(L.cs[0], (v) => v.members.filter((m) => m.ready).length === 3);
  L.cs[0].send({ type: 'start' });
  const spec = await L.cs[6].next('launch');
  assert.equal(spec.spectate, true);
  assert.equal(spec.port, null);
  const p3 = await L.cs[2].next('launch');
  assert.equal(p3.port, 3);
  assert.equal(p3.spectate, false);
  for (const c of [...L.cs, extra]) c.close();
  await L.srv.close();
});

test('spectator asks for an occupied port: holder declines, then accepts', async () => {
  const L = await lobbyOf(3, 'n64', 2);   // P0,P1 on ports, P2 watching
  const [host, p1, spec] = L.cs;
  spec.send({ type: 'requestPort', port: 2 });
  const req = await p1.next('portRequest');
  assert.equal(req.fromName, 'P2');
  assert.equal(req.fromPort, null);
  let v = await L.latest(host, (x) => x.requests.length === 1);
  assert.equal(v.requests[0].targetName, 'P1');
  p1.send({ type: 'answerPort', reqId: req.reqId, accept: false });
  assert.match((await spec.next('info', (m) => /said no/.test(m.message))).message, /P1 said no/);
  spec.send({ type: 'requestPort', port: 2 });
  const req2 = await p1.next('portRequest');
  p1.send({ type: 'answerPort', reqId: req2.reqId, accept: true });
  v = await L.latest(host, (x) => byName(x, 'P2').port === 2);
  assert.equal(byName(v, 'P1').spectator, true, 'the player who gave up the port now watches');
  // a player taking a free port needs no confirmation
  host.send({ type: 'setOptions', maxPlayers: 3 });
  await L.latest(host, (x) => x.maxPlayers === 3);
  p1.send({ type: 'requestPort', port: 3 });
  v = await L.latest(host, (x) => byName(x, 'P1').port === 3);
  for (const c of L.cs) c.close();
  await L.srv.close();
});

test('two players swap ports; host can move anyone directly', async () => {
  const L = await lobbyOf(3, 'gc', 3);
  const [host, a, b] = L.cs;
  a.send({ type: 'requestPort', port: 3 });   // a is P2, b is P3
  const req = await b.next('portRequest');
  assert.equal(req.fromPort, 2);
  b.send({ type: 'answerPort', reqId: req.reqId, accept: true });
  let v = await L.latest(host, (x) => byName(x, 'P1').port === 3);
  assert.equal(byName(v, 'P2').port, 2, 'b took a\'s old port');
  host.send({ type: 'setPort', id: b.id, port: null });
  v = await L.latest(host, (x) => byName(x, 'P2').spectator);
  host.send({ type: 'setPort', id: b.id, port: 1 });   // swaps with the host
  v = await L.latest(host, (x) => byName(x, 'P2').port === 1);
  assert.equal(byName(v, 'P0').port, null, 'host moved to b\'s old slot (spectator)');
  for (const c of L.cs) c.close();
  await L.srv.close();
});

test('live N64 swap: leaver spectates first, newcomer plays and lands on the freed port', async () => {
  const L = await lobbyOf(3, 'n64', 2);
  const [host, p1, spec] = L.cs;
  p1.send({ type: 'ready', ready: true });
  await L.latest(host, (x) => byName(x, 'P1').ready);
  host.send({ type: 'start' });
  await spec.next('launch');
  host.send({ type: 'hostReady', port: 55435, lanIps: ['192.168.1.2'] });
  await spec.next('connectInfo');
  spec.send({ type: 'requestPort', port: 2 });
  const req = await p1.next('portRequest');
  p1.send({ type: 'answerPort', reqId: req.reqId, accept: true });
  const t0 = Date.now();
  const off = await p1.next('netplayMode');
  assert.equal(off.mode, 'spectate');
  const on = await spec.next('netplayMode', () => true, 5000);
  assert.equal(on.mode, 'play');
  assert.equal(on.port, 2);
  assert.ok(Date.now() - t0 >= 1000, 'play is sent after the spectate step');
  const ch = await host.next('portsChanged');
  assert.equal(ch.live, true);
  for (const c of L.cs) c.close();
  await L.srv.close();
});

test('someone joining a running N64 match is launched as a spectator', async () => {
  const L = await lobbyOf(2, 'n64', 2);
  const [host, p1] = L.cs;
  p1.send({ type: 'ready', ready: true });
  await L.latest(host, (x) => byName(x, 'P1').ready);
  host.send({ type: 'start' });
  await p1.next('launch');
  host.send({ type: 'hostReady', port: 55435 });
  await p1.next('connectInfo');
  const late = await client(`http://127.0.0.1:${L.srv.httpServer.address().port}`, 'Late').ready;
  late.send({ type: 'join', code: L.code });
  await late.next('joined');
  const launch = await late.next('launch');
  assert.equal(launch.spectate, true);
  const ci = await late.next('connectInfo');
  assert.ok(ci.mode);
  for (const c of [...L.cs, late]) c.close();
  await L.srv.close();
});

test('bracket: seeding, byes for 5 players, advancing to a champion', () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const ppl = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase() }));
  const t = createBracket(ppl, 1, 'lobby');
  assert.equal(t.rounds.length, 3);                    // 8-slot bracket
  const r0 = t.rounds[0];
  assert.equal(r0.filter((m) => m.bye).length, 3, '3 byes for 5 players');
  assert.deepEqual(r0.filter((m) => !m.bye).map((m) => [m.a, m.b]), [['d', 'e']]);
  const semis = t.rounds[1];
  assert.equal(semis[0].a, 'a', 'seed 1 got a bye into the semis');
  finishMatch(t, findMatch(t, r0.find((m) => !m.bye).id), 'e');
  assert.equal(semis[0].b, 'e');
  assert.equal(semis[0].status, 'ready');
  finishMatch(t, semis[0], 'a');
  finishMatch(t, semis[1], semis[1].a);
  finishMatch(t, t.rounds[2][0], 'a');
  assert.equal(t.champion, 'a');
});

test('tournament flow in a lobby: setup, best-of-3 reporting, undo, champion', async () => {
  const L = await lobbyOf(4, 'n64', 4);
  const [host, b, c, d] = L.cs;
  host.send({ type: 'tCreate', participants: L.cs.map((x) => x.id), bestOf: 3, seeding: 'lobby' });
  let v = await L.latest(host, (x) => x.tournament);
  assert.equal(v.tournament.rounds.length, 2);
  const m1 = v.tournament.rounds[0].matches[0];
  assert.deepEqual([m1.a, m1.b], [host.id, d.id], 'seed 1 vs seed 4');
  host.send({ type: 'tSetup', matchId: m1.id });
  v = await L.latest(host, (x) => x.tournament.current === m1.id);
  assert.deepEqual(v.ports.slice(0, 2), [host.id, d.id], 'the two players are on P1/P2');
  assert.equal(byName(v, 'P1').spectator, true);
  // a non-participant can't report
  b.send({ type: 'tReport', matchId: m1.id, winner: host.id });
  d.send({ type: 'tReport', matchId: m1.id, winner: d.id });
  v = await L.latest(host, (x) => x.tournament.rounds[0].matches[0].scoreB === 1);
  assert.equal(v.tournament.rounds[0].matches[0].scoreA, 0);
  host.send({ type: 'tReport', matchId: m1.id, winner: d.id });
  v = await L.latest(host, (x) => x.tournament.rounds[0].matches[0].status === 'done');
  assert.equal(v.tournament.rounds[1].matches[0].a, d.id);
  host.send({ type: 'tUndo' });
  v = await L.latest(host, (x) => x.tournament.rounds[0].matches[0].status !== 'done');
  assert.equal(v.tournament.rounds[1].matches[0].a, null, 'undo pulls the winner back out of the final');
  host.send({ type: 'tReport', matchId: m1.id, winner: d.id });
  const m2 = v.tournament.rounds[0].matches[1];
  host.send({ type: 'tReport', matchId: m2.id, winner: m2.a, forfeit: true });
  v = await L.latest(host, (x) => x.tournament.rounds[1].matches[0].status === 'ready');
  const fin = v.tournament.rounds[1].matches[0];
  host.send({ type: 'tReport', matchId: fin.id, winner: fin.a, forfeit: true });
  const done = await c.next('tournamentDone');
  assert.equal(done.champion, fin.a);
  for (const x of L.cs) x.close();
  await L.srv.close();
});

test('game link: only http(s), set on create or later by the host', async () => {
  const srv = createServer({ log: () => {}, probe: async () => true });
  const addr = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}`;
  const host = await client(base, 'H').ready;
  const guest = await client(base, 'G').ready;
  host.send({ type: 'create', system: 'n64', game: { ...GAME, link: 'javascript:alert(1)' } });
  const { code } = await host.next('joined');
  let v = (await host.next('lobby')).lobby;
  assert.equal(v.game.link, '', 'script links are dropped');
  guest.send({ type: 'join', code });
  await guest.next('joined');
  guest.send({ type: 'setOptions', gameLink: 'https://evil.example/' });       // not the host: ignored
  host.send({ type: 'setOptions', gameLink: 'https://creator.itch.io/my-hack' });
  v = (await guest.next('lobby', (m) => m.lobby.game.link)).lobby;
  assert.equal(v.game.link, 'https://creator.itch.io/my-hack');
  host.send({ type: 'setOptions', gameLink: 'file:///C:/Windows/system32' });
  v = (await guest.next('lobby', (m) => m.lobby.game.link === '')).lobby;
  assert.equal(v.game.link, '');
  host.close(); guest.close();
  await srv.close();
});


test('automatic delay: GameCube gets a Dolphin-sized buffer from the slowest guest-to-host path', async () => {
  const L = await lobbyOf(4, 'gc');
  for (const c of L.cs.slice(1)) c.send({ type: 'ready', ready: true });
  await L.latest(L.cs[0], (v) => v.members.filter((m) => m.ready).length === 3);
  L.cs[0].send({ type: 'start' });
  const launch = await L.cs[1].next('launch');
  // all local: tiny pings -> the floor (3), never the old N64-style 1-2
  assert.ok(launch.inputDelay >= 3 && launch.inputDelay <= 5, `buffer ${launch.inputDelay}`);
  for (const c of L.cs) c.close();
  await L.srv.close();
});
