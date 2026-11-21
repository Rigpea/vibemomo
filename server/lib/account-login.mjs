// User-approved launches of the official account CLIs. The confirmation page has its own loopback origin.
// Claude Code's provider flow: https://code.claude.com/docs/en/authentication
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const accounts = new Map([
  ['claude', { name: 'Claude Code', args: ['auth', 'login', '--claudeai'], command: 'claude auth login --claudeai' }],
  ['codex', { name: 'ChatGPT in Codex', args: ['login'], command: 'codex login' }],
]);
const messages = {
  cancelled: 'Sign-in was cancelled.',
  pending: 'Finish signing in with your provider in the browser.',
  complete: 'The CLI finished. Return to Settings and choose Check accounts to confirm the sign-in.',
  failed: 'The CLI could not complete sign-in.',
  timeout: 'This sign-in timed out. You can try again.',
  missing: 'The studio could not launch the installed CLI directly.',
};

// A provider only needs OS, browser, network and CLI configuration. Project variables, API
// keys and agent-session variables must never enter this process or the browser it opens.
export function loginEnvironment(env) {
  const keep = /^(?:PATH|PATHEXT|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USERNAME|USER|LOGNAME|SHELL|TMP|TEMP|TMPDIR|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|LANG|LANGUAGE|LC_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_(?:CONFIG_HOME|CACHE_HOME|DATA_HOME|RUNTIME_DIR|CURRENT_DESKTOP|SESSION_TYPE|DATA_DIRS)|DBUS_SESSION_BUS_ADDRESS|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_(?:FILE|DIR)|NODE_EXTRA_CA_CERTS|CLAUDE_CONFIG_DIR|CODEX_HOME)$/i;
  return Object.fromEntries(Object.entries(env).filter(([name]) => keep.test(name)));
}

function launch(bin, provider) {
  const args = accounts.get(provider).args;
  // Resolve official npm shims directly, without sending any path or argument through a shell.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const entry = provider === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js';
    bin = path.join(path.dirname(bin), 'node_modules', entry);
    if (!existsSync(bin)) return null;
  }
  const js = /\.m?js$/i.test(bin);
  return spawn(js ? process.execPath : bin, js ? [bin, ...args] : args, {
    cwd: os.homedir(), env: loginEnvironment(process.env), shell: false, windowsHide: true, stdio: 'ignore',
  });
}

const headers = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
};

function page(provider, state) {
  const { name, command } = accounts.get(provider);
  const pending = state === 'pending';
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    (pending ? '<meta http-equiv="refresh" content="3">' : '') +
    '<title>' + name + ' sign-in · vibeMomo</title><style>html{color-scheme:light dark;font:100%/1.6 system-ui}main{max-width:32rem;margin:12vh auto;padding:1.5rem}button{font:inherit;padding:.35em .85em;cursor:pointer}code{overflow-wrap:anywhere}</style>' +
    '<main><small>vibeMomo · Account settings</small><h1>Sign in with ' + name + '</h1><p>' +
    (messages[state] || 'Continue to open the provider’s sign-in in your browser. The installed CLI will save the login on this computer.') +
    '</p>' + (pending ? '<form method="post" action="/' + provider + '/cancel"><button>Cancel sign-in</button></form>' : state === 'complete' ? '' : '<form method="post" action="/' + provider + '"><button>Continue to ' + name + '</button></form>') +
    '<p>If the browser does not open or asks for a code, cancel any pending sign-in and run <code>' + command +
    '</code> in your own terminal. Return to Settings and choose <b>Check accounts</b>.</p></main></html>';
}

export function createAccountLogin({ resolveBinary, launchCli = launch, timeoutMs = 5 * 60_000 }) {
  const runs = new Map();
  let listening, origin, closed = false;
  function finish(run, state) {
    if (run.state !== 'pending') return;
    clearTimeout(run.timer);
    run.state = state;
    run.child = null;
  }
  async function start(provider) {
    if (runs.get(provider)?.state === 'pending') return;
    const run = { state: 'pending', child: null, timer: null };
    runs.set(provider, run);
    try {
      const bin = await resolveBinary(provider);
      if (closed || run.state !== 'pending') return;
      const child = bin && launchCli(bin, provider);
      if (!child) return finish(run, 'missing');
      run.child = child;
      child.once('error', () => finish(run, 'failed'));
      child.once('exit', code => finish(run, code === 0 ? 'complete' : 'failed'));
      run.timer = setTimeout(() => { finish(run, 'timeout'); child.kill(); }, timeoutMs);
      run.timer.unref();
    } catch { finish(run, 'failed'); }
  }
  const server = http.createServer(async (req, res) => {
    const respond = (code, body = '', extra = {}) => { res.writeHead(code, { ...headers, ...extra }); res.end(body); };
    if ('http://' + req.headers.host !== origin) return respond(403);
    const match = /^\/(claude|codex)(\/(?:status|cancel))?$/.exec(req.url);
    if (!match) return respond(404);
    const [, provider, action] = match;
    if (req.method === 'GET') {
      if (action === '/cancel') return respond(405);
      const state = runs.get(provider)?.state;
      return respond(200, page(provider, (action === '/status' || state === 'pending') ? state : null));
    }
    if (req.method !== 'POST' || action === '/status') return respond(405);
    // Only the form on this isolated origin can start a CLI. No CORS or account callbacks are served here.
    if (req.headers.origin !== origin || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return respond(403);
    if (action === '/cancel') {
      const run = runs.get(provider);
      if (run?.state === 'pending') {
        const child = run.child;
        finish(run, 'cancelled');
        child?.kill();
      }
    } else await start(provider);
    respond(303, '', { Location: '/' + provider + '/status' });
  });
  return {
    listen() {
      if (!listening) listening = new Promise((resolve, reject) => {
        const fail = err => { listening = null; reject(err); };
        server.once('error', fail);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', fail);
          origin = 'http://127.0.0.1:' + server.address().port;
          resolve(origin);
        });
      });
      return listening;
    },
    close() {
      closed = true;
      for (const run of runs.values()) { clearTimeout(run.timer); run.child?.kill(); }
      if (server.listening) { server.close(); server.closeAllConnections(); }
    },
  };
}
