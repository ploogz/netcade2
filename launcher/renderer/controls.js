/* global InputMaps */
/**
 * Controls editor: press-to-bind mapping for keyboard or controller, per system.
 * Used both on the Controls page and in the lobby's Controls drawer.
 */
(function () {
  'use strict';
  const IM = window.InputMaps;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readPads() {
    const out = [];
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of list) {
      if (!p || !p.connected) continue;
      out.push({
        index: p.index,
        id: p.id,
        standard: p.mapping === 'standard',
        buttons: p.buttons.map((b) => (typeof b === 'object' ? b.value : b)),
        axes: p.axes.slice(),
      });
    }
    return out;
  }

  const ADAPTER_GUIDE = 'https://dolphin-emu.org/docs/guides/how-use-official-gc-controller-adapter-wii-u/';

  /**
   * What Dolphin will call each connected controller. Xbox-style pads on Windows go through
   * Dolphin's XInput backend (numbered among Xbox pads only); everything else through SDL, where
   * Dolphin numbers controllers that share a name (two "PS5 Controller"s are SDL/0 and SDL/1).
   */
  function padCandidates(pads, platform) {
    const out = [];
    let xinput = 0;
    const sdlSeen = {};
    for (const p of pads) {
      if (platform === 'win32' && IM.isXInputLike(p.id)) {
        out.push({ pad: p, kind: 'xinput', index: xinput, name: '', label: `Xbox controller${xinput ? ` ${xinput + 1}` : ''}`, sub: 'Xbox-style controller' });
        xinput++;
      } else {
        const name = IM.guessSdlName(p.id);
        const index = sdlSeen[name] || 0;
        sdlSeen[name] = index + 1;
        out.push({ pad: p, kind: 'sdl', index, name, label: name + (index ? ` ${index + 1}` : ''), sub: `Dolphin sees it as "${name}"` });
      }
    }
    return out;
  }

  function sameDevice(dev, c) {
    if (!dev || dev.kind !== c.kind) return false;
    if (c.kind === 'adapter') return true;
    return (dev.index | 0) === c.index && (c.kind === 'xinput' || dev.name === c.name);
  }

  function bindingActive(bd, pads, keys) {
    if (!bd) return false;
    if (bd.t === 'key') return keys.has(bd.code);
    for (const p of pads) {
      if (bd.t === 'btn' && (p.buttons[bd.i] || 0) > 0.5) return true;
      if (bd.t === 'axis' && (p.axes[bd.i] || 0) * bd.d > 0.5) return true;
    }
    return false;
  }

  class ControlsEditor {
    constructor(container, opts) {
      this.el = container;
      this.opts = opts;           // { getSettings, save, toast, platform, system, lockSystem }
      this.system = opts.system || 'n64';
      this.listening = null;
      this.keys = new Set();
      this.raf = 0;
      this.mounted = false;
      this._onKeyDown = this.onKeyDown.bind(this);
      this._onKeyUp = this.onKeyUp.bind(this);
      this._onClick = this.onClick.bind(this);
      this._onChange = this.onChange.bind(this);
    }

    get cfg() {
      return this.opts.getSettings().controls[this.system];
    }

    get mode() {
      return this.cfg.mode === 'gamepad' ? 'gamepad' : 'keyboard';
    }

    get map() {
      return IM.resolve(this.system, this.mode, this.cfg[this.mode]);
    }

    mount(system) {
      if (system) this.system = system;
      if (!this.mounted) {
        window.addEventListener('keydown', this._onKeyDown, true);
        window.addEventListener('keyup', this._onKeyUp, true);
        this.el.addEventListener('click', this._onClick);
        this.el.addEventListener('change', this._onChange);
        this.mounted = true;
        this.loop();
      }
      this.render();
    }

    unmount() {
      if (!this.mounted) return;
      window.removeEventListener('keydown', this._onKeyDown, true);
      window.removeEventListener('keyup', this._onKeyUp, true);
      this.el.removeEventListener('click', this._onClick);
      this.el.removeEventListener('change', this._onChange);
      cancelAnimationFrame(this.raf);
      this.mounted = false;
      this.listening = null;
    }

    async saveMap(map) {
      const sys = this.system;
      const patch = { controls: { [sys]: { mode: this.mode, [this.mode]: map } } };
      await this.opts.save(patch);
    }

    render() {
      const sys = this.system;
      const mode = this.mode;
      const map = this.map;
      const conflicts = IM.conflicts(sys, map);
      const conflictIds = new Set(conflicts.flatMap((c) => [c.id, c.other]));
      const groups = [];
      for (const c of IM.CONTROLS[sys]) {
        let g = groups.find((x) => x.name === c.group);
        if (!g) groups.push((g = { name: c.group, items: [] }));
        g.items.push(c);
      }
      const platform = this.opts.platform;
      const dev = this.cfg.device || {};
      const pads = readPads();
      // GameCube in controller mode with nothing picked yet: use the first connected controller
      if (sys === 'gc' && mode === 'gamepad' && !dev.chosen && !this.cfg.useDolphin && pads.length && !this.autoPicking) {
        const c = padCandidates(pads, platform)[0];
        this.autoPicking = true;
        this.opts.save({ controls: { gc: { device: { kind: c.kind, index: c.index, name: c.name, chosen: true } } } })
          .then(() => { this.autoPicking = false; this.render(); });
      }

      this.el.innerHTML = `
        <div class="view-head">
          <div>
            <h1>Controls</h1>
            <div class="sub">Click a control, then press the key or button you want. Esc cancels, Backspace clears.</div>
          </div>
          <div class="spacer"></div>
          ${this.opts.lockSystem ? '' : `
          <div class="seg" role="tablist">
            <button data-act="system" data-v="n64" class="${sys === 'n64' ? 'active' : ''}">N64</button>
            <button data-act="system" data-v="gc" class="${sys === 'gc' ? 'active' : ''}">GameCube</button>
          </div>`}
          <div class="seg">
            <button data-act="mode" data-v="keyboard" class="${mode === 'keyboard' ? 'active' : ''}">Keyboard</button>
            <button data-act="mode" data-v="gamepad" class="${mode === 'gamepad' ? 'active' : ''}">Controller</button>
          </div>
        </div>
        ${sys === 'gc' && this.cfg.useDolphin ? `<div class="banner info">${ICON_INFO}<div><b>Using the controls you set in Dolphin</b> (${esc(keptDeviceName(this.cfg))}). Netcade won't overwrite them. <button class="btn small" data-act="useNetcade" style="margin-left:8px">Use Netcade's controls instead</button></div></div>` : ''}
        ${conflicts.length ? `<div class="banner warn">${ICON_WARN}<div>Some controls share the same input: ${conflicts.map((c) => `${esc(label(sys, c.id))} + ${esc(label(sys, c.other))}`).join(', ')}.</div></div>` : ''}
        <div class="controls-wrap">
          ${sys === 'gc' && mode === 'gamepad' && dev.kind === 'adapter' && !this.cfg.useDolphin ? this.renderAdapterInfo() : `<div class="panel ${sys === 'gc' && this.cfg.useDolphin ? 'kept-off' : ''}">
            ${sys === 'gc' && this.cfg.useDolphin ? '<p class="hint" style="margin-top:0">Netcade\'s own layout below isn\'t used while your Dolphin controls are kept. Changing anything here switches back to it.</p>' : ''}
            ${groups.map((g) => `
              <div class="bind-group">
                <h3>${esc(g.name)}</h3>
                <div class="bind-grid">
                  ${g.items.map((c) => {
                    const bd = map[c.id];
                    const listening = this.listening && this.listening.id === c.id;
                    return `<div class="bind ${conflictIds.has(c.id) ? 'conflict' : ''}" data-bind="${c.id}">
                      <span class="lbl">${esc(c.label)}</span>
                      <button class="bind-btn ${bd ? '' : 'unbound'} ${listening ? 'listening' : ''}" data-act="listen" data-id="${c.id}">
                        ${listening ? (mode === 'keyboard' ? 'Press a key…' : 'Press / move…') : esc(IM.describeBinding(bd))}
                      </button>
                      <button class="icon-btn" title="Clear" data-act="clear" data-id="${c.id}">${ICON_X}</button>
                    </div>`;
                  }).join('')}
                </div>
              </div>`).join('')}
            <div class="row">
              <button class="btn" data-act="reset">Reset ${mode === 'keyboard' ? 'keyboard' : 'controller'} defaults</button>
              <span class="hint">Saved automatically. Applies the next time a game launches.</span>
            </div>
          </div>`}
          <div class="stack">
            ${sys === 'gc' ? this.renderPicker(pads, dev, platform, mode) : ''}
            ${mode === 'gamepad' ? this.renderPads(pads, dev, platform) : this.renderKeyboardNotes()}
          </div>
        </div>`;
    }

    renderKeyboardNotes() {
      const sys = this.system;
      return `<div class="panel">
        <h2>Keyboard tips</h2>
        <p class="muted small">Bound keys light up as you press them, so you can test your layout right here.</p>
        ${sys === 'n64' ? `<p class="muted small">In N64 games, emulator shortcuts need <b>Right Ctrl</b> held down, so your game keys never trigger them:</p>
        <ul class="muted small">
          <li><b>Right Ctrl + F</b>: fullscreen</li>
          <li><b>Right Ctrl + Esc</b>: quit</li>
          <li><b>Right Ctrl + F1</b>: RetroArch menu</li>
        </ul>` : `<p class="muted small">In GameCube games, <b>Walk modifier</b> slows the stick to half speed, which helps for precise movement on a keyboard.</p>
        <p class="muted small">Press <b>Esc</b> in Dolphin to stop the game.</p>`}
      </div>`;
    }

    renderPads(pads, dev, platform) {
      const sys = this.system;
      const padHtml = pads.length
        ? pads.map((p) => `<div class="pad" data-pad="${p.index}">
            <strong>${esc(p.id.replace(/\s*\(.*\)\s*$/, '') || 'Controller')}</strong>
            <span class="${p.standard ? 'muted' : 'warn-text'}">${p.standard ? `Controller ${p.index + 1} · standard layout` : 'Unrecognised layout: bindings may be off'}</span>
            <div class="viz">${p.buttons.slice(0, 17).map(() => '<i></i>').join('')}</div>
          </div>`).join('')
        : `<div class="pad"><strong>No controller detected</strong><span class="muted">Plug one in and press any button. Wireless controllers must be paired first.</span></div>`;

      let deviceHtml = '';
      if (sys === 'gc') {
        deviceHtml = '';
      } else {
        deviceHtml = `<div class="panel">
          <h2>How N64 controller mapping works</h2>
          <p class="muted small">RetroArch recognises most controllers automatically. Netcade then remaps buttons to the N64 layout you set here. The left stick is always the N64 analog stick; the right stick doubles as the C buttons.</p>
        </div>`;
      }
      return `<div class="panel"><h2>Connected controllers</h2><div class="pad-list">${padHtml}</div></div>${deviceHtml}`;
    }

    /** GameCube: which controller Dolphin should use for port 1. */
    renderPicker(pads, dev, platform, mode) {
      const cands = padCandidates(pads, platform);
      this.cands = cands;
      const kept = !!this.cfg.useDolphin;
      const row = (on, title, sub, act, extra = '') => `<div class="pick ${on && !kept ? 'on' : ''}">
          <div class="pick-txt"><strong>${esc(title)}</strong><span class="muted small">${esc(sub)}</span></div>
          ${on && !kept ? '<span class="tag ok">✓ In use</span>' : `<button class="btn small" data-act="${act}" ${extra}>Use this</button>`}
        </div>`;
      const rows = [
        row(mode === 'keyboard', 'Keyboard', 'Keys you set on this page', 'pickKeyboard'),
        ...cands.map((c, i) => row(mode === 'gamepad' && sameDevice(dev, c), c.label, c.sub, 'pick', `data-i="${i}"`)),
        row(mode === 'gamepad' && dev.kind === 'adapter', 'GameCube controller adapter', 'Real GameCube controllers (Nintendo or Mayflash adapter)', 'pickAdapter'),
      ];
      // a saved controller that isn't plugged in right now
      const savedMissing = mode === 'gamepad' && (dev.kind === 'xinput' || dev.kind === 'sdl') && !cands.some((c) => sameDevice(dev, c));
      return `<div class="panel">
        <h2>Controller for GameCube games</h2>
        <div class="pick-list">${rows.join('')}</div>
        ${savedMissing && !kept ? `<p class="hint">Saved choice: <b>${esc(dev.kind === 'xinput' ? `Xbox controller ${(dev.index | 0) + 1}` : dev.name || 'Controller')}</b> (not connected right now).</p>` : ''}
        ${pads.length ? '' : '<p class="hint">Controller not listed? Plug it in (or pair it) and press any button on it.</p>'}
        <details class="adv"><summary>Advanced: exact Dolphin device</summary>
          <p class="hint">Only needed if a picked controller doesn't respond in Dolphin. Easier: set it up in Dolphin → Controllers once and Netcade will offer to keep it.</p>
          ${platform === 'win32' ? `<label class="field">Dolphin backend
            <select class="input" data-field="device.kind">
              <option value="xinput" ${dev.kind === 'xinput' ? 'selected' : ''}>XInput (Xbox-style)</option>
              <option value="sdl" ${dev.kind === 'sdl' ? 'selected' : ''}>SDL (PlayStation, Switch Pro, others)</option>
            </select></label>` : ''}
          <label class="field" style="margin-top:8px">Device name (SDL)
            <input class="input" data-field="device.name" value="${esc(dev.name || '')}" placeholder="e.g. PS5 Controller"></label>
          <label class="field" style="margin-top:8px">Number
            <select class="input" data-field="device.index">${[0, 1, 2, 3].map((i) => `<option value="${i}" ${(dev.index | 0) === i ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></label>
        </details>
      </div>`;
    }

    renderAdapterInfo() {
      return `<div class="panel">
        <h2>GameCube controller adapter</h2>
        <p class="muted">Real GameCube controllers need no button mapping: Dolphin reads the adapter directly, with full analog sticks and triggers.</p>
        <ol class="muted small">
          <li>Plug your controller into <b>port 1</b> of the adapter.</li>
          <li>Mayflash adapters: set the switch to <b>Wii U</b>.</li>
          <li>Windows only, one time: the adapter needs the WinUSB driver (installed with the free Zadig tool). Dolphin's guide walks through it.</li>
        </ol>
        <div class="row"><button class="btn small" data-act="adapterGuide">Open Dolphin's adapter guide</button></div>
      </div>`;
    }

    // ---------------------------------------------------------------- events
    async onClick(e) {
      const t = e.target.closest('[data-act]');
      if (!t || !this.el.contains(t)) return;
      const act = t.dataset.act;
      if (act === 'system') {
        this.system = t.dataset.v;
        this.listening = null;
        this.render();
      } else if (act === 'mode') {
        await this.opts.save({ controls: { [this.system]: { mode: t.dataset.v } } });
        this.listening = null;
        this.render();
      } else if (act === 'listen') {
        const pads = readPads();
        this.listening = {
          id: t.dataset.id,
          at: performance.now(),
          base: pads.map((p) => ({ index: p.index, buttons: p.buttons.slice(), axes: p.axes.slice() })),
        };
        this.render();
      } else if (act === 'clear') {
        const map = this.map;
        map[t.dataset.id] = null;
        await this.saveMap(map);
        this.render();
      } else if (act === 'reset') {
        await this.saveMap(IM.resolve(this.system, this.mode, null));
        this.render();
      } else if (act === 'pick') {
        const c = (this.cands || [])[+t.dataset.i];
        if (!c) return;
        await this.opts.save({ controls: { gc: { mode: 'gamepad', device: { kind: c.kind, index: c.index, name: c.name, chosen: true } } } });
        this.opts.toast(`GameCube games will use ${c.label}.`);
        this.render();
      } else if (act === 'pickKeyboard') {
        await this.opts.save({ controls: { gc: { mode: 'keyboard' } } });
        this.render();
      } else if (act === 'pickAdapter') {
        await this.opts.save({ controls: { gc: { mode: 'gamepad', device: { kind: 'adapter', index: 0, name: '', chosen: true } } } });
        this.opts.toast('GameCube games will use your GameCube controller adapter.');
        this.render();
      } else if (act === 'useNetcade') {
        await this.opts.save({ controls: { gc: { useDolphin: false } } });
        this.render();
      } else if (act === 'adapterGuide') {
        window.netcade.openExternal(ADAPTER_GUIDE);
      }
    }

    async onChange(e) {
      const t = e.target.closest('[data-field]');
      if (!t) return;
      const [, field] = t.dataset.field.split('.');
      const value = field === 'index' ? +t.value : t.value;
      const device = { ...(this.cfg.device || {}), [field]: value, chosen: true };
      await this.opts.save({ controls: { gc: { mode: 'gamepad', device } } });
      if (field !== 'name') this.render();
    }

    async commit(bd) {
      const id = this.listening.id;
      const err = IM.validate(this.system, this.mode, id, bd);
      if (err) {
        this.opts.toast(err, 'warn');
        return;
      }
      const map = this.map;
      map[id] = bd;
      this.listening = null;
      await this.saveMap(map);
      this.render();
    }

    onKeyDown(e) {
      if (!this.el.isConnected || !this.el.offsetParent) return;
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
      if (!this.listening) {
        if (!typing) this.keys.add(e.code);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        this.listening = null;
        this.render();
        return;
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        const map = this.map;
        map[this.listening.id] = null;
        this.listening = null;
        this.saveMap(map).then(() => this.render());
        return;
      }
      if (this.mode === 'keyboard') this.commit({ t: 'key', code: e.code });
    }

    onKeyUp(e) {
      this.keys.delete(e.code);
    }

    loop() {
      this.raf = requestAnimationFrame(() => this.loop());
      if (!this.el.offsetParent) return;
      const pads = readPads();

      // capture a controller input
      if (this.listening && this.mode === 'gamepad') {
        if (performance.now() - this.listening.at > 10000) {
          this.listening = null;
          this.render();
          return;
        }
        for (const p of pads) {
          const base = this.listening.base.find((b) => b.index === p.index) || { buttons: [], axes: [] };
          for (let i = 0; i < p.buttons.length && i < 17; i++) {
            if (p.buttons[i] > 0.6 && !((base.buttons[i] || 0) > 0.6)) {
              this.commit({ t: 'btn', i });
              return;
            }
          }
          for (let i = 0; i < p.axes.length && i < 4; i++) {
            const v = p.axes[i];
            if (Math.abs(v) > 0.65 && Math.abs(v - (base.axes[i] || 0)) > 0.5) {
              this.commit({ t: 'axis', i, d: v > 0 ? 1 : -1 });
              return;
            }
          }
        }
      }

      // live highlight of bound inputs
      const map = this.map;
      for (const el of this.el.querySelectorAll('[data-bind]')) {
        el.classList.toggle('live', bindingActive(map[el.dataset.bind], pads, this.keys));
      }
      for (const el of this.el.querySelectorAll('[data-pad]')) {
        const p = pads.find((x) => x.index === +el.dataset.pad);
        if (!p) continue;
        el.querySelectorAll('.viz i').forEach((dot, i) => dot.classList.toggle('on', (p.buttons[i] || 0) > 0.5));
      }
      // re-render when a controller is plugged in or out
      const sig = pads.map((p) => p.index + p.id).join('|');
      if (this.mode === 'gamepad' && sig !== this.padSig) {
        this.padSig = sig;
        if (!this.listening) this.render();
      }
    }
  }

  function keptDeviceName(cfg) {
    const p = cfg.dolphinPad || {};
    if (p.siDevice === 12) return 'GameCube controller adapter';
    const m = /^([^/]+)\/(\d+)\/(.+)$/.exec(p.section?.Device || '');
    if (!m) return 'custom setup';
    if (m[1] === 'XInput') return `Xbox controller ${+m[2] + 1}`;
    if (/keyboard/i.test(m[3]) || m[1] === 'Quartz' || m[1] === 'XInput2') return 'keyboard';
    return m[3];
  }

  function label(sys, id) {
    return (IM.CONTROLS[sys].find((c) => c.id === id) || {}).label || id;
  }

  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>';

  window.ControlsEditor = ControlsEditor;
})();
