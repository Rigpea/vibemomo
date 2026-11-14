// Server-sent events hub: the UI subscribes once and receives change
// notifications; it then fetches the records it needs (no payload bloat).
const clients = new Set();

export function subscribe(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(type, payload = {}) {
  const line = `event: ${type}\ndata: ${JSON.stringify({ ...payload, ts: Date.now() })}\n\n`;
  for (const res of clients) {
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

export function clientCount() {
  return clients.size;
}
