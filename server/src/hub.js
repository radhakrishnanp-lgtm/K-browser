'use strict';
// Server-sent-events hub: keeps a live channel to each connected browser so
// the admin can push policy changes, messages and commands instantly.
class Hub {
  constructor() {
    this.clients = new Map(); // sessionId -> { res, userId }
    this.ping = setInterval(() => {
      for (const { res } of this.clients.values()) res.write(': ping\n\n');
    }, 25000);
    this.ping.unref();
  }

  attach(session, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const existing = this.clients.get(session.id);
    if (existing) existing.res.end();
    this.clients.set(session.id, { res, userId: session.userId });
    res.on('close', () => {
      const cur = this.clients.get(session.id);
      if (cur && cur.res === res) this.clients.delete(session.id);
    });
  }

  isOnline(sessionId) {
    return this.clients.has(sessionId);
  }

  send(sessionId, event, data = {}) {
    const c = this.clients.get(sessionId);
    if (!c) return false;
    c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }

  sendToUser(userId, event, data) {
    let n = 0;
    for (const [sid, c] of this.clients) if (c.userId === userId && this.send(sid, event, data)) n++;
    return n;
  }

  broadcast(event, data) {
    let n = 0;
    for (const sid of this.clients.keys()) if (this.send(sid, event, data)) n++;
    return n;
  }

  disconnect(sessionId) {
    const c = this.clients.get(sessionId);
    if (c) {
      c.res.end();
      this.clients.delete(sessionId);
    }
  }

  close() {
    clearInterval(this.ping);
    for (const { res } of this.clients.values()) res.end();
    this.clients.clear();
  }
}

module.exports = { Hub };
