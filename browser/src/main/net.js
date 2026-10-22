'use strict';
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');

function derToPem(der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter the server address');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'https:') u.protocol = 'https:';
  if (!u.port) u.port = '8443';
  return u.origin;
}

// Connects without verification only to read the server certificate, so the
// user (or managed.json) can pin its fingerprint. No data is sent.
function fetchCertificate(serverUrl, timeoutMs = 6000) {
  const u = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: /^[\d.]+$/.test(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false }, () => {
      const cert = sock.getPeerCertificate(true);
      sock.end();
      if (!cert || !cert.raw) return reject(new Error('Server did not present a certificate'));
      resolve({ certPem: derToPem(cert.raw), fingerprint: cert.fingerprint256 });
    });
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      reject(new Error('Connection timed out'));
    });
    sock.on('error', (err) => reject(new Error(`Cannot reach server: ${err.message}`)));
  });
}

class HttpError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// HTTPS client that trusts exactly the pinned server certificate.
class ServerClient {
  constructor({ serverUrl, certPem, fingerprint, token = null }) {
    this.serverUrl = serverUrl;
    this.certPem = certPem;
    this.fingerprint = fingerprint;
    this.token = token;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  }

  tlsOptions() {
    return {
      agent: this.agent,
      ca: [this.certPem, ...tls.rootCertificates],
      checkServerIdentity: (host, cert) =>
        cert.fingerprint256 === this.fingerprint ? undefined : new Error('Server certificate does not match the pinned fingerprint'),
    };
  }

  request(method, path, body, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = https.request(
        this.serverUrl + path,
        {
          method,
          ...this.tlsOptions(),
          headers: {
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let data = null;
            try {
              data = text ? JSON.parse(text) : null;
            } catch {
              data = { error: text };
            }
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
            else reject(new HttpError(res.statusCode, (data && data.error) || `Server error ${res.statusCode}`, data));
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Server did not respond in time')));
      req.on('error', (err) => reject(err instanceof HttpError ? err : new HttpError(0, err.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Server-sent events with automatic reconnect.
  stream(path, { onEvent, onStatus }) {
    let closed = false;
    let req = null;
    let delay = 2000;
    let timer = null;

    const connect = () => {
      if (closed) return;
      req = https.request(
        this.serverUrl + path,
        { method: 'GET', ...this.tlsOptions(), agent: false, headers: { Accept: 'text/event-stream', Authorization: `Bearer ${this.token}` } },
        (res) => {
          if (res.statusCode === 401) {
            onStatus && onStatus('unauthorized');
            res.resume();
            closed = true;
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            return retry();
          }
          delay = 2000;
          onStatus && onStatus('online');
          res.setEncoding('utf8');
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let event = 'message';
              const data = [];
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trim());
              }
              if (!data.length) continue;
              try {
                onEvent(event, JSON.parse(data.join('\n')));
              } catch (err) {
                console.error('bad event', err);
              }
            }
          });
          res.on('end', retry);
          res.on('error', retry);
        }
      );
      req.on('error', retry);
      req.end();
    };

    const retry = () => {
      if (closed || timer) return;
      onStatus && onStatus('offline');
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
      delay = Math.min(delay * 2, 30000);
    };

    connect();
    return {
      close() {
        closed = true;
        clearTimeout(timer);
        if (req) req.destroy();
      },
    };
  }

  close() {
    this.agent.destroy();
  }
}

function fingerprintOfPem(pem) {
  return new crypto.X509Certificate(pem).fingerprint256;
}

module.exports = { ServerClient, HttpError, fetchCertificate, normalizeServerUrl, fingerprintOfPem };
