'use strict';
/**
 * In-game overlay: a transparent, always-on-top window over the game.
 *
 *  - Shows lobby chat, port requests and notices without taking focus from the emulator.
 *  - Mouse clicks pass through to the game except over the overlay's own panels/buttons
 *    (the page reports when the pointer is over something clickable).
 *  - The chat key (a global shortcut, registered only while a game runs) gives the overlay the
 *    keyboard so you can type; Enter/Esc hands focus back to the game.
 *
 * Needs the emulator in borderless fullscreen (Netcade configures both emulators that way):
 * nothing can draw over exclusive fullscreen.
 */
const path = require('path');
const { BrowserWindow, globalShortcut, screen, ipcMain } = require('electron');

const CHAT_KEYS = {
  Tab: 'Tab',
  T: 'T',
  Y: 'Y',
  Enter: 'Return',
  Backquote: '`',
};

class Overlay {
  constructor({ log = () => {}, onAction = () => {} }) {
    this.log = log;
    this.onAction = onAction;   // (action, payload) from the overlay page
    this.win = null;
    this.ready = false;
    this.queue = [];
    this.chatKey = 'Tab';
    this.shortcut = null;
    this.chatOpen = false;
    this.state = null;          // last full state pushed, re-sent when the page loads

    ipcMain.on('overlay:interactive', (e, on) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      this.win.setIgnoreMouseEvents(!on, { forward: true });
    });
    ipcMain.on('overlay:action', (e, action, payload) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      if (action === 'closeChat') return this.closeChat();
      if (action === 'openChat') return this.openChat();
      this.onAction(action, payload);
    });
    ipcMain.on('overlay:ready', (e) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      this.ready = true;
      if (this.state) this.send('state', this.state);
      for (const [ch, p] of this.queue) this.send(ch, p);
      this.queue = [];
    });
  }

  create(fullscreen) {
    if (this.win && !this.win.isDestroyed()) return;
    // Fullscreen game: cover the whole display, so the side columns line up with the black bars.
    // Windowed game: stay inside the work area, so the overlay's buttons stay off the taskbar.
    const d = screen.getPrimaryDisplay();
    const area = fullscreen ? d.bounds : d.workArea;
    this.ready = false;
    this.win = new BrowserWindow({
      x: area.x, y: area.y, width: area.width, height: area.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,          // clicks don't pull focus away from the game
      hasShadow: false,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'overlay', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));
    this.win.on('closed', () => { this.win = null; this.ready = false; });
  }

  /**
   * A match started: show the overlay and enable the chat key.
   * view: { fullscreen, aspect (game picture width/height), layout: 'auto'|'corners', history: [chat] }
   */
  show(session, view = {}) {
    this.create(!!view.fullscreen);
    this.win.showInactive();
    this.registerKey();
    this.push({
      session: { title: session.title, system: session.system, port: session.port, spectate: session.spectate },
      layout: { pref: view.layout || 'auto', aspect: view.aspect || 4 / 3 },
      chatKey: this.keyLabel(),
    });
    for (const m of (view.history || []).slice(-20)) this.chat(m);
    this.send('notice', { text: `${this.keyLabel()} to chat · hover the player list to swap`, kind: 'hint', ms: 6000 });
  }

  /** Layout preference changed in Settings while a game is running. */
  setLayout(pref) {
    if (this.state) this.push({ layout: { ...(this.state.layout || {}), pref } });
  }

  hide() {
    this.unregisterKey();
    this.chatOpen = false;
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
      this.win.destroy();
    }
    this.win = null;
    this.state = null;
  }

  get visible() {
    return !!(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  keyLabel() {
    return this.chatKey === 'Backquote' ? '`' : this.chatKey;
  }

  setChatKey(key) {
    const k = CHAT_KEYS[key] ? key : 'Tab';
    if (k === this.chatKey) return;
    this.chatKey = k;
    if (this.visible) { this.unregisterKey(); this.registerKey(); this.push({ chatKey: this.keyLabel() }); }
  }

  registerKey() {
    this.unregisterKey();
    const acc = CHAT_KEYS[this.chatKey];
    try {
      if (globalShortcut.register(acc, () => this.toggleChat())) {
        this.shortcut = acc;
      } else {
        this.log('overlay: chat key already taken:', acc);
        this.send('notice', { text: `The ${this.keyLabel()} key is in use by another app. Click 💬 to chat.`, kind: 'warn', ms: 8000 });
      }
    } catch (err) {
      this.log('overlay: could not register chat key', err.message);
    }
  }

  unregisterKey() {
    if (this.shortcut) {
      try { globalShortcut.unregister(this.shortcut); } catch { /* ignore */ }
      this.shortcut = null;
    }
  }

  toggleChat() {
    if (this.chatOpen) this.closeChat(); else this.openChat();
  }

  openChat() {
    if (!this.win) return;
    this.chatOpen = true;
    // the shortcut would swallow the key while typing (e.g. T or Y), so drop it until chat closes
    this.unregisterKey();
    this.win.setFocusable(true);
    this.win.setIgnoreMouseEvents(false);
    this.win.show();
    this.win.focus();
    this.send('chat-open', { key: this.keyLabel() });
  }

  closeChat() {
    if (!this.win) return;
    this.chatOpen = false;
    this.send('chat-close', {});
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.win.setFocusable(false);
    this.win.blur();             // hands the keyboard back to the game window underneath
    this.registerKey();
  }

  /** Merge into the overlay's state (lobby, me, session). */
  push(patch) {
    this.state = { ...(this.state || {}), ...patch };
    this.send('state', this.state);
  }

  send(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.ready) {
      if (channel !== 'state') this.queue.push([channel, payload]);
      return;
    }
    this.win.webContents.send(`overlay:${channel}`, payload);
  }

  chat(msg) { this.send('chat', msg); }
  notice(text, kind = 'info', ms = 5000) { this.send('notice', { text, kind, ms }); }
  request(req) { this.send('request', req); }
  requestClosed(reqId) { this.send('request-closed', { reqId }); }
}

module.exports = { Overlay, CHAT_KEYS };
