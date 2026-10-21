'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPassword, verifyPassword, Vault, totp } = require('../src/crypto');

test('password hashing round-trips', () => {
  const h = hashPassword('s3cret!');
  assert.ok(verifyPassword('s3cret!', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('s3cret!', 'garbage'));
});

test('vault encrypts and detects tampering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kbv-'));
  const v = new Vault(path.join(dir, 'k'), '');
  const blob = v.encrypt('hunter2');
  assert.notStrictEqual(blob, 'hunter2');
  assert.strictEqual(v.decrypt(blob), 'hunter2');
  assert.strictEqual(new Vault(path.join(dir, 'k'), '').decrypt(blob), 'hunter2');
  const raw = Buffer.from(blob.slice(3), 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => v.decrypt('v1:' + raw.toString('base64')));
});

test('TOTP matches RFC 6238 test vector', () => {
  // RFC 6238 SHA1 secret "12345678901234567890" in base32
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.strictEqual(totp(secret, { time: 59 * 1000, digits: 8 }), '94287082');
  assert.strictEqual(totp(secret, { time: 1111111109 * 1000, digits: 8 }), '07081804');
});
