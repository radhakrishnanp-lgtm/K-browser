'use strict';
const crypto = require('crypto');
const fs = require('fs');

const SCRYPT = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomPassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// AES-256-GCM vault for site credentials. The master key lives in the data
// directory (mode 0600) unless KB_MASTER_KEY (base64, 32 bytes) is provided.
class Vault {
  constructor(keyFile, envKey = process.env.KB_MASTER_KEY) {
    if (envKey) {
      this.key = Buffer.from(envKey, 'base64');
    } else if (fs.existsSync(keyFile)) {
      this.key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    } else {
      this.key = crypto.randomBytes(32);
      fs.writeFileSync(keyFile, this.key.toString('base64'), { mode: 0o600 });
    }
    if (this.key.length !== 32) throw new Error('Vault master key must be 32 bytes');
  }

  encrypt(plaintext) {
    if (plaintext === undefined || plaintext === null || plaintext === '') return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  decrypt(blob) {
    if (!blob) return '';
    if (!blob.startsWith('v1:')) throw new Error('Unknown vault format');
    const raw = Buffer.from(blob.slice(3), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// RFC 6238 TOTP, used to fill two-factor codes for shared accounts.
function totp(secret, { time = Date.now(), step = 30, digits = 6, algorithm = 'sha1' } = {}) {
  const counter = Math.floor(time / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algorithm, base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, randomPassword, Vault, totp, base32Decode };
