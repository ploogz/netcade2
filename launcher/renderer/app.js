/* global netcade, ControlsEditor */
(function () {
  'use strict';

  // ================================================================ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SYS = { n64: 'N64', gc: 'GameCube' };

  const S = {
    covers: {},
    settings: null, games: [], errors: [], emulators: { dolphin: {}, retroarch: {} }, server: { state: 'offline' },
    lobby: null, session: null, platform: 'win32', appVersion: '', lanIps: [], downloadPages: {},
    view: 'library', filter: 'all', search: '', chat: [], publicLobbies: [], scan: null, coreProgress: null,
    hostDraft: { key: '', public: false, maxPlayers: 4, password: '' },
  };
  const sig = {}; // render signatures per region, to avoid needless re-renders

  function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, kind === 'error' ? 6500 : 4200);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4600);
  }

  /** Runs an action; on success returns its value (or true if it returned nothing), on failure toasts and returns undefined. */
  async function act(fn, okText) {
    try {
      const r = await fn();
      if (okText) toast(okText);
      return r === undefined ? true : r;
    } catch (err) {
      toast(err.message || String(err), 'error');
      return undefined;
    }
  }

  async function saveSettings(patch) {
    const s = await act(() => netcade.setSettings(patch));
    if (s) S.settings = s;
    return s;
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function coverStyle(g) {
    const h = hash(g.title || g.key || '?');
    const hue = h % 360;
    const base = g.system === 'gc' ? '252' : '36';
    return `--cover-bg: radial-gradient(120% 120% at 100% 0%, hsl(${hue} 70% 45% / .9) 0%, transparent 55%),
      linear-gradient(160deg, hsl(${base} 60% 22%) 0%, hsl(${(hue + 40) % 360} 45% 12%) 100%);`;
  }

  function monogram(title) {
    const words = String(title || '?').replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    const sig2 = words.filter((w) => !/^(the|of|a|and|in)$/i.test(w));
    const pick = (sig2.length ? sig2 : words).slice(0, 2).map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase()));
    return pick.join('');
  }

  /** Ask the main process for box art we don't have yet (batched, once per key). */
  const coverAsked = new Set();
  function wantCovers(games) {
    const need = games.filter((g) => g && g.key && !S.covers[g.key] && !coverAsked.has(g.key));
    if (!need.length) return;
    need.forEach((g) => coverAsked.add(g.key));
    netcade.covers.request(need.map((g) => ({ key: g.key, system: g.system, title: g.title, region: g.region, rev: g.rev }))).catch(() => {});
  }

  function coverHtml(g, cls = '') {
    const art = S.covers[g.key];
    if (art) {
      return `<div class="cover art ${cls}" data-cover="${esc(g.key)}">
        <div class="art-bg" style="background-image:url('${art}')"></div>
        <img class="art-img" src="${art}" alt="" loading="lazy">
        <span class="badge ${g.system}">${SYS[g.system] || ''}</span>
      </div>`;
    }
    return `<div class="cover ${cls}" data-cover="${esc(g.key)}" style="${coverStyle(g)}">
      <span class="badge ${g.system}">${SYS[g.system] || ''}</span>
      <span class="mono-mark">${esc(monogram(g.title))}</span>
      <span class="cover-title">${esc(g.title)}</span>
    </div>`;
  }

  function domainOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n < 1e6) return Math.max(1, Math.round(n / 1e3)) + ' KB';
    return Math.round(n / 1e6) + ' MB';
  }

  function pingBars(ms) {
    if (ms == null) return '<span class="ping">—</span>';
    const q = ms < 60 ? 4 : ms < 110 ? 3 : ms < 180 ? 2 : 1;
    return `<span class="ping"><span class="bars q${q}"><i></i><i></i><i></i><i></i></span>${ms} ms</span>`;
  }

  const I = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
    host: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    pad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8h12a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.3 2.1L14.5 14h-5l-1.2 1.6A3.5 3.5 0 0 1 2 13.5V12a4 4 0 0 1 4-4Z"/><path d="M7 11v3M5.5 12.5h3"/></svg>',
  };

  // ================================================================ navigation
  function show(view) {
    S.view = view;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    if (view === 'controls') pageEditor.mount(); else pageEditor.unmount();
    if (view === 'library') renderLibrary(true);
    if (view === 'online') { renderOnline(true); if (!S.lobby) refreshLobbies(); }
    if (view === 'settings') { renderSettings(); refreshCacheUse(); }
    $('#main').scrollTop = 0;
  }

  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#statusPill').addEventListener('click', () => show('settings'));

  // ================================================================ sidebar
  function renderSidebar() {
    const st = S.server.state;
    $('#statusDot').className = `dot ${st}`;
    const url = S.server.url;
    $('#statusText').textContent = !url ? 'No server set'
      : st === 'online' ? `Online as ${S.settings?.name || ''}`
        : st === 'connecting' ? 'Connecting…' : st === 'reconnecting' ? 'Reconnecting…' : 'Offline';
    const badge = $('#navLobbyBadge');
    if (S.lobby) { badge.hidden = false; badge.textContent = `${S.lobby.members.length}/${S.lobby.maxMembers || 8}`; } else badge.hidden = true;
    const ms = $('#miniSession');
    if (S.session) {
      const label = S.session.phase === 'preparing' ? 'Unpacking' : S.session.role === 'solo' ? 'Playing' : 'Online';
      const sub = S.session.phase === 'preparing' ? S.session.text : S.session.phase === 'waiting' ? 'Waiting for host…' : SYS[S.session.system];
      ms.innerHTML = `<div class="mini-session"><span class="live">${label}</span><strong>${esc(S.session.title || '')}</strong>${esc(sub || '')}</div>`;
      ms.firstChild.onclick = () => show(S.session.role === 'solo' ? 'library' : 'online');
    } else ms.innerHTML = '';
  }

  // ================================================================ first-launch emulator setup
  function setupCardHtml() {
    const st = S.setup || {};
    if (S.emulators.bundled || S.settings.emulatorSource === 'custom' || st.state === 'done') return '';
    if (st.state === 'error') {
      return `<div class="banner bad" style="margin-bottom:20px">${I.warn}<div style="flex:1"><b>Couldn't finish downloading the emulators.</b><br>${esc(st.error)}<br>
        <span class="small">Check your internet connection, then try again. Your progress is kept.</span></div>
        <button class="btn primary" data-act="runSetup">Try again</button></div>`;
    }
    const pct = st.total ? Math.round((st.got / st.total) * 100) : null;
    return `<div class="panel session-card" style="margin-bottom:20px">
      <div class="row"><span class="live">One-time setup</span><div class="spacer"></div><span class="hint">about ${st.approxMB || 300} MB</span></div>
      <h2 style="margin:10px 0 6px">Getting Dolphin and RetroArch ready…</h2>
      <p class="muted small" style="margin:0 0 12px">Netcade is downloading the GameCube and N64 emulators. This happens once and takes a few minutes. You can add your game folder while you wait.</p>
      <div class="progress"><div style="width:${pct ?? 3}%"></div></div>
      <div class="hint" style="margin-top:6px">${esc(st.label || 'Starting…')}${pct != null ? ` · ${pct}%` : ''}</div>
    </div>`;
  }

  function renderSetup() {
    const el = $('#libSetup');
    if (el) el.innerHTML = setupCardHtml();
    const se = $('#setEmus');
    if (se && S.view === 'settings') se.innerHTML = emusHtml();
  }

  // ================================================================ library
  function setupChecklist() {
    const hasGames = S.games.length > 0;
    const emusOk = S.emulators.dolphin?.ok || (S.emulators.retroarch?.ok && S.emulators.n64Core);
    const serverOk = !!S.server.url;
    if (hasGames && emusOk && serverOk && S.settings.onboarded) return '';
    if (hasGames && emusOk && serverOk) { saveSettings({ onboarded: true }); return ''; }
    const step = (n, done, title, text, btn) => `<div class="check ${done ? 'done' : ''}"><div class="num">${done ? '✓' : n}</div><div><strong>${title}</strong><span class="muted small">${text}</span>${done ? '' : `<div>${btn}</div>`}</div></div>`;
    return `<div class="checklist">
      ${step(1, hasGames, 'Add your games', 'Point Netcade at the folder where you keep your N64 and GameCube files.', '<button class="btn small primary" data-act="addFolder">Add folder</button>')}
      ${S.emulators.bundled || (S.setup && S.setup.state !== 'done' && S.settings.emulatorSource !== 'custom')
        ? step(2, emusOk, 'Emulators included', S.emulators.bundled ? 'Dolphin and RetroArch are built in. Nothing else to install.' : (S.setup?.state === 'error' ? 'The download stopped. Press Try again above.' : 'Downloading now (see above). Nothing for you to do.'), '')
        : step(2, emusOk, 'Set up emulators', 'Dolphin for GameCube, RetroArch for N64. Netcade finds them automatically.', '<button class="btn small" data-goto="settings">Open emulator settings</button>')}
      ${step(3, serverOk, 'Connect to a server', 'Use a hosted Netcade server, or run one from this PC.', '<button class="btn small" data-goto="settings">Set up online</button>')}
    </div>`;
  }

  function filteredGames() {
    const q = S.search.trim().toLowerCase();
    const fav = new Set(S.settings.favorites || []);
    const recent = (S.settings.recent || []).map((r) => r.key);
    let list = S.games.slice();
    if (S.filter === 'n64' || S.filter === 'gc') list = list.filter((g) => g.system === S.filter);
    if (S.filter === 'fav') list = list.filter((g) => fav.has(g.key));
    if (S.filter === 'recent') list = recent.map((k) => list.find((g) => g.key === k)).filter(Boolean);
    if (q) list = list.filter((g) => `${g.title} ${g.headerName} ${g.region} ${g.id} ${g.file}`.toLowerCase().includes(q));
    return list;
  }

  function renderLibrary(full) {
    const root = $('#view-library');
    if (full || !root.dataset.ready) {
      root.dataset.ready = '1';
      root.innerHTML = `
        <div class="view-head">
          <div><h1>Library</h1><div class="sub" id="libCount"></div></div>
          <div class="spacer"></div>
          <button class="btn" data-act="rescan">Rescan</button>
          <button class="btn primary" data-act="addFolder">Add game folder</button>
        </div>
        <div id="libSetup"></div>
        <div id="libChecklist"></div>
        <div class="lib-tools">
          <div class="search">${I.search}<input class="input" id="libSearch" placeholder="Search your games" value="${esc(S.search)}"></div>
          <div class="chips" id="libFilters">
            ${[['all', 'All'], ['n64', 'N64'], ['gc', 'GameCube'], ['fav', 'Favorites'], ['recent', 'Recently played']]
              .map(([v, l]) => `<button class="chip ${S.filter === v ? 'active' : ''}" data-filter="${v}">${l}</button>`).join('')}
          </div>
        </div>
        <div id="libScan"></div>
        <div id="libGrid"></div>`;
      $('#libSearch').addEventListener('input', (e) => { S.search = e.target.value; renderLibraryGrid(); });
    }
    $('#libSetup').innerHTML = setupCardHtml();
    $('#libChecklist').innerHTML = setupChecklist();
    renderLibraryGrid();
  }

  function renderLibraryGrid() {
    const n64 = S.games.filter((g) => g.system === 'n64').length;
    const gc = S.games.length - n64;
    const cnt = $('#libCount');
    if (cnt) cnt.textContent = S.games.length ? `${n64} N64 · ${gc} GameCube${S.errors.length ? ` · ${S.errors.length} unreadable` : ''}` : 'No games yet';
    const scan = $('#libScan');
    if (scan) {
      scan.innerHTML = S.scan && S.scan.total && S.scan.done < S.scan.total
        ? `<div class="stack" style="margin-bottom:16px"><div class="progress"><div style="width:${Math.round((S.scan.done / S.scan.total) * 100)}%"></div></div><span class="hint">Reading ${esc(S.scan.file)} (${S.scan.done}/${S.scan.total})</span></div>` : '';
    }
    const grid = $('#libGrid');
    if (!grid) return;
    if (!S.settings.romFolders.length) {
      grid.innerHTML = `<div class="empty"><h2>Bring your games</h2><p>Netcade reads <b>.z64 .n64 .v64</b> (N64) and <b>.iso .gcm .rvz .ciso</b> (GameCube) files, and games inside <b>.zip</b> and <b>.7z</b> archives, from folders you choose.<br>Your files never leave your computer.</p><button class="btn primary big" data-act="addFolder">Add game folder</button></div>`;
      return;
    }
    const list = filteredGames();
    if (!list.length) {
      grid.innerHTML = `<div class="empty"><h2>${S.games.length ? 'Nothing matches' : 'No games found yet'}</h2><p>${S.games.length ? 'Try a different search or filter.' : 'Check that your folder contains supported files, then rescan.'}</p></div>`;
      return;
    }
    const fav = new Set(S.settings.favorites || []);
    wantCovers(list);
    grid.innerHTML = `<div class="grid">${list.map((g) => `
      <div class="card" data-key="${esc(g.key)}">
        <button class="fav ${fav.has(g.key) ? 'on' : ''}" data-act="fav" title="Favorite">${I.star}</button>
        ${coverHtml(g)}
        <div class="card-body">
          ${S.covers[g.key] ? `<div class="card-title">${esc(g.title)}</div>` : ''}
          <div class="card-meta">
            <span class="tag">${esc(g.region)}</span>
            ${g.rev ? `<span class="tag">Rev ${g.rev}</span>` : ''}
            ${g.disc ? `<span class="tag">Disc ${g.disc + 1}</span>` : ''}
            ${g.archive ? `<span class="tag" title="Inside ${esc(g.path)}. Unpacked automatically when you play.">${esc((g.path.split('.').pop() || 'zip').toLowerCase())}</span>` : ''}
            ${g.id ? `<span class="tag mono">${esc(g.id)}</span>` : ''}
            <span class="tag">${fmtSize(g.size)}</span>
          </div>
          <div class="card-actions">
            <button class="btn" data-act="play" title="Play by yourself">${I.play}Play</button>
            <button class="btn primary" data-act="host" title="Create an online lobby">${I.host}Host</button>
            <button class="btn icon-only" data-act="edit" title="Rename, change cover, set link">⋯</button>
          </div>
        </div>
      </div>`).join('')}</div>`;
  }

  $('#view-library').addEventListener('click', async (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) return show(goto.dataset.goto);
    const f = e.target.closest('[data-filter]');
    if (f) {
      S.filter = f.dataset.filter;
      document.querySelectorAll('#libFilters .chip').forEach((c) => c.classList.toggle('active', c === f));
      return renderLibraryGrid();
    }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const key = t.closest('[data-key]')?.dataset.key;
    switch (t.dataset.act) {
      case 'addFolder': await act(() => netcade.library.addFolder()); break;
      case 'runSetup': await act(() => netcade.emu.setup()); break;
      case 'rescan': await act(() => netcade.library.rescan(), 'Library rescanned.'); break;
      case 'fav': { const favs = await act(() => netcade.library.favorite(key)); if (favs) { S.settings.favorites = favs; renderLibraryGrid(); } break; }
      case 'play': await act(() => netcade.play(key)); break;
      case 'host': openHostModal(key); break;
      case 'edit': openEditModal(key); break;
      default:
    }
  });
  $('#view-library').addEventListener('contextmenu', (e) => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (key) { e.preventDefault(); openEditModal(key); }
  });

  // ================================================================ edit game (name, cover, link)
  async function openEditModal(key) {
    const g = S.games.find((x) => x.key === key);
    if (!g) return;
    const info = await netcade.games.link(key).catch(() => ({}));
    const root = $('#modalRoot');
    const linkVal = info.saved || '';
    const render = () => {
      const art = S.covers[key];
      root.innerHTML = `<div class="modal-back"><div class="modal wide">
        <h2>Edit game</h2>
        <div class="edit-grid">
          <div class="edit-cover">${art ? `<img src="${art}" alt="">` : coverHtml(g)}</div>
          <div class="stack">
            <label class="field">Name in Netcade
              <div class="row"><input class="input" id="egName" style="flex:1" maxlength="120" value="${esc(g.title)}">
              ${g.originalTitle ? `<button class="btn small ghost" data-e="resetName" title="Back to ${esc(g.originalTitle)}">Reset</button>` : ''}</div>
              <span class="hint">Shown in your library and in lobbies you host. Matching with friends still uses the game file itself.</span>
            </label>
            <div class="field">Cover image
              <div class="row">
                <button class="btn small" data-e="coverFile">Choose image file…</button>
                <button class="btn small ghost" data-e="coverReset">Use automatic cover</button>
              </div>
              <div class="row"><input class="input" id="egCoverUrl" style="flex:1" placeholder="…or paste an image address (https://…)"><button class="btn small" data-e="coverUrl">Use</button></div>
            </div>
            <label class="field">Where to get this game (shown to friends who don't have it)
              <input class="input" id="egLink" placeholder="https://…" value="${esc(linkVal)}">
              ${info.suggested && info.suggested !== linkVal ? `<span class="hint">Found from your download: <b>${esc(info.suggestedDomain)}</b> <a href="#" data-e="useSuggested">Use this link</a></span>` : '<span class="hint">For example the creator\'s page for a homebrew game or ROM hack.</span>'}
            </label>
            <div class="hint mono path">${esc(g.archive ? `${g.path} → ${g.entry}` : g.path)} <a href="#" data-e="reveal">Show file</a></div>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end;margin-top:14px">
          <button class="btn ghost" data-e="cancel">Cancel</button>
          <button class="btn primary" data-e="save">Save</button>
        </div>
      </div></div>`;
    };
    render();
    const close = () => { root.innerHTML = ''; root.onclick = null; };
    root.onclick = async (e) => {
      if (e.target.classList.contains('modal-back')) return close();
      const t = e.target.closest('[data-e]');
      if (!t) return;
      e.preventDefault();
      const act2 = t.dataset.e;
      if (act2 === 'cancel') return close();
      if (act2 === 'reveal') return netcade.library.reveal(key);
      if (act2 === 'resetName') { $('#egName').value = g.originalTitle; return; }
      if (act2 === 'useSuggested') { $('#egLink').value = info.suggested; return; }
      if (act2 === 'coverFile' || act2 === 'coverUrl' || act2 === 'coverReset') {
        const name = $('#egName').value;
        const link = $('#egLink').value;
        let url;
        if (act2 === 'coverFile') url = await act(() => netcade.games.coverFile(key));
        if (act2 === 'coverUrl') url = await act(() => netcade.games.coverUrl(key, $('#egCoverUrl').value));
        if (act2 === 'coverReset') { await act(() => netcade.games.coverReset(key), 'Looking up the automatic cover…'); delete S.covers[key]; coverAsked.delete(key); }
        if (typeof url === 'string') S.covers[key] = url;
        render();
        $('#egName').value = name;
        $('#egLink').value = link;
        renderLibraryGrid();
        return;
      }
      if (act2 === 'save') {
        const name = $('#egName').value.trim();
        const link = $('#egLink').value.trim();
        if (link && !/^https?:\/\//i.test(link)) return toast('The link should start with https://', 'warn');
        if (name !== g.title) await act(() => netcade.games.rename(key, name === (g.originalTitle || '') ? '' : name));
        await act(() => netcade.setSettings({ gameLinks: { [key]: link || null } }));
        close();
      }
    };
  }

  // ================================================================ host modal
  async function openHostModal(key) {
    if (!S.server.url) {
      // no server yet: start the free built-in one (with internet sharing) and carry on
      toast('Starting your server…');
      await saveSettings({ embeddedServer: { enabled: true, share: true } });
    }
    for (let i = 0; i < 25 && S.server.state !== 'online'; i++) await new Promise((r) => setTimeout(r, 200));
    if (S.server.state !== 'online') { toast('Couldn\'t connect to the server yet. Check Settings → Online.', 'warn'); return; }
    const g = S.games.find((x) => x.key === key);
    if (!g) return;
    const d = S.hostDraft;
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal">
      <h2>Host ${esc(g.title)}</h2>
      <div class="stack">
        <label class="toggle"><input type="checkbox" id="hmPublic" ${d.public ? 'checked' : ''}><span class="track"></span>List in public lobbies</label>
        <div class="form-grid">
          <label class="field">Players
            <select class="input" id="hmMax">${[2, 3, 4].map((n) => `<option ${n === d.maxPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </label>
          <label class="field">Password (optional)
            <input class="input" id="hmPass" value="${esc(d.password)}" maxlength="32" placeholder="Anyone with the code">
          </label>
        </div>
        <label class="field">Where to get this game (optional)
          <input class="input" id="hmLink" placeholder="https://…">
          <span class="hint" id="hmLinkHint">Friends who don't have the game get a button to this page.</span>
        </label>
        <p class="hint">Friends join with the 6-letter lobby code or an invite link. They need their own copy of this exact game; Netcade checks it for them.</p>
        <div class="row" style="justify-content:flex-end">
          <button class="btn ghost" id="hmCancel">Cancel</button>
          <button class="btn primary" id="hmCreate">${I.host}Create lobby</button>
        </div>
      </div></div></div>`;
    const close = () => { root.innerHTML = ''; };
    netcade.games.link(key).then((info) => {
      const inp = $('#hmLink');
      if (!inp) return;
      inp.value = info.saved || info.suggested || '';
      if (!info.saved && info.suggested) $('#hmLinkHint').innerHTML = `Found from your download: <b>${esc(info.suggestedDomain)}</b>. Clear it if you'd rather not share it.`;
    }).catch(() => {});
    $('#hmCancel').onclick = close;
    root.firstChild.addEventListener('click', (e) => { if (e.target === root.firstChild) close(); });
    $('#hmCreate').onclick = async () => {
      S.hostDraft = { key, public: $('#hmPublic').checked, maxPlayers: +$('#hmMax').value, password: $('#hmPass').value };
      const link = $('#hmLink').value.trim();
      if (link && !/^https?:\/\//i.test(link)) return toast('The link should start with https://', 'warn');
      const ok = await act(() => netcade.lobby.create({ key, public: S.hostDraft.public, maxPlayers: S.hostDraft.maxPlayers, password: S.hostDraft.password, link }));
      if (ok !== undefined) { close(); show('online'); }
    };
  }

  // ================================================================ online
  async function refreshLobbies() {
    if (S.server.state === 'online') await act(() => netcade.lobby.send({ type: 'list' }));
  }

  function renderOnline(full) {
    const root = $('#view-online');
    const mode = !S.server.url ? 'noserver' : S.lobby ? `lobby:${S.lobby.code}` : 'browse';
    if (full || root.dataset.mode !== mode) {
      root.dataset.mode = mode;
      for (const k of Object.keys(sig)) delete sig[k];
      if (mode === 'noserver') root.innerHTML = noServerHtml();
      else if (mode === 'browse') root.innerHTML = browseHtml();
      else root.innerHTML = lobbyHtml();
      if (mode.startsWith('lobby')) renderChat(true);
    }
    if (mode === 'browse') renderPublicList();
    if (mode.startsWith('lobby')) renderLobbyParts();
  }

  function noServerHtml() {
    return `<div class="view-head"><div><h1>Play online</h1><div class="sub">Join a friend's game, or host your own.</div></div></div>
      <div class="online-grid">
        <div class="panel">
          <h2>Join a friend</h2>
          <input class="input code" id="joinCode" placeholder="Paste invite" autocomplete="off" spellcheck="false">
          <div class="row" style="margin-top:12px"><button class="btn primary" data-act="join" style="flex:1;justify-content:center">Join lobby</button></div>
          <p class="hint">Paste the whole invite message your friend sent. It contains their server address, so there's nothing to set up.</p>
        </div>
        <div class="panel">
          <h2>Host your own game</h2>
          <p class="muted">Turn on the free built-in server and Netcade gives you an internet address your friends can use. No account, no router setup.</p>
          <div class="row" style="margin-top:12px"><button class="btn primary" data-act="startOwnServer">Start my server</button>
          <button class="btn ghost" data-goto="settings">I have a server address</button></div>
          <p class="hint" style="margin-top:12px">Your PC needs to stay on while friends play.</p>
        </div>
      </div>`;
  }

  function browseHtml() {
    const games = S.games;
    const d = S.hostDraft;
    return `<div class="view-head"><div><h1>Play online</h1><div class="sub">Join a friend with their code, host your own lobby, or jump into a public one.</div></div></div>
      <div class="online-grid">
        <div class="stack">
          <div class="panel">
            <h2>Join a friend</h2>
            <input class="input code" id="joinCode" placeholder="ABC123" autocomplete="off" spellcheck="false">
            <div class="row" style="margin-top:12px"><button class="btn primary" data-act="join" style="flex:1;justify-content:center">Join lobby</button></div>
            <p class="hint">Type the 6-letter code, or paste the whole invite message your friend sent. Netcade picks up their server address from it automatically.</p>
          </div>
          <div class="panel">
            <h2>Host a game</h2>
            ${games.length ? `
            <div class="stack">
              <label class="field">Game
                <select class="input" id="hostGame">${games.map((g) => `<option value="${esc(g.key)}" ${g.key === d.key ? 'selected' : ''}>${esc(g.title)} · ${SYS[g.system]} · ${esc(g.region)}${g.rev ? ` Rev ${g.rev}` : ''}</option>`).join('')}</select>
              </label>
              <div class="form-grid">
                <label class="field">Players
                  <select class="input" id="hostMax">${[2, 3, 4].map((n) => `<option ${n === d.maxPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select>
                </label>
                <label class="field">Password (optional)<input class="input" id="hostPass" maxlength="32" value="${esc(d.password)}"></label>
              </div>
              <label class="toggle"><input type="checkbox" id="hostPublic" ${d.public ? 'checked' : ''}><span class="track"></span>List in public lobbies</label>
              <button class="btn primary" data-act="create" style="justify-content:center">${I.host}Create lobby</button>
            </div>` : '<p class="muted">Add games to your library to host.</p><button class="btn" data-goto="library">Go to library</button>'}
          </div>
        </div>
        <div class="panel">
          <div class="row" style="margin-bottom:10px"><h2 style="margin:0">Public lobbies</h2><div class="spacer"></div><button class="btn small" data-act="refresh">Refresh</button></div>
          <div id="publicList"></div>
        </div>
      </div>`;
  }

  function renderPublicList() {
    const el = $('#publicList');
    if (!el) return;
    if (S.server.state !== 'online') { el.innerHTML = '<p class="muted">Connecting to the server…</p>'; return; }
    if (!S.publicLobbies.length) { el.innerHTML = '<div class="empty" style="padding:30px"><p>No public lobbies right now.<br>Host one and tick "List in public lobbies".</p></div>'; return; }
    const keys = new Set(S.games.map((g) => g.key));
    el.innerHTML = `<table class="lobby-list"><thead><tr><th>Game</th><th>Host</th><th>Players</th><th>Ping</th><th></th></tr></thead><tbody>
      ${S.publicLobbies.map((l) => `<tr>
        <td><div class="row" style="gap:8px"><span class="badge ${l.system}">${SYS[l.system]}</span><b>${esc(l.title)}</b>${l.hasPassword ? I.lock : ''}</div>
          <div class="hint">${esc(l.region)}${l.rev ? ` · Rev ${l.rev}` : ''} · ${keys.has(l.gameKey) ? '<span class="ok-text">In your library</span>' : '<span class="warn-text">Not in your library</span>'}</div></td>
        <td>${esc(l.hostName)}</td>
        <td class="mono">${l.players}/${l.maxPlayers}${l.members > l.players ? ` <span class="tag">+${l.members - l.players} watching</span>` : ''}${l.state !== 'waiting' ? ' <span class="tag">playing</span>' : ''}</td>
        <td>${pingBars(l.hostPing)}</td>
        <td style="text-align:right"><button class="btn small ${keys.has(l.gameKey) ? 'primary' : ''}" data-act="joinPublic" data-code="${l.code}" data-pw="${l.hasPassword ? 1 : 0}" ${l.members >= (l.maxMembers || 8) ? 'disabled' : ''}>${l.state !== 'waiting' || l.players >= l.maxPlayers ? 'Watch' : 'Join'}</button></td>
      </tr>`).join('')}</tbody></table>`;
  }

  function lobbyHtml() {
    return `<div id="lobbyHead"></div>
      <div id="lobbyBanners"></div>
      <div class="lobby-grid">
        <div class="stack">
          <div id="sessionCard"></div>
          <div id="requestsBox"></div>
          <div class="panel">
            <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Controllers</h2><span class="hint" id="memberCount"></span><div class="spacer"></div>
              <button class="btn small" data-act="openControls">${I.pad}My controls</button></div>
            <div class="players" id="players"></div>
            <div id="spectators"></div>
          </div>
          <div id="lobbyControls"></div>
          <div id="tournamentBox"></div>
        </div>
        <div class="panel chat">
          <div class="chat-head"><h2 style="margin:0">Chat</h2><span class="hint" id="chatCount"></span></div>
          <div class="chat-log" id="chatLog"></div>
          <div class="chat-input"><input class="input" id="chatInput" maxlength="300" placeholder="Say something…" autocomplete="off"><button class="btn" data-act="sendChat">Send</button></div>
        </div>
      </div>`;
  }

  function isHost() {
    return S.lobby && S.lobby.hostId === S.lobby.myId;
  }

  function renderLobbyParts() {
    const L = S.lobby;
    if (!L) return;
    const me = L.members.find((m) => m.id === L.myId);
    const host = isHost();

    // ----- header
    const headSig = JSON.stringify([L.code, L.game, L.system, L.state, host]);
    if (sig.head !== headSig) {
      sig.head = headSig;
      wantCovers([{ ...L.game, system: L.system }]);
      $('#lobbyHead').innerHTML = `<div class="lobby-head">
        ${coverHtml({ ...L.game, system: L.system })}
        <div>
          <div class="row" style="gap:8px;margin-bottom:6px"><span class="badge ${L.system}">${SYS[L.system]}</span>
            <span class="tag">${esc(L.game.region)}${L.game.rev ? ` · Rev ${L.game.rev}` : ''}</span>
            ${L.state !== 'waiting' ? '<span class="live">Match running</span>' : ''}</div>
          <div class="lobby-title">${esc(L.game.title)}</div>
          ${L.game.link ? `<a href="#" class="game-link" data-act="openLink" title="${esc(L.game.link)}">🔗 Get the game · ${esc(domainOf(L.game.link))}</a>` : ''}
          <div class="row" style="margin-top:12px">
            <button class="btn small" data-act="copyInvite">${I.copy}Copy invite link</button>
            <button class="btn small ghost danger" data-act="leave">Leave lobby</button>
          </div>
        </div>
        <div class="code-box"><div class="label">Lobby code</div><div class="code">${esc(L.code)}</div>
          <button class="btn small ghost" data-act="copyCode">${I.copy}Copy code</button></div>
      </div>`;
    }

    // ----- banners
    const banners = [];
    if (!host && L.myHas && L.myHas.status !== 'match') {
      banners.push(`<div class="banner ${L.myHas.status === 'missing' ? 'bad' : 'warn'}">${I.warn}<div><b>${L.myHas.status === 'missing' ? "You don't have this game." : 'Your copy is a different version.'}</b><br>${esc(L.myHas.detail)}<br><span class="small">Add the right file (unpacked, .zip or .7z) to one of your game folders and Netcade will notice automatically after a rescan.</span></div>
      ${L.game.link ? `<button class="btn small primary" data-act="openLink">Get the game · ${esc(domainOf(L.game.link))}</button>` : ''}</div>`);
    }
    if (L.versionMismatch) {
      banners.push(`<div class="banner warn">${I.warn}<div><b>Players have different ${L.system === 'gc' ? 'Dolphin' : 'RetroArch'} versions.</b> Netplay needs everyone on the same version. Check the versions under each name.</div></div>`);
    }
    const emuMissing = L.system === 'gc' ? !S.emulators.dolphin?.ok : !(S.emulators.retroarch?.ok && S.emulators.n64Core);
    if (emuMissing) banners.push(`<div class="banner bad">${I.warn}<div><b>${L.system === 'gc' ? 'Dolphin' : 'RetroArch or its N64 core'} isn't set up on this PC.</b> <a href="#" data-goto="settings">Open emulator settings</a></div></div>`);
    const bSig = banners.join('');
    if (sig.banners !== bSig) { sig.banners = bSig; $('#lobbyBanners').innerHTML = bSig; }

    // ----- controller ports + spectators
    const myPort = me?.port ?? null;
    const myReq = (L.requests || []).find((r) => r.from === L.myId);
    const verKey = L.system === 'gc' ? 'dolphin' : 'retroarch';
    const live = L.state !== 'waiting';
    const tourneyLocked = !!(L.tournament && L.tournament.current);
    const hostMenu = (m) => (host ? `<select class="input mini" data-act-change="setPort" data-id="${m.id}" title="Move to…">
        <option value="" selected disabled>Move…</option>
        ${Array.from({ length: L.maxPlayers }, (_, i) => i + 1).filter((n) => n !== m.port).map((n) => `<option value="${n}">P${n}</option>`).join('')}
        ${m.port ? '<option value="spectate">Spectators</option>' : ''}
      </select>${m.isHost ? '' : `<button class="icon-btn" title="Remove from lobby" data-act="kick" data-id="${m.id}">${I.x}</button>`}` : '');
    const memberDetail = (m) => {
      const has = m.has?.status || 'unknown';
      const d = m.isHost ? 'Host' : has === 'match' ? 'Has the game' : has === 'missing' ? 'Missing the game' : has === 'mismatch' ? 'Different version of the game' : 'Checking library…';
      const cls = has === 'missing' ? 'bad' : has === 'mismatch' ? 'warn' : '';
      return `<div class="detail ${cls}">${esc(d)}${m.versions?.[verKey] ? ` · <span class="mono">${esc(L.system === 'gc' ? 'Dolphin' : 'RetroArch')} ${esc(m.versions[verKey])}</span>` : ''}</div>`;
    };
    const slots = [];
    for (let i = 1; i <= L.maxPlayers; i++) {
      const m = L.members.find((x) => x.port === i);
      const pending = (L.requests || []).filter((r) => r.port === i);
      let mine = '';
      if (m && m.id === L.myId) {
        mine = `<button class="btn small ghost" data-act="spectate" title="Give up your controller and watch">Watch instead</button>`;
      } else if (myReq && myReq.port === i) {
        mine = `<span class="pending-tag">Asked ${esc(m?.name || '')}…</span><button class="btn small ghost" data-act="cancelPort" data-req="${myReq.id}">Cancel</button>`;
      } else if (!tourneyLocked) {
        mine = m ? `<button class="btn small" data-act="requestPort" data-port="${i}">${myPort ? 'Ask to swap' : 'Ask to play'}</button>`
          : `<button class="btn small primary" data-act="requestPort" data-port="${i}">Take P${i}</button>`;
      }
      if (!m) {
        slots.push(`<div class="empty-slot"><div class="port">P<b>${i}</b></div><span>Open controller</span><div class="spacer"></div>
          ${mine}<button class="btn small ghost" data-act="copyInvite">${I.copy}Invite</button></div>`);
        continue;
      }
      slots.push(`<div class="player ${m.id === L.myId ? 'me' : ''}">
        <div class="port">P<b>${i}</b></div>
        <div>
          <div class="name">${esc(m.name)}${m.id === L.myId ? ' <span class="tag">You</span>' : ''}${pending.length ? ` <span class="pending-tag">${pending.length} request${pending.length > 1 ? 's' : ''}</span>` : ''}</div>
          ${memberDetail(m)}
        </div>
        ${pingBars(m.ping)}
        <div class="row" style="gap:4px">
          ${m.isHost ? '<span class="ready-pill host">Host</span>' : live ? '' : `<span class="ready-pill ${m.ready ? 'yes' : 'no'}">${m.ready ? 'Ready' : 'Not ready'}</span>`}
          ${mine}${hostMenu(m)}
        </div>
      </div>`);
    }
    const pSig = slots.join('');
    if (sig.players !== pSig) { sig.players = pSig; $('#players').innerHTML = pSig; }

    const specs = L.members.filter((m) => !m.port);
    const specHtml = specs.length ? `<h3>👀 Watching (${specs.length})</h3><div class="spec-list">${specs.map((m) => `
      <div class="spec ${m.id === L.myId ? 'me' : ''}">
        <span class="name">${esc(m.name)}${m.id === L.myId ? ' <span class="tag">You</span>' : ''}${m.isHost ? ' <span class="tag">Host</span>' : ''}</span>
        ${memberDetail(m)}
        <div class="row" style="gap:4px">${pingBars(m.ping)}${hostMenu(m)}</div>
      </div>`).join('')}</div>` : '';
    if (sig.specs !== specHtml) { sig.specs = specHtml; $('#spectators').innerHTML = specHtml; }
    const mc = $('#memberCount');
    if (mc) mc.textContent = `${L.members.length}/${L.maxMembers || 8} in lobby`;

    // ----- port requests: ones aimed at me (or all, for the host)
    const incoming = (L.requests || []).filter((r) => r.target === L.myId || (host && r.from !== L.myId));
    const reqHtml = incoming.map((r) => `<div class="banner ok req-banner">🎮<div style="flex:1"><b>${esc(r.fromName)}</b> wants ${r.target === L.myId ? 'your controller' : `${esc(r.targetName)}'s controller`} (P${r.port})${r.target === L.myId ? '' : '. You can approve as host.'}</div>
      <button class="btn small primary" data-act="answerPort" data-req="${r.id}" data-accept="1">Let them in</button>
      <button class="btn small" data-act="answerPort" data-req="${r.id}" data-accept="0">Not now</button></div>`).join('');
    if (sig.reqs !== reqHtml) { sig.reqs = reqHtml; $('#requestsBox').innerHTML = reqHtml; }

    // ----- host / guest controls
    const guests = L.members.filter((m) => !m.isHost && m.port);
    const notReady = guests.filter((m) => !m.ready);
    const missing = guests.filter((m) => m.has?.status && m.has.status !== 'match');
    const nPlayers = L.members.filter((m) => m.port).length;
    let ctl;
    if (L.state !== 'waiting') {
      ctl = `<div class="panel"><div class="row"><span class="live">Match running</span><div class="spacer"></div>
        ${host ? '<button class="btn danger" data-act="endGame">End match for everyone</button>' : ''}</div>
        <p class="hint">Closing your emulator ${host ? 'also ends the match for everyone.' : 'drops you out; the host can restart the match from the lobby.'}</p></div>`;
    } else if (host) {
      const startReason = !nPlayers ? 'Nobody is on a controller.'
        : missing.length ? `${missing.map((m) => m.name).join(', ')} can't play this game yet`
          : notReady.length ? `Waiting for ${notReady.map((m) => m.name).join(', ')} to ready up` : '';
      ctl = `<div class="panel">
        <h2>Match settings</h2>
        <div class="form-grid">
          <label class="field">${L.system === 'gc' ? 'Dolphin buffer' : 'Input delay'}
            <select class="input" data-opt="inputDelay">
              <option value="auto" ${L.inputDelay === 'auto' ? 'selected' : ''}>Auto (based on ping)</option>
              ${(L.system === 'gc' ? [3, 4, 5, 6, 8, 10, 12, 15, 20] : [0, 1, 2, 3, 4, 5, 6, 8, 10]).map((n) => `<option value="${n}" ${L.inputDelay === n ? 'selected' : ''}>${L.system === 'gc' ? `Buffer ${n}` : `${n} frame${n === 1 ? '' : 's'}`}</option>`).join('')}
            </select>
            ${L.system === 'gc' ? '<span class="hint">Game running below full speed? Raise this, or press + on the match card during the game.</span>' : ''}
          </label>
          <label class="field">Controller ports
            <select class="input" data-opt="maxPlayers">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${n === L.maxPlayers ? 'selected' : ''}>${n} controller${n > 1 ? 's' : ''}</option>`).join('')}</select>
          </label>
          <label class="field" style="grid-column: span 2">Game
            <select class="input" data-act-change="setGame">
              ${S.games.map((g) => `<option value="${esc(g.key)}" ${g.key === L.game.key ? 'selected' : ''}>${esc(g.title)} · ${SYS[g.system]} · ${esc(g.region)}${g.rev ? ` Rev ${g.rev}` : ''}</option>`).join('')}
            </select>
          </label>
        </div>
        ${L.system === 'gc' ? dolphinOptionsHtml() : ''}
        <label class="field" style="margin-top:12px">Where to get this game
          <div class="row"><input class="input" id="lobbyLink" style="flex:1" placeholder="https://… (optional)" value="${esc(L.game.link || '')}">
          <button class="btn small" data-act="saveLink">Save link</button></div>
        </label>
        <div class="row" style="margin-top:14px;gap:22px">
          <label class="toggle"><input type="checkbox" data-opt="public" ${L.public ? 'checked' : ''}><span class="track"></span>Public lobby</label>
          ${L.system === 'n64' ? `<label class="toggle" title="Route traffic through the server even if a direct connection would work"><input type="checkbox" data-opt="forceRelay" ${L.forceRelay ? 'checked' : ''}><span class="track"></span>Always use relay</label>` : ''}
        </div>
        <div class="hr"></div>
        <div class="row"><button class="btn primary big" data-act="start" ${startReason ? 'disabled' : ''}>${I.play}${L.members.length > 1 ? 'Start match' : 'Start (solo test)'}</button>
          <span class="hint">${esc(startReason || (L.members.length > 1 ? `Everyone is ready.${L.members.length > nPlayers ? ` ${L.members.length - nPlayers} will watch.` : ''}` : 'Invite friends with the code, or start alone to test your setup.'))}</span></div>
      </div>`;
    } else if (!myPort) {
      ctl = `<div class="panel"><div class="row"><span style="font-size:22px">👀</span>
        <span class="hint" style="flex:1">You're watching. ${L.myHas?.status === 'match' ? 'You\'ll see the match live when it starts.' : 'You need the same game to watch the match; you can still chat.'}
        ${tourneyLocked ? '' : ' Take an open controller or ask a player to swap.'}</span></div></div>`;
    } else {
      const canReady = L.myHas?.status === 'match' && !emuMissing;
      ctl = `<div class="panel"><div class="row">
        <button class="btn big ${me?.ready ? '' : 'primary'}" data-act="ready" ${canReady ? '' : 'disabled'}>${me?.ready ? 'Not ready' : `${I.ok}Ready up`}</button>
        <span class="hint">${canReady ? (me?.ready ? 'Waiting for the host to start the match.' : 'Set your controls, then ready up.') : 'You need the exact game and a working emulator to ready up.'}</span>
      </div></div>`;
    }
    if (sig.ctl !== ctl) { sig.ctl = ctl; $('#lobbyControls').innerHTML = ctl; }

    renderTournament();
    renderSessionCard();
    const chatCount = $('#chatCount');
    if (chatCount) chatCount.textContent = `${L.members.length} in lobby`;
  }

  // ================================================================ tournament
  let tDraft = null;
  function renderTournament() {
    const box = $('#tournamentBox');
    if (!box) return;
    const L = S.lobby;
    const host = isHost();
    const t = L.tournament;
    let html = '';
    if (!t) {
      if (host && L.state === 'waiting' && L.members.length >= 2) {
        if (!tDraft) {
          html = `<div class="panel"><div class="row"><h2 style="margin:0">🏆 Tournament</h2><div class="spacer"></div>
            <button class="btn small" data-act="tDraft">Set up a tournament</button></div>
            <p class="hint" style="margin:8px 0 0">Single-elimination bracket for up to ${L.maxMembers || 8} people. Netcade puts each match's two players on P1 and P2; everyone else watches.</p></div>`;
        } else {
          html = `<div class="panel"><h2>🏆 New tournament</h2>
            <h3>Who's in</h3>
            <div class="t-people">${L.members.map((m) => `<label class="toggle"><input type="checkbox" data-tpick="${m.id}" ${tDraft.pick.has(m.id) ? 'checked' : ''}><span class="track"></span>${esc(m.name)}</label>`).join('')}</div>
            <div class="form-grid" style="margin-top:12px">
              <label class="field">Each match
                <select class="input" id="tBestOf">${[1, 3, 5].map((n) => `<option value="${n}" ${tDraft.bestOf === n ? 'selected' : ''}>${n === 1 ? 'One game' : `Best of ${n}`}</option>`).join('')}</select></label>
              <label class="field">Bracket order
                <select class="input" id="tSeeding"><option value="random" ${tDraft.seeding === 'random' ? 'selected' : ''}>Random draw</option><option value="lobby" ${tDraft.seeding === 'lobby' ? 'selected' : ''}>Lobby order (P1 is top seed)</option></select></label>
            </div>
            <div class="row" style="margin-top:14px"><button class="btn primary" data-act="tCreate">Create bracket</button><button class="btn ghost" data-act="tCancelDraft">Cancel</button>
            <span class="hint">${tDraft.pick.size} player${tDraft.pick.size === 1 ? '' : 's'}${tDraft.pick.size > 2 && (tDraft.pick.size & (tDraft.pick.size - 1)) ? ' · some get a first-round bye' : ''}</span></div></div>`;
        }
      }
    } else {
      const nm = (id) => (id ? esc(t.names[id] || '?') : '<span class="muted">TBD</span>');
      const champ = t.champion ? `<div class="banner ok" style="margin-bottom:12px">🏆<div><b>${esc(t.names[t.champion])}</b> wins the tournament!</div></div>` : '';
      const cols = t.rounds.map((r) => `<div class="t-round"><div class="t-rname">${esc(r.name)}</div><div class="t-matches">${r.matches.map((m) => {
        const isCur = t.current === m.id;
        const inMatch = m.a === L.myId || m.b === L.myId;
        const canReport = m.status !== 'done' && m.a && m.b && (host || inMatch) && (isCur || host);
        const side = (id, score) => {
          if (!id && m.bye) return '<div class="t-side"><span class="muted">bye</span></div>';
          const cls = m.bye ? '' : m.winner && m.winner === id ? 'win' : m.winner ? 'lose' : '';
          return `<div class="t-side ${cls}"><span>${nm(id)}</span>${!m.bye && (t.bestOf > 1 || m.status === 'done') ? `<b>${score}</b>` : ''}</div>`;
        };
        let actions = '';
        if (host && m.status === 'ready' && L.state === 'waiting' && !isCur) actions += `<button class="btn small primary" data-act="tSetup" data-match="${m.id}">Play this match</button>`;
        if (canReport) {
          actions += `<button class="btn small" data-act="tReport" data-match="${m.id}" data-winner="${m.a}">${nm(m.a)} won</button>
            <button class="btn small" data-act="tReport" data-match="${m.id}" data-winner="${m.b}">${nm(m.b)} won</button>`;
          const gone = [m.a, m.b].filter((id) => !L.members.some((x) => x.id === id));
          if (host && gone.length === 1) {
            const stay = gone[0] === m.a ? m.b : m.a;
            actions += `<button class="btn small ghost" data-act="tReport" data-match="${m.id}" data-winner="${stay}" data-forfeit="1">${nm(gone[0])} left: forfeit</button>`;
          }
        }
        return `<div class="t-match ${isCur ? 'cur' : ''} ${m.bye ? 'bye' : ''} ${m.status}">
          ${isCur ? '<div class="t-flag">Now playing</div>' : ''}
          ${side(m.a, m.scoreA)}${side(m.b, m.scoreB)}
          ${actions ? `<div class="t-actions">${actions}</div>` : ''}
        </div>`;
      }).join('')}</div></div>`).join('');
      html = `<div class="panel"><div class="row" style="margin-bottom:12px"><h2 style="margin:0">🏆 Tournament</h2>
          <span class="tag">${t.bestOf === 1 ? 'One game per match' : `Best of ${t.bestOf}`}</span><div class="spacer"></div>
          ${host && t.canUndo ? '<button class="btn small ghost" data-act="tUndo">Undo last result</button>' : ''}
          ${host ? '<button class="btn small ghost danger" data-act="tEnd">End tournament</button>' : ''}</div>
        ${champ}<div class="bracket">${cols}</div>
        ${!t.champion && !t.current && host ? '<p class="hint" style="margin-top:10px">Pick the next match with "Play this match". Its two players go on P1 and P2; then press Start match.</p>' : ''}
        ${t.current ? '<p class="hint" style="margin-top:10px">After each game, either player (or the host) reports who won.</p>' : ''}</div>`;
    }
    if (sig.tourney !== html) { sig.tourney = html; box.innerHTML = html; }
  }

  function renderSessionCard() {
    const el = $('#sessionCard');
    if (!el) return;
    const s = S.session;
    const L = S.lobby;
    let html = '';
    if (s && s.role !== 'solo') {
      const showManual = s.system === 'gc' && s.role === 'host' && L && !L.dolphin && s.phase === 'dolphin';
      const net = s.netMode ? `<span class="tag">${s.netMode === 'direct' ? 'Direct connection' : 'Via relay'}</span>` : '';
      html = `<div class="panel session-card">
        <div class="row"><span class="live">${s.phase === 'preparing' ? 'Unpacking' : s.phase === 'waiting' ? 'Starting' : 'Live'}</span> ${net}<div class="spacer"></div>
          ${s.phase !== 'waiting' && s.phase !== 'preparing' ? '<button class="btn small danger" data-act="stopSession">Close emulator</button>' : ''}</div>
        <h2 style="margin:10px 0 0">${esc(s.text || '')}</h2>
        ${s.steps ? `<ol>${s.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
        ${s.netcade ? netcadeSessionHtml(s) : ''}
        ${s.system === 'gc' && s.role === 'guest' && s.hostCode ? `<div class="row" style="margin-top:12px"><span class="muted small">Host code</span><span class="mono" style="font-size:18px;color:var(--signal)">${esc(s.hostCode)}</span><button class="btn small" data-act="copyText" data-text="${esc(s.hostCode)}">${I.copy}Copy</button></div>` : ''}
        ${showManual && s.gcConnection === 'relay' ? `<div class="hr"></div><p class="hint">Friends' Dolphin didn't open after you clicked Host? Netcade may have missed it. Press this once your NetPlay window is open.</p>
          <div class="row"><button class="btn small" data-act="relayReady">My NetPlay window is open, connect my friends</button></div>` : ''}
        ${showManual && s.gcConnection !== 'relay' ? `<div class="hr"></div><p class="hint">Guests not connecting after you clicked Host? Copy the host code from Dolphin's NetPlay window and paste it here.</p>
          <div class="row"><input class="input mono" id="manualCode" placeholder="e.g. 4f2a91bc" maxlength="40"><button class="btn small" data-act="manualCode">Send to guests</button></div>` : ''}
      </div>`;
    } else if (s && s.phase === 'error') {
      html = `<div class="banner bad">${I.warn}<div>${esc(s.text)}</div></div>`;
    }
    if (sig.session !== html) { sig.session = html; el.innerHTML = html; }
  }

  // ------------------------------------------------ GameCube sessions run by Netcade's Dolphin
  const DOLPHIN_STATUS = {
    ok: 'Ready', missing: 'No game', wrongHash: 'Different copy', wrongDisc: 'Other disc',
    wrongRevision: 'Other revision', wrongRegion: 'Other region', unknown: 'Checking…',
  };

  function netcadeSessionHtml(s) {
    const d = s.dolphin;
    const host = s.role === 'host';
    if (!d) return `<p class="hint" style="margin-top:8px">${s.dolphinLinked === false ? '' : 'Dolphin is starting up…'}</p>`;
    const r = s.readiness;
    const rows = d.players.map((p) => `<div class="dp-row">
        <span class="dp-port">${p.port ? `P${p.port}` : '👀'}</span>
        <span class="dp-name">${esc(p.name)}${p.host ? ' <span class="tag">host</span>' : ''}</span>
        <span class="tag ${p.status === 'ok' ? 'ok' : 'warn'}">${esc(DOLPHIN_STATUS[p.status] || p.status)}</span>
        <span class="mono small muted">${p.ping} ms</span>
      </div>`).join('');
    const waitingRows = host && r && !d.running ? r.waiting.map((n) => `<div class="dp-row pending"><span class="dp-port">…</span><span class="dp-name">${esc(n)}</span><span class="muted small">connecting</span><span></span></div>`).join('') : '';
    const canBuffer = host ? !d.hia : d.hia;
    const actions = [];
    if (host && !d.running) {
      if (s.started) actions.push('<button class="btn small primary" data-act="dStart">Play again</button>');
      else if (r && !r.ready) actions.push(`<button class="btn small" data-act="dStart" data-force="1" title="Start with the players who are connected">Start without ${esc(listNames([...r.waiting, ...r.wrong.map((w) => w.name)]))}</button>`);
      else if (s.startError) actions.push('<button class="btn small primary" data-act="dStart">Start now</button>');
    }
    actions.push(`<button class="btn small ghost" data-act="dWindow">${d.windowVisible ? 'Hide' : 'Open'} Dolphin's NetPlay window</button>`);
    const log = (s.dolphinLog || []).slice(-3);
    return `<div class="dolphin-session">
        <div class="dp-list">${rows}${waitingRows}</div>
        ${canBuffer ? `<div class="row dp-buffer"><span class="muted small">${d.hia ? 'Your max buffer' : 'Buffer'}</span>
          <button class="btn small icon-only" data-act="dBuffer" data-d="-1" title="Less input lag">−</button>
          <span class="mono">${d.buffer}</span>
          <button class="btn small icon-only" data-act="dBuffer" data-d="1" title="Smoother if the game runs below full speed">+</button>
          <span class="hint">Running below full speed? Press + until it's smooth. Works mid-game.</span></div>` : ''}
        <div class="row" style="margin-top:10px;flex-wrap:wrap;gap:8px">${actions.join('')}</div>
        ${log.length ? `<div class="dp-log">${log.map((l) => `<div style="${l.color && /^(red|green|magenta|darkcyan)$/.test(l.color) ? `color:${l.color === 'darkcyan' ? '#7fd4d4' : l.color === 'magenta' ? '#e39af0' : l.color === 'red' ? '#ff8a8a' : '#8fe3a8'}` : ''}">${esc(l.text)}</div>`).join('')}</div>` : ''}
      </div>`;
  }

  function listNames(names) {
    return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  /** The options from Dolphin's NetPlay window, set from the lobby (host). */
  function dolphinOptionsHtml() {
    const o = S.settings.dolphinNetplay || {};
    const live = S.session?.netcade && S.session.dolphin;
    const locked = live && !S.session.dolphin.optionsEditable;
    const tog = (k, label, tip) => `<label class="toggle" title="${esc(tip)}"><input type="checkbox" data-dopt="${k}" ${o[k] ? 'checked' : ''}><span class="track"></span>${label}</label>`;
    return `<details class="adv dolphin-opts" ${S.ui?.dolphinOptsOpen ? 'open' : ''}>
      <summary>Dolphin NetPlay options</summary>
      <div class="form-grid" style="margin-top:8px">
        <label class="field">Network mode
          <select class="input" data-dopt="networkMode">
            ${[['fixeddelay', 'Fair input delay (everyone equal)'], ['hostinputauthority', 'Host input authority (host has no lag)'], ['golf', 'Golf mode (whoever\'s turn it is has no lag)']]
              .map(([v, l]) => `<option value="${v}" ${o.networkMode === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
        <label class="field">Save data
          <select class="input" data-dopt="savedata">
            ${[['none', 'No save data (fresh start)'], ['load', 'Load host\'s save data only'], ['write', 'Load and write host\'s save data']]
              .map(([v, l]) => `<option value="${v}" ${o.savedata === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="row" style="margin-top:10px;gap:18px;flex-wrap:wrap">
        ${tog('syncCodes', 'Sync AR/Gecko codes', 'Everyone uses the host\'s cheat codes')}
        ${tog('strictSync', 'Strict settings sync', 'Also syncs graphics settings that can cause desyncs (needs a fixed resolution)')}
        ${tog('recordInputs', 'Record inputs', 'Save a replay of the match')}
        ${tog('syncAllWii', 'Use all Wii save data', 'Wii games: sync every save, not only this game\'s')}
        ${tog('golfOverlay', 'Golf mode overlay', 'Shows who is golfing')}
        ${tog('hideRemoteGbas', 'Hide remote GBAs', 'GBA link games: only show your own GBA window')}
      </div>
      <p class="hint" style="margin-top:8px">${locked ? 'The game is running: changes apply from the next game.' : 'Applied when the match starts.'} Everything else (game checks, GBA setup, Dolphin's chat) is in Dolphin's NetPlay window, which you can open from the match card.</p>
    </details>`;
  }

  function renderChat(full) {
    const log = $('#chatLog');
    if (!log) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const line = (m) => {
      const t = new Date(m.t || Date.now());
      const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      if (m.system) return `<div class="msg system">${esc(m.text)}<span class="t">${time}</span></div>`;
      const color = `hsl(${hash(m.from || m.name) % 360} 80% 72%)`;
      return `<div class="msg"><span class="who" style="color:${color}">${esc(m.name)}</span>${esc(m.text)}<span class="t">${time}</span></div>`;
    };
    if (full) log.innerHTML = S.chat.map(line).join('');
    else if (S.chat.length) log.insertAdjacentHTML('beforeend', line(S.chat[S.chat.length - 1]));
    if (stick || full) log.scrollTop = log.scrollHeight;
  }

  async function sendChat() {
    const inp = $('#chatInput');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    await act(() => netcade.lobby.send({ type: 'chat', text }));
  }

  async function inviteText() {
    const server = await netcade.lobby.inviteServer().catch(() => '');
    const lines = [`Join my Netcade game: ${S.lobby.game.title}`, `Code: ${S.lobby.code}`];
    if (server) lines.push(`Server: ${server}`);
    if (S.lobby.game.link) lines.push(`Get the game: ${S.lobby.game.link}`);
    lines.push('Copy this whole message, then in Netcade go to Play online and paste it in the Join box.');
    return lines.join('\n');
  }

  $('#view-online').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'chatInput') sendChat();
    if (e.key === 'Enter' && e.target.id === 'joinCode') $('[data-act="join"]').click();
  });

  // pasting a whole invite message joins straight away (and keeps its line breaks, which a
  // single-line box would otherwise strip)
  $('#view-online').addEventListener('paste', async (e) => {
    if (e.target.id !== 'joinCode') return;
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (text.trim().length <= 8) return;
    e.preventDefault();
    const r = await act(() => netcade.lobby.joinInvite(text));
    if (r && r.code) {
      e.target.value = r.code;
      toast(r.switched ? `Connecting to your friend's server and joining ${r.code}…` : `Joining ${r.code}…`);
    }
  });

  $('#view-online').addEventListener('input', (e) => {
    // a short entry is a typed code; anything longer is a pasted invite and is left alone
    if (e.target.id === 'joinCode' && e.target.value.length <= 8 && !/[:/]/.test(e.target.value)) {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
  });

  $('#view-online').addEventListener('toggle', (e) => {
    if (e.target.classList?.contains('dolphin-opts')) S.ui = { ...(S.ui || {}), dolphinOptsOpen: e.target.open };
  }, true);
  $('#view-online').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.dopt) {
      const v = t.type === 'checkbox' ? t.checked : t.value;
      const ok = await act(async () => { S.settings = await netcade.dolphin.setOptions({ [t.dataset.dopt]: v }); return true; });
      if (!ok) renderOnline();
      return;
    }
    if (t.dataset.opt) {
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.opt === 'maxPlayers') v = +v;
      if (t.dataset.opt === 'inputDelay') v = v === 'auto' ? 'auto' : +v;
      await act(() => netcade.lobby.send({ type: 'setOptions', [t.dataset.opt]: v }));
    }
    if (t.dataset.actChange === 'setGame') await act(() => netcade.lobby.setGame(t.value));
    if (t.dataset.actChange === 'setPort') {
      const port = t.value === 'spectate' ? null : +t.value;
      await act(() => netcade.lobby.send({ type: 'setPort', id: t.dataset.id, port }));
    }
    if (t.dataset.tpick && tDraft) {
      if (t.checked) tDraft.pick.add(t.dataset.tpick); else tDraft.pick.delete(t.dataset.tpick);
      renderTournament();
    }
    if ((t.id === 'tBestOf' || t.id === 'tSeeding') && tDraft) {
      tDraft.bestOf = +$('#tBestOf').value;
      tDraft.seeding = $('#tSeeding').value;
    }
  });

  $('#view-online').addEventListener('click', async (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) { e.preventDefault(); return show(goto.dataset.goto); }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const L = S.lobby;
    switch (t.dataset.act) {
      case 'startOwnServer': {
        await saveSettings({ embeddedServer: { enabled: true, share: true } });
        toast('Server started. Host a game from your Library and send the invite.');
        break;
      }
      case 'join': {
        const text = $('#joinCode').value.trim();
        if (text.length < 6) return toast('Lobby codes are 6 characters.', 'warn');
        const r = await act(() => netcade.lobby.joinInvite(text));
        if (r && r.switched) toast(`Connecting to your friend's server…`);
        break;
      }
      case 'joinPublic':
        if (t.dataset.pw === '1') return askPassword(t.dataset.code);
        await act(() => netcade.lobby.send({ type: 'join', code: t.dataset.code }));
        break;
      case 'refresh': await refreshLobbies(); break;
      case 'create': {
        const key = $('#hostGame').value;
        S.hostDraft = { key, public: $('#hostPublic').checked, maxPlayers: +$('#hostMax').value, password: $('#hostPass').value };
        await act(() => netcade.lobby.create({ key, public: S.hostDraft.public, maxPlayers: S.hostDraft.maxPlayers, password: S.hostDraft.password }));
        break;
      }
      case 'leave': await act(() => netcade.lobby.send({ type: 'leave' })); break;
      case 'copyCode': await act(() => netcade.copy(L.code), 'Lobby code copied.'); break;
      case 'copyInvite': {
        const sh = S.share || {};
        if (S.settings.embeddedServer?.enabled && S.settings.embeddedServer.share !== false && sh.state !== 'on') {
          toast(sh.state === 'error' ? `Internet sharing isn't working: ${sh.error} This invite only works for people in your home.` : 'Your internet address is still being set up. This invite only works for people in your home; copy again in a few seconds for friends elsewhere.', 'warn');
        }
        await act(async () => netcade.copy(await inviteText()), 'Invite copied. Paste it to your friends.');
        break;
      }
      case 'copyText': await act(() => netcade.copy(t.dataset.text), 'Copied.'); break;
      case 'sendChat': await sendChat(); break;
      case 'ready': {
        const me = L.members.find((m) => m.id === L.myId);
        await act(() => netcade.lobby.send({ type: 'ready', ready: !me?.ready }));
        break;
      }
      case 'start': await act(() => netcade.lobby.send({ type: 'start' })); break;
      case 'endGame': await act(() => netcade.lobby.send({ type: 'endGame' })); break;
      case 'kick': await act(() => netcade.lobby.send({ type: 'kick', id: t.dataset.id })); break;
      case 'requestPort': await act(() => netcade.lobby.send({ type: 'requestPort', port: +t.dataset.port })); break;
      case 'cancelPort': await act(() => netcade.lobby.send({ type: 'cancelPort', reqId: t.dataset.req })); break;
      case 'answerPort': await act(() => netcade.lobby.send({ type: 'answerPort', reqId: t.dataset.req, accept: t.dataset.accept === '1' })); break;
      case 'spectate': await act(() => netcade.lobby.send({ type: 'spectate' })); break;
      case 'tDraft': tDraft = { pick: new Set(L.members.map((m) => m.id)), bestOf: 1, seeding: 'random' }; renderTournament(); break;
      case 'tCancelDraft': tDraft = null; renderTournament(); break;
      case 'tCreate': {
        const picks = L.members.filter((m) => tDraft.pick.has(m.id)).map((m) => m.id);
        const ok = await act(() => netcade.lobby.send({ type: 'tCreate', participants: picks, bestOf: +$('#tBestOf').value, seeding: $('#tSeeding').value }));
        if (ok) tDraft = null;
        break;
      }
      case 'tSetup': await act(() => netcade.lobby.send({ type: 'tSetup', matchId: t.dataset.match })); break;
      case 'tReport': await act(() => netcade.lobby.send({ type: 'tReport', matchId: t.dataset.match, winner: t.dataset.winner, forfeit: t.dataset.forfeit === '1' })); break;
      case 'tUndo': await act(() => netcade.lobby.send({ type: 'tUndo' })); break;
      case 'tEnd': if (confirm('End the tournament? The bracket will be cleared.')) await act(() => netcade.lobby.send({ type: 'tEnd' })); break;
      case 'openLink': if (L?.game?.link) await netcade.openExternal(L.game.link); break;
      case 'saveLink': {
        const v = $('#lobbyLink').value.trim();
        if (v && !/^https?:\/\//i.test(v)) { toast('The link should start with https://', 'warn'); break; }
        await act(() => netcade.lobby.setLink(v), v ? 'Link saved. Friends without the game will see it.' : 'Link removed.');
        break;
      }
      case 'stopSession': await act(() => netcade.stopSession()); break;
      case 'dStart': await act(() => netcade.dolphin.cmd('start', { force: t.dataset.force === '1' })); break;
      case 'dWindow': await act(() => netcade.dolphin.cmd(S.session?.dolphin?.windowVisible ? 'hide' : 'show')); break;
      case 'dBuffer': {
        const cur = S.session?.dolphin?.buffer ?? 0;
        await act(() => netcade.dolphin.cmd('buffer', { value: Math.max(0, Math.min(99, cur + +t.dataset.d)) }));
        break;
      }
      case 'relayReady': await act(() => netcade.lobby.send({ type: 'dolphinManual', relay: true }), 'Connecting your friends…'); break;
      case 'manualCode': {
        const code = $('#manualCode').value.trim();
        if (code) await act(() => netcade.lobby.send({ type: 'dolphinManual', hostCode: code }), 'Sent to guests.');
        break;
      }
      case 'openControls': openDrawer(); break;
      default:
    }
  });

  function askPassword(code) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal"><h2>Lobby password</h2>
      <input class="input" id="pwInput" type="password" style="width:100%" placeholder="Password">
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" id="pwCancel">Cancel</button><button class="btn primary" id="pwOk">Join</button></div></div></div>`;
    const close = () => { root.innerHTML = ''; };
    $('#pwInput').focus();
    $('#pwCancel').onclick = close;
    const go = async () => { const pw = $('#pwInput').value; close(); await act(() => netcade.lobby.send({ type: 'join', code, password: pw })); };
    $('#pwOk').onclick = go;
    $('#pwInput').onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); };
  }

  // ================================================================ controls (page + lobby drawer)
  const editorOpts = (extra) => ({
    getSettings: () => S.settings,
    save: async (patch) => { await saveSettings(patch); },
    toast,
    platform: S.platform,
    ...extra,
  });
  const pageEditor = new ControlsEditor($('#view-controls'), editorOpts({}));
  let drawerEditor = null;

  function openDrawer() {
    const sys = S.lobby ? S.lobby.system : 'n64';
    const drawer = $('#drawer');
    drawer.innerHTML = '<div style="display:flex;justify-content:flex-end"><button class="btn ghost" id="drawerClose">Done</button></div><div id="drawerBody"></div>';
    drawerEditor = new ControlsEditor($('#drawerBody'), editorOpts({ system: sys, lockSystem: true, platform: S.platform }));
    drawerEditor.mount(sys);
    drawer.classList.add('open');
    $('#drawerBack').classList.add('open');
    $('#drawerClose').onclick = closeDrawer;
  }

  function closeDrawer() {
    if (drawerEditor) drawerEditor.unmount();
    drawerEditor = null;
    $('#drawer').classList.remove('open');
    $('#drawerBack').classList.remove('open');
  }
  $('#drawerBack').addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerEditor && !drawerEditor.listening) closeDrawer();
  });

  // ================================================================ settings
  function renderSettings() {
    const s = S.settings;
    const g = s.graphics;
    const root = $('#view-settings');
    const embedded = s.embeddedServer?.enabled;
    root.innerHTML = `
      <div class="view-head"><div><h1>Settings</h1><div class="sub">Netcade ${esc(S.appVersion)}</div></div></div>
      <div class="settings-grid">
        <div class="panel">
          <h2>Profile & online</h2>
          <div class="stack">
            <label class="field">Your name in lobbies<input class="input" data-set="name" maxlength="24" value="${esc(s.name)}"></label>
            <div class="seg" style="align-self:flex-start">
              <button data-act="serverMode" data-v="remote" class="${embedded ? '' : 'active'}">Use a server</button>
              <button data-act="serverMode" data-v="local" class="${embedded ? 'active' : ''}">Run server on this PC</button>
            </div>
            ${embedded ? `
              <label class="field">Port<input class="input" data-set="embeddedServer.port" type="number" min="1024" max="65535" value="${s.embeddedServer.port || 8080}"></label>
              <div class="banner ok">${I.ok}<div>Server running on this PC. Friends in your home can use <span class="mono selectable">${S.lanIps.map((ip) => `http://${esc(ip)}:${s.embeddedServer.port || 8080}`).join(', ') || 'your LAN address'}</span>.</div></div>
              <label class="toggle"><input type="checkbox" data-set="embeddedServer.share" ${s.embeddedServer.share !== false ? 'checked' : ''}><span class="track"></span>Let friends join over the internet (free, no account)</label>
              <div id="shareStatus">${shareHtml()}</div>` : `
              <label class="field">Server address
                <div class="row"><input class="input" style="flex:1" data-set="serverUrl" placeholder="https://your-netcade-server.fly.dev" value="${esc(s.serverUrl)}">
                <button class="btn" data-act="testServer">Test</button></div>
              </label>
              <span class="hint" id="serverTest">${S.server.state === 'online' ? '<span class="ok-text">Connected.</span>' : S.server.url ? 'Not connected.' : 'Deploy the included server (README → "Run your own server") and paste its address here.'}</span>`}
          </div>
        </div>

        <div class="panel">
          <h2>Game folders</h2>
          <div class="stack" id="setFolders">${foldersHtml()}</div>
          <div class="row" style="margin-top:12px"><button class="btn primary" data-act="addFolder">Add folder</button><button class="btn" data-act="rescan">Rescan</button></div>
          <h3>Zipped games</h3>
          <p class="hint" style="margin:0 0 8px">Games inside .zip and .7z files are unpacked to a cache the first time you play them. Your archives are never changed.</p>
          <div class="row">
            <label class="field" style="flex:1">Cache size limit
              <select class="input" data-set="unpackCacheGB" data-num="1">${[5, 10, 20, 50, 100].map((n) => `<option value="${n}" ${(s.unpackCacheGB || 20) === n ? 'selected' : ''}>${n} GB</option>`).join('')}</select>
            </label>
            <div class="stack" style="gap:4px"><span class="hint" id="cacheUse">Using …</span><button class="btn small" data-act="clearUnpacked">Clear cache</button></div>
          </div>
          ${S.errors.length ? `<details style="margin-top:12px"><summary class="hint">${S.errors.length} file(s) couldn't be read</summary><div class="stack small" style="margin-top:8px">${S.errors.slice(0, 30).map((e) => `<div><span class="path">${esc(e.file)}</span><br><span class="bad-text">${esc(e.error)}</span></div>`).join('')}</div></details>` : ''}
        </div>

        <div class="panel" id="setEmus">${emusHtml()}</div>

        <div class="panel">
          <h2>Graphics</h2>
          <div class="stack">
            <label class="field">Preset
              <select class="input" data-act-change="preset">
                ${[['performance', 'Performance (older PCs)'], ['balanced', 'Balanced'], ['quality', 'Quality (strong GPU)'], ['custom', 'Custom']]
                  .map(([v, l]) => `<option value="${v}" ${g.preset === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </label>
            <div class="form-grid">
              <label class="field">N64 renderer
                <select class="input" data-set="graphics.n64Renderer">
                  <option value="parallel" ${g.n64Renderer === 'parallel' ? 'selected' : ''}>ParaLLEl-RDP (Vulkan, accurate)</option>
                  <option value="gliden64" ${g.n64Renderer === 'gliden64' ? 'selected' : ''}>GLideN64 (OpenGL, fast, widescreen)</option>
                </select>
              </label>
              <label class="field">N64 resolution
                <select class="input" data-set="graphics.n64Scale" data-num="1">${[1, 2, 4, 8].map((n) => `<option value="${n}" ${g.n64Scale === n ? 'selected' : ''}>${n}× native</option>`).join('')}</select>
              </label>
              <label class="field">GameCube backend
                <select class="input" data-set="graphics.gcBackend">
                  ${[['auto', 'Automatic'], ['vulkan', 'Vulkan'], ...(S.platform === 'win32' ? [['d3d12', 'Direct3D 12']] : []), ...(S.platform === 'darwin' ? [['metal', 'Metal']] : []), ['opengl', 'OpenGL']]
                    .map(([v, l]) => `<option value="${v}" ${g.gcBackend === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </label>
              <label class="field">GameCube resolution
                <select class="input" data-set="graphics.gcScale" data-num="1">${[1, 2, 3, 4, 6].map((n) => `<option value="${n}" ${g.gcScale === n ? 'selected' : ''}>${n}× native${n === 3 ? ' (1080p)' : n === 6 ? ' (4K)' : ''}</option>`).join('')}</select>
              </label>
            </div>
            <div class="row" style="gap:22px">
              <label class="toggle"><input type="checkbox" data-set="graphics.fullscreen" ${g.fullscreen ? 'checked' : ''}><span class="track"></span>Fullscreen</label>
              <label class="toggle"><input type="checkbox" data-set="graphics.vsync" ${g.vsync !== false ? 'checked' : ''}><span class="track"></span>V-Sync</label>
              <label class="toggle"><input type="checkbox" data-set="graphics.widescreen" ${g.widescreen ? 'checked' : ''}><span class="track"></span>Widescreen hack</label>
              <label class="toggle"><input type="checkbox" data-set="graphics.showFps" ${g.showFps ? 'checked' : ''}><span class="track"></span>Show FPS</label>
            </div>
            <span class="hint">In online N64 matches everyone uses the host's renderer so the games stay in sync. Widescreen on N64 needs GLideN64.</span>
          </div>
        </div>

        <div class="panel">
          <h2>Netplay</h2>
          <div class="stack">
            <label class="toggle"><input type="checkbox" data-set="netplay.forceRelay" ${s.netplay.forceRelay ? 'checked' : ''}><span class="track"></span>Always use the relay for N64 lobbies I host</label>
            <label class="field">GameCube connection (lobbies I host)
              <select class="input" data-set="netplay.gcConnection">${[
                ['relay', 'Through Netcade (works on any network, recommended)'],
                ['traversal', 'Dolphin traversal server (slightly less lag, fails on some routers)'],
                ['direct', 'Direct IP (I forwarded UDP port 2626)'],
              ].map(([v, l]) => `<option value="${v}" ${(s.netplay.gcConnection || 'relay') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <span class="hint">Through Netcade, friends connect via your lobby server, so no router or firewall setup is needed. Use another option only if everyone's routers allow it.</span>
            </label>
            <label class="toggle"><input type="checkbox" data-set="netplay.notify" ${s.netplay.notify ? 'checked' : ''}><span class="track"></span>Desktop notifications (joins, chat, match start)</label>
            <label class="field">In-game chat key
              <select class="input" data-set="chatKey">${[['Tab', 'Tab'], ['T', 'T'], ['Y', 'Y'], ['Enter', 'Enter'], ['Backquote', '` (backtick)']].map(([v, l]) => `<option value="${v}" ${(s.chatKey || 'Tab') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <span class="hint">Opens chat over the game. Only active while a game is running. Pick a key your game controls don't use.</span>
            </label>
            <label class="field">In-game overlay (players, spectators, chat)
              <select class="input" data-set="overlayLayout">
                <option value="auto" ${(s.overlayLayout || 'auto') === 'auto' ? 'selected' : ''}>In the black bars beside the game (when there are any)</option>
                <option value="corners" ${s.overlayLayout === 'corners' ? 'selected' : ''}>Always in the corners</option>
              </select>
              <span class="hint">4:3 games on a widescreen monitor leave black bars on each side; the player list and chat sit there, out of the way. With the widescreen hack on, they move to the corners.</span>
            </label>
            <div class="form-grid">
              <label class="field">N64 netplay port<input class="input" type="number" data-set="netplay.retroarchPort" data-num="1" value="${s.netplay.retroarchPort}"></label>
              <label class="field">GameCube host port<input class="input" type="number" data-set="netplay.dolphinPort" data-num="1" value="${s.netplay.dolphinPort}"></label>
            </div>
            <span class="hint">Netcade tries UPnP to open ports automatically. If direct connections fail, N64 falls back to the relay; GameCube uses Dolphin's traversal server.</span>
          </div>
        </div>

        <div class="panel">
          <h2>Troubleshooting</h2>
          <div class="row">
            <button class="btn" data-act="openPath" data-v="logs">Open logs</button>
            <button class="btn" data-act="openPath" data-v="dolphin">Open Netcade's Dolphin folder</button>
            <button class="btn" data-act="openPath" data-v="retroarch">Open N64 saves folder</button>
          </div>
          <p class="hint" style="margin-top:12px">Netcade uses its own Dolphin user folder, so your normal Dolphin settings and saves are untouched. Netcade never uploads or shares game files: every player uses their own copy.</p>
        </div>
      </div>`;
  }

  function shareHtml() {
    const sh = S.share || { state: 'off' };
    const s = S.settings;
    if (!s.embeddedServer?.enabled || s.embeddedServer.share === false) {
      return '<p class="hint">Turn this on to get a free internet address for your server through Cloudflare. Your PC needs to stay on while friends play.</p>';
    }
    if (sh.state === 'downloading') return `<p class="hint">Downloading the Cloudflare tunnel program (one time)… ${sh.progress || 0}%</p>`;
    if (sh.state === 'starting') return '<p class="hint">Getting an internet address from Cloudflare…</p>';
    if (sh.state === 'error') return `<div class="banner bad">${I.warn}<div style="flex:1">${esc(sh.error)}</div><button class="btn small" data-act="shareRetry">Try again</button></div>`;
    if (sh.state === 'on') {
      return `<div class="banner ok">${I.ok}<div style="flex:1">Friends anywhere can join through<br><span class="mono selectable">${esc(sh.url)}</span>
        <div class="hint" style="margin-top:4px">You don't need to send this yourself: lobby invites include it. The address changes each time Netcade restarts.</div></div>
        <button class="btn small" data-act="copyShare">${I.copy}Copy</button></div>`;
    }
    return '<p class="hint">Starting…</p>';
  }

  function refreshCacheUse() {
    netcade.unpacked.info().then((r) => {
      const el = $('#cacheUse');
      if (el) el.textContent = `Using ${(r.bytes / 1024 ** 3).toFixed(1)} GB`;
    }).catch(() => {});
  }

  function foldersHtml() {
    const s = S.settings;
    if (!s.romFolders.length) return '<p class="muted">No folders yet.</p>';
    return s.romFolders.map((f) => `<div class="folder"><span class="path">${esc(f)}</span><button class="icon-btn" title="Remove" data-act="removeFolder" data-folder="${esc(f)}">${I.x}</button></div>`).join('');
  }

  function emusHtml() {
    const e = S.emulators;
    const cp = S.coreProgress;
    if (!e.bundled && S.settings.emulatorSource !== 'custom' && (S.setup?.state === 'running' || S.setup?.state === 'error' || S.setup?.state === 'idle')) {
      return `<h2>Emulators</h2>${setupCardHtml() || '<p class="muted">Preparing…</p>'}
        <button class="btn small ghost" data-act="emuSource" data-v="custom">Use my own Dolphin / RetroArch instead…</button>`;
    }
    if (e.bundled) {
      const row = (cls, short, name, info, extra = '') => `<div class="emu">
        <div class="emu-icon ${cls}">${short}</div>
        <div>
          <div class="row" style="gap:8px"><b>${name}</b>${info.ok ? `<span class="ok-text small">● Built in${info.version ? ` · ${esc(info.version)}` : ''}</span>` : '<span class="bad-text small">● Missing from this install</span>'}</div>
          ${extra}
        </div></div>`;
      return `<div class="row" style="margin-bottom:12px"><h2 style="margin:0">Emulators</h2></div>
        ${row('gc', 'GC', 'Dolphin', e.dolphin || {})}
        ${row('n64', '64', 'RetroArch', e.retroarch || {}, e.n64CoreVersion ? `<div class="hint">N64 core: ${esc(e.n64CoreVersion)}</div>` : '')}
        <p class="hint">Netcade ships its own copies of both emulators, so everyone on the same Netcade version matches automatically and nothing else needs installing. They keep their own settings and saves, separate from any emulators you installed yourself.</p>
        <button class="btn small ghost" data-act="emuSource" data-v="custom">Use my own Dolphin / RetroArch instead…</button>`;
    }
    const card = (cls, short, name, info, kind, extra = '') => `<div class="emu">
      <div class="emu-icon ${cls}">${short}</div>
      <div>
        <div class="row" style="gap:8px"><b>${name}</b>${info.ok ? `<span class="ok-text small">● Found${info.version ? ` · ${esc(info.version)}` : ''}</span>` : '<span class="bad-text small">● Not found</span>'}</div>
        <div class="path">${esc(info.path || 'Not set')}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn small" data-act="browse" data-kind="${kind}">Browse…</button>
          ${info.ok ? '' : `<button class="btn small primary" data-act="download" data-kind="${kind}">Download</button>`}
        </div>
        ${extra}
      </div></div>`;
    const core = `<div style="margin-top:10px" class="row">
      <span class="small ${e.n64Core ? 'ok-text' : 'warn-text'}">${e.n64Core ? '● N64 core installed' : '● N64 core (Mupen64Plus-Next) missing'}</span>
      ${e.n64Core ? `<button class="btn small ghost" data-act="installCore">Update core</button>` : `<button class="btn small primary" data-act="installCore" ${cp ? 'disabled' : ''}>${cp ? `Downloading… ${cp.total ? Math.round((cp.got / cp.total) * 100) + '%' : ''}` : 'Install N64 core'}</button>`}
      <button class="btn small ghost" data-act="browse" data-kind="core">Choose file…</button></div>`;
    const back = e.bundleAvailable ? `<div class="banner ok" style="margin-bottom:12px">${I.ok}<div>You're using your own emulator installs. <a href="#" data-act="emuSource" data-v="bundled">Switch back to the built-in emulators</a> (recommended for online play).</div></div>` : '';
    return `${back}<div class="row" style="margin-bottom:12px"><h2 style="margin:0">Emulators</h2><div class="spacer"></div><button class="btn small" data-act="detect">Auto-detect</button></div>
      ${card('gc', 'GC', 'Dolphin', e.dolphin || {}, 'dolphin')}
      ${card('n64', '64', 'RetroArch', e.retroarch || {}, 'retroarch', core)}
      <p class="hint">Everyone in a lobby needs the same emulator version. Using the latest stable release of each keeps that easy.</p>`;
  }

  const PRESETS = {
    performance: { n64Renderer: 'gliden64', n64Scale: 1, gcScale: 1 },
    balanced: { n64Renderer: 'parallel', n64Scale: 2, gcScale: 2 },
    quality: { n64Renderer: 'parallel', n64Scale: 4, gcScale: 4 },
  };

  function setPath(obj, dotted, value) {
    const parts = dotted.split('.');
    const patch = {};
    let cur = patch;
    parts.forEach((p, i) => { cur[p] = i === parts.length - 1 ? value : {}; cur = cur[p]; });
    return patch;
  }

  $('#view-settings').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.set) {
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.num || t.type === 'number') v = +v;
      if (t.dataset.set === 'serverUrl') v = v.trim();
      const patch = setPath({}, t.dataset.set, v);
      if (t.dataset.set.startsWith('graphics.') && !['graphics.fullscreen', 'graphics.vsync', 'graphics.showFps'].includes(t.dataset.set)) patch.graphics.preset = 'custom';
      await saveSettings(patch);
      if (t.dataset.set === 'graphics.n64Renderer' || patch.graphics?.preset) renderSettings();
    }
    if (t.dataset.actChange === 'preset') {
      const p = PRESETS[t.value];
      await saveSettings({ graphics: { preset: t.value, ...(p || {}) } });
      renderSettings();
    }
  });

  $('#view-settings').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'shareRetry': await act(() => netcade.share.retry()); break;
      case 'copyShare': await act(() => netcade.copy(S.share.url), 'Address copied.'); break;
      case 'serverMode': await saveSettings({ embeddedServer: { enabled: t.dataset.v === 'local' } }); renderSettings(); break;
      case 'testServer': {
        const url = $('[data-set="serverUrl"]').value.trim();
        $('#serverTest').textContent = 'Testing…';
        const r = await act(() => netcade.server.test(url));
        $('#serverTest').innerHTML = r?.ok ? `<span class="ok-text">Works! ${r.info.players} player(s) online.</span>` : `<span class="bad-text">${esc(r?.error || 'Failed')}</span>`;
        if (r?.ok && url !== S.settings.serverUrl) await saveSettings({ serverUrl: url });
        break;
      }
      case 'addFolder': await act(() => netcade.library.addFolder()); renderSettings(); break;
      case 'removeFolder': await act(() => netcade.library.removeFolder(t.dataset.folder)); renderSettings(); break;
      case 'rescan': await act(() => netcade.library.rescan(), 'Library rescanned.'); renderSettings(); break;
      case 'browse': { const r = await act(() => netcade.emu.browse(t.dataset.kind)); if (r) { S.emulators = r; $('#setEmus').innerHTML = emusHtml(); } break; }
      case 'runSetup': await act(() => netcade.emu.setup()); break;
      case 'emuSource': {
        e.preventDefault();
        if (t.dataset.v === 'custom' && !confirm('Use your own Dolphin and RetroArch installs?\n\nOnline matches only work when everyone uses the same emulator versions, which the built-in copies guarantee.')) break;
        await saveSettings({ emulatorSource: t.dataset.v });
        const st = await netcade.getState();
        S.emulators = st.emulators;
        $('#setEmus').innerHTML = emusHtml();
        break;
      }
      case 'detect': { const r = await act(() => netcade.emu.detect()); if (r) { S.emulators = r; $('#setEmus').innerHTML = emusHtml(); toast(r.dolphin.ok || r.retroarch.ok ? 'Detection finished.' : 'No emulators found. Install them, or use Browse.'); } break; }
      case 'download': await netcade.openExternal(S.downloadPages[t.dataset.kind]); break;
      case 'installCore': {
        S.coreProgress = { got: 0, total: 0 };
        $('#setEmus').innerHTML = emusHtml();
        const r = await act(() => netcade.emu.installCore(), 'N64 core installed.');
        S.coreProgress = null;
        if (r) S.emulators = r;
        $('#setEmus').innerHTML = emusHtml();
        break;
      }
      case 'openPath': await netcade.openPath(t.dataset.v); break;
      case 'clearUnpacked': {
        const r = await act(() => netcade.unpacked.clear(), 'Unpacked games removed. They\'ll unpack again next time you play them.');
        if (r) $('#cacheUse').textContent = 'Using 0 GB';
        break;
      }
      default:
    }
  });

  // ================================================================ events from main
  let coverRedraw = 0;
  netcade.on('cover', ({ key, url }) => {
    S.covers[key] = url;
    if (S.view === 'library') {
      clearTimeout(coverRedraw);
      coverRedraw = setTimeout(renderLibraryGrid, 150);
    }
    for (const el of document.querySelectorAll(`[data-cover="${CSS.escape(key)}"]`)) {
      const g = S.games.find((x) => x.key === key) || (S.lobby && S.lobby.game.key === key ? { ...S.lobby.game, system: S.lobby.system } : null);
      if (!g) continue;
      const cls = [...el.classList].filter((c) => c !== 'cover' && c !== 'art').join(' ');
      el.outerHTML = coverHtml(g, cls);
    }
    if (S.view === 'online' && S.lobby && S.lobby.game.key === key) { delete sig.head; renderLobbyParts(); }
  });
  netcade.on('share', (st) => {
    S.share = st;
    const el = $('#shareStatus');
    if (el) el.innerHTML = shareHtml();
  });
  netcade.on('setup', (st) => {
    S.setup = st;
    renderSetup();
  });
  netcade.on('server-status', (st) => {
    S.server = { ...S.server, ...st };
    renderSidebar();
    if (S.view === 'online') renderOnline();
    if (S.view === 'settings' && $('#serverTest')) $('#serverTest').innerHTML = st.state === 'online' ? '<span class="ok-text">Connected.</span>' : esc(st.error || st.state);
  });
  netcade.on('lobby', (l) => {
    const was = S.lobby;
    S.lobby = l;
    if (!l && was) closeDrawer();
    renderSidebar();
    if (S.view === 'online') renderOnline();
  });
  netcade.on('lobby-msg', (m) => {
    if (m.type === 'lobbies') { S.publicLobbies = m.list; if (S.view === 'online') renderPublicList(); }
    if (m.type === 'joined') { S.chat = m.chat || []; show('online'); renderChat(true); }
    if (m.type === 'chat') { S.chat.push(m); if (S.chat.length > 200) S.chat.shift(); renderChat(false); }
    if (m.type === 'error') {
      if (m.needPassword) askPassword(m.code);
      else toast(m.message, 'error');
    }
    if (m.type === 'left') { S.chat = []; refreshLobbies(); }
    if (m.type === 'tournamentDone') toast(`🏆 ${m.name} wins the tournament!`);
    if (m.type === 'portRequest' && S.view !== 'online') toast(`${m.fromName} wants your controller (P${m.port}). Open Play online to answer.`);
  });
  netcade.on('session', (s) => {
    S.session = s;
    renderSidebar();
    if (S.view === 'online') renderSessionCard();
  });
  netcade.on('library', (lib) => {
    S.games = lib.games;
    S.errors = lib.errors || [];
    S.scan = null;
    if (S.view === 'library') renderLibrary();
    if (S.view === 'online' && !S.lobby) renderOnline(true);
  });
  netcade.on('library-progress', (p) => {
    S.scan = p;
    if (S.view === 'library') renderLibraryGrid();
  });
  netcade.on('settings', (s) => {
    S.settings = s;
    renderSidebar();
  });
  netcade.on('controls-dolphin', (info) => askKeepDolphinControls(info));

  /** "XInput/0/Gamepad" -> "Xbox controller 1", "SDL/0/PS5 Controller" -> "PS5 Controller" */
  function dolphinDeviceName(dev, adapter) {
    if (adapter) return 'GameCube controller adapter';
    const m = /^([^/]+)\/(\d+)\/(.+)$/.exec(dev || '');
    if (!m) return 'your controller';
    if (m[1] === 'XInput') return `Xbox controller ${+m[2] + 1}`;
    if (/keyboard/i.test(m[3]) || m[1] === 'Quartz' || m[1] === 'XInput2') return 'keyboard';
    return m[3];
  }

  function askKeepDolphinControls(info) {
    const root = $('#modalRoot');
    if (root.innerHTML.trim()) return;   // another dialog is open; don't stack them
    const what = dolphinDeviceName(info.device, info.adapter);
    root.innerHTML = `<div class="modal-back"><div class="modal">
      <h2>Keep your Dolphin controls?</h2>
      <p class="muted">You ${info.again ? 'changed your GameCube controls in Dolphin again' : 'changed your GameCube controls in Dolphin'} (using <b>${esc(what)}</b>). Netcade normally rewrites them from its Controls page at every launch.</p>
      <p class="muted small">Keep them and Netcade will use exactly what you set in Dolphin from now on. You can switch back on the Controls page any time.</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" id="kdNo">Use Netcade's controls</button>
        <button class="btn primary" id="kdYes">Keep my Dolphin controls</button>
      </div></div></div>`;
    const done = async (keep) => {
      root.innerHTML = '';
      const ok = await act(async () => { S.settings = await netcade.controls.keepDolphin(keep); return true; },
        keep ? 'Saved. Your Dolphin controls will be used from now on.' : '');
      if (ok && pageEditor.mounted) pageEditor.render();
      if (ok && drawerEditor?.mounted) drawerEditor.render();
    };
    $('#kdYes').onclick = () => done(true);
    $('#kdNo').onclick = () => done(false);
  }
  netcade.on('emulators', (e) => {
    S.emulators = e;
    if (S.view === 'settings' && $('#setEmus')) $('#setEmus').innerHTML = emusHtml();
    if (S.view === 'library') $('#libChecklist').innerHTML = setupChecklist();
  });
  netcade.on('core-progress', (p) => {
    S.coreProgress = p;
    if (S.view === 'settings' && $('#setEmus')) $('#setEmus').innerHTML = emusHtml();
  });
  netcade.on('toast', (t) => toast(t.text, t.kind));
  netcade.on('navigate', (v) => show(v));

  // ================================================================ boot
  (async () => {
    const st = await netcade.getState();
    Object.assign(S, st);
    S.server = st.server;
    pageEditor.opts.platform = S.platform;
    renderSidebar();
    show('library');
    setInterval(() => { if (S.view === 'online' && !S.lobby) refreshLobbies(); }, 15000);
  })();
})();
