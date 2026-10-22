'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { matchesPattern, evaluateUrl, inSchedule, parseSchedule, dlpFor } = require('../src/match');

test('domain patterns include subdomains', () => {
  assert.ok(matchesPattern('https://example.com/', 'example.com'));
  assert.ok(matchesPattern('https://www.example.com/a', 'example.com'));
  assert.ok(!matchesPattern('https://badexample.com/', 'example.com'));
  assert.ok(!matchesPattern('https://example.com.evil.net/', 'example.com'));
});

test('subdomain-only, exact and port patterns', () => {
  assert.ok(!matchesPattern('https://example.com/', '*.example.com'));
  assert.ok(matchesPattern('https://a.example.com/', '*.example.com'));
  assert.ok(matchesPattern('https://example.com/', '=example.com'));
  assert.ok(!matchesPattern('https://www.example.com/', '=example.com'));
  assert.ok(matchesPattern('http://intranet:8080/x', 'intranet:8080'));
  assert.ok(!matchesPattern('http://intranet/x', 'intranet:8080'));
});

test('path, glob and CIDR patterns', () => {
  assert.ok(matchesPattern('https://youtube.com/shorts/abc', 'youtube.com/shorts'));
  assert.ok(!matchesPattern('https://youtube.com/watch', 'youtube.com/shorts'));
  assert.ok(matchesPattern('https://a.b.com/x/y?z=1', 'https://*.b.com/x/*'));
  assert.ok(matchesPattern('http://192.168.1.20/', '192.168.1.0/24'));
  assert.ok(!matchesPattern('http://192.168.2.20/', '192.168.1.0/24'));
  assert.ok(matchesPattern('https://anything.org/', '*'));
});

test('evaluateUrl honours first-match order and mode', () => {
  const policy = {
    mode: 'allowlist',
    rules: [
      { pattern: 'mail.google.com', action: 'block' },
      { pattern: 'google.com', action: 'allow' },
    ],
  };
  assert.strictEqual(evaluateUrl('https://www.google.com/', policy).allowed, true);
  assert.strictEqual(evaluateUrl('https://mail.google.com/', policy).allowed, false);
  assert.strictEqual(evaluateUrl('https://facebook.com/', policy).allowed, false);
  assert.strictEqual(evaluateUrl('https://facebook.com/', { mode: 'blocklist', rules: [] }).allowed, true);
  assert.strictEqual(evaluateUrl('kb://newtab', policy).allowed, true);
  assert.strictEqual(evaluateUrl('file:///etc/passwd', { mode: 'blocklist', rules: [] }).allowed, false);
  assert.strictEqual(evaluateUrl('javascript:alert(1)', { mode: 'blocklist', rules: [] }).allowed, false);
  assert.strictEqual(
    evaluateUrl('https://x.com/', { mode: 'blocklist', rules: [{ pattern: 'x.com', action: 'block', enabled: false }] }).allowed,
    true
  );
});

test('categories, schedules and expiry', () => {
  assert.ok(matchesPattern('https://www.instagram.com/x', 'category:social'));
  assert.ok(matchesPattern('https://m.youtube.com/', 'category:video'));
  assert.ok(!matchesPattern('https://example.com/', 'category:social'));
  assert.ok(!matchesPattern('https://example.com/', 'category:nope'));

  // Wednesday 2026-10-21 10:30 local time
  const wed = new Date(2026, 9, 21, 10, 30);
  const sat = new Date(2026, 9, 24, 10, 30);
  assert.ok(inSchedule('Mon-Fri 09:00-18:00', wed));
  assert.ok(!inSchedule('Mon-Fri 09:00-18:00', sat));
  assert.ok(inSchedule('Sat,Sun', sat));
  assert.ok(!inSchedule('13:00-14:00', wed));
  assert.ok(inSchedule('22:00-06:00', new Date(2026, 9, 21, 2, 0)));
  assert.throws(() => parseSchedule('Funday 10:00-11:00'));

  const policy = { mode: 'blocklist', rules: [{ pattern: 'category:video', action: 'block', schedule: 'Mon-Fri 09:00-18:00' }] };
  assert.strictEqual(evaluateUrl('https://youtube.com/', policy, wed).allowed, false);
  assert.strictEqual(evaluateUrl('https://youtube.com/', policy, sat).allowed, true);

  const expired = { mode: 'allowlist', rules: [{ pattern: 'x.com', action: 'allow', expiresAt: '2000-01-01T00:00:00Z' }] };
  assert.strictEqual(evaluateUrl('https://x.com/', expired).allowed, false);
});

test('DLP rules combine per URL', () => {
  const rules = [
    { match: ['crm.example.com'], blockCopy: true, watermark: true },
    { match: ['example.com'], blockDownload: true },
    { match: ['other.com'], blockPrint: true },
  ];
  assert.deepStrictEqual(dlpFor('https://crm.example.com/a', rules), { blockCopy: true, watermark: true, blockDownload: true });
  assert.deepStrictEqual(dlpFor('https://nothing.org/', rules), {});
});

test('browser copy of match.js is identical', () => {
  const a = fs.readFileSync(path.join(__dirname, '..', 'src', 'match.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '..', '..', 'browser', 'src', 'main', 'match.js'), 'utf8');
  assert.strictEqual(b.replace(/^\/\/ NOTE:.*\n.*\n/m, ''), a.replace(/^\/\/ NOTE:.*\n.*\n/m, ''));
});
