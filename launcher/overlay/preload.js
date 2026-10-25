'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'chat', 'notice', 'request', 'request-closed', 'chat-open', 'chat-close'];

contextBridge.exposeInMainWorld('overlay', {
  ready: () => ipcRenderer.send('overlay:ready'),
  interactive: (on) => ipcRenderer.send('overlay:interactive', !!on),
  action: (name, payload) => ipcRenderer.send('overlay:action', String(name), payload ?? null),
  on: (channel, cb) => {
    if (!CHANNELS.includes(channel)) throw new Error('unknown channel ' + channel);
    ipcRenderer.on(`overlay:${channel}`, (_e, payload) => cb(payload));
  },
});
