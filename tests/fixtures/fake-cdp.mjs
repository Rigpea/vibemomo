// A fake WebView DevTools endpoint for the inspect tests: GET /json lists one page, and a minimal WebSocket
// server (handshake, unfragmented text frames) answers the CDP methods inspect sends. No dependency.
import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function textFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function readFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    const masked = buf[off + 1] & 0x80;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (buf.length < p + (masked ? 4 : 0) + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/**
 * view: what Runtime.evaluate returns; element: what Runtime.callFunctionOn returns (null: no node at the point).
 * received lists every { method, params } in order, for the assertions.
 */
export async function startFakeCdp({ view = { dpr: 1, innerHeight: 18, innerWidth: 10, hash: '#/start' }, element = { tag: 'button', id: 'start', classes: ['btn', 'primary'], text: 'Start the round now', selector: '#start', url: 'https://localhost/#/start' } } = {}) {
  const received = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (req.url === '/json' || req.url === '/json/list') {
      const body = JSON.stringify([
        { type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/0` },
        { type: 'page', url: 'https://localhost/#/start', description: '{"attached":true,"visible":true}', webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/1` },
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
  const answer = (method, params) => {
    if (method === 'Runtime.evaluate') return { result: { type: 'object', value: view } };
    if (method === 'DOM.getDocument') return { root: { nodeId: 1, backendNodeId: 1, nodeName: '#document' } };
    if (method === 'DOM.getNodeForLocation') return element ? { backendNodeId: 42, nodeId: 0, frameId: 'F1' } : {};
    if (method === 'DOM.describeNode') return { node: { nodeId: 0, backendNodeId: params.backendNodeId, nodeName: 'BUTTON', localName: 'button' } };
    if (method === 'DOM.resolveNode') return { object: { type: 'object', objectId: 'obj-42' } };
    if (method === 'Runtime.callFunctionOn') return { result: { type: 'object', value: element } };
    return null;
  };
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 8) { socket.end(Buffer.from([0x88, 0])); continue; }
        if (f.opcode !== 1) continue;
        const msg = JSON.parse(f.payload.toString('utf8'));
        received.push({ method: msg.method, params: msg.params });
        const result = answer(msg.method, msg.params || {});
        socket.write(textFrame(JSON.stringify(result ? { id: msg.id, result } : { id: msg.id, error: { code: -32601, message: `${msg.method} not found` } })));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    received,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
