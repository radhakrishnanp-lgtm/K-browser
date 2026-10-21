'use strict';
const { randomToken, sha256, verifyPassword } = require('./crypto');

const SESSION_TTL = {
  browser: 30 * 24 * 3600 * 1000, // idle timeout for staff browsers
  console: 12 * 3600 * 1000, // admin console sessions
};

class LoginLimiter {
  constructor({ maxAttempts = 5, windowMs = 5 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.failures = new Map();
  }

  key(ip, username) {
    return `${ip}|${String(username).toLowerCase()}`;
  }

  isLocked(ip, username) {
    const f = this.failures.get(this.key(ip, username));
    if (!f) return false;
    if (Date.now() - f.first > this.windowMs) {
      this.failures.delete(this.key(ip, username));
      return false;
    }
    return f.count >= this.maxAttempts;
  }

  fail(ip, username) {
    const k = this.key(ip, username);
    const f = this.failures.get(k);
    if (!f || Date.now() - f.first > this.windowMs) this.failures.set(k, { count: 1, first: Date.now() });
    else f.count++;
  }

  reset(ip, username) {
    this.failures.delete(this.key(ip, username));
  }
}

function clientIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function findUserByName(store, username) {
  const name = String(username || '').trim().toLowerCase();
  return store.data.users.find((u) => u.username.toLowerCase() === name) || null;
}

function authenticate(store, username, password) {
  const user = findUserByName(store, username);
  if (!user || user.enabled === false) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

function createSession(store, user, { kind, device, ip }) {
  const token = randomToken();
  const now = new Date().toISOString();
  const session = store.insert('sessions', {
    tokenHash: sha256(token),
    userId: user.id,
    kind,
    device: String(device || '').slice(0, 120),
    ip,
    lastSeen: now,
  });
  return { token, session };
}

function sessionFromToken(store, token) {
  if (!token) return null;
  const hash = sha256(token);
  const session = store.data.sessions.find((s) => s.tokenHash === hash);
  if (!session) return null;
  const ttl = SESSION_TTL[session.kind] || SESSION_TTL.browser;
  if (Date.now() - Date.parse(session.lastSeen) > ttl) {
    store.remove('sessions', session.id);
    return null;
  }
  return session;
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function requireSession(store, { admin = false, kind = null } = {}) {
  return (req, res, next) => {
    const session = sessionFromToken(store, bearer(req));
    if (!session) return res.status(401).json({ error: 'Not signed in' });
    const user = store.get('users', session.userId);
    if (!user || user.enabled === false) {
      store.remove('sessions', session.id);
      return res.status(401).json({ error: 'Account disabled' });
    }
    if (kind && session.kind !== kind) return res.status(403).json({ error: 'Wrong session type' });
    if (admin && user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
    const now = Date.now();
    if (now - Date.parse(session.lastSeen) > 30000) {
      session.lastSeen = new Date(now).toISOString();
      session.ip = clientIp(req);
      store.save();
    }
    req.session = session;
    req.user = user;
    next();
  };
}

module.exports = {
  LoginLimiter,
  clientIp,
  authenticate,
  createSession,
  sessionFromToken,
  requireSession,
  findUserByName,
};
