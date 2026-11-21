import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAccountLogin, loginEnvironment } from '../server/lib/account-login.mjs';

test('confirmation is isolated, user initiated, deduplicated and cancellable', async t => {
  const launched = [];
  const helper = createAccountLogin({
    resolveBinary: async name => '/installed/' + name,
    launchCli(bin, provider) {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; child.emit('exit', 1); };
      launched.push({ bin, provider, child });
      return child;
    },
  });
  t.after(() => helper.close());
  const [origin, again] = await Promise.all([helper.listen(), helper.listen()]);
  assert.equal(origin, again);
  const post = (route, headers = { origin }) => fetch(origin + route, { method: 'POST', redirect: 'manual', headers });
  for (const name of ['claude', 'codex']) {
    const confirm = await fetch(origin + '/' + name);
    assert.equal(confirm.status, 200);
    assert.match(confirm.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(confirm.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(confirm.headers.get('access-control-allow-origin'), null);
    assert.match(await confirm.text(), /Continue to/);
  }
  assert.equal((await post('/codex', {})).status, 403);
  assert.equal((await post('/claude', { origin: 'http://localhost:4747' })).status, 403);
  assert.equal((await post('/codex', { origin, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post('/other')).status, 404);
  assert.equal(launched.length, 0);
  for (const provider of ['claude', 'codex']) {
    const url = '/' + provider;
    const replies = await Promise.all([post(url), post(url)]);
    assert.ok(replies.every(r => r.status === 303 && r.headers.get('location') === url + '/status'));
    assert.equal(launched.filter(r => r.provider === provider).length, 1);
    assert.match(await (await fetch(origin + url + '/status')).text(), /Cancel sign-in/);
  }
  launched[0].child.emit('exit', 0);
  assert.match(await (await fetch(origin + '/claude/status')).text(), /CLI finished/);
  assert.equal((await post('/codex/cancel')).status, 303);
  assert.equal(launched[1].child.killed, true);
  assert.match(await (await fetch(origin + '/codex/status')).text(), /was cancelled/);
});

test('missing CLI and timeout offer recovery without exposing command output', async t => {
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const helper = createAccountLogin({ resolveBinary: async p => p === 'claude' ? null : '/installed/codex', launchCli: () => child, timeoutMs: 10 });
  t.after(() => helper.close());
  const origin = await helper.listen();
  for (const p of ['claude', 'codex']) await fetch(origin + '/' + p, { method: 'POST', headers: { origin } });
  assert.match(await (await fetch(origin + '/claude/status')).text(), /could not launch/);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(child.killed, true);
  assert.match(await (await fetch(origin + '/codex/status')).text(), /timed out/);
});

test('the login process inherits OS and CLI locations without project or agent credentials', () => {
  const kept = { Path: '/bin', home: '/home/user', CODEX_HOME: '/codex', CLAUDE_CONFIG_DIR: '/claude', DISPLAY: ':0' };
  const credentials = { OpenAI_Api_Key: 'fixture', CLAUDE_CODE_OAUTH_TOKEN: 'fixture', ANTHROPIC_AUTH_TOKEN: 'fixture',
    GITHUB_TOKEN: 'fixture', CUSTOM_SECRET: 'fixture', NODE_OPTIONS: 'fixture', BROWSER: 'fixture', SSH_AUTH_SOCK: 'fixture' };
  assert.deepEqual(loginEnvironment({ ...kept, ...credentials }), kept);
});
