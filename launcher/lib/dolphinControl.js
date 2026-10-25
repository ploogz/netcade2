'use strict';
/**
 * Control link to Netcade's build of Dolphin (see dolphin-netcade/ in the repo).
 *
 * Netcade listens on 127.0.0.1:<random port> and starts Dolphin with
 *   --netcade-host <game> | --netcade-join <game>   --netcade-control <port>
 * and the session token in NETCADE_TOKEN. Dolphin connects back and both sides send one JSON
 * object per line. Dolphin's NetPlay window stays hidden while this link is up.
 *
 * Events emitted: 'connected', 'state' (players, buffer, options…), 'msg' (NetPlay chat/log line),
 * 'event' ({ ev, detail } for started/stopped/desync/lost/error/failed/indexed/…), 'closed'.
 */
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const COMMANDS = new Set(['show', 'hide', 'state', 'start', 'pads', 'buffer', 'options', 'recheck', 'kick', 'chat']);

class DolphinControl extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.token = crypto.randomBytes(18).toString('hex');
    this.sock = null;
    this.server = null;
    this.port = 0;
    this.state = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  /** Start listening; resolves to the port to give Dolphin. */
  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this.accept(sock));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  accept(sock) {
    if (this.sock || this.closed) { sock.destroy(); return; }
    let authed = false;
    let buf = '';
    const timer = setTimeout(() => { if (!authed) sock.destroy(); }, 5000);
    sock.setNoDelay(true);
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.length > 4 * 1024 * 1024) { sock.destroy(); return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) {
          // the first line must be Dolphin's hello with our token
          if (msg.ev !== 'hello' || msg.token !== this.token) { sock.destroy(); return; }
          authed = true;
          clearTimeout(timer);
          this.sock = sock;
          this.log('dolphin control: connected', msg.version || '');
          this.emit('connected', { version: msg.version || '', protocol: msg.protocol || 1 });
          continue;
        }
        this.onMessage(msg);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(timer);
      if (this.sock === sock) {
        this.sock = null;
        for (const p of this.pending.values()) p.resolve({ ok: false, error: 'dolphin-closed' });
        this.pending.clear();
        this.emit('closed');
      }
    });
  }

  onMessage(msg) {
    switch (msg.ev) {
      case 'state':
        this.state = msg;
        this.emit('state', msg);
        break;
      case 'msg':
        this.emit('msg', { text: String(msg.text || ''), color: String(msg.color || '') });
        break;
      case 'result': {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg); }
        break;
      }
      default:
        if (typeof msg.ev === 'string') this.emit('event', { ev: msg.ev, detail: msg.detail || '' });
    }
  }

  get connected() { return !!this.sock; }

  /** Send a command; resolves to Dolphin's { ok, error } reply. */
  send(cmd, args = {}) {
    if (!COMMANDS.has(cmd)) return Promise.resolve({ ok: false, error: 'unknown-command' });
    if (!this.sock) return Promise.resolve({ ok: false, error: 'not-connected' });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'timeout' }); }, 8000);
      this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); } });
      this.sock.write(JSON.stringify({ ...args, cmd, id }) + '\n');
    });
  }

  close() {
    this.closed = true;
    if (this.sock) this.sock.destroy();
    if (this.server) this.server.close();
    this.removeAllListeners();
  }
}

/**
 * Host side: is everyone who should be in the Dolphin session there, with the right game?
 * expected: lobby names; players: Dolphin's player list. Returns { ready, waiting, wrong }.
 */
function sessionReadiness(expected, players) {
  const byName = new Map((players || []).map((p) => [p.name, p]));
  const waiting = [];
  const wrong = [];
  for (const name of expected) {
    const p = byName.get(name);
    if (!p) waiting.push(name);
    else if (p.status !== 'ok') wrong.push({ name, status: p.status });
  }
  return { ready: !waiting.length && !wrong.length, waiting, wrong };
}

/** Dolphin's controller ports from the lobby: ["name on port 1", …, "name on port 4"]. */
function padsFromLobby(members, maxPlayers = 4) {
  const ports = ['', '', '', ''];
  for (const m of members || []) {
    if (m.port >= 1 && m.port <= Math.min(4, maxPlayers)) ports[m.port - 1] = m.name;
  }
  return ports;
}

const STATUS_TEXT = {
  ok: 'ready',
  missing: 'doesn\'t have the game',
  wrongHash: 'has a different copy of the game',
  wrongDisc: 'has the other disc',
  wrongRevision: 'has a different revision',
  wrongRegion: 'has a different region',
  unknown: 'is checking their game',
};

module.exports = { DolphinControl, sessionReadiness, padsFromLobby, STATUS_TEXT };
