'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['state', 'tabs', 'notify', 'find-open', 'find-result', 'focus-address', 'password-open'];

contextBridge.exposeInMainWorld('kb', {
  send: (channel, ...args) => ipcRenderer.send('ui', channel, ...args),
  invoke: async (channel, ...args) => {
    const r = await ipcRenderer.invoke('ui:invoke', channel, ...args);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  on: (event, cb) => {
    if (EVENTS.includes(event)) ipcRenderer.on(event, (e, payload) => cb(payload));
  },
});
