'use strict';
const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const { evaluateUrl } = require('./match');

const PAGES_DIR = path.join(__dirname, '..', 'renderer', 'pages');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const configured = new WeakSet();

function cleanUserAgent(ua) {
  return ua
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(/\sk-browser\/[\d.]+/i, '')
    .replace(/\sK-Browser\/[\d.]+/, '');
}

function pemBody(pem) {
  return String(pem || '').replace(/-----[^-]+-----|\s/g, '');
}

// Applies the enterprise policy to a user's browsing session. Handlers read the
// live context through `ctx()` so policy updates apply without re-registering.
function configureSession(partition, ctx) {
  const ses = session.fromPartition(partition);
  if (configured.has(ses)) return ses;
  configured.add(ses);

  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  ses.setSpellCheckerEnabled(true);

  // Internal pages: kb://newtab, kb://blocked
  ses.protocol.handle('kb', async (req) => {
    const u = new URL(req.url);
    const c = ctx();
    if (u.pathname === '/data.json') {
      return new Response(JSON.stringify(c ? c.pageData(u.hostname, u) : {}), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (u.hostname === 'blocked' && u.pathname === '/request' && c) {
      c.onAccessRequest(u.searchParams.get('url') || '', u.searchParams.get('reason') || '');
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }
    const name = u.pathname === '/' ? `${u.hostname}.html` : path.basename(u.pathname);
    const file = path.join(PAGES_DIR, name);
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        headers: {
          'content-type': MIME[path.extname(file)] || 'application/octet-stream',
          'content-security-policy': "default-src 'self' kb:; img-src * data:; style-src 'self' kb: 'unsafe-inline'; connect-src kb:",
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  ses.webRequest.onBeforeRequest((details, callback) => {
    const c = ctx();
    if (!c) return callback({ cancel: true });
    const type = details.resourceType;
    if (type !== 'mainFrame' && type !== 'subFrame') return callback({});
    const url = details.url;
    if (url.startsWith('file:') && c.settings.allowFileUrls) return callback({});
    if (c.isServerUrl(url)) return callback({});
    const verdict = evaluateUrl(url, c.policy);
    if (verdict.allowed) return callback({});
    callback({ cancel: true });
    c.onBlocked(details, verdict);
  });

  // Trust the pinned control-server certificate (for the admin console in a tab).
  ses.setCertificateVerifyProc((req, callback) => {
    const c = ctx();
    if (c && c.serverHost === req.hostname && pemBody(req.certificate.data) === pemBody(c.certPem)) return callback(0);
    callback(-3);
  });

  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const c = ctx();
    if (!c) return callback(false);
    const base = ['clipboard-sanitized-write', 'fullscreen', 'notifications', 'pointerLock', 'window-management'];
    if (base.includes(permission)) return callback(true);
    if (permission === 'media' && c.settings.allowMedia) return callback(true);
    if (permission === 'clipboard-read') return callback(true);
    callback(false);
  });

  ses.setPermissionCheckHandler((wc, permission) => {
    const c = ctx();
    if (!c) return false;
    if (permission === 'media') return !!c.settings.allowMedia;
    return ['clipboard-sanitized-write', 'fullscreen', 'notifications', 'pointerLock', 'clipboard-read'].includes(permission);
  });

  ses.on('will-download', (event, item) => {
    const c = ctx();
    if (!c) return event.preventDefault();
    c.onDownload(event, item);
  });

  // Never offer to store passwords; K-Browser manages them centrally.
  if (typeof ses.setPasswordManagerEnabled === 'function') ses.setPasswordManagerEnabled(false);

  return ses;
}

module.exports = { configureSession, cleanUserAgent };
