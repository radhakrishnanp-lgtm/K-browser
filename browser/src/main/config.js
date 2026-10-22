'use strict';
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// managed.json lets an administrator pre-configure (and lock) the server for
// every computer. Searched in this order; the first one found wins.
function managedConfigPaths() {
  const list = [];
  if (process.env.KB_MANAGED_CONFIG) list.push(process.env.KB_MANAGED_CONFIG);
  if (process.platform === 'win32') {
    list.push(path.join(process.env.ProgramData || 'C:\\ProgramData', 'KBrowser', 'managed.json'));
  } else {
    list.push('/etc/kbrowser/managed.json');
  }
  list.push(path.join(path.dirname(process.execPath), 'managed.json'));
  return list;
}

function loadManaged() {
  for (const p of managedConfigPaths()) {
    try {
      if (fs.existsSync(p)) {
        const m = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { serverUrl: m.serverUrl || '', fingerprint: (m.fingerprint || '').toUpperCase(), lockServer: m.lockServer !== false, source: p };
      }
    } catch (err) {
      console.error(`Cannot read ${p}: ${err.message}`);
    }
  }
  return null;
}

class LocalConfig {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'kbrowser.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  // The session token is encrypted with the OS keystore when one is available
  // (DPAPI on Windows, libsecret/kwallet on Linux).
  setToken(token) {
    if (!token) return this.set({ token: null });
    if (safeStorage.isEncryptionAvailable()) {
      this.set({ token: 'enc:' + safeStorage.encryptString(token).toString('base64') });
    } else {
      this.set({ token: 'raw:' + token });
    }
  }

  getToken() {
    const t = this.data.token;
    if (!t) return null;
    try {
      if (t.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(t.slice(4), 'base64'));
      if (t.startsWith('raw:')) return t.slice(4);
    } catch {
      return null;
    }
    return null;
  }
}

module.exports = { LocalConfig, loadManaged };
