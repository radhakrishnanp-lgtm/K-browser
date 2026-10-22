'use strict';
// Tests for roles, 2FA, seat limits, shared sessions, access requests, DLP,
// usage reports, webhook alerts and the tamper-evident audit log.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { openStores } = require('../src/store');
const { Vault, hashPassword, totp } = require('../src/crypto');
const { Hub } = require('../src/hub');
const { createApp } = require('../src/app');
const { attachAlerts } = require('../src/alerts');

let server, base, hub, audit, store;
const posted = [];

function request(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const login = async (username, password, extra = {}) => (await request('POST', '/api/auth/login', { body: { username, password, ...extra } })).body;

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbe-'));
  ({ store, audit } = openStores(dir));
  const add = (username, role) => store.insert('users', { username, role, enabled: true, groupIds: [], passwordHash: hashPassword('pass-' + username) });
  add('admin', 'admin');
  add('help', 'helpdesk');
  add('audit', 'auditor');
  add('ann', 'user');
  add('bob', 'user');
  store.data.settings.webhookUrl = 'https://hooks.example/abc';
  attachAlerts(audit, store, { post: async (url, body) => posted.push({ url, body }) });
  hub = new Hub();
  const app = createApp({ store, audit, vault: new Vault(path.join(dir, 'vault.key'), ''), hub, info: { version: 'test', fingerprint: 'x' } });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  hub.close();
  server.close();
  server.closeAllConnections();
});

test('roles: helpdesk and auditor have limited power', async () => {
  const help = (await login('help', 'pass-help', { kind: 'console' })).token;
  const aud = (await login('audit', 'pass-audit', { kind: 'console' })).token;
  assert.ok(help && aud);
  assert.strictEqual((await request('GET', '/api/admin/users', { token: aud })).status, 200);
  assert.strictEqual((await request('PUT', '/api/admin/policy', { token: aud, body: { mode: 'blocklist', rules: [] } })).status, 403);
  assert.strictEqual((await request('POST', '/api/admin/users', { token: aud, body: { username: 'zz' } })).status, 403);
  assert.strictEqual((await request('POST', '/api/admin/users', { token: help, body: { username: 'newstaff' } })).status, 201);
  assert.strictEqual((await request('POST', '/api/admin/users', { token: help, body: { username: 'sneaky', role: 'admin' } })).status, 400);
  assert.strictEqual((await request('POST', '/api/admin/credentials', { token: help, body: { name: 'x', match: 'x.com' } })).status, 403);
  assert.strictEqual((await request('GET', '/api/admin/backup', { token: help })).status, 403);
});

test('2FA protects sign-in', async () => {
  const tok = (await login('admin', 'pass-admin', { kind: 'console' })).token;
  const setup = (await request('POST', '/api/auth/2fa/setup', { token: tok })).body;
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.strictEqual((await request('POST', '/api/auth/2fa/enable', { token: tok, body: { code: '000000' } })).status, 400);
  assert.strictEqual((await request('POST', '/api/auth/2fa/enable', { token: tok, body: { code: totp(setup.secret) } })).status, 200);
  const r1 = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'pass-admin', kind: 'console' } });
  assert.strictEqual(r1.status, 401);
  assert.strictEqual(r1.body.needOtp, true);
  const r2 = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'pass-admin', kind: 'console', otp: totp(setup.secret) } });
  assert.strictEqual(r2.status, 200);
  await request('POST', '/api/auth/2fa/disable', { token: r2.body.token, body: { password: 'pass-admin' } });
});

test('seat limits, shared sessions, access requests, DLP, usage, alerts, audit chain', async () => {
  const admin = (await login('admin', 'pass-admin', { kind: 'console' })).token;
  const ann = store.data.users.find((u) => u.username === 'ann');
  const bob = store.data.users.find((u) => u.username === 'bob');
  let r = await request('POST', '/api/admin/credentials', {
    token: admin,
    body: { name: 'Canva', match: 'canva.com', username: 'team@x.com', password: 'pw', seats: 1, costMonthly: 999, renewalDate: '2026-11-01', everyone: true },
  });
  const cred = r.body;
  assert.strictEqual(cred.seats, 1);

  const annTok = (await login('ann', 'pass-ann')).token;
  const bobTok = (await login('bob', 'pass-bob')).token;
  r = await request('POST', '/api/client/seat', { token: annTok, body: { credentialId: cred.id, url: 'https://www.canva.com/' } });
  assert.strictEqual(r.status, 200);
  r = await request('POST', '/api/client/fill', { token: bobTok, body: { credentialId: cred.id, url: 'https://www.canva.com/' } });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(r.body.holders, ['ann']);
  await request('POST', '/api/auth/logout', { token: annTok });
  r = await request('POST', '/api/client/seat', { token: bobTok, body: { credentialId: cred.id, url: 'https://www.canva.com/' } });
  assert.strictEqual(r.status, 200, 'seat freed when holder signs out');

  // Session sharing: admin captures from a browser session
  const adminBrowser = (await login('admin', 'pass-admin')).token;
  r = await request('POST', '/api/client/capture-session', {
    token: adminBrowser,
    body: { credentialId: cred.id, url: 'https://www.canva.com/', cookies: [{ name: 'sid', value: 'SECRET-COOKIE-123', domain: '.canva.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }] },
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await request('POST', '/api/client/capture-session', { token: bobTok, body: { url: 'https://a.com', cookies: [] } })).status, 403);
  r = await request('POST', '/api/client/session', { token: bobTok, body: { credentialId: cred.id, url: 'https://www.canva.com/' } });
  assert.strictEqual(r.body.cookies[0].value, 'SECRET-COOKIE-123');
  r = await request('GET', '/api/client/bootstrap', { token: bobTok });
  assert.strictEqual(r.body.credentials[0].hasSession, true);
  assert.ok(!JSON.stringify(r.body).includes('SECRET-COOKIE-123'));

  // Access request → approve for 60 minutes
  r = await request('POST', '/api/client/access-request', { token: bobTok, body: { url: 'https://www.youtube.com/watch?v=1', reason: 'training video' } });
  const reqId = r.body.id;
  r = await request('GET', '/api/admin/requests?status=pending', { token: admin });
  assert.strictEqual(r.body[0].reason, 'training video');
  r = await request('POST', `/api/admin/requests/${reqId}/approve`, { token: admin, body: { minutes: 60 } });
  assert.strictEqual(r.body.status, 'approved');
  r = await request('GET', '/api/client/bootstrap', { token: bobTok });
  assert.strictEqual(r.body.policy.rules[0].pattern, 'youtube.com');
  assert.ok(r.body.policy.rules[0].expiresAt);

  // DLP rule for a group of one user
  r = await request('PUT', '/api/admin/dlp', { token: admin, body: [{ name: 'CRM', match: 'crm.example.com', blockCopy: true, watermark: true, userIds: [bob.id] }] });
  assert.strictEqual(r.status, 200);
  r = await request('GET', '/api/client/bootstrap', { token: bobTok });
  assert.strictEqual(r.body.dlp[0].blockCopy, true);
  const annTok2 = (await login('ann', 'pass-ann')).token;
  r = await request('GET', '/api/client/bootstrap', { token: annTok2 });
  assert.strictEqual(r.body.dlp.length, 0);

  // Usage report
  await request('POST', '/api/client/activity', { token: bobTok, body: { usage: { 'www.canva.com': 60, 'mail.google.com': 30 } } });
  r = await request('GET', '/api/admin/reports/usage', { token: admin });
  assert.ok(r.body.rows.some((x) => x.username === 'bob' && x.host === 'www.canva.com' && x.seconds === 60));

  r = await request('GET', '/api/admin/subscriptions', { token: admin });
  assert.strictEqual(r.body.monthlyCost, 999);
  assert.strictEqual(r.body.items[0].eligibleUsers, store.data.users.length);

  // Alerts fired for access request and seat denial
  const types = posted.map((p) => p.body.event.type);
  assert.ok(types.includes('access.request') && types.includes('seat.denied'));

  // Audit chain verifies, then detects tampering
  r = await request('GET', '/api/admin/audit/verify', { token: admin });
  assert.strictEqual(r.body.ok, true);
  audit.entries[2].detail = 'tampered';
  r = await request('GET', '/api/admin/audit/verify', { token: admin });
  assert.strictEqual(r.body.ok, false);

  void ann;
});
