'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SETTINGS = {
  orgName: 'My Office',
  homepage: 'kb://newtab',
  searchUrl: 'https://www.google.com/search?q=%s',
  loginBanner: '',
  logActivity: true,
  allowDownloads: true,
  blockedDownloadExtensions: ['exe', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'scr', 'sh', 'appimage', 'deb', 'rpm'],
  allowDevTools: false,
  allowPrinting: true,
  allowMedia: true,
  allowFileUrls: false,
  clearDataOnLogout: false,
  idleLogoutMinutes: 0,
  maxTabs: 0,
};

// Keys that groups and users may override.
const OVERRIDABLE_SETTINGS = [
  'homepage',
  'logActivity',
  'allowDownloads',
  'allowDevTools',
  'allowPrinting',
  'allowMedia',
  'allowFileUrls',
  'clearDataOnLogout',
  'idleLogoutMinutes',
  'maxTabs',
];

function emptyData() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    policy: { mode: 'blocklist', rules: [] },
    bookmarks: [],
    users: [],
    groups: [],
    credentials: [],
    sessions: [],
  };
}

function newId() {
  return crypto.randomUUID();
}

// Small JSON-file database. Writes are atomic (write temp file + rename) and
// debounced so frequent updates (session lastSeen etc.) stay cheap.
class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    if (fs.existsSync(file)) {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...emptyData(), ...loaded };
      this.data.settings = { ...DEFAULT_SETTINGS, ...loaded.settings };
    } else {
      this.data = emptyData();
      this.saveNow();
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.saveNow();
    }, 250);
  }

  saveNow() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(collection, id) {
    return this.data[collection].find((x) => x.id === id) || null;
  }

  insert(collection, doc) {
    const now = new Date().toISOString();
    const row = { id: newId(), createdAt: now, updatedAt: now, ...doc };
    this.data[collection].push(row);
    this.save();
    return row;
  }

  update(collection, id, patch) {
    const row = this.get(collection, id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  remove(collection, id) {
    const list = this.data[collection];
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.save();
    return true;
  }
}

// Append-only audit/activity log (JSON lines) with an in-memory window for queries.
class AuditLog {
  constructor(file, { keep = 50000, rotateBytes = 50 * 1024 * 1024 } = {}) {
    this.file = file;
    this.keep = keep;
    this.rotateBytes = rotateBytes;
    this.entries = [];
    this.listeners = new Set();
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-keep)) {
        try {
          this.entries.push(JSON.parse(line));
        } catch {
          // skip corrupt line
        }
      }
    }
  }

  add(entry) {
    const row = { id: newId(), ts: new Date().toISOString(), ...entry };
    this.entries.push(row);
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > this.rotateBytes) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(this.file, this.file.replace(/\.jsonl$/, `-${stamp}.jsonl`));
      }
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error('audit write failed:', err.message);
    }
    for (const fn of this.listeners) fn(row);
    return row;
  }

  query({ userId, type, q, since, until, limit = 500 } = {}) {
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (userId && e.userId !== userId) continue;
      if (type && !String(type).split(',').includes(e.type)) continue;
      if (since && e.ts < since) continue;
      if (until && e.ts > until) continue;
      if (q) {
        const hay = `${e.username || ''} ${e.url || ''} ${e.title || ''} ${e.detail || ''}`.toLowerCase();
        if (!hay.includes(String(q).toLowerCase())) continue;
      }
      out.push(e);
    }
    return out;
  }
}

function openStores(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    store: new Store(path.join(dataDir, 'db.json')),
    audit: new AuditLog(path.join(dataDir, 'audit.jsonl')),
  };
}

module.exports = { Store, AuditLog, openStores, DEFAULT_SETTINGS, OVERRIDABLE_SETTINGS };
