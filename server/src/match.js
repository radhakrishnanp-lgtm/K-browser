'use strict';
// URL pattern matching shared by the control server and the browser client.
// NOTE: an identical copy lives in browser/src/main/match.js — keep them in sync
// (server/test/match.test.js fails if they differ).
//
// Supported pattern forms:
//   *                         every http(s) URL
//   example.com               example.com and all of its subdomains
//   *.example.com             subdomains of example.com only (not the apex)
//   =example.com              exactly this host, no subdomains
//   example.com/path          host (and subdomains) + path prefix
//   example.com:8080          host + explicit port
//   https://example.com/a/*   full-URL glob ("*" matches anything)
//   192.168.1.0/24            IPv4 CIDR range

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostMatches(host, patternHost, mode) {
  host = host.toLowerCase().replace(/\.$/, '');
  patternHost = patternHost.toLowerCase().replace(/\.$/, '');
  if (mode === 'exact') return host === patternHost;
  if (mode === 'subdomains') return host.endsWith('.' + patternHost);
  return host === patternHost || host.endsWith('.' + patternHost);
}

function matchesPattern(url, pattern) {
  if (!pattern || typeof pattern !== 'string') return false;
  pattern = pattern.trim();
  if (!pattern) return false;
  const u = typeof url === 'string' ? parseUrl(url) : url;
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  if (pattern === '*') return true;

  if (pattern.includes('://')) {
    return globToRegExp(pattern).test(u.href);
  }

  const cidr = pattern.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr) {
    const base = ipv4ToInt(cidr[1]);
    const host = ipv4ToInt(u.hostname);
    const bits = Number(cidr[2]);
    if (base === null || host === null || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((base & mask) >>> 0) === ((host & mask) >>> 0);
  }

  let mode = 'domain';
  if (pattern.startsWith('=')) {
    mode = 'exact';
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('*.')) {
    mode = 'subdomains';
    pattern = pattern.slice(2);
  }

  const slash = pattern.indexOf('/');
  let hostPart = slash === -1 ? pattern : pattern.slice(0, slash);
  const pathPart = slash === -1 ? '' : pattern.slice(slash);

  let port = null;
  const portMatch = hostPart.match(/^(.*):(\d+)$/);
  if (portMatch) {
    hostPart = portMatch[1];
    port = portMatch[2];
  }

  if (!hostMatches(u.hostname, hostPart, mode)) return false;
  if (port !== null) {
    const actualPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (actualPort !== port) return false;
  }
  if (pathPart) {
    const p = pathPart.toLowerCase();
    if (p.includes('*')) {
      if (!globToRegExp(p).test((u.pathname + u.search).toLowerCase())) return false;
    } else if (!u.pathname.toLowerCase().startsWith(p)) {
      return false;
    }
  }
  return true;
}

const INTERNAL_SCHEMES = new Set(['kb:', 'about:', 'data:', 'blob:']);

// policy = { mode: 'blocklist' | 'allowlist', rules: [{ pattern, action: 'allow'|'block', source }] }
// Rules are evaluated in order; the first match wins. Without a match the mode decides.
function evaluateUrl(url, policy) {
  const u = parseUrl(url);
  if (!u) return { allowed: false, reason: 'invalid-url', rule: null };
  if (INTERNAL_SCHEMES.has(u.protocol)) return { allowed: true, reason: 'internal', rule: null };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { allowed: false, reason: 'scheme', rule: null };
  }
  const rules = (policy && policy.rules) || [];
  for (const rule of rules) {
    if (rule && rule.enabled !== false && matchesPattern(u, rule.pattern)) {
      return { allowed: rule.action !== 'block', reason: 'rule', rule };
    }
  }
  const mode = (policy && policy.mode) || 'blocklist';
  return { allowed: mode !== 'allowlist', reason: 'default', rule: null };
}

function credentialMatches(url, credential) {
  return (credential.match || []).some((p) => matchesPattern(url, p));
}

module.exports = { matchesPattern, evaluateUrl, credentialMatches, globToRegExp };
