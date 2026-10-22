'use strict';
// Concurrent-seat tracking for shared site logins. A user holds a seat while
// their browser has the site open (browsers renew it every 15 s); seats free
// themselves two minutes after the last renewal.
const LEASE_MS = 120000;

class Seats {
  constructor() {
    this.leases = new Map(); // credentialId -> Map(userId -> { at, username })
  }

  holders(credentialId, now = Date.now()) {
    const m = this.leases.get(credentialId);
    if (!m) return [];
    for (const [uid, l] of m) if (now - l.at > LEASE_MS) m.delete(uid);
    return [...m.entries()].map(([userId, l]) => ({ userId, username: l.username, since: l.since }));
  }

  // Returns { ok: true } or { ok: false, holders } when every seat is taken.
  acquire(credential, user, now = Date.now()) {
    const limit = Number(credential.seats) || 0;
    const holders = this.holders(credential.id, now);
    if (!limit) return { ok: true };
    if (!holders.some((h) => h.userId === user.id) && holders.length >= limit) return { ok: false, holders };
    this.renew(credential.id, user, now);
    return { ok: true };
  }

  renew(credentialId, user, now = Date.now()) {
    let m = this.leases.get(credentialId);
    if (!m) this.leases.set(credentialId, (m = new Map()));
    const prev = m.get(user.id);
    m.set(user.id, { at: now, username: user.username, since: prev ? prev.since : new Date(now).toISOString() });
  }

  releaseUser(userId) {
    for (const m of this.leases.values()) m.delete(userId);
  }
}

module.exports = { Seats, LEASE_MS };
