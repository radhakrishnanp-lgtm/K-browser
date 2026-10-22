'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('kb', {
  init: () => call('login:init'),
  discover: () => call('login:discover'),
  probe: (url) => call('login:probe', url),
  submit: (form) => call('login:submit', form),
  setPassword: (current, next) => call('login:set-password', current, next),
  onMessage: (cb) => ipcRenderer.on('login:message', (e, msg) => cb(msg)),
});
