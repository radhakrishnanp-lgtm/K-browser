'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { openStores } = require('../src/store');
const { Vault, hashPassword } = require('../src/crypto');
const { Hub } = require('../src/hub');
const { createApp } = require('../src/app');
const { loadOrCreateCert } = require('../src/tls');

let server, base, tls, hub, store;

// Same pinning approach the browser uses: trust exactly this certificate.
function request(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      base + url,
      {
        method,
        ca: tls.cert,
        checkServerIdentity: (host, cert) => (cert.fingerprint256 === tls.fingerprint ? undefined : new Error('pin mismatch')),
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-'));
  const stores = openStores(dir);
  store = stores.store;
  store.insert('users', { username: 'admin', role: 'admin', enabled: true, groupIds: [], passwordHash: hashPassword('adminpass') });
  tls = await loadOrCreateCert(dir);
  hub = new Hub();
  const app = createApp({ store, audit: stores.audit, vault: new Vault(path.join(dir, 'vault.key'), ''), hub, info: { version: 'test', fingerprint: tls.fingerprint } });
  server = https.createServer({ cert: tls.cert, key: tls.key }, app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  hub.close();
  server.close();
  server.closeAllConnections();
});

test('pinned TLS rejects a different certificate', async () => {
  const saved = tls.fingerprint;
  tls = { ...tls, fingerprint: 'AA:BB' };
  await assert.rejects(request('GET', '/api/info'));
  tls = { ...tls, fingerprint: saved };
  const r = await request('GET', '/api/info');
  assert.strictEqual(r.status, 200);
});

test('end-to-end admin + browser flow', async () => {
  let r = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } });
  assert.strictEqual(r.status, 401);
  r = await request('POST', '/api/auth/login', { body: { username: 'admin', password: 'adminpass', kind: 'console' } });
  assert.strictEqual(r.status, 200);
  const admin = r.body.token;

  r = await request('POST', '/api/admin/groups', { token: admin, body: { name: 'Design', policy: { mode: 'inherit', rules: [{ pattern: 'canva.com', action: 'allow' }] } } });
  const group = r.body;

  r = await request('POST', '/api/admin/users', { token: admin, body: { username: 'priya', password: 'priyapass', groupIds: [group.id] } });
  assert.strictEqual(r.status, 201);
  const priya = r.body;
  r = await request('POST', '/api/admin/users', { token: admin, body: { username: 'arun' } });
  assert.ok(r.body.generatedPassword);
  const arun = r.body;

  r = await request('PUT', '/api/admin/policy', { token: admin, body: { mode: 'allowlist', rules: [{ pattern: 'facebook.com', action: 'block' }] } });
  assert.strictEqual(r.body.mode, 'allowlist');

  // Two different accounts for the same site, one per user.
  r = await request('POST', '/api/admin/credentials', {
    token: admin,
    body: { name: 'Canva (Priya)', loginUrl: 'https://www.canva.com/login', username: 'priya@office.com', password: 'CanvaP@ss1', assignedUserIds: [priya.id] },
  });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual(r.body.match, ['canva.com']);
  assert.strictEqual(r.body.password, undefined, 'password is never returned');
  const canvaPriya = r.body;
  r = await request('POST', '/api/admin/credentials', {
    token: admin,
    body: { name: 'Canva (Arun)', match: 'canva.com', username: 'arun@office.com', password: 'CanvaP@ss2', totpSecret: 'GEZDGNBVGY3TQOJQ', assignedUserIds: [arun.id] },
  });
  const canvaArun = r.body;

  r = await request('GET', '/api/admin/credentials', { token: admin });
  assert.ok(!JSON.stringify(r.body).includes('CanvaP@ss'));

  // Staff browser
  r = await request('POST', '/api/auth/login', { body: { username: 'priya', password: 'priyapass', kind: 'console' } });
  assert.strictEqual(r.status, 403, 'non-admin cannot open console');
  r = await request('POST', '/api/auth/login', { body: { username: 'priya', password: 'priyapass', device: 'PC-12' } });
  const tok = r.body.token;

  r = await request('GET', '/api/admin/users', { token: tok });
  assert.strictEqual(r.status, 403);

  r = await request('GET', '/api/client/bootstrap', { token: tok });
  assert.strictEqual(r.body.policy.mode, 'allowlist');
  assert.deepStrictEqual(r.body.policy.rules.map((x) => x.source), ['group:Design', 'global']);
  assert.deepStrictEqual(r.body.credentials.map((c) => c.id), [canvaPriya.id]);
  assert.ok(!JSON.stringify(r.body).includes('CanvaP@ss'));

  r = await request('POST', '/api/client/fill', { token: tok, body: { credentialId: canvaPriya.id, url: 'https://www.canva.com/login' } });
  assert.strictEqual(r.body.password, 'CanvaP@ss1');
  assert.strictEqual(r.body.username, 'priya@office.com');

  r = await request('POST', '/api/client/fill', { token: tok, body: { credentialId: canvaPriya.id, url: 'https://evil.example/login' } });
  assert.strictEqual(r.status, 404, 'secret only released for matching site');
  r = await request('POST', '/api/client/fill', { token: tok, body: { credentialId: canvaArun.id, url: 'https://www.canva.com/login' } });
  assert.strictEqual(r.status, 404, 'cannot use another user credential');

  r = await request('POST', '/api/client/activity', { token: tok, body: { events: [{ type: 'visit', url: 'https://www.canva.com/', title: 'Canva' }], current: { url: 'https://www.canva.com/', title: 'Canva', tabCount: 2 } } });
  assert.strictEqual(r.status, 200);

  r = await request('POST', '/api/admin/policy/test', { token: admin, body: { url: 'https://canva.com', userId: priya.id } });
  assert.strictEqual(r.body.allowed, true);
  r = await request('POST', '/api/admin/policy/test', { token: admin, body: { url: 'https://canva.com', userId: arun.id } });
  assert.strictEqual(r.body.allowed, false);

  r = await request('GET', '/api/admin/sessions', { token: admin });
  const s = r.body.find((x) => x.username === 'priya');
  assert.strictEqual(s.currentUrl, 'https://www.canva.com/');
  assert.strictEqual(s.tabCount, 2);

  r = await request('GET', '/api/admin/audit?type=credential.fill', { token: admin });
  assert.strictEqual(r.body.length, 1);

  // Disabling the user kills their sessions.
  await request('PUT', `/api/admin/users/${priya.id}`, { token: admin, body: { enabled: false } });
  r = await request('GET', '/api/client/bootstrap', { token: tok });
  assert.strictEqual(r.status, 401);
});

test('login lockout after repeated failures', async () => {
  for (let i = 0; i < 5; i++) await request('POST', '/api/auth/login', { body: { username: 'lock', password: 'x' } });
  const r = await request('POST', '/api/auth/login', { body: { username: 'lock', password: 'x' } });
  assert.strictEqual(r.status, 429);
});
