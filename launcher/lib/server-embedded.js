// AUTO-GENERATED from server/server.js by scripts/sync-server.js. Do not edit here.
'use strict';
/**
 * Netcade lobby server
 *
 *  - /ws            JSON WebSocket: lobbies, chat, ready checks, game matching, launch signalling
 *  - /relay         binary WebSocket tunnels (TCP for N64/RetroArch when direct fails; one
 *                   message per UDP packet for GameCube/Dolphin)
 *  - /dolphin/v0/*  a private implementation of Dolphin's NetPlay session-index API. Dolphin
 *                   instances launched by Netcade point their "IndexServer" here, so when the
 *                   host clicks "Host" in Dolphin, this server learns the traversal host code
 *                   and pushes it straight to the other players' launchers.
 *  - /health        liveness probe
 *
 * No game data ever passes through this server except relayed netplay traffic.
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const SERVER_VERSION = '1.5.0';
const PROTOCOL_VERSION = 1;

const LIMITS = {
  maxNameLen: 24,
  maxChatLen: 300,
  maxTitleLen: 120,
  maxPlayers: 4,          // controller ports
  maxMembers: 8,          // players + spectators
  requestTtlMs: 30000,    // how long a port request waits for an answer
  liveSwapStepMs: 1200,   // gap between RetroArch play/spectate switches during a live swap
  chatHistory: 60,
  maxLobbies: 2000,
  msgBurst: 40,          // messages allowed per window
  msgWindowMs: 5000,
  tunnelsPerLobby: 24,
  tunnelPairTimeoutMs: 15000,
  probeTimeoutMs: 2500,
  pingIntervalMs: 4000,
  deadAfterMs: 30000,
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function createServer(options = {}) {
  const opts = {
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === '1',
    log: options.log ?? ((...a) => console.log(new Date().toISOString(), ...a)),
    probe: options.probe ?? probeTcp,
  };

  /** @type {Map<string, Player>} */
  const players = new Map();
  /** @type {Map<string, Lobby>} */
  const lobbies = new Map();
  /** dolphin index secret -> lobby code */
  const dolphinSecrets = new Map();
  /** cid -> pending tunnel */
  const pendingTunnels = new Map();

  // ---------------------------------------------------------------- helpers
  const now = () => Date.now();
  const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');

  function clientIp(req) {
    const direct = normalizeIp(req.socket.remoteAddress || '');
    // Behind a reverse proxy (TRUST_PROXY=1), or a tunnel running on this same machine (loopback),
    // the real client address is in the forwarding headers.
    if (opts.trustProxy || isLoopback(direct)) {
      const fly = req.headers['fly-client-ip'];
      if (fly) return String(fly).trim();
      const cf = req.headers['cf-connecting-ip'];
      if (cf) return String(cf).trim();
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return direct;
  }

  function normalizeIp(ip) {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  function cleanText(s, max) {
    return String(s ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, max);
  }

  function newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let c = '';
      const bytes = crypto.randomBytes(6);
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      if (!lobbies.has(c)) return c;
    }
    throw new Error('could not allocate lobby code');
  }

  function send(player, msg) {
    if (player && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(msg));
    }
  }

  function broadcast(lobby, msg, exceptId) {
    for (const id of lobby.members) {
      if (id !== exceptId) send(players.get(id), msg);
    }
  }

  function systemChat(lobby, text) {
    const entry = { from: null, name: 'Netcade', text, t: now(), system: true };
    lobby.chat.push(entry);
    if (lobby.chat.length > LIMITS.chatHistory) lobby.chat.shift();
    broadcast(lobby, { type: 'chat', ...entry });
  }

  // ------------------------------------------------------------ ports
  /** 1-based controller port of a member, or null for a spectator. */
  function portOf(lobby, id) {
    const i = lobby.ports.indexOf(id);
    return i >= 0 ? i + 1 : null;
  }

  function lowestFreePort(lobby) {
    for (let i = 0; i < lobby.maxPlayers; i++) if (!lobby.ports[i]) return i + 1;
    return null;
  }

  const playersIn = (lobby) => lobby.ports.filter(Boolean);
  const nameOf = (id) => players.get(id)?.name ?? '?';

  function lobbyView(lobby) {
    const members = lobby.members.map((id) => {
      const p = players.get(id);
      const port = portOf(lobby, id);
      return {
        id,
        name: p?.name ?? '?',
        ping: p?.ping ?? null,
        ready: lobby.ready.has(id),
        has: lobby.has.get(id) ?? { status: 'unknown' },
        isHost: id === lobby.hostId,
        versions: p?.versions ?? {},
        port,
        spectator: port === null,
      };
    });
    members.sort((a, b) => (a.port ?? 99) - (b.port ?? 99));
    const requests = [...lobby.requests.values()].map((r) => ({
      id: r.id, from: r.from, fromName: nameOf(r.from), port: r.port, target: r.target, targetName: r.target ? nameOf(r.target) : null,
    }));
    const versionKey = lobby.system === 'gc' ? 'dolphin' : 'retroarch';
    const distinct = new Set(members.map((m) => m.versions[versionKey]).filter(Boolean));
    return {
      code: lobby.code,
      system: lobby.system,
      game: lobby.game,
      hostId: lobby.hostId,
      public: lobby.public,
      hasPassword: !!lobby.password,
      maxPlayers: lobby.maxPlayers,
      maxMembers: LIMITS.maxMembers,
      ports: lobby.ports.slice(0, lobby.maxPlayers),
      requests,
      tournament: tournamentView(lobby),
      state: lobby.state,
      forceRelay: lobby.forceRelay,
      inputDelay: lobby.inputDelay,
      members,
      versionMismatch: distinct.size > 1,
      dolphin: lobby.dolphin
        ? (dolphinRelayed(lobby)
          ? { hostCode: '', method: 'direct', port: lobby.dolphin.port, relay: true }
          : { hostCode: lobby.dolphin.serverId, method: lobby.dolphin.method, port: lobby.dolphin.port })
        : null,
      netplay: lobby.netplay ? { mode: lobby.netplay.mode } : null,
      createdAt: lobby.createdAt,
    };
  }

  function pushLobby(lobby) {
    const view = lobbyView(lobby);
    broadcast(lobby, { type: 'lobby', lobby: view });
  }

  function publicList() {
    const out = [];
    for (const l of lobbies.values()) {
      if (!l.public) continue;
      out.push({
        code: l.code,
        system: l.system,
        title: l.game?.title ?? 'Unknown game',
        region: l.game?.region ?? '',
        gameKey: l.game?.key ?? '',
        rev: l.game?.rev ?? 0,
        gameId: l.game?.id ?? '',
        players: playersIn(l).length,
        maxPlayers: l.maxPlayers,
        members: l.members.length,
        maxMembers: LIMITS.maxMembers,
        state: l.state,
        hasPassword: !!l.password,
        hostName: players.get(l.hostId)?.name ?? '?',
        hostPing: players.get(l.hostId)?.ping ?? null,
      });
    }
    out.sort((a, b) => (a.state === 'waiting' ? 0 : 1) - (b.state === 'waiting' ? 0 : 1) || b.players - a.players);
    return out.slice(0, 200);
  }

  function sanitizeGame(g) {
    if (!g || typeof g !== 'object') return null;
    return {
      key: cleanText(g.key, 80),          // identity used for matching (hash or game id)
      title: cleanText(g.title, LIMITS.maxTitleLen) || 'Unknown game',
      region: cleanText(g.region, 16),
      rev: Number.isFinite(+g.rev) ? +g.rev : 0,
      id: cleanText(g.id, 16),            // GC game ID (GALE01) / N64 cart code (NSME)
      size: Number.isFinite(+g.size) ? +g.size : 0,
      link: cleanLink(g.link),            // optional "Get the game" page, set by the host
    };
  }

  /** http(s) links only (no javascript:, file:, data: …), max 500 chars. */
  function cleanLink(u) {
    const str = String(u || '').trim();
    if (!str || str.length > 500) return '';
    try {
      const url = new URL(str);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return '';
      return url.toString();
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------ lobby ops
  function leaveLobby(player, reason) {
    const code = player.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    player.lobbyCode = null;
    if (!lobby) return;
    lobby.members = lobby.members.filter((id) => id !== player.id);
    const leftPort = portOf(lobby, player.id);
    if (leftPort) lobby.ports[leftPort - 1] = null;
    lobby.ready.delete(player.id);
    lobby.has.delete(player.id);
    for (const [rid2, r] of lobby.requests) {
      if (r.from === player.id || r.target === player.id) dropRequest(lobby, rid2, 'left');
    }
    if (leftPort && lobby.state === 'in-game') applyLiveChanges(lobby, [{ id: player.id, from: leftPort, to: null, gone: true }]);

    if (lobby.members.length === 0) {
      destroyLobby(lobby);
      return;
    }
    if (lobby.hostId === player.id) {
      lobby.hostId = playersIn(lobby)[0] || lobby.members[0];
      if (lobby.state !== 'waiting') endGame(lobby, 'The host left, so the match ended.');
      systemChat(lobby, `${player.name} left. ${players.get(lobby.hostId)?.name} is now the host.`);
    } else {
      systemChat(lobby, `${player.name} ${reason === 'kick' ? 'was removed' : 'left'}.`);
    }
    pushLobby(lobby);
  }

  function destroyLobby(lobby) {
    if (lobby.dolphin?.secret) dolphinSecrets.delete(lobby.dolphin.secret);
    for (const [cid, t] of pendingTunnels) {
      if (t.code === lobby.code) {
        t.guestWs.close(1000, 'lobby closed');
        pendingTunnels.delete(cid);
      }
    }
    lobbies.delete(lobby.code);
  }

  function endGame(lobby, msg) {
    lobby.state = 'waiting';
    for (const [k] of lobby.requests) dropRequest(lobby, k, 'cancelled');
    lobby.netplay = null;
    if (lobby.dolphin?.secret) dolphinSecrets.delete(lobby.dolphin.secret);
    lobby.dolphin = null;
    lobby.ready.clear();
    broadcast(lobby, { type: 'gameEnded', message: msg || null });
  }

  // ------------------------------------------------------- message router
  const handlers = {
    hello(p, m) {
      p.name = cleanText(m.name, LIMITS.maxNameLen) || p.name;
      if (m.versions && typeof m.versions === 'object') {
        p.versions = {
          app: cleanText(m.versions.app, 40),
          dolphin: cleanText(m.versions.dolphin, 60),
          retroarch: cleanText(m.versions.retroarch, 60),
        };
      }
      if (p.lobbyCode) pushLobby(lobbies.get(p.lobbyCode));
    },

    list(p) {
      send(p, { type: 'lobbies', list: publicList() });
    },

    create(p, m) {
      if (lobbies.size >= LIMITS.maxLobbies) return send(p, { type: 'error', message: 'Server is full, try again later.' });
      const system = m.system === 'gc' ? 'gc' : m.system === 'n64' ? 'n64' : null;
      if (!system) return send(p, { type: 'error', message: 'Pick a game first.' });
      const game = sanitizeGame(m.game);
      if (!game) return send(p, { type: 'error', message: 'Pick a game first.' });
      leaveLobby(p);
      const code = newCode();
      const lobby = {
        code,
        system,
        game,
        hostId: p.id,
        members: [p.id],
        ports: [p.id, null, null, null],
        requests: new Map(),
        tournament: null,
        ready: new Set(),
        has: new Map([[p.id, { status: 'match' }]]),
        public: !!m.public,
        password: cleanText(m.password, 32) || '',
        maxPlayers: clampInt(m.maxPlayers, 2, LIMITS.maxPlayers, 4),
        forceRelay: !!m.forceRelay,
        inputDelay: m.inputDelay === undefined ? 'auto' : m.inputDelay,
        state: 'waiting',
        chat: [],
        createdAt: now(),
        dolphin: null,
        netplay: null,
        tunnels: 0,
      };
      lobbies.set(code, lobby);
      p.lobbyCode = code;
      send(p, { type: 'joined', code, chat: [] });
      systemChat(lobby, `Lobby created for ${game.title}. Share code ${code} to invite friends.`);
      pushLobby(lobby);
    },

    join(p, m) {
      const code = cleanText(m.code, 8).toUpperCase();
      const lobby = lobbies.get(code);
      if (!lobby) return send(p, { type: 'error', message: `No lobby with code ${code}.` });
      if (lobby.members.includes(p.id)) return pushLobby(lobby);
      if (lobby.password && lobby.password !== String(m.password ?? '')) {
        return send(p, { type: 'error', message: 'Wrong lobby password.', needPassword: true, code });
      }
      if (lobby.members.length >= LIMITS.maxMembers) return send(p, { type: 'error', message: `That lobby is full (${LIMITS.maxMembers} people).` });
      leaveLobby(p);
      lobby.members.push(p.id);
      p.lobbyCode = code;
      // take a controller port if one is open and no match is running, otherwise watch
      const free = lobby.state === 'waiting' && !lobby.tournament?.current ? lowestFreePort(lobby) : null;
      if (free) lobby.ports[free - 1] = p.id;
      send(p, { type: 'joined', code, chat: lobby.chat });
      systemChat(lobby, free ? `${p.name} joined as player ${free}.` : `${p.name} joined as a spectator.`);
      pushLobby(lobby);
      // N64 matches can be watched mid-game; Dolphin only lets people in before the game starts
      if (lobby.state === 'in-game' && lobby.system === 'n64' && lobby.netplay) {
        send(p, launchMessage(lobby, p.id, lobby.lastLaunch || {}));
        sendConnectInfo(lobby, p);
      } else if (lobby.state !== 'waiting') {
        send(p, { type: 'info', message: 'A match is running. You\'ll be able to watch or play from the next one.' });
      }
    },

    leave(p) {
      leaveLobby(p);
      send(p, { type: 'left' });
    },

    chat(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby) return;
      const text = cleanText(m.text, LIMITS.maxChatLen);
      if (!text) return;
      const entry = { from: p.id, name: p.name, text, t: now(), system: false };
      lobby.chat.push(entry);
      if (lobby.chat.length > LIMITS.chatHistory) lobby.chat.shift();
      broadcast(lobby, { type: 'chat', ...entry });
    },

    ready(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.state !== 'waiting') return;
      if (m.ready && !portOf(lobby, p.id)) return send(p, { type: 'error', message: 'Spectators don\'t need to ready up. Take a controller port to play.' });
      if (m.ready) lobby.ready.add(p.id); else lobby.ready.delete(p.id);
      pushLobby(lobby);
    },

    has(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby) return;
      const status = ['match', 'missing', 'mismatch'].includes(m.status) ? m.status : 'unknown';
      lobby.has.set(p.id, { status, detail: cleanText(m.detail, 160) });
      if (status !== 'match') lobby.ready.delete(p.id);
      pushLobby(lobby);
    },

    kick(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || m.id === p.id) return;
      const target = players.get(m.id);
      if (!target || target.lobbyCode !== lobby.code) return;
      leaveLobby(target, 'kick');
      send(target, { type: 'kicked' });
    },

    setGame(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.state !== 'waiting') return;
      const system = m.system === 'gc' ? 'gc' : 'n64';
      const game = sanitizeGame(m.game);
      if (!game) return;
      lobby.system = system;
      lobby.game = game;
      lobby.ready.clear();
      for (const id of lobby.members) if (id !== lobby.hostId) lobby.has.set(id, { status: 'unknown' });
      systemChat(lobby, `Host switched the game to ${game.title}.`);
      pushLobby(lobby);
    },

    setOptions(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id) return;
      if (m.public !== undefined) lobby.public = !!m.public;
      if (m.maxPlayers !== undefined && lobby.state === 'waiting') {
        const want = clampInt(m.maxPlayers, 1, LIMITS.maxPlayers, lobby.maxPlayers);
        // players on ports being closed move to open ones, or become spectators
        for (let i = want; i < LIMITS.maxPlayers; i++) {
          const id = lobby.ports[i];
          if (!id) continue;
          lobby.ports[i] = null;
          const open = lobby.ports.slice(0, want).indexOf(null);
          if (open >= 0) lobby.ports[open] = id; else lobby.ready.delete(id);
        }
        lobby.maxPlayers = want;
      }
      if (m.forceRelay !== undefined) lobby.forceRelay = !!m.forceRelay;
      if (m.inputDelay !== undefined) lobby.inputDelay = m.inputDelay === 'auto' ? 'auto' : clampInt(m.inputDelay, 0, 20, 2);
      if (m.password !== undefined) lobby.password = cleanText(m.password, 32);
      if (m.gameLink !== undefined) {
        const link = cleanLink(m.gameLink);
        if (link !== lobby.game.link) {
          lobby.game.link = link;
          if (link) systemChat(lobby, `Host added a link to get ${lobby.game.title}.`);
        }
      }
      pushLobby(lobby);
    },

    /** Ask for a controller port. Free port: taken at once. Occupied: its holder must accept. */
    requestPort(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby) return;
      const port = clampInt(m.port, 1, LIMITS.maxPlayers, 0);
      if (!port || port > lobby.maxPlayers) return send(p, { type: 'error', message: 'That controller port isn\'t open.' });
      if (portOf(lobby, p.id) === port) return;
      if (lobby.tournament?.current && lobby.state !== 'waiting') return send(p, { type: 'error', message: 'Tournament match in progress. Ports change between matches.' });
      const occupant = lobby.ports[port - 1];
      if (!occupant) {
        movePorts(lobby, [{ id: p.id, to: port }], `${p.name} took player ${port}.`);
        return;
      }
      for (const [k, r] of lobby.requests) if (r.from === p.id) dropRequest(lobby, k, 'replaced');
      const req = { id: rid(6), from: p.id, port, target: occupant, t: now() };
      req.timer = setTimeout(() => dropRequest(lobby, req.id, 'timeout'), LIMITS.requestTtlMs);
      lobby.requests.set(req.id, req);
      const fromPort = portOf(lobby, p.id);
      send(players.get(occupant), {
        type: 'portRequest', reqId: req.id, fromId: p.id, fromName: p.name, port, fromPort,
        ttlMs: LIMITS.requestTtlMs,
      });
      send(p, { type: 'info', message: `Asked ${nameOf(occupant)} for player ${port}…` });
      pushLobby(lobby);
    },

    /** The holder of a requested port (or the host) answers a request. */
    answerPort(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby) return;
      const req = lobby.requests.get(String(m.reqId || ''));
      if (!req) return send(p, { type: 'info', message: 'That request already expired.' });
      if (req.target !== p.id && lobby.hostId !== p.id) return;
      lobby.requests.delete(req.id);
      clearTimeout(req.timer);
      const asker = players.get(req.from);
      if (!m.accept) {
        send(asker, { type: 'info', message: `${p.name} said no to swapping into player ${req.port}.` });
        pushLobby(lobby);
        return;
      }
      if (lobby.ports[req.port - 1] !== req.target || !lobby.members.includes(req.from)) {
        send(asker, { type: 'info', message: 'The ports changed before that swap could happen. Try again.' });
        pushLobby(lobby);
        return;
      }
      const fromPort = portOf(lobby, req.from);
      movePorts(lobby, [{ id: req.from, to: req.port }, { id: req.target, to: fromPort }],
        fromPort ? `${nameOf(req.from)} and ${nameOf(req.target)} swapped controllers.` : `${nameOf(req.from)} rotated in for ${nameOf(req.target)} on player ${req.port}.`);
    },

    cancelPort(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      const req = lobby?.requests.get(String(m.reqId || ''));
      if (req && req.from === p.id) dropRequest(lobby, req.id, 'cancelled');
    },

    /** Give up your controller and watch. */
    spectate(p) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || !portOf(lobby, p.id)) return;
      movePorts(lobby, [{ id: p.id, to: null }], `${p.name} is now spectating.`);
    },

    /** Host: put anyone on any port (swapping with whoever is there), or make them a spectator. */
    setPort(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id) return;
      const target = String(m.id || '');
      if (!lobby.members.includes(target)) return;
      const port = m.port === null || m.port === undefined ? null : clampInt(m.port, 1, LIMITS.maxPlayers, 0);
      if (port !== null && (!port || port > lobby.maxPlayers)) return;
      if (portOf(lobby, target) === port) return;
      const changes = [{ id: target, to: port }];
      const occupant = port ? lobby.ports[port - 1] : null;
      if (occupant) changes.push({ id: occupant, to: portOf(lobby, target) });
      movePorts(lobby, changes, port ? `Host put ${nameOf(target)} on player ${port}.` : `Host moved ${nameOf(target)} to spectators.`);
    },

    // ---------------------------------------------------------------- tournaments
    tCreate(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id) return;
      if (lobby.state !== 'waiting') return send(p, { type: 'error', message: 'End the current match first.' });
      const ids = (Array.isArray(m.participants) ? m.participants : []).filter((id) => lobby.members.includes(id));
      const unique = [...new Set(ids)];
      if (unique.length < 2) return send(p, { type: 'error', message: 'A tournament needs at least 2 people.' });
      const bestOf = [1, 3, 5].includes(+m.bestOf) ? +m.bestOf : 1;
      lobby.tournament = createBracket(unique.map((id) => ({ id, name: nameOf(id) })), bestOf, m.seeding === 'lobby' ? 'lobby' : 'random');
      systemChat(lobby, `Tournament created: ${unique.length} players, best of ${bestOf}. Good luck!`);
      pushLobby(lobby);
    },

    /** Host: line up a bracket match (its two players on P1/P2, everyone else watches). */
    tSetup(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      const t = lobby?.tournament;
      if (!t || lobby.hostId !== p.id || lobby.state !== 'waiting') return;
      const match = findMatch(t, m.matchId);
      if (!match || match.status === 'done' || !match.a || !match.b) return send(p, { type: 'error', message: 'That match isn\'t ready yet.' });
      const missing = [match.a, match.b].filter((id) => !lobby.members.includes(id));
      if (missing.length) return send(p, { type: 'error', message: `${missing.map((id) => t.names[id]).join(' and ')} left the lobby. Report the match as a forfeit instead.` });
      for (const [k] of lobby.requests) dropRequest(lobby, k, 'cancelled');
      lobby.ports = [match.a, match.b, null, null];
      if (lobby.maxPlayers < 2) lobby.maxPlayers = 2;
      lobby.ready.clear();
      t.current = match.id;
      match.status = 'playing';
      systemChat(lobby, `Next up: ${t.names[match.a]} vs ${t.names[match.b]} (${roundName(t, match.round)}). Ready up!`);
      pushLobby(lobby);
    },

    /** Host or either player in the match: record a game win. */
    tReport(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      const t = lobby?.tournament;
      if (!t) return;
      const match = findMatch(t, m.matchId);
      if (!match || match.status === 'done' || !match.a || !match.b) return;
      const isHost = lobby.hostId === p.id;
      if (!isHost && p.id !== match.a && p.id !== match.b) return;
      if (m.winner !== match.a && m.winner !== match.b) return;
      if (m.winner === match.a) match.scoreA++; else match.scoreB++;
      const need = Math.floor(t.bestOf / 2) + 1;
      t.history.push({ matchId: match.id, winner: m.winner, by: p.id });
      if (match.scoreA >= need || match.scoreB >= need || m.forfeit) {
        finishMatch(t, match, m.winner);
        if (t.current === match.id) t.current = null;
        systemChat(lobby, `${t.names[m.winner]} wins ${t.names[match.a]} vs ${t.names[match.b]} (${match.scoreA}-${match.scoreB})${m.forfeit ? ' by forfeit' : ''}. Reported by ${p.name}.`);
        if (t.champion) {
          systemChat(lobby, `🏆 ${t.names[t.champion]} is the tournament champion!`);
          broadcast(lobby, { type: 'tournamentDone', champion: t.champion, name: t.names[t.champion] });
        }
      } else {
        systemChat(lobby, `Game to ${t.names[m.winner]}. ${t.names[match.a]} ${match.scoreA}-${match.scoreB} ${t.names[match.b]}.`);
      }
      pushLobby(lobby);
    },

    tUndo(p) {
      const lobby = lobbies.get(p.lobbyCode);
      const t = lobby?.tournament;
      if (!t || lobby.hostId !== p.id || !t.history.length) return;
      const last = t.history.pop();
      const match = findMatch(t, last.matchId);
      if (!match) return;
      if (match.status === 'done') unfinishMatch(t, match);
      if (last.winner === match.a) match.scoreA = Math.max(0, match.scoreA - 1); else match.scoreB = Math.max(0, match.scoreB - 1);
      systemChat(lobby, 'Host undid the last reported result.');
      pushLobby(lobby);
    },

    tEnd(p) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby?.tournament || lobby.hostId !== p.id) return;
      lobby.tournament = null;
      systemChat(lobby, 'Tournament ended.');
      pushLobby(lobby);
    },

    start(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id) return;
      if (lobby.state !== 'waiting') return;
      if (!playersIn(lobby).length) return send(p, { type: 'error', message: 'Nobody is on a controller port.' });
      const notReady = playersIn(lobby).filter((id) => id !== lobby.hostId && !lobby.ready.has(id));
      if (notReady.length) {
        return send(p, { type: 'error', message: `Waiting on: ${notReady.map((id) => players.get(id)?.name).join(', ')}` });
      }
      const delay = resolveInputDelay(lobby);
      // emulation settings that must be identical for everyone (decided by the host)
      const hostOptions = {
        n64Renderer: m && m.hostOptions && m.hostOptions.n64Renderer === 'gliden64' ? 'gliden64' : 'parallel',
        // GameCube: 'relay' (through this server, works on any network), 'traversal' (Dolphin's
        // NAT punching) or 'direct' (host forwarded the port)
        gcConnection: ['relay', 'traversal', 'direct'].includes(m && m.hostOptions && m.hostOptions.gcConnection)
          ? m.hostOptions.gcConnection : 'relay',
      };
      lobby.state = 'starting';
      lobby.netplay = null;
      lobby.dolphin = null;
      for (const [k] of lobby.requests) dropRequest(lobby, k, 'cancelled');
      lobby.lastLaunch = { inputDelay: delay, hostOptions };
      const spectators = lobby.members.length - playersIn(lobby).length;
      systemChat(lobby, lobby.members.length > 1
        ? `Starting the match…${spectators ? ` ${spectators} watching.` : ''}` : 'Starting (solo).');
      for (const id of lobby.members) send(players.get(id), launchMessage(lobby, id, lobby.lastLaunch));
      pushLobby(lobby);
    },

    async hostReady(p, m) {
      // N64 / RetroArch: the host's emulator is now listening on m.port.
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.system !== 'n64') return;
      const port = clampInt(m.port, 1, 65535, 55435);
      const lanIps = Array.isArray(m.lanIps) ? m.lanIps.slice(0, 4).map((s) => cleanText(s, 45)).filter((s) => net.isIP(s)) : [];
      let mode = 'relay';
      // A private/loopback host address means the server runs inside the host's network (e.g. "Run
      // server on this PC"), so the host's public address is unknown: LAN guests connect directly,
      // everyone else uses the relay.
      if (!lobby.forceRelay && net.isIP(p.ip) && !isPrivateIp(p.ip)) {
        const reachable = await opts.probe(p.ip, port, LIMITS.probeTimeoutMs);
        if (reachable) mode = 'direct';
      }
      if (!lobbies.has(lobby.code)) return;
      lobby.netplay = { mode, ip: p.ip, port, lanIps };
      lobby.state = 'in-game';
      systemChat(lobby, mode === 'direct'
        ? 'Host is reachable directly. Connecting peer-to-peer.'
        : 'Host is behind a strict router. Connecting through the relay.');
      for (const id of lobby.members) {
        if (id === lobby.hostId) continue;
        sendConnectInfo(lobby, players.get(id));
      }
      send(p, { type: 'hostMode', mode });
      pushLobby(lobby);
    },

    dolphinManual(p, m) {
      // fallback: host typed the Dolphin host code by hand
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.system !== 'gc') return;
      if (m.relay && lobby.lastLaunch?.hostOptions?.gcConnection === 'relay' && lobby.state !== 'waiting') {
        // relay mode needs no code: the host just confirms Dolphin is hosting
        lobby.dolphin = { serverId: 'relay', method: 'direct', port: 2626, secret: null, inGame: false, playerCount: 1 };
        lobby.state = 'in-game';
        announceDolphin(lobby);
        return;
      }
      const code = cleanText(m.hostCode, 64);
      if (!code) return;
      const isIp = /^[0-9a-fA-F:.]+$/.test(code) && code.includes('.');
      lobby.dolphin = { serverId: code, method: isIp ? 'direct' : 'traversal', port: clampInt(m.port, 1, 65535, 2626), secret: null, inGame: false, playerCount: 1 };
      lobby.state = 'in-game';
      announceDolphin(lobby);
    },

    endGame(p) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.state === 'waiting') return;
      endGame(lobby, 'The host ended the match.');
      systemChat(lobby, 'Match ended. Back in the lobby.');
      pushLobby(lobby);
    },

    pong(p, m) {
      const t = +m.t;
      if (Number.isFinite(t)) {
        const sample = Math.max(0, now() - t);
        p.ping = p.ping == null ? sample : Math.round(p.ping * 0.6 + sample * 0.4);
      }
      p.lastPong = now();
    },
  };

  function launchMessage(lobby, id, { inputDelay, hostOptions }) {
    const port = portOf(lobby, id);
    return {
      type: 'launch',
      system: lobby.system,
      role: id === lobby.hostId ? 'host' : 'guest',
      code: lobby.code,
      port,
      spectate: port === null,
      playerCount: playersIn(lobby).length,
      inputDelay: inputDelay ?? 2,
      game: lobby.game,
      hostOptions: hostOptions || {},
    };
  }

  function dropRequest(lobby, reqId, why) {
    const req = lobby.requests.get(reqId);
    if (!req) return;
    clearTimeout(req.timer);
    lobby.requests.delete(reqId);
    if (why === 'timeout') send(players.get(req.from), { type: 'info', message: `${nameOf(req.target)} didn't answer your request for player ${req.port}.` });
    send(players.get(req.target), { type: 'portRequestClosed', reqId });
    if (why !== 'left') pushLobby(lobby);
  }

  /**
   * Apply port moves [{id, to}] (to = port number or null for spectator).
   * Between matches the new layout simply applies at the next launch. During an N64 match the
   * players' RetroArch switches between playing and spectating live; RetroArch gives a player
   * who starts playing the lowest free port, so the final layout is computed the same way.
   */
  function movePorts(lobby, moves, message) {
    const before = lobby.ports.slice();
    const live = lobby.state === 'in-game' || lobby.state === 'starting';
    for (const mv of moves) {
      const i = lobby.ports.indexOf(mv.id);
      if (i >= 0) lobby.ports[i] = null;
    }
    const changes = [];
    if (live && lobby.system === 'n64') {
      // leavers free their ports first, then joiners take the lowest free ports in request order
      for (const mv of moves.filter((x) => x.to)) {
        const got = lowestFreePort(lobby);
        if (!got) continue;
        lobby.ports[got - 1] = mv.id;
      }
    } else {
      for (const mv of moves) if (mv.to) lobby.ports[mv.to - 1] = mv.id;
    }
    for (const mv of moves) {
      const from = before.indexOf(mv.id) + 1 || null;
      const to = portOf(lobby, mv.id);
      if (from !== to) changes.push({ id: mv.id, from, to });
      if (!to) lobby.ready.delete(mv.id);
    }
    for (const [k, r] of lobby.requests) {
      if (lobby.ports[r.port - 1] !== r.target) dropRequest(lobby, k, 'cancelled');
    }
    if (message) systemChat(lobby, message);
    if (live && changes.length) applyLiveChanges(lobby, changes);
    pushLobby(lobby);
  }

  /** Tell everyone's launcher about port changes during a running match. */
  function applyLiveChanges(lobby, changes) {
    if (lobby.system === 'n64') {
      // spectate first (frees ports), then play, one at a time, lowest port first
      const leavers = changes.filter((c) => c.from && !c.gone);
      const joiners = changes.filter((c) => c.to).sort((a, b) => a.to - b.to);
      let delay = 0;
      for (const c of leavers) {
        const pl = players.get(c.id);
        setTimeout(() => send(pl, { type: 'netplayMode', mode: 'spectate' }), delay);
      }
      if (leavers.length) delay += LIMITS.liveSwapStepMs;
      for (const c of joiners) {
        const pl = players.get(c.id);
        setTimeout(() => send(pl, { type: 'netplayMode', mode: 'play', port: c.to }), delay);
        delay += LIMITS.liveSwapStepMs;
      }
    } else {
      systemChat(lobby, 'GameCube: the new controller layout applies when the host restarts the game from Dolphin\'s NetPlay window (Assign Controller Ports shows who goes where).');
    }
    broadcast(lobby, { type: 'portsChanged', changes, live: lobby.system === 'n64' });
  }

  /**
   * Automatic input delay from measured pings. Pings are each player's round trip to this server,
   * so the slowest guest-to-host path is roughly that guest's ping plus the host's.
   *  - N64 (RetroArch, rollback): frames of delay, one per ~16.7ms of one-way latency.
   *  - GameCube (Dolphin, lockstep): Dolphin's pad buffer. Too small a buffer doesn't add lag; it
   *    makes every PC wait for late inputs, so the whole match runs below full speed. Rule of
   *    thumb is (round trip / 8), plus headroom for relay jitter, and more with many players.
   */
  function resolveInputDelay(lobby) {
    if (lobby.inputDelay !== 'auto') return lobby.inputDelay;
    const hostPing = players.get(lobby.hostId)?.ping ?? 0;
    let worst = 0;
    for (const id of lobby.members) {
      if (id !== lobby.hostId) worst = Math.max(worst, players.get(id)?.ping ?? 0); // spectators lag too
    }
    const path = worst + hostPing;
    if (lobby.system === 'gc') {
      const others = lobby.members.length - 1;
      const headroom = 2 + (others >= 3 ? 1 : 0);
      return Math.min(20, Math.max(3, Math.ceil(path / 8) + headroom));
    }
    return Math.min(10, Math.max(1, Math.ceil(path / 2 / 16.7) + 1));
  }

  function sendConnectInfo(lobby, guest) {
    if (!guest || !lobby.netplay) return;
    const np = lobby.netplay;
    // Same household as the host? (same public IP, or both seen on the server's own network.)
    // Public-IP hairpinning often fails at home, so use the host's LAN address.
    const sameHome = guest.ip === np.ip || (isPrivateIp(guest.ip) && isPrivateIp(np.ip));
    if (!lobby.forceRelay && sameHome && np.lanIps.length) {
      send(guest, { type: 'connectInfo', mode: 'direct', ip: np.lanIps[0], port: np.port });
    } else if (np.mode === 'direct') {
      send(guest, { type: 'connectInfo', mode: 'direct', ip: np.ip, port: np.port });
    } else {
      send(guest, { type: 'connectInfo', mode: 'relay', port: np.port });
    }
  }

  /** The host hosts by direct IP but guests reach it through the relay (the IP stays private). */
  function dolphinRelayed(lobby) {
    return !!lobby.dolphin && lobby.dolphin.method === 'direct' && lobby.lastLaunch?.hostOptions?.gcConnection === 'relay';
  }

  function announceDolphin(lobby) {
    const d = lobby.dolphin;
    const relay = dolphinRelayed(lobby);
    systemChat(lobby, relay
      ? 'Host\'s Dolphin session is up. Guests are connecting through Netcade.'
      : d.method === 'traversal'
        ? `Host's Dolphin session is up (code ${d.serverId}). Guests are being connected.`
        : `Host's Dolphin session is up at ${d.serverId}. Guests are being connected.`);
    broadcast(lobby, relay
      ? { type: 'dolphinSession', relay: true, method: 'direct', hostCode: '', port: d.port }
      : { type: 'dolphinSession', hostCode: d.serverId, method: d.method, port: d.port }, lobby.hostId);
    pushLobby(lobby);
  }

  // ------------------------------------------------- Dolphin index (HTTP)
  function handleDolphin(req, res, url, ip) {
    const q = url.searchParams;
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const path = url.pathname.replace(/^\/dolphin/, '');

    if (path === '/v0/list') {
      const nameFilter = (q.get('name') || '').toUpperCase();
      const sessions = [];
      for (const l of lobbies.values()) {
        if (l.system !== 'gc' || !l.dolphin) continue;
        if (!l.public && nameFilter !== l.code) continue; // private lobbies only show to people who know the code
        if (nameFilter && !l.code.includes(nameFilter) && !l.game.title.toUpperCase().includes(nameFilter)) continue;
        sessions.push({
          name: l.code,
          region: 'NA',
          method: l.dolphin.method,
          game: l.dolphin.game || l.game.title,
          server_id: l.dolphin.serverId,
          password: false,
          player_count: l.dolphin.playerCount || 1,
          port: l.dolphin.port || 2626,
          in_game: !!l.dolphin.inGame,
          version: l.dolphin.version || '',
        });
      }
      return json({ status: 'OK', sessions });
    }

    if (path === '/v0/session/add') {
      const name = (q.get('name') || '').toUpperCase().trim();
      const lobby = lobbies.get(name);
      if (!lobby || lobby.system !== 'gc') return json({ status: 'NOT_A_NETCADE_LOBBY' });
      if (lobby.state === 'waiting') return json({ status: 'MATCH_NOT_STARTED' });
      const host = players.get(lobby.hostId);
      if (process.env.STRICT_INDEX_IP === '1' && host && host.ip !== ip) return json({ status: 'NOT_HOST' });
      if (q.get('password') === '1') {
        // Netcade never sets an index password, so the id would be encrypted and useless to us
        return json({ status: 'PASSWORD_NOT_SUPPORTED' });
      }
      const serverId = cleanText(q.get('server_id'), 64);
      if (!serverId) return json({ status: 'MISSING_SERVER_ID' });
      if (lobby.dolphin?.secret) dolphinSecrets.delete(lobby.dolphin.secret);
      const secret = rid(16);
      lobby.dolphin = {
        serverId,
        method: q.get('method') === 'direct' ? 'direct' : 'traversal',
        port: clampInt(q.get('port'), 1, 65535, 2626),
        game: cleanText(q.get('game'), 120),
        version: cleanText(q.get('version'), 60),
        playerCount: clampInt(q.get('player_count'), 0, 16, 1),
        inGame: q.get('in_game') === '1',
        secret,
        lastSeen: now(),
      };
      dolphinSecrets.set(secret, lobby.code);
      lobby.state = 'in-game';
      opts.log(`[dolphin] session for lobby ${lobby.code}: ${lobby.dolphin.method} ${serverId}`);
      announceDolphin(lobby);
      return json({ status: 'OK', secret });
    }

    if (path === '/v0/session/active') {
      const code = dolphinSecrets.get(q.get('secret') || '');
      const lobby = code && lobbies.get(code);
      if (!lobby || !lobby.dolphin) return json({ status: 'BAD_SECRET' });
      const wasInGame = lobby.dolphin.inGame;
      lobby.dolphin.playerCount = clampInt(q.get('player_count'), 0, 16, lobby.dolphin.playerCount);
      lobby.dolphin.inGame = q.get('in_game') === '1';
      lobby.dolphin.game = cleanText(q.get('game'), 120) || lobby.dolphin.game;
      lobby.dolphin.lastSeen = now();
      if (!wasInGame && lobby.dolphin.inGame) systemChat(lobby, 'Game is running. Have fun!');
      return json({ status: 'OK' });
    }

    if (path === '/v0/session/remove') {
      const code = dolphinSecrets.get(q.get('secret') || '');
      dolphinSecrets.delete(q.get('secret') || '');
      const lobby = code && lobbies.get(code);
      if (lobby && lobby.state !== 'waiting') {
        endGame(lobby, 'The host closed the Dolphin session.');
        systemChat(lobby, 'Host closed the Dolphin session. Back in the lobby.');
        pushLobby(lobby);
      }
      return json({ status: 'OK' });
    }

    return json({ status: 'NOT_FOUND' }, 404);
  }

  // ------------------------------------------------------------- HTTP
  const httpServer = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const ip = clientIp(req);
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'netcade-server', version: SERVER_VERSION, protocol: PROTOCOL_VERSION, players: players.size, lobbies: lobbies.size }));
      return;
    }
    if (url.pathname.startsWith('/dolphin/')) return handleDolphin(req, res, url, ip);
    if (url.pathname === '/api/lobbies') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(publicList()));
      return;
    }
    res.writeHead(404).end('not found');
  });

  // ------------------------------------------------------------- WebSockets
  const wssControl = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const wssRelay = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname === '/ws') {
      wssControl.handleUpgrade(req, socket, head, (ws) => onControl(ws, req));
    } else if (url.pathname === '/relay') {
      wssRelay.handleUpgrade(req, socket, head, (ws) => onRelay(ws, req, url));
    } else {
      socket.destroy();
    }
  });

  function onControl(ws, req) {
    const player = {
      id: rid(9),
      token: rid(18),
      ws,
      ip: clientIp(req),
      name: 'Player',
      versions: {},
      lobbyCode: null,
      ping: null,
      lastPong: now(),
      bucket: { count: 0, start: now() },
    };
    players.set(player.id, player);
    send(player, { type: 'welcome', id: player.id, token: player.token, serverVersion: SERVER_VERSION, protocol: PROTOCOL_VERSION });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const b = player.bucket;
      if (now() - b.start > LIMITS.msgWindowMs) { b.start = now(); b.count = 0; }
      if (++b.count > LIMITS.msgBurst) return; // silently drop floods
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const h = msg && typeof msg.type === 'string' && Object.prototype.hasOwnProperty.call(handlers, msg.type) && handlers[msg.type];
      if (!h) return;
      try {
        await h(player, msg);
      } catch (err) {
        opts.log('handler error', msg.type, err);
      }
    });

    ws.on('close', () => {
      leaveLobby(player);
      players.delete(player.id);
    });
    ws.on('error', () => {});
  }

  function onRelay(ws, req, url) {
    const q = url.searchParams;
    const role = q.get('role');
    const player = players.get(q.get('pid') || '');
    if (!player || player.token !== q.get('token')) return ws.close(4001, 'auth');
    const lobby = lobbies.get(player.lobbyCode || '');
    const udp = !!lobby && lobby.system === 'gc';
    if (!lobby || (udp ? !dolphinRelayed(lobby) : !lobby.netplay)) return ws.close(4002, 'no session');

    if (role === 'guest') {
      if (player.id === lobby.hostId) return ws.close(4003, 'host cannot be guest');
      if (lobby.tunnels >= LIMITS.tunnelsPerLobby) return ws.close(4004, 'too many tunnels');
      const cid = rid(12);
      const pending = { cid, code: lobby.code, guestWs: ws, buffer: [], bytes: 0 };
      pendingTunnels.set(cid, pending);
      lobby.tunnels++;
      const onEarly = (d) => {
        pending.bytes += d.length;
        if (pending.bytes > 512 * 1024) return ws.close(4005, 'buffer overflow');
        pending.buffer.push(d);
      };
      ws.on('message', onEarly);
      pending.detachEarly = () => ws.off('message', onEarly);
      ws.on('close', () => {
        if (pendingTunnels.get(cid) === pending) pendingTunnels.delete(cid);
        if (pending.hostWs) pending.hostWs.close();
        const l = lobbies.get(pending.code);
        if (l) l.tunnels = Math.max(0, l.tunnels - 1);
      });
      ws.on('error', () => {});
      pending.timer = setTimeout(() => {
        if (pendingTunnels.get(cid) === pending) {
          pendingTunnels.delete(cid);
          ws.close(4006, 'host did not answer');
        }
      }, LIMITS.tunnelPairTimeoutMs);
      send(players.get(lobby.hostId), { type: 'tunnelOpen', cid, udp });
      return;
    }

    if (role === 'host') {
      if (player.id !== lobby.hostId) return ws.close(4003, 'not host');
      const cid = q.get('cid') || '';
      const pending = pendingTunnels.get(cid);
      if (!pending || pending.code !== lobby.code) return ws.close(4007, 'unknown tunnel');
      pendingTunnels.delete(cid);
      clearTimeout(pending.timer);
      pending.detachEarly();
      pending.hostWs = ws;
      const g = pending.guestWs;
      for (const chunk of pending.buffer) ws.send(chunk, { binary: true });
      pending.buffer = [];
      g.on('message', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true }); });
      ws.on('message', (d) => { if (g.readyState === WebSocket.OPEN) g.send(d, { binary: true }); });
      ws.on('close', () => g.close());
      ws.on('error', () => {});
      return;
    }
    ws.close(4000, 'bad role');
  }

  // ------------------------------------------------------------- timers
  const pingTimer = setInterval(() => {
    const t = now();
    for (const p of players.values()) {
      if (t - p.lastPong > LIMITS.deadAfterMs) {
        p.ws.terminate();
        continue;
      }
      send(p, { type: 'ping', t });
    }
    // refresh lobby views so pings stay current (cheap: tiny payloads, small lobbies)
    for (const l of lobbies.values()) pushLobby(l);
    // expire stale dolphin sessions (Dolphin refreshes every 5s)
    for (const l of lobbies.values()) {
      if (l.dolphin?.secret && t - l.dolphin.lastSeen > 45000) {
        endGame(l, 'Lost contact with the host\'s Dolphin session.');
        systemChat(l, 'Lost contact with the host\'s Dolphin. Back in the lobby.');
        pushLobby(l);
      }
    }
  }, LIMITS.pingIntervalMs);
  pingTimer.unref();

  return {
    httpServer,
    listen(port, host) {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address())));
    },
    close() {
      clearInterval(pingTimer);
      for (const p of players.values()) p.ws.terminate();
      wssControl.close();
      wssRelay.close();
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
    _state: { players, lobbies },
  };
}

// ------------------------------------------------------------------ tournaments
/** Standard seeding order for a bracket of `size` (1 v size, 2 v size-1, ... kept apart). */
function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

function createBracket(participants, bestOf, seeding) {
  const list = participants.slice();
  if (seeding === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  let size = 2;
  while (size < list.length) size *= 2;
  const slots = seedOrder(size).map((seed) => list[seed - 1]?.id || null);
  const rounds = [];
  let n = 0;
  const first = [];
  for (let i = 0; i < size; i += 2) first.push({ id: `m${++n}`, round: 0, a: slots[i], b: slots[i + 1], scoreA: 0, scoreB: 0, winner: null, status: 'pending', bye: false });
  rounds.push(first);
  for (let r = 1; size >> r > 1; r++) {
    const prev = rounds[r - 1];
    const cur = [];
    for (let i = 0; i < prev.length; i += 2) cur.push({ id: `m${++n}`, round: r, a: null, b: null, scoreA: 0, scoreB: 0, winner: null, status: 'pending', bye: false });
    rounds.push(cur);
  }
  const t = {
    bestOf, seeding, rounds, current: null, champion: null, history: [],
    names: Object.fromEntries(participants.map((x) => [x.id, x.name])),
    createdAt: Date.now(),
  };
  // byes: a lone player advances automatically
  for (const m of first) {
    if (m.a && !m.b) { m.bye = true; finishMatch(t, m, m.a); }
    else if (!m.a && m.b) { m.bye = true; finishMatch(t, m, m.b); }
    else if (!m.a && !m.b) { m.bye = true; m.status = 'done'; }
    else m.status = 'ready';
  }
  refreshStatuses(t);
  return t;
}

function findMatch(t, id) {
  for (const r of t.rounds) for (const m of r) if (m.id === id) return m;
  return null;
}

function nextSlot(t, m) {
  const idx = t.rounds[m.round].indexOf(m);
  const next = t.rounds[m.round + 1]?.[Math.floor(idx / 2)];
  return next ? { next, side: idx % 2 === 0 ? 'a' : 'b' } : null;
}

function finishMatch(t, m, winner) {
  m.winner = winner;
  m.status = 'done';
  const ns = nextSlot(t, m);
  if (ns) ns.next[ns.side] = winner; else t.champion = winner;
  refreshStatuses(t);
}

function unfinishMatch(t, m) {
  const ns = nextSlot(t, m);
  if (ns) {
    if (ns.next.status === 'done') unfinishMatch(t, ns.next);
    ns.next[ns.side] = null;
    ns.next.scoreA = 0;
    ns.next.scoreB = 0;
  } else t.champion = null;
  m.winner = null;
  m.status = 'ready';
  refreshStatuses(t);
}

function refreshStatuses(t) {
  for (const r of t.rounds) {
    for (const m of r) {
      if (m.status === 'done' || m.status === 'playing') continue;
      m.status = m.a && m.b ? 'ready' : 'pending';
    }
  }
}

function roundName(t, r) {
  const left = t.rounds.length - r;
  return left === 1 ? 'Final' : left === 2 ? 'Semifinal' : left === 3 ? 'Quarterfinal' : `Round ${r + 1}`;
}

function tournamentView(lobby) {
  const t = lobby.tournament;
  if (!t) return null;
  return {
    bestOf: t.bestOf,
    current: t.current,
    champion: t.champion,
    names: t.names,
    canUndo: t.history.length > 0,
    rounds: t.rounds.map((r, i) => ({
      name: roundName(t, i),
      matches: r.map((m) => ({ id: m.id, a: m.a, b: m.b, scoreA: m.scoreA, scoreB: m.scoreB, winner: m.winner, status: m.status, bye: m.bye })),
    })),
  };
}

function isLoopback(ip) {
  return ip === '::1' || ip.startsWith('127.');
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (isLoopback(ip)) return true;
  const m = /^(\d+)\.(\d+)\./.exec(ip);
  if (m) {
    const a = +m[1], b = +m[2];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip);
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function probeTcp(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

module.exports = { createServer, probeTcp, isPrivateIp, createBracket, findMatch, finishMatch, seedOrder };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8080', 10);
  const srv = createServer();
  srv.listen(port, '0.0.0.0').then((addr) => {
    console.log(`Netcade server ${SERVER_VERSION} listening on :${addr.port}`);
  });
  const shutdown = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
