/* global overlay */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
  const SYS = { n64: 'N64', gc: 'GC' };

  let state = { lobby: null, myId: null, session: null, layout: { pref: 'auto', aspect: 4 / 3 }, chatKey: 'Tab' };
  let chatOpen = false;
  let mode = 'corners';
  const log = [];

  // ---------------------------------------------------------------- layout
  // With a 4:3 picture on a wider screen, the game leaves black bars left and right; the overlay
  // lives there. Otherwise (widescreen hack, 4:3 monitor, bars too thin) it uses the corners.
  function layout() {
    const { pref = 'auto', aspect = 4 / 3 } = state.layout || {};
    const bar = Math.floor((window.innerWidth - window.innerHeight * aspect) / 2);
    const next = pref !== 'corners' && bar >= 180 ? 'bars' : 'corners';
    document.body.style.setProperty('--bar', `${Math.min(bar, 420)}px`);
    if (next !== mode) {
      mode = next;
      document.body.className = mode;
      renderFeed();
    }
  }
  window.addEventListener('resize', layout);

  // ---------------------------------------------------------------- mouse pass-through
  // The window ignores the mouse (clicks reach the game) except while the pointer is over a
  // ".hit" element; the main process flips that when we report it.
  let interactive = false;
  document.addEventListener('mousemove', (e) => {
    const over = !!e.target.closest('.hit, .req');
    if (over !== interactive && !chatOpen) {
      interactive = over;
      overlay.interactive(over);
    }
  });

  // ---------------------------------------------------------------- roster (always visible)
  function renderRoster() {
    const L = state.lobby;
    if (!L) { $('#roster').innerHTML = ''; return; }
    const me = state.myId;
    const myPort = L.members.find((m) => m.id === me)?.port ?? null;
    const myReq = (L.requests || []).find((r) => r.from === me);
    const msTag = (m) => (m.ping == null ? '' : `<span class="ms ${m.ping > 120 ? 'slow' : ''}">${m.ping}ms</span>`);
    const slots = [];
    for (let i = 1; i <= L.maxPlayers; i++) {
      const h = L.members.find((m) => m.port === i);
      let act = '';
      if (h && h.id === me) act = '<button class="btn tiny" data-act="spectate">Watch instead</button>';
      else if (myReq && myReq.port === i) act = `<span class="pending">Asked ${esc(h?.name || '')}…</span><button class="btn tiny" data-act="cancel" data-req="${myReq.id}">Cancel</button>`;
      else if (!h) act = `<button class="btn tiny go" data-act="request" data-port="${i}">Take P${i}</button>`;
      else act = `<button class="btn tiny" data-act="request" data-port="${i}">${myPort ? 'Ask to swap' : 'Ask to play'}</button>`;
      slots.push(`<div class="slot ${h?.id === me ? 'me' : ''}">
        <span class="p">P${i}</span>
        <span class="n ${h ? '' : 'open'}">${h ? `<i class="dot ${h.ping > 120 ? 'slow' : ''}"></i>${esc(h.name)}${h.id === me ? ' (you)' : ''}` : 'open'}</span>
        ${h ? msTag(h) : '<span></span>'}
        <div class="act">${act}</div>
      </div>`);
    }
    const watchers = L.members.filter((m) => !m.port);
    const watch = `<div class="watch">👀 ${watchers.length ? `<b>Watching (${watchers.length})</b>${watchers.map((w) => `<span class="w">${esc(w.name)}${w.id === me ? ' (you)' : ''}</span>`).join('')}` : 'Nobody watching'}</div>`;
    $('#roster').innerHTML = `<div class="r-title"><span class="sys">${SYS[L.system] || ''}</span>${esc(L.game?.title || 'Netcade')}</div>${slots.join('')}${watch}`;
  }
  // action buttons only while the pointer is over the roster, so it stays tidy during play
  const style = document.createElement('style');
  style.textContent = '#roster:not(:hover) .act { display: none; }';
  document.head.appendChild(style);

  // ---------------------------------------------------------------- tournament match (right column)
  function renderMatch() {
    const t = state.lobby?.tournament;
    let html = '';
    if (t && t.current) {
      for (const r of t.rounds) {
        const m = r.matches.find((x) => x.id === t.current);
        if (m) {
          html = `<div class="card"><div class="k">🏆 ${esc(r.name)}</div>
            <div class="vs">${esc(t.names[m.a])} vs ${esc(t.names[m.b])}</div>
            ${t.bestOf > 1 ? `<div class="sc">${m.scoreA}–${m.scoreB} · best of ${t.bestOf}</div>` : ''}</div>`;
        }
      }
    }
    $('#match').innerHTML = html;
  }

  // ---------------------------------------------------------------- chat feed
  // Black bars: recent chat stays on screen (older lines dim). Corners: lines fade away.
  function lineHtml(m) {
    return m.system ? esc(m.text) : `<b style="color:hsl(${hue(m.from || m.name)} 85% 72%)">${esc(m.name)}</b>${esc(m.text)}`;
  }
  function renderFeed() {
    $('#feed').innerHTML = '';
    if (mode !== 'bars') return;
    for (const m of log.slice(-12)) addLine(m, true);
  }
  function addLine(m, quiet) {
    const el = document.createElement('div');
    el.className = `line${m.system ? ' system' : ''}`;
    el.innerHTML = lineHtml(m);
    if (quiet) el.style.animation = 'none';
    $('#feed').appendChild(el);
    const max = mode === 'bars' ? 12 : 6;
    while ($('#feed').children.length > max) $('#feed').firstChild.remove();
    if (mode === 'bars') {
      const age = Date.now() - (m.t || Date.now());
      setTimeout(() => el.classList.add('old'), Math.max(0, 30000 - age));
    } else {
      setTimeout(() => el.classList.add('gone'), 9000);
      setTimeout(() => el.remove(), 9800);
    }
  }
  function renderLog() {
    $('#log').innerHTML = log.slice(-80).map((m) => (m.system
      ? `<div class="system">${esc(m.text)}</div>`
      : `<div><b style="color:hsl(${hue(m.from || m.name)} 85% 72%)">${esc(m.name)}</b> ${esc(m.text)}</div>`)).join('');
    $('#log').scrollTop = $('#log').scrollHeight;
  }

  // ---------------------------------------------------------------- port requests aimed at me
  const reqTimers = new Map();
  function showRequest(r) {
    const el = document.createElement('div');
    el.className = 'req hit';
    el.dataset.req = r.reqId;
    const what = r.fromPort ? `Swap: you'd move to P${r.fromPort}` : 'Rotate in: you\'d watch';
    el.innerHTML = `<div class="t">🎮 ${esc(r.fromName)} wants P${r.port}</div>
      <div class="s">${esc(what)}</div>
      <div class="bar"><i style="width:100%"></i></div>
      <div class="row"><button class="btn go" data-act="accept" data-req="${r.reqId}">Let them in</button>
      <button class="btn" data-act="decline" data-req="${r.reqId}">Not now</button></div>`;
    $('#requests').appendChild(el);
    const bar = el.querySelector('.bar i');
    requestAnimationFrame(() => { bar.style.transitionDuration = `${r.ttlMs || 30000}ms`; bar.style.width = '0%'; });
    reqTimers.set(r.reqId, setTimeout(() => closeRequest(r.reqId), r.ttlMs || 30000));
  }
  function closeRequest(reqId) {
    clearTimeout(reqTimers.get(reqId));
    reqTimers.delete(reqId);
    document.querySelector(`.req[data-req="${CSS.escape(reqId)}"]`)?.remove();
    if (!document.querySelector('.req') && !chatOpen && interactive) { interactive = false; overlay.interactive(false); }
  }

  function notice({ text, kind = 'info', ms = 5000 }) {
    const el = document.createElement('div');
    el.className = `notice ${kind}`;
    el.textContent = text;
    $('#notices').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, ms);
    setTimeout(() => el.remove(), ms + 600);
  }

  // ---------------------------------------------------------------- chat open / close
  function openPanel() {
    chatOpen = true;
    $('#panel').hidden = false;
    $('#chatBtn').hidden = true;
    $('#feed').hidden = true;
    renderLog();
    setTimeout(() => $('#chatInput').focus(), 30);
  }
  function closePanel() {
    chatOpen = false;
    $('#panel').hidden = true;
    $('#chatBtn').hidden = false;
    $('#feed').hidden = false;
    $('#chatInput').value = '';
    interactive = false;
    renderFeed();
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act], #chatBtn');
    if (!t) return;
    if (t.id === 'chatBtn') return overlay.action('openChat');
    const act = t.dataset.act;
    if (act === 'request') return overlay.action('requestPort', { port: +t.dataset.port });
    if (act === 'cancel') return overlay.action('cancelPort', { reqId: t.dataset.req });
    if (act === 'spectate') return overlay.action('spectate');
    if (act === 'accept' || act === 'decline') {
      overlay.action('answerPort', { reqId: t.dataset.req, accept: act === 'accept' });
      closeRequest(t.dataset.req);
    }
  });

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (text) overlay.action('chat', { text });
    $('#chatInput').value = '';
    overlay.action('closeChat');   // back to the game right after sending
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chatOpen) { e.preventDefault(); overlay.action('closeChat'); }
  });

  overlay.on('state', (s) => {
    state = { ...state, ...s };
    $('#chatKeyLabel').textContent = state.chatKey || 'Tab';
    layout();
    renderRoster();
    renderMatch();
  });
  overlay.on('chat', (m) => {
    log.push(m);
    if (log.length > 200) log.shift();
    if (chatOpen) renderLog(); else addLine(m);
  });
  overlay.on('notice', notice);
  overlay.on('request', showRequest);
  overlay.on('request-closed', ({ reqId }) => closeRequest(reqId));
  overlay.on('chat-open', openPanel);
  overlay.on('chat-close', closePanel);

  layout();
  overlay.ready();
})();
