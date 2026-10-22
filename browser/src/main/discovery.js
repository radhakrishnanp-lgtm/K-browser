'use strict';
const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 41234;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

// Broadcasts a probe on the LAN and collects K-Browser servers that answer.
function discoverServers({ timeoutMs = 1800 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    const finish = () => {
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const info = JSON.parse(msg.toString('utf8'));
        if (info.type !== 'KB_SERVER_V1') return;
        // One entry per server; prefer its LAN address over loopback.
        const prev = found.get(info.fingerprint);
        if (prev && !prev.url.includes('://127.')) return;
        const url = `https://${rinfo.address}:${info.port}`;
        found.set(info.fingerprint, { url, name: info.name, fingerprint: info.fingerprint, version: info.version });
      } catch {
        // ignore unrelated packets
      }
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const probe = Buffer.from('KB_DISCOVER_V1');
      for (const addr of broadcastAddresses()) sock.send(probe, DISCOVERY_PORT, addr, () => {});
      sock.send(probe, DISCOVERY_PORT, '127.0.0.1', () => {});
      setTimeout(finish, timeoutMs);
    });
  });
}

module.exports = { discoverServers };
