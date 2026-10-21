'use strict';
const express = require('express');
const { authenticate, createSession, clientIp, requireSession, findUserByName } = require('../auth');
const { hashPassword, verifyPassword, totp } = require('../crypto');
const P = require('../policy');

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role,
  };
}

function clip(v, n = 2048) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

module.exports = function clientRoutes(ctx) {
  const { store, audit, vault, hub, limiter, info } = ctx;
  const r = express.Router();
  const recentFills = new Map();

  r.get('/info', (req, res) => {
    res.json({
      name: store.data.settings.orgName,
      loginBanner: store.data.settings.loginBanner,
      version: info.version,
      fingerprint: info.fingerprint,
    });
  });

  r.post('/auth/login', (req, res) => {
    const { username, password, device } = req.body || {};
    const kind = req.body && req.body.kind === 'console' ? 'console' : 'browser';
    const ip = clientIp(req);
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    if (limiter.isLocked(ip, username)) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    const user = authenticate(store, username, password);
    if (!user) {
      limiter.fail(ip, username);
      const known = findUserByName(store, username);
      audit.add({ type: 'login.failed', userId: known ? known.id : null, username: String(username).slice(0, 80), ip, detail: kind });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    if (kind === 'console' && user.role !== 'admin') {
      return res.status(403).json({ error: 'Only administrators can open the admin console' });
    }
    limiter.reset(ip, username);
    const { token, session } = createSession(store, user, { kind, device, ip });
    store.update('users', user.id, { lastLoginAt: new Date().toISOString() });
    audit.add({ type: 'login', userId: user.id, username: user.username, ip, detail: `${kind} ${session.device}`.trim() });
    res.json({ token, user: publicUser(user), mustChangePassword: !!user.mustChangePassword });
  });

  const anySession = requireSession(store);
  r.post('/auth/logout', anySession, (req, res) => {
    hub.disconnect(req.session.id);
    store.remove('sessions', req.session.id);
    audit.add({ type: 'logout', userId: req.user.id, username: req.user.username, ip: clientIp(req) });
    res.json({ ok: true });
  });

  r.post('/auth/password', anySession, (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(current || '', req.user.passwordHash)) return res.status(400).json({ error: 'Current password is wrong' });
    if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    store.update('users', req.user.id, { passwordHash: hashPassword(next), mustChangePassword: false });
    audit.add({ type: 'password.changed', userId: req.user.id, username: req.user.username });
    res.json({ ok: true });
  });

  const browser = requireSession(store, { kind: 'browser' });

  r.get('/client/bootstrap', browser, (req, res) => {
    const u = req.user;
    res.json({
      user: publicUser(u),
      orgName: store.data.settings.orgName,
      policy: P.effectivePolicy(store, u),
      settings: P.effectiveSettings(store, u),
      bookmarks: P.effectiveBookmarks(store, u),
      credentials: P.credentialsForUser(store, u).map((x) => P.publicCredential(x.credential, x.priority)),
    });
  });

  // Returns the secret for one assigned credential, only for a URL it matches.
  r.post('/client/fill', browser, (req, res) => {
    const { credentialId, url } = req.body || {};
    const c = P.credentialAllowedForUser(store, req.user, credentialId, url);
    if (!c) return res.status(404).json({ error: 'No credential available for this site' });
    const key = `${req.user.id}|${c.id}`;
    const last = recentFills.get(key) || 0;
    if (Date.now() - last > 60000) {
      recentFills.set(key, Date.now());
      audit.add({ type: 'credential.fill', userId: req.user.id, username: req.user.username, url: clip(url), detail: c.name });
    }
    let code = '';
    if (c.totpEnc) {
      try {
        code = totp(vault.decrypt(c.totpEnc));
      } catch {
        code = '';
      }
    }
    res.json({
      username: vault.decrypt(c.usernameEnc || ''),
      password: vault.decrypt(c.passwordEnc || ''),
      totp: code,
      usernameSelector: c.usernameSelector || '',
      passwordSelector: c.passwordSelector || '',
      totpSelector: c.totpSelector || '',
      submitSelector: c.submitSelector || '',
      autoSubmit: !!c.autoSubmit,
    });
  });

  const ACTIVITY_TYPES = new Set(['visit', 'blocked', 'access.request', 'download', 'download.blocked', 'error']);
  r.post('/client/activity', browser, (req, res) => {
    const { events = [], current } = req.body || {};
    const settings = P.effectiveSettings(store, req.user);
    for (const e of events.slice(0, 200)) {
      if (!e || !ACTIVITY_TYPES.has(e.type)) continue;
      if (e.type === 'visit' && !settings.logActivity) continue;
      audit.add({
        type: e.type,
        userId: req.user.id,
        username: req.user.username,
        ip: clientIp(req),
        url: clip(e.url),
        title: clip(e.title, 300),
        detail: clip(e.detail, 500),
      });
    }
    if (current && typeof current === 'object') {
      req.session.currentUrl = settings.logActivity ? clip(current.url) : '';
      req.session.currentTitle = settings.logActivity ? clip(current.title, 300) : '';
      req.session.tabCount = Number(current.tabCount) || 0;
      req.session.appVersion = clip(current.appVersion, 40);
      req.session.platform = clip(current.platform, 40);
    }
    res.json({ ok: true });
  });

  r.get('/client/events', browser, (req, res) => {
    hub.attach(req.session, res);
  });

  return r;
};

module.exports.publicUser = publicUser;
