'use strict';
// End-to-end test: starts a control server and a fake "paid website", launches
// K-Browser and checks sign-in, automatic site login, password masking, web
// filtering, admin messages and remote sign-out.
//
//   node test/e2e.js            (on Linux CI wrap with xvfb-run)
//   KB_SHOTS=dir node test/e2e.js   also saves screenshots of the X display
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const SERVER_DIR = path.join(ROOT, '..', 'server');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const SITE_PORT = PORT + 1000;
const ADMIN_PW = 'Admin-pass-123';
const shots = process.env.KB_SHOTS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 15000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${label}${last ? ': ' + last.message : ''}`);
}

function screenshot(name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  try {
    execFileSync('import', ['-window', 'root', path.join(shots, `${name}.png`)], { env: process.env });
  } catch (err) {
    console.warn('screenshot failed', err.message);
  }
}

// ---- fake subscription website -------------------------------------------------
const LOGIN_PAGE = `<!doctype html><html><head><title>Fake SaaS login</title></head><body>
<h1>Sign in to FakeSaaS</h1>
<form method="post" action="/session">
  <label>Email <input type="email" name="email" id="email" autocomplete="username"></label>
  <label>Password <input type="password" name="password" id="password"></label>
  <button type="button" id="reveal">Show password</button>
  <button type="submit">Sign in</button>
</form>
<script>
  document.getElementById('reveal').onclick = () => { const p = document.getElementById('password'); p.type = p.type === 'password' ? 'text' : 'password'; };
</script></body></html>`;

function startSite() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const ok = p.get('password') === 'S3cret-SaaS!';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><title>${ok ? 'Dashboard' : 'Failed'}</title><h1 id="result">${ok ? 'Welcome ' + p.get('email') : 'Wrong password'}</h1>`);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(LOGIN_PAGE);
  });
  return new Promise((r) => server.listen(SITE_PORT, '0.0.0.0', () => r(server)));
}

// ---- control server ---------------------------------------------------------------
let fingerprint = null;
let certPem = null;
function api(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://127.0.0.1:${PORT}/api${p}`,
      { method, ca: certPem, checkServerIdentity: () => undefined, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => (res.statusCode < 300 ? resolve(JSON.parse(d)) : reject(new Error(`${res.statusCode} ${d}`))));
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startServer() {
  const dataDir = path.join(tmp, 'server-data');
  const proc = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], {
    env: { ...process.env, KB_DATA_DIR: dataDir, KB_PORT: String(PORT), KB_ADMIN_PASSWORD: ADMIN_PW, KB_DISCOVERY: 'off' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  proc.stdout.on('data', (c) => (out += c));
  await waitFor(() => /TLS fingerprint: (\S+)/.test(out), { label: 'server start' });
  fingerprint = out.match(/TLS fingerprint: (\S+)/)[1];
  certPem = fs.readFileSync(path.join(dataDir, 'tls', 'cert.pem'), 'utf8');
  return proc;
}

async function main() {
  const site = await startSite();
  const serverProc = await startServer();
  let app;
  try {
    const admin = (await api('POST', '/auth/login', { username: 'admin', password: ADMIN_PW, kind: 'console' })).token;
    const staff = await api('POST', '/admin/users', { username: 'priya', displayName: 'Priya Sharma', password: 'priya-pass-1' }, admin);
    await api('POST', '/admin/credentials', { name: 'FakeSaaS (auto)', match: [`127.0.0.1:${SITE_PORT}`], loginUrl: `http://127.0.0.1:${SITE_PORT}/login`, username: 'design@office.com', password: 'S3cret-SaaS!', autoSubmit: true, assignedUserIds: [staff.id] }, admin);
    await api('POST', '/admin/credentials', { name: 'FakeSaaS (manual)', match: [`127.0.0.2:${SITE_PORT}`], loginUrl: `http://127.0.0.2:${SITE_PORT}/login`, username: 'manual@office.com', password: 'S3cret-SaaS!', autoSubmit: false, assignedUserIds: [staff.id] }, admin);
    await api('PUT', '/admin/policy', { mode: 'blocklist', rules: [{ pattern: 'localhost', action: 'block', note: 'test' }] }, admin);
    await api('PUT', '/admin/bookmarks', [{ title: 'FakeSaaS', url: `http://127.0.0.1:${SITE_PORT}/login` }], admin);

    const managed = path.join(tmp, 'managed.json');
    fs.writeFileSync(managed, JSON.stringify({ serverUrl: `https://127.0.0.1:${PORT}`, fingerprint, lockServer: true }));

    app = await electron.launch({
      args: [ROOT, '--no-sandbox'],
      env: { ...process.env, KB_USER_DATA: path.join(tmp, 'client'), KB_MANAGED_CONFIG: managed },
    });

    if (process.env.KB_E2E_DEBUG) {
      app.process().stdout.on('data', (d) => process.stdout.write('[main] ' + d));
      app.process().stderr.on('data', (d) => process.stdout.write('[main] ' + d));
    }

    // 1. Sign in
    const login = await app.firstWindow();
    await login.waitForSelector('#username');
    assert.ok(await login.isVisible('#server-locked'), 'managed server is locked');
    assert.ok((await login.isHidden('#trust')) && (await login.isHidden('#newpw')), 'only the sign-in form is shown');
    await login.fill('#username', 'priya');
    await login.fill('#password', 'priya-pass-1');
    screenshot('01-login');
    await login.click('#submit');

    const shell = await waitFor(() => app.windows().find((w) => w.url().endsWith('browser.html')), { label: 'browser window' });
    await waitFor(async () => (await shell.textContent('#username')) === 'Priya Sharma', { label: 'user name in toolbar' });
    console.log('✔ staff sign-in opens the browser');

    const page = async (pred, label) => waitFor(() => app.windows().find((w) => pred(w.url())), { label });
    await page((u) => u.startsWith('kb://newtab'), 'new tab page');
    await sleep(800);
    screenshot('02-newtab');
    console.log('✔ new tab page loads');

    // 2. Automatic login with auto-submit
    await shell.fill('#address', `127.0.0.1:${SITE_PORT}/login`);
    await shell.press('#address', 'Enter');
    const dash = await page((u) => u === `http://127.0.0.1:${SITE_PORT}/session`, 'dashboard after auto login');
    await dash.waitForSelector('#result');
    assert.strictEqual(await dash.textContent('#result'), 'Welcome design@office.com');
    console.log('✔ assigned site login is filled and submitted automatically');

    // 3. Manual login page: password filled, but cannot be revealed
    await shell.fill('#address', `http://127.0.0.2:${SITE_PORT}/login`);
    await shell.press('#address', 'Enter');
    const manual = await page((u) => u === `http://127.0.0.2:${SITE_PORT}/login`, 'manual login page');
    await waitFor(async () => (await manual.inputValue('#email')) === 'manual@office.com', { label: 'username filled' });
    assert.strictEqual(await manual.inputValue('#password'), 'S3cret-SaaS!');
    await manual.click('#reveal');
    await sleep(300);
    assert.strictEqual(await manual.getAttribute('#password', 'type'), 'password', 'reveal button is neutralised');
    await waitFor(async () => !(await shell.isHidden('#key')), { label: 'key chip' });
    screenshot('03-autofill');
    console.log('✔ password is filled but stays hidden ("show password" is blocked)');

    // 4. Web filter
    await shell.fill('#address', `http://localhost:${SITE_PORT}/`);
    await shell.press('#address', 'Enter');
    const blocked = await page((u) => u.startsWith('kb://blocked'), 'blocked page');
    await blocked.waitForSelector('#rule');
    assert.ok((await blocked.textContent('#rule')).includes('localhost'));
    screenshot('04-blocked');
    console.log('✔ blocked domain shows the block page');

    await shell.fill('#address', 'javascript:alert(document.cookie)');
    await shell.press('#address', 'Enter');
    await waitFor(async () => app.windows().some((w) => w.url().includes('reason=scheme')), { label: 'javascript: blocked' });
    console.log('✔ javascript: URLs are refused');

    // 5. Admin message pushed live
    await api('POST', '/admin/command', { target: 'all', command: 'message', text: 'Server maintenance at 6 PM', level: 'warning' }, admin);
    await shell.waitForSelector('.notice.warning');
    assert.ok((await shell.textContent('#notices')).includes('Server maintenance'));
    screenshot('05-message');
    console.log('✔ admin message appears instantly');

    // 6. Policy change applies without restart
    await api('PUT', '/admin/policy', { mode: 'allowlist', rules: [{ pattern: `127.0.0.2:${SITE_PORT}`, action: 'allow' }] }, admin);
    await sleep(1000);
    await shell.fill('#address', `http://127.0.0.1:${SITE_PORT}/login`);
    await shell.press('#address', 'Enter');
    await waitFor(async () => app.windows().some((w) => w.url().startsWith('kb://blocked') && w.url().includes('127.0.0.1')), { label: 'allowlist blocks site' });
    console.log('✔ switching to allow-list mode is enforced live');

    // 7. Audit trail
    await sleep(16000); // activity is flushed every 15s
    const audit = await api('GET', '/admin/audit?limit=200', null, admin);
    const types = new Set(audit.map((e) => e.type));
    for (const t of ['login', 'credential.fill', 'blocked', 'visit']) assert.ok(types.has(t), `audit has ${t}`);
    const sessions = await api('GET', '/admin/sessions', null, admin);
    const s = sessions.find((x) => x.username === 'priya' && x.online);
    assert.ok(s, 'live session listed');
    console.log('✔ activity log + live session tracking');

    // 8. Remote sign-out
    await api('POST', `/admin/sessions/${s.id}/logout`, {}, admin);
    const back = await waitFor(() => app.windows().find((w) => w.url().endsWith('login.html')), { label: 'login window after remote logout' });
    await back.waitForSelector('#error');
    await waitFor(async () => (await back.textContent('#error')).length > 0, { label: 'logout message' });
    console.log('✔ admin can sign a user out remotely');
    console.log('\nAll end-to-end checks passed.');
  } finally {
    if (app) await app.close().catch(() => {});
    serverProc.kill();
    site.close();
  }
}

main().catch((err) => {
  console.error('\n✖ E2E FAILED:', err);
  process.exit(1);
});
