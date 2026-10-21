'use strict';
const express = require('express');
const { requireSession, clientIp } = require('../auth');
const { hashPassword, randomPassword, base32Decode } = require('../crypto');
const { evaluateUrl } = require('../match');
const { OVERRIDABLE_SETTINGS, DEFAULT_SETTINGS } = require('../store');
const P = require('../policy');

class BadRequest extends Error {}

function str(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function bool(v, dflt) {
  return typeof v === 'boolean' ? v : dflt;
}

function list(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  return [];
}

function cleanRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter((r) => r && str(r.pattern))
    .map((r) => ({
      pattern: str(r.pattern, 1000),
      action: r.action === 'allow' ? 'allow' : 'block',
      note: str(r.note, 200),
      enabled: r.enabled !== false,
    }));
}

function cleanPolicy(p, allowInherit) {
  const modes = allowInherit ? ['inherit', 'blocklist', 'allowlist'] : ['blocklist', 'allowlist'];
  const mode = p && modes.includes(p.mode) ? p.mode : modes[0];
  return { mode, rules: cleanRules(p && p.rules) };
}

function cleanBookmarks(b) {
  if (!Array.isArray(b)) return [];
  return b.filter((x) => x && str(x.url)).map((x) => ({ title: str(x.title, 120), url: str(x.url, 2000) }));
}

function cleanOverrides(s) {
  const out = {};
  if (!s || typeof s !== 'object') return out;
  for (const key of OVERRIDABLE_SETTINGS) {
    const v = s[key];
    if (v === undefined || v === null || v === '') continue;
    const type = typeof DEFAULT_SETTINGS[key];
    if (type === 'boolean' && typeof v === 'boolean') out[key] = v;
    if (type === 'number' && Number.isFinite(Number(v))) out[key] = Number(v);
    if (type === 'string' && typeof v === 'string') out[key] = v.trim();
  }
  return out;
}

module.exports = function adminRoutes(ctx) {
  const { store, audit, vault, hub, info } = ctx;
  const r = express.Router();
  r.use(requireSession(store, { admin: true }));

  const log = (req, type, detail) =>
    audit.add({ type: `admin.${type}`, userId: req.user.id, username: req.user.username, ip: clientIp(req), detail });

  // Tell affected browsers to re-download their policy.
  const notifyAll = () => hub.broadcast('refresh', {});
  const notifyUser = (id) => hub.sendToUser(id, 'refresh', {});

  const userView = (u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName || '',
    email: u.email || '',
    role: u.role,
    enabled: u.enabled !== false,
    groupIds: u.groupIds || [],
    policy: u.policy || { mode: 'inherit', rules: [] },
    settings: u.settings || {},
    bookmarks: u.bookmarks || [],
    mustChangePassword: !!u.mustChangePassword,
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt,
    online: store.data.sessions.some((s) => s.userId === u.id && hub.isOnline(s.id)),
  });

  const credView = (c) => ({
    id: c.id,
    name: c.name,
    match: c.match || [],
    loginUrl: c.loginUrl || '',
    username: vault.decrypt(c.usernameEnc || ''),
    hasPassword: !!c.passwordEnc,
    hasTotp: !!c.totpEnc,
    usernameSelector: c.usernameSelector || '',
    passwordSelector: c.passwordSelector || '',
    totpSelector: c.totpSelector || '',
    submitSelector: c.submitSelector || '',
    autoFill: c.autoFill !== false,
    autoSubmit: !!c.autoSubmit,
    showOnNewTab: c.showOnNewTab !== false,
    everyone: !!c.everyone,
    enabled: c.enabled !== false,
    assignedUserIds: c.assignedUserIds || [],
    assignedGroupIds: c.assignedGroupIds || [],
    notes: c.notes || '',
    updatedAt: c.updatedAt,
  });

  // ---- dashboard -------------------------------------------------------
  r.get('/overview', (req, res) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const day = audit.query({ since, limit: 100000 });
    const count = (t) => day.filter((e) => e.type === t).length;
    const topSites = {};
    for (const e of day) {
      if (e.type !== 'visit' || !e.url) continue;
      try {
        const h = new URL(e.url).hostname;
        topSites[h] = (topSites[h] || 0) + 1;
      } catch {
        // ignore
      }
    }
    res.json({
      orgName: store.data.settings.orgName,
      users: store.data.users.length,
      groups: store.data.groups.length,
      credentials: store.data.credentials.length,
      online: store.data.sessions.filter((s) => hub.isOnline(s.id)).length,
      last24h: {
        visits: count('visit'),
        blocked: count('blocked'),
        fills: count('credential.fill'),
        failedLogins: count('login.failed'),
        downloads: count('download'),
      },
      topSites: Object.entries(topSites)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([host, visits]) => ({ host, visits })),
      recent: audit.query({ limit: 15 }),
      server: info,
    });
  });

  // ---- users -----------------------------------------------------------
  r.get('/users', (req, res) => res.json(store.data.users.map(userView)));

  const applyUser = (body, existing) => {
    const patch = {};
    if (!existing || body.username !== undefined) {
      const username = str(body.username, 64);
      if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) throw new BadRequest('Username must be 2-64 characters: letters, digits, . _ @ -');
      const clash = store.data.users.find((u) => u.username.toLowerCase() === username.toLowerCase() && (!existing || u.id !== existing.id));
      if (clash) throw new BadRequest('That username already exists');
      patch.username = username;
    }
    if (body.displayName !== undefined) patch.displayName = str(body.displayName, 120);
    if (body.email !== undefined) patch.email = str(body.email, 200);
    if (body.role !== undefined) patch.role = body.role === 'admin' ? 'admin' : 'user';
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.groupIds !== undefined) patch.groupIds = list(body.groupIds).filter((id) => store.get('groups', id));
    if (body.policy !== undefined) patch.policy = cleanPolicy(body.policy, true);
    if (body.settings !== undefined) patch.settings = cleanOverrides(body.settings);
    if (body.bookmarks !== undefined) patch.bookmarks = cleanBookmarks(body.bookmarks);
    if (body.mustChangePassword !== undefined) patch.mustChangePassword = !!body.mustChangePassword;
    if (body.password) {
      if (String(body.password).length < 6) throw new BadRequest('Password must be at least 6 characters');
      patch.passwordHash = hashPassword(body.password);
    }
    return patch;
  };

  r.post('/users', (req, res) => {
    const body = req.body || {};
    const generated = body.password ? null : randomPassword(12);
    const patch = applyUser({ ...body, password: body.password || generated });
    const user = store.insert('users', {
      role: 'user',
      enabled: true,
      groupIds: [],
      policy: { mode: 'inherit', rules: [] },
      settings: {},
      bookmarks: [],
      ...patch,
    });
    log(req, 'user.create', user.username);
    res.status(201).json({ ...userView(user), generatedPassword: generated });
  });

  r.put('/users/:id', (req, res) => {
    const user = store.get('users', req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const patch = applyUser(req.body || {}, user);
    if (user.id === req.user.id && (patch.role === 'user' || patch.enabled === false)) {
      throw new BadRequest('You cannot remove your own administrator access');
    }
    store.update('users', user.id, patch);
    if (patch.enabled === false) {
      for (const s of store.data.sessions.filter((s) => s.userId === user.id)) {
        hub.send(s.id, 'logout', { reason: 'Your account was disabled' });
        hub.disconnect(s.id);
      }
      store.data.sessions = store.data.sessions.filter((s) => s.userId !== user.id);
      store.save();
    } else {
      notifyUser(user.id);
    }
    log(req, 'user.update', user.username);
    res.json(userView(user));
  });

  r.post('/users/:id/reset-password', (req, res) => {
    const user = store.get('users', req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const password = str((req.body || {}).password, 200) || randomPassword(12);
    store.update('users', user.id, { passwordHash: hashPassword(password), mustChangePassword: !!(req.body || {}).mustChangePassword });
    log(req, 'user.reset-password', user.username);
    res.json({ password });
  });

  r.delete('/users/:id', (req, res) => {
    const user = store.get('users', req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.id === req.user.id) throw new BadRequest('You cannot delete yourself');
    for (const s of store.data.sessions.filter((s) => s.userId === user.id)) {
      hub.send(s.id, 'logout', { reason: 'Your account was removed' });
      hub.disconnect(s.id);
    }
    store.data.sessions = store.data.sessions.filter((s) => s.userId !== user.id);
    for (const c of store.data.credentials) c.assignedUserIds = (c.assignedUserIds || []).filter((id) => id !== user.id);
    store.remove('users', user.id);
    log(req, 'user.delete', user.username);
    res.json({ ok: true });
  });

  r.get('/users/:id/effective', (req, res) => {
    const user = store.get('users', req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      policy: P.effectivePolicy(store, user),
      settings: P.effectiveSettings(store, user),
      bookmarks: P.effectiveBookmarks(store, user),
      credentials: P.credentialsForUser(store, user).map((x) => P.publicCredential(x.credential, x.priority)),
    });
  });

  // ---- groups ----------------------------------------------------------
  r.get('/groups', (req, res) =>
    res.json(store.data.groups.map((g) => ({ ...g, memberCount: store.data.users.filter((u) => (u.groupIds || []).includes(g.id)).length })))
  );

  const applyGroup = (body) => {
    const patch = {};
    if (body.name !== undefined) {
      patch.name = str(body.name, 80);
      if (!patch.name) throw new BadRequest('Group name is required');
    }
    if (body.description !== undefined) patch.description = str(body.description, 300);
    if (body.policy !== undefined) patch.policy = cleanPolicy(body.policy, true);
    if (body.settings !== undefined) patch.settings = cleanOverrides(body.settings);
    if (body.bookmarks !== undefined) patch.bookmarks = cleanBookmarks(body.bookmarks);
    return patch;
  };

  r.post('/groups', (req, res) => {
    const patch = applyGroup({ name: '', ...req.body });
    const group = store.insert('groups', { policy: { mode: 'inherit', rules: [] }, settings: {}, bookmarks: [], ...patch });
    if (Array.isArray(req.body.memberIds)) setMembers(group.id, req.body.memberIds);
    log(req, 'group.create', group.name);
    notifyAll();
    res.status(201).json(group);
  });

  const setMembers = (groupId, memberIds) => {
    const want = new Set(list(memberIds));
    for (const u of store.data.users) {
      const has = (u.groupIds || []).includes(groupId);
      if (want.has(u.id) && !has) u.groupIds = [...(u.groupIds || []), groupId];
      if (!want.has(u.id) && has) u.groupIds = u.groupIds.filter((g) => g !== groupId);
    }
    store.save();
  };

  r.put('/groups/:id', (req, res) => {
    const group = store.get('groups', req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    store.update('groups', group.id, applyGroup(req.body || {}));
    if (Array.isArray((req.body || {}).memberIds)) setMembers(group.id, req.body.memberIds);
    log(req, 'group.update', group.name);
    notifyAll();
    res.json(group);
  });

  r.delete('/groups/:id', (req, res) => {
    const group = store.get('groups', req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    for (const u of store.data.users) u.groupIds = (u.groupIds || []).filter((g) => g !== group.id);
    for (const c of store.data.credentials) c.assignedGroupIds = (c.assignedGroupIds || []).filter((g) => g !== group.id);
    store.remove('groups', group.id);
    log(req, 'group.delete', group.name);
    notifyAll();
    res.json({ ok: true });
  });

  // ---- credentials (site logins) ---------------------------------------
  r.get('/credentials', (req, res) => res.json(store.data.credentials.map(credView)));

  const applyCredential = (body, existing) => {
    const patch = {};
    if (!existing || body.name !== undefined) {
      patch.name = str(body.name, 120);
      if (!patch.name) throw new BadRequest('Name is required');
    }
    if (!existing || body.match !== undefined) {
      patch.match = list(body.match);
      if (!patch.match.length && body.loginUrl) {
        try {
          patch.match = [new URL(body.loginUrl).hostname.replace(/^www\./, '')];
        } catch {
          // fall through to validation below
        }
      }
      if (!patch.match.length) throw new BadRequest('At least one website pattern is required');
    }
    if (body.loginUrl !== undefined) patch.loginUrl = str(body.loginUrl, 2000);
    if (body.username !== undefined) patch.usernameEnc = vault.encrypt(str(body.username, 500));
    if (body.password) patch.passwordEnc = vault.encrypt(String(body.password));
    if (body.clearPassword) patch.passwordEnc = '';
    if (body.totpSecret) {
      try {
        base32Decode(body.totpSecret);
      } catch {
        throw new BadRequest('2FA secret must be a base32 key (as shown when setting up an authenticator app)');
      }
      patch.totpEnc = vault.encrypt(String(body.totpSecret).replace(/\s/g, ''));
    }
    if (body.clearTotp) patch.totpEnc = '';
    for (const k of ['usernameSelector', 'passwordSelector', 'totpSelector', 'submitSelector', 'notes']) {
      if (body[k] !== undefined) patch[k] = str(body[k], 1000);
    }
    for (const [k, d] of [['autoFill', true], ['autoSubmit', false], ['showOnNewTab', true], ['everyone', false], ['enabled', true]]) {
      if (body[k] !== undefined || !existing) patch[k] = bool(body[k], existing ? existing[k] : d);
    }
    if (body.assignedUserIds !== undefined) patch.assignedUserIds = list(body.assignedUserIds).filter((id) => store.get('users', id));
    if (body.assignedGroupIds !== undefined) patch.assignedGroupIds = list(body.assignedGroupIds).filter((id) => store.get('groups', id));
    return patch;
  };

  r.post('/credentials', (req, res) => {
    const c = store.insert('credentials', { assignedUserIds: [], assignedGroupIds: [], ...applyCredential(req.body || {}) });
    log(req, 'credential.create', c.name);
    notifyAll();
    res.status(201).json(credView(c));
  });

  r.put('/credentials/:id', (req, res) => {
    const c = store.get('credentials', req.params.id);
    if (!c) return res.status(404).json({ error: 'Credential not found' });
    store.update('credentials', c.id, applyCredential(req.body || {}, c));
    log(req, 'credential.update', c.name);
    notifyAll();
    res.json(credView(c));
  });

  r.delete('/credentials/:id', (req, res) => {
    const c = store.get('credentials', req.params.id);
    if (!c) return res.status(404).json({ error: 'Credential not found' });
    store.remove('credentials', c.id);
    log(req, 'credential.delete', c.name);
    notifyAll();
    res.json({ ok: true });
  });

  // ---- global policy, bookmarks, settings -------------------------------
  r.get('/policy', (req, res) => res.json(store.data.policy));
  r.put('/policy', (req, res) => {
    store.data.policy = cleanPolicy(req.body, false);
    store.save();
    log(req, 'policy.update', `${store.data.policy.mode}, ${store.data.policy.rules.length} rules`);
    notifyAll();
    res.json(store.data.policy);
  });

  r.post('/policy/test', (req, res) => {
    const { url, userId } = req.body || {};
    const user = userId ? store.get('users', userId) : null;
    const policy = user ? P.effectivePolicy(store, user) : store.data.policy;
    res.json(evaluateUrl(str(url, 2000), policy));
  });

  r.get('/bookmarks', (req, res) => res.json(store.data.bookmarks));
  r.put('/bookmarks', (req, res) => {
    store.data.bookmarks = cleanBookmarks(req.body);
    store.save();
    log(req, 'bookmarks.update', `${store.data.bookmarks.length} bookmarks`);
    notifyAll();
    res.json(store.data.bookmarks);
  });

  r.get('/settings', (req, res) => res.json(store.data.settings));
  r.put('/settings', (req, res) => {
    const body = req.body || {};
    const s = store.data.settings;
    for (const [key, dflt] of Object.entries(DEFAULT_SETTINGS)) {
      if (body[key] === undefined) continue;
      if (typeof dflt === 'boolean') s[key] = !!body[key];
      else if (typeof dflt === 'number') s[key] = Math.max(0, Number(body[key]) || 0);
      else if (Array.isArray(dflt)) s[key] = list(body[key]).map((x) => x.replace(/^\./, '').toLowerCase());
      else s[key] = str(String(body[key]), 2000);
    }
    store.save();
    log(req, 'settings.update', Object.keys(body).join(', '));
    notifyAll();
    res.json(s);
  });

  // ---- live sessions & remote control -----------------------------------
  r.get('/sessions', (req, res) => {
    res.json(
      store.data.sessions
        .map((s) => {
          const u = store.get('users', s.userId);
          return {
            id: s.id,
            userId: s.userId,
            username: u ? u.username : '(deleted)',
            displayName: u ? u.displayName || u.username : '',
            kind: s.kind,
            device: s.device,
            ip: s.ip,
            createdAt: s.createdAt,
            lastSeen: s.lastSeen,
            online: hub.isOnline(s.id),
            currentUrl: s.currentUrl || '',
            currentTitle: s.currentTitle || '',
            tabCount: s.tabCount || 0,
            appVersion: s.appVersion || '',
            platform: s.platform || '',
          };
        })
        .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen.localeCompare(a.lastSeen))
    );
  });

  r.post('/sessions/:id/logout', (req, res) => {
    const s = store.get('sessions', req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    hub.send(s.id, 'logout', { reason: str((req.body || {}).reason) || 'Signed out by administrator' });
    hub.disconnect(s.id);
    store.remove('sessions', s.id);
    const u = store.get('users', s.userId);
    log(req, 'session.logout', u ? u.username : s.userId);
    res.json({ ok: true });
  });

  // Commands: message, open-url, close-all-tabs, refresh, clear-data
  r.post('/command', (req, res) => {
    const { target = 'all', sessionId, userId, command, text, url, level } = req.body || {};
    const allowed = ['message', 'open-url', 'close-tabs', 'refresh', 'clear-data'];
    if (!allowed.includes(command)) throw new BadRequest('Unknown command');
    const payload = { text: str(text, 2000), url: str(url, 2000), level: ['info', 'warning', 'critical'].includes(level) ? level : 'info', from: req.user.displayName || req.user.username };
    if (command === 'open-url' && !/^https?:\/\//i.test(payload.url)) throw new BadRequest('URL must start with http:// or https://');
    let delivered = 0;
    if (target === 'session' && sessionId) delivered = hub.send(sessionId, command, payload) ? 1 : 0;
    else if (target === 'user' && userId) delivered = hub.sendToUser(userId, command, payload);
    else delivered = hub.broadcast(command, payload);
    log(req, `command.${command}`, `${target} ${payload.text || payload.url}`.trim());
    res.json({ delivered });
  });

  // ---- audit log ---------------------------------------------------------
  r.get('/audit', (req, res) => {
    const { userId, type, q, since, until } = req.query;
    const limit = Math.min(Number(req.query.limit) || 500, 20000);
    res.json(audit.query({ userId, type, q, since, until, limit }));
  });

  r.get('/audit.csv', (req, res) => {
    const { userId, type, q, since, until } = req.query;
    const rows = audit.query({ userId, type, q, since, until, limit: 100000 });
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = ['time,type,user,ip,url,title,detail'];
    for (const e of rows) lines.push([e.ts, e.type, e.username, e.ip, e.url, e.title, e.detail].map(esc).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="kbrowser-activity.csv"');
    res.send(lines.join('\n'));
  });

  // ---- backup ------------------------------------------------------------
  // Secrets stay encrypted in the export; it can only be restored with the same vault key.
  r.get('/backup', (req, res) => {
    log(req, 'backup.export', '');
    res.setHeader('Content-Disposition', `attachment; filename="kbrowser-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ ...store.data, sessions: [] });
  });

  r.use((err, req, res, next) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    next(err);
  });

  return r;
};
