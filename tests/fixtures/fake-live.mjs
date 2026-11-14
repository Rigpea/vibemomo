// A FAKE live server for tests/live.test.mjs and the screenshot driver (scripts/ui-check/verify-live.cjs).
// --mode=ok (default): starts a grandchild that only sleeps (so a stop must end the whole tree), prints its token on a
// line of its own before the ready line (so masking must apply to lines already logged), serves a page on 127.0.0.1
// and prints the ready line. Other modes: silent (never ready), evil (a non-loopback URL), junk (a ready line
// without a URL that parses), exit (exits with code 3 before it is ready).
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=ok').slice('--mode='.length);
const token = process.env.FAKE_LIVE_TOKEN || crypto.randomBytes(12).toString('hex');
const say = (line) => process.stdout.write(`${line}\n`);

say(`fake live starting in ${process.cwd()}`);
say(`frame origin ${process.env.ATELIER_FRAME_ORIGIN || 'none'}`);
say(`api key in env: ${process.env.ANTHROPIC_API_KEY || process.env.STUDIO_ANTHROPIC_API_KEY ? 'yes' : 'no'}`);
process.stderr.write('a line on stderr\n');

const keep = setInterval(() => {}, 1 << 30);
if (mode === 'silent') {
  // never ready
} else if (mode === 'exit') {
  clearInterval(keep);
  process.exit(3);
} else if (mode === 'evil') {
  say(JSON.stringify({ atelierLive: 1, url: `http://example.com:8080/#k=${token}` }));
} else if (mode === 'junk') {
  say('{"atelierLive":1, this is not json');
  say(JSON.stringify({ atelierLive: 1, url: 'not a url' }));
} else {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true });
  say(`grandchild ${grandchild.pid}`);
  say(`token ${token}`);
  const origin = process.env.ATELIER_FRAME_ORIGIN || '';
  const server = http.createServer((req, res) => {
    const page = `<!doctype html><meta charset="utf-8"><title>Fake live</title><body style="font:16px system-ui;background:#0f2a1d;color:#d8f5e4;margin:0;display:grid;place-items:center;height:100vh"><main><h1>Fake live server</h1><p>Served by a process the studio started; it can save files and open terminals the static preview cannot.</p><p id="hash"></p></main><script>document.getElementById('hash').textContent = location.hash ? 'Token received in the fragment.' : 'No token.';</script></body>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `frame-ancestors ${origin || "'none'"}` });
    res.end(page);
  });
  server.listen(0, '127.0.0.1', () => {
    say(`listening; open http://127.0.0.1:${server.address().port}/#k=${token} in a browser`);
    say(JSON.stringify({ atelierLive: 1, url: `http://127.0.0.1:${server.address().port}/#k=${token}` }));
  });
}
