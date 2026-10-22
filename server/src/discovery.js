'use strict';
const dgram = require('dgram');

const DISCOVERY_PORT = 41234;
const REQUEST = 'KB_DISCOVER_V1';

// Answers LAN broadcast probes from browsers so staff do not need to type the server address.
function startDiscovery({ port = DISCOVERY_PORT, describe }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== REQUEST) return;
    const reply = Buffer.from(JSON.stringify({ type: 'KB_SERVER_V1', ...describe() }));
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', (err) => {
    console.warn(`LAN discovery disabled: ${err.message}`);
    sock.close();
  });
  sock.bind(port);
  return sock;
}

module.exports = { startDiscovery, DISCOVERY_PORT, REQUEST };
