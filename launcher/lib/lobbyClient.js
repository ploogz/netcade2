'use strict';
/**
 * Connection to the Netcade lobby server, with automatic reconnect.
 * Emits: 'status' ({state, error}), 'message' (msg)
 */
const { EventEmitter } = require('events');
const { WebSocket } = require('ws');

function controlUrl(serverUrl) {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  return u.toString();
}

function httpBase(serverUrl) {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  return u.toString().replace(/\/$/, '');
}

class LobbyClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.url = '';
    this.state = 'offline';
    this.me = null;            // { id, token }
    this.retry = 0;
    this.timer = null;
    this.hello = null;         // last hello payload, re-sent on reconnect
    this.stopped = true;
  }

  connect(serverUrl, hello) {
    this.hello = hello;
    if (this.url === serverUrl && this.ws && this.state !== 'offline') {
      this.send({ type: 'hello', ...hello });
      return;
    }
    this.disconnect();
    this.url = serverUrl;
    this.stopped = false;
    this._open();
  }

  _open() {
    clearTimeout(this.timer);
    let url;
    try {
      url = controlUrl(this.url);
    } catch {
      this._set('offline', 'Invalid server address');
      return;
    }
    this._set('connecting');
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'ping') {
        this.send({ type: 'pong', t: msg.t });
        return;
      }
      if (msg.type === 'welcome') {
        this.me = { id: msg.id, token: msg.token };
        this._set('online');
        if (this.hello) this.send({ type: 'hello', ...this.hello });
      }
      this.emit('message', msg);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.me = null;
      if (this.stopped) return this._set('offline');
      this._set('reconnecting');
      const delay = Math.min(15000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this._open(), delay);
    });
    ws.on('error', (err) => {
      this.lastError = err.message;
    });
  }

  _set(state, error) {
    this.state = state;
    this.emit('status', { state, error: error || (state !== 'online' ? this.lastError : undefined) });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.terminate();
    }
    this.me = null;
    this._set('offline');
  }
}

module.exports = { LobbyClient, controlUrl, httpBase };
