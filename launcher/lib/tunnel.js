'use strict';
/**
 * Relay tunnels for netplay when the host can't be reached directly (strict NAT, CGNAT,
 * no UPnP). N64/RetroArch uses TCP; GameCube/Dolphin uses UDP (see below). RetroArch only ever sees a plain local TCP connection; the bytes travel through the
 * Netcade server over WebSockets.
 *
 * Guest side: listen on 127.0.0.1:<random>; each RetroArch connection becomes one relay socket.
 * Host side:  when the server says "tunnelOpen", dial the relay and the local RetroArch port.
 */
const net = require('net');
const dgram = require('dgram');
const { WebSocket } = require('ws');

function relayUrl(serverUrl, params) {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = '/relay';
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}

function pipe(sock, ws) {
  const pending = [];
  sock.setNoDelay(true);
  sock.on('data', (d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true });
    else if (ws.readyState === WebSocket.CONNECTING) pending.push(d);
  });
  ws.on('open', () => {
    for (const d of pending) ws.send(d, { binary: true });
    pending.length = 0;
  });
  ws.on('message', (d) => {
    if (!sock.destroyed) sock.write(d);
  });
  const end = () => {
    if (!sock.destroyed) sock.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  };
  sock.on('close', end);
  sock.on('error', end);
  ws.on('close', end);
  ws.on('error', end);
}

/** Start the guest-side listener. Resolves to { port, close() }. */
function startGuest({ serverUrl, pid, token, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      log('relay: emulator connected, opening tunnel');
      const ws = new WebSocket(relayUrl(serverUrl, { role: 'guest', pid, token }), { perMessageDeflate: false });
      pipe(sock, ws);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close() {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

/** Host side: connect one tunnel id to the local emulator port. */
function openHostTunnel({ serverUrl, pid, token, cid, localPort, log = () => {} }) {
  const sock = net.connect({ host: '127.0.0.1', port: localPort });
  const ws = new WebSocket(relayUrl(serverUrl, { role: 'host', cid, pid, token }), { perMessageDeflate: false });
  pipe(sock, ws);
  log(`relay: tunnel ${cid} -> 127.0.0.1:${localPort}`);
  return { close: () => { sock.destroy(); ws.terminate(); } };
}

// ------------------------------------------------------------------ UDP (GameCube / Dolphin)
// Dolphin's netplay is UDP (ENet). Each datagram travels as one WebSocket message, so packet
// boundaries survive the trip. Dolphin on both PCs only ever talks to 127.0.0.1, which is why
// routers and firewalls don't get in the way.

/**
 * Guest side: a local UDP port the guest's Dolphin "direct connects" to. The tunnel opens on
 * Dolphin's first packet; a new Connect attempt (new source port) gets a fresh tunnel.
 * Resolves to { port, close() }.
 */
function startGuestUdp({ serverUrl, pid, token, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let peer = null;          // Dolphin's address on this PC
    let ws = null;
    let pending = [];
    let closed = false;

    const openWs = () => {
      const w = new WebSocket(relayUrl(serverUrl, { role: 'guest', pid, token }), { perMessageDeflate: false });
      w.on('open', () => {
        for (const d of pending) w.send(d, { binary: true });
        pending = [];
      });
      w.on('message', (d) => {
        if (!closed && peer && w === ws) sock.send(d, peer.port, peer.address);
      });
      const gone = () => { if (ws === w) { ws = null; pending = []; } };
      w.on('close', gone);
      w.on('error', gone);
      return w;
    };

    sock.on('message', (d, rinfo) => {
      if (rinfo.address !== '127.0.0.1') return;     // only this PC's Dolphin
      if (!peer || peer.port !== rinfo.port) {
        if (ws) ws.terminate();
        ws = null;
        pending = [];
        peer = { address: rinfo.address, port: rinfo.port };
        log(`relay(udp): Dolphin connecting from port ${rinfo.port}, opening tunnel`);
      }
      if (!ws) ws = openWs();
      if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true });
      else if (pending.length < 256) pending.push(d);
    });
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      sock.removeListener('error', reject);
      sock.on('error', (e) => log('relay(udp) socket error', e.message));
      resolve({
        port: sock.address().port,
        close() {
          closed = true;
          if (ws) ws.terminate();
          try { sock.close(); } catch { /* already closed */ }
        },
      });
    });
  });
}

/** Host side: one guest's tunnel, delivered to the host's Dolphin at 127.0.0.1:localPort. */
function openHostUdpTunnel({ serverUrl, pid, token, cid, localPort, log = () => {} }) {
  const sock = dgram.createSocket('udp4');
  const ws = new WebSocket(relayUrl(serverUrl, { role: 'host', cid, pid, token }), { perMessageDeflate: false });
  let ready = false;
  const early = [];
  const end = () => {
    try { sock.close(); } catch { /* closed */ }
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  };
  sock.bind(0, '127.0.0.1', () => {
    ready = true;
    for (const d of early) sock.send(d, localPort, '127.0.0.1');
    early.length = 0;
  });
  sock.on('message', (d, rinfo) => {
    if (rinfo.address !== '127.0.0.1' || rinfo.port !== localPort) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true });
  });
  sock.on('error', (e) => { log('relay(udp) host socket error', e.message); end(); });
  ws.on('message', (d) => {
    if (ready) sock.send(d, localPort, '127.0.0.1');
    else if (early.length < 256) early.push(d);
  });
  ws.on('close', end);
  ws.on('error', end);
  log(`relay(udp): tunnel ${cid} -> 127.0.0.1:${localPort}`);
  return { close: end };
}

/** Wait until something is listening on 127.0.0.1:port. */
function waitForPort(port, timeoutMs = 30000, isAlive = () => true) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (!isAlive()) return resolve(false);
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 700);
      });
    };
    tryOnce();
  });
}

module.exports = { startGuest, openHostTunnel, startGuestUdp, openHostUdpTunnel, waitForPort, relayUrl };
