'use strict';
const express = require('express');
const { authenticate, createSession, clientIp, requireSession, findUserByName } = require('../auth');
const { hashPassword, verifyPassword, totp, verifyTotp, base32Encode } = require('../crypto');
const { CONSOLE_ROLES, can } = require('../rbac');
const { credentialMatches } = require('../match');
const P = require('../policy');
const crypto = require('crypto');

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    role: u.role,
    twoFactor: !!u.totpEnabled,
  };
}

function clip(v, n = 2048) {
  return typeof v === 'string' ? v.slice(0, n) : '';
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const SAME_SITE = ['unspecified', 'no_restriction', 'lax', 'strict'];

// Normalises cookies captured from an administrator's browser.
function cleanCookies(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string')
    .slice(0, 300)
    .map((c) => ({
      name: c.name.slice(0, 4096),
      value: c.value.slice(0, 8192),
      domain: c.domain.slice(0, 255),
      path: typeof c.path === 'string' ? c.path.slice(0, 1024) : '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: SAME_SITE.includes(c.sameSite) ? c.sameSite : 'unspecified',
      expirationDate: Number.isFinite(c.expirationDate) ? c.expirationDate : undefined,
    }));
}

module.exports = function clientRoutes(ctx) {
  const { store, audit, vault, hub, limiter, info, seats } = ctx;
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
    const { username, password, device, otp } = req.body || {};
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
    if (kind === 'console' && !CONSOLE_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Only administrators can open the admin console' });
    }
    if (user.totpEnabled) {
      if (!otp) return res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app', needOtp: true });
      if (!verifyTotp(vault.decrypt(user.totpEnc), otp)) {
        limiter.fail(ip, username);
        audit.add({ type: 'login.failed', userId: user.id, username: user.username, ip, detail: `${kind} wrong 2FA code` });
        return res.status(401).json({ error: 'Wrong authenticator code', needOtp: true });
      }
    }
    limiter.reset(ip, username);
    const { token, session } = createSession(store, user, { kind, device, ip });
    store.update('users', user.id, { lastLoginAt: new Date().toISOString() });
    audit.add({ type: 'login', userId: user.id, username: user.username, ip, detail: `${kind} ${session.device}`.trim() });
    res.json({
      token,
      user: publicUser(user),
      mustChangePassword: !!user.mustChangePassword,
      mustEnable2fa: kind === 'console' && !!store.data.settings.requireAdmin2fa && !user.totpEnabled,
    });
  });

  const anySession = requireSession(store);
  r.post('/auth/logout', anySession, (req, res) => {
    hub.disconnect(req.session.id);
    store.remove('sessions', req.session.id);
    if (!store.data.sessions.some((s) => s.userId === req.user.id)) seats.releaseUser(req.user.id);
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

  // ---- two-factor authentication for your own account -----------------------
  r.get('/auth/me', anySession, (req, res) => res.json({ user: publicUser(req.user), session: { kind: req.session.kind } }));

  r.post('/auth/2fa/setup', anySession, (req, res) => {
    const secret = base32Encode(crypto.randomBytes(20));
    store.update('users', req.user.id, { totpPendingEnc: vault.encrypt(secret) });
    const label = encodeURIComponent(`${store.data.settings.orgName}:${req.user.username}`);
    const issuer = encodeURIComponent(`K-Browser ${store.data.settings.orgName}`);
    res.json({ secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30` });
  });

  r.post('/auth/2fa/enable', anySession, (req, res) => {
    const pending = req.user.totpPendingEnc && vault.decrypt(req.user.totpPendingEnc);
    if (!pending) return res.status(400).json({ error: 'Start the setup first' });
    if (!verifyTotp(pending, (req.body || {}).code)) return res.status(400).json({ error: 'That code is not correct — check the time on your phone and try again' });
    store.update('users', req.user.id, { totpEnc: req.user.totpPendingEnc, totpPendingEnc: '', totpEnabled: true });
    audit.add({ type: '2fa.enabled', userId: req.user.id, username: req.user.username });
    res.json({ ok: true });
  });

  r.post('/auth/2fa/disable', anySession, (req, res) => {
    if (!verifyPassword((req.body || {}).password || '', req.user.passwordHash)) return res.status(400).json({ error: 'Password is wrong' });
    store.update('users', req.user.id, { totpEnc: '', totpPendingEnc: '', totpEnabled: false });
    audit.add({ type: '2fa.disabled', userId: req.user.id, username: req.user.username });
    res.json({ ok: true });
  });

  // ---- browser API -----------------------------------------------------------------
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
      dlp: P.dlpRulesForUser(store, u),
      serverTime: new Date().toISOString(),
    });
  });

  const seatCheck = (req, res, c) => {
    const result = seats.acquire(c, req.user);
    if (result.ok) return true;
    audit.add({ type: 'seat.denied', userId: req.user.id, username: req.user.username, url: clip(req.body.url), detail: c.name });
    res.status(409).json({
      error: `All ${c.seats} seat(s) for "${c.name}" are in use right now`,
      seats: c.seats,
      holders: result.holders.map((h) => h.username),
    });
    return false;
  };

  const usableCredential = (req, res) => {
    const { credentialId, url } = req.body || {};
    const c = P.credentialAllowedForUser(store, req.user, credentialId, url);
    if (!c) {
      res.status(404).json({ error: 'No credential available for this site' });
      return null;
    }
    return c;
  };

  // Seat check before a seat-limited site opens.
  r.post('/client/seat', browser, (req, res) => {
    const c = usableCredential(req, res);
    if (c && seatCheck(req, res, c)) res.json({ ok: true });
  });

  // Returns the secret for one assigned credential, only for a URL it matches.
  r.post('/client/fill', browser, (req, res) => {
    const c = usableCredential(req, res);
    if (!c || !seatCheck(req, res, c)) return;
    const { url } = req.body;
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

  // Shared signed-in session (cookies captured by an administrator).
  r.post('/client/session', browser, (req, res) => {
    const c = usableCredential(req, res);
    if (!c || !seatCheck(req, res, c)) return;
    if (!c.sessionEnc) return res.status(404).json({ error: 'No shared session for this site' });
    audit.add({ type: 'session.use', userId: req.user.id, username: req.user.username, url: clip(req.body.url), detail: c.name });
    res.json({ version: c.sessionCapturedAt, cookies: JSON.parse(vault.decrypt(c.sessionEnc)) });
  });

  // Administrators can share the signed-in session from their own K-Browser.
  r.post('/client/capture-session', browser, (req, res) => {
    if (!can(req.user, 'credentials:write')) return res.status(403).json({ error: 'Only administrators can share sessions' });
    const { credentialId, name, url, cookies } = req.body || {};
    const list = cleanCookies(cookies);
    if (!list.length) return res.status(400).json({ error: 'No cookies to share — sign in to the site first' });
    const host = hostOf(url);
    if (!host) return res.status(400).json({ error: 'Invalid URL' });
    let c = credentialId ? store.get('credentials', credentialId) : null;
    const patch = { sessionEnc: vault.encrypt(JSON.stringify(list)), sessionCapturedAt: new Date().toISOString(), sessionCapturedBy: req.user.username };
    if (c) {
      store.update('credentials', c.id, patch);
    } else {
      c = store.insert('credentials', {
        name: clip(name, 120) || host,
        match: [host.replace(/^www\./, '')],
        loginUrl: clip(url),
        autoFill: false,
        autoSubmit: false,
        showOnNewTab: true,
        everyone: false,
        enabled: true,
        assignedUserIds: [],
        assignedGroupIds: [],
        ...patch,
      });
    }
    audit.add({ type: 'admin.session.capture', userId: req.user.id, username: req.user.username, url: clip(url), detail: `${c.name} (${list.length} cookies)` });
    hub.broadcast('refresh', {});
    res.json({ id: c.id, name: c.name, cookies: list.length, created: !credentialId });
  });

  // Credentials an administrator may attach a captured session to.
  r.get('/client/admin/credentials', browser, (req, res) => {
    if (!can(req.user, 'credentials:write')) return res.status(403).json({ error: 'Not allowed' });
    const url = String(req.query.url || '');
    res.json(store.data.credentials.filter((c) => !url || credentialMatches(url, c)).map((c) => ({ id: c.id, name: c.name, hasSession: !!c.sessionEnc })));
  });

  r.post('/client/access-request', browser, (req, res) => {
    const url = clip((req.body || {}).url);
    const reason = clip((req.body || {}).reason, 500);
    const host = hostOf(url);
    if (!host) return res.status(400).json({ error: 'Invalid URL' });
    const open = store.data.accessRequests.find((a) => a.userId === req.user.id && a.host === host && a.status === 'pending');
    if (open) return res.json({ ok: true, id: open.id, duplicate: true });
    const row = store.insert('accessRequests', { userId: req.user.id, username: req.user.username, url, host, reason, status: 'pending' });
    if (store.data.accessRequests.length > 2000) store.data.accessRequests.splice(0, store.data.accessRequests.length - 2000);
    audit.add({ type: 'access.request', userId: req.user.id, username: req.user.username, url, detail: reason });
    res.json({ ok: true, id: row.id });
  });

  const ACTIVITY_TYPES = new Set(['visit', 'blocked', 'download', 'download.blocked', 'dlp.blocked', 'error']);
  r.post('/client/activity', browser, (req, res) => {
    const { events = [], current, usage, activeCredentials } = req.body || {};
    const settings = P.effectiveSettings(store, req.user);
    for (const e of (Array.isArray(events) ? events : []).slice(0, 200)) {
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
    // Active time per site, aggregated per day.
    if (settings.logActivity && usage && typeof usage === 'object') {
      const day = new Date().toISOString().slice(0, 10);
      const byUser = ((store.data.usage[day] = store.data.usage[day] || {})[req.user.id] = store.data.usage[day][req.user.id] || {});
      for (const [host, secs] of Object.entries(usage).slice(0, 100)) {
        const n = Math.min(Number(secs) || 0, 120);
        if (n > 0 && /^[a-z0-9.-]{1,253}(:\d+)?$/i.test(host)) byUser[host] = (byUser[host] || 0) + n;
      }
      store.save();
    }
    if (Array.isArray(activeCredentials)) {
      for (const id of activeCredentials.slice(0, 50)) {
        const c = P.credentialAllowedForUser(store, req.user, id);
        if (c) seats.renew(c.id, req.user);
      }
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
