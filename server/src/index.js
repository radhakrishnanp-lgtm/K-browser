#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { openStores } = require('./store');
const { Vault, hashPassword, randomPassword } = require('./crypto');
const { Hub } = require('./hub');
const { createApp } = require('./app');
const { loadOrCreateCert, lanAddresses } = require('./tls');
const { startDiscovery } = require('./discovery');
const { attachAlerts } = require('./alerts');
const pkg = require('../package.json');

const dataDir = path.resolve(process.env.KB_DATA_DIR || path.join(__dirname, '..', 'data'));
const port = Number(process.env.KB_PORT || 8443);
const host = process.env.KB_HOST || '0.0.0.0';

function ensureAdmin(store) {
  if (store.data.users.some((u) => u.role === 'admin')) return null;
  const password = process.env.KB_ADMIN_PASSWORD || randomPassword(14);
  store.insert('users', {
    username: 'admin',
    displayName: 'Administrator',
    role: 'admin',
    enabled: true,
    groupIds: [],
    policy: { mode: 'inherit', rules: [] },
    settings: {},
    bookmarks: [],
    passwordHash: hashPassword(password),
    mustChangePassword: !process.env.KB_ADMIN_PASSWORD,
  });
  store.saveNow();
  return password;
}

function resetAdmin(store, username) {
  const user = store.data.users.find((u) => u.username.toLowerCase() === (username || 'admin').toLowerCase());
  const password = randomPassword(14);
  if (user) {
    user.passwordHash = hashPassword(password);
    user.role = 'admin';
    user.enabled = true;
  } else {
    store.insert('users', {
      username: username || 'admin',
      displayName: 'Administrator',
      role: 'admin',
      enabled: true,
      groupIds: [],
      passwordHash: hashPassword(password),
    });
  }
  store.saveNow();
  console.log(`Password for "${username || 'admin'}" is now: ${password}`);
}

async function main() {
  const { store, audit } = openStores(dataDir);

  if (process.argv[2] === 'reset-admin') {
    resetAdmin(store, process.argv[3]);
    return;
  }

  const vault = new Vault(path.join(dataDir, 'vault.key'));
  const tls = await loadOrCreateCert(dataDir);
  const hub = new Hub();
  const info = { version: pkg.version, fingerprint: tls.fingerprint, port, hostname: os.hostname(), addresses: lanAddresses() };
  const app = createApp({ store, audit, vault, hub, info });
  attachAlerts(audit, store);

  // Daily housekeeping: drop old usage statistics and finished access requests.
  const housekeeping = () => {
    const keepDays = Number(store.data.settings.usageRetentionDays) || 90;
    const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
    for (const day of Object.keys(store.data.usage || {})) if (day < cutoff) delete store.data.usage[day];
    const old = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
    store.data.accessRequests = store.data.accessRequests.filter((a) => a.status === 'pending' || a.createdAt > old);
    store.save();
  };
  housekeeping();
  setInterval(housekeeping, 6 * 3600 * 1000).unref();

  const firstPassword = ensureAdmin(store);
  if (firstPassword) {
    const note = path.join(dataDir, 'initial-admin-password.txt');
    fs.writeFileSync(note, `username: admin\npassword: ${firstPassword}\n`, { mode: 0o600 });
  }

  const server = https.createServer({ cert: tls.cert, key: tls.key }, app);
  server.keepAliveTimeout = 65000;
  server.listen(port, host, () => {
    const urls = ['localhost', ...info.addresses].map((a) => `  https://${a}:${port}/admin/`);
    console.log(`K-Browser Control Server ${pkg.version}`);
    console.log(`Data directory : ${dataDir}`);
    console.log(`Admin console  :\n${urls.join('\n')}`);
    console.log(`TLS fingerprint: ${tls.fingerprint}`);
    if (firstPassword) {
      console.log('\nFirst start: an administrator account was created.');
      console.log(`  username: admin\n  password: ${firstPassword}`);
      console.log('(also saved in data/initial-admin-password.txt; delete that file after you sign in)\n');
    }
  });

  let discovery = null;
  if (process.env.KB_DISCOVERY !== 'off') {
    discovery = startDiscovery({
      describe: () => ({ name: store.data.settings.orgName, port, fingerprint: tls.fingerprint, version: pkg.version }),
    });
  }

  const shutdown = () => {
    store.saveNow();
    hub.close();
    if (discovery) discovery.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
