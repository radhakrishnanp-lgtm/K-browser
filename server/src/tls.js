'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (!a.internal && a.family === 'IPv4') out.push(a.address);
  }
  return out;
}

// Loads data/tls/cert.pem + key.pem, generating a self-signed certificate for
// this machine on first start. Browsers pin its SHA-256 fingerprint.
async function loadOrCreateCert(dataDir) {
  const dir = path.join(dataDir, 'tls');
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true });
    const selfsigned = require('selfsigned');
    const host = os.hostname();
    const altNames = [
      { type: 2, value: host },
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...lanAddresses().map((ip) => ({ type: 7, ip })),
    ];
    const pems = await selfsigned.generate([{ name: 'commonName', value: `K-Browser Server (${host})` }], {
      keySize: 2048,
      notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
  }
  const cert = fs.readFileSync(certFile, 'utf8');
  const key = fs.readFileSync(keyFile, 'utf8');
  const fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  return { cert, key, fingerprint };
}

module.exports = { loadOrCreateCert, lanAddresses };
