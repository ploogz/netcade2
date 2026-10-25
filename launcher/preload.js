'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const EVENTS = ['cover', 'share', 'setup', 'server-status', 'lobby', 'lobby-msg', 'session', 'library', 'library-progress', 'settings',
  'emulators', 'toast', 'navigate', 'core-progress', 'controls-dolphin'];

contextBridge.exposeInMainWorld('netcade', {
  getState: () => call('state:get'),
  setSettings: (patch) => call('settings:set', patch),
  library: {
    addFolder: () => call('library:addFolder'),
    removeFolder: (f) => call('library:removeFolder', f),
    rescan: () => call('library:rescan'),
    favorite: (key) => call('library:favorite', key),
    reveal: (key) => call('library:reveal', key),
  },
  emu: {
    browse: (kind) => call('emu:browse', kind),
    detect: () => call('emu:detect'),
    installCore: () => call('emu:installCore'),
    setup: () => call('emu:setup'),
  },
  play: (key) => call('play:solo', key),
  stopSession: () => call('session:stop'),
  lobby: {
    create: (opts) => call('lobby:create', opts),
    setGame: (key) => call('lobby:setGame', key),
    send: (msg) => call('lobby:send', msg),
    joinInvite: (text) => call('lobby:joinInvite', text),
    inviteServer: () => call('lobby:inviteServer'),
    setLink: (link) => call('lobby:setLink', link),
  },
  share: { retry: () => call('share:retry') },
  controls: { keepDolphin: (keep) => call('controls:keepDolphin', keep) },
  dolphin: {
    cmd: (cmd, args) => call('dolphin:cmd', cmd, args),
    setOptions: (opts) => call('dolphin:setOptions', opts),
  },
  covers: { request: (games) => call('covers:request', games) },
  unpacked: { info: () => call('unpacked:info'), clear: () => call('unpacked:clear') },
  games: {
    link: (key) => call('games:link', key),
    rename: (key, name) => call('games:rename', key, name),
    coverFile: (key) => call('games:coverFile', key),
    coverUrl: (key, url) => call('games:coverUrl', key, url),
    coverReset: (key) => call('games:coverReset', key),
  },
  server: {
    test: (url) => call('server:test', url),
    reconnect: () => call('server:reconnect'),
  },
  openExternal: (url) => call('app:openExternal', url),
  openPath: (which) => call('app:openPath', which),
  copy: (text) => call('app:copy', text),
  on: (event, cb) => {
    if (!EVENTS.includes(event)) throw new Error('unknown event ' + event);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(event, fn);
    return () => ipcRenderer.removeListener(event, fn);
  },
});
