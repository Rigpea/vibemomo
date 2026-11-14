// Live (docs/ARCHITECTURE.md section 20): a project's own server shown in the Workbench preview.
// Risks covered: a manifest entry outside the contract is refused with a reason; cwd cannot leave the project;
// the ready line accepts only http loopback URLs and ignores junk; a silent server fails after the timeout; the token
// never shows in the log or an answer, also when printed before the ready line; consent is keyed to the exact command
// and cwd, so a changed command asks again; start/stop of a FAKE server ends its whole process tree.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLive, launchOf, parseReadyLine, loopbackUrl, maskSecrets, maskUrl, createLogRing, consentKey, frameOrigin, createLive, serveLiveFrame } from '../server/lib/live.mjs';
import { createRunRegistry } from '../server/lib/runs.mjs';
import { alive } from '../server/lib/proc.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-live.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-live-'));
const projectDir = path.join(root, 'project');
fs.mkdirSync(path.join(projectDir, 'sub'), { recursive: true });
fs.copyFileSync(FAKE, path.join(projectDir, 'fake-live.mjs'));
const services = [];
after(async () => {
  for (const s of services) s.stopAll('test end');
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir */ }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

// ---------- manifest ----------
test('checkLive: absent is no entry, a valid entry is normalised', () => {
  assert.deepEqual(checkLive(undefined, projectDir), { live: null, problem: null });
  const { live, problem } = checkLive({ label: ' Live mode ', command: ['node', 'srv.js', '--atelier'] }, projectDir);
  assert.equal(problem, null);
  assert.deepEqual(live, { label: 'Live mode', command: ['node', 'srv.js', '--atelier'], cwd: '.' });
  assert.equal(checkLive({ command: ['node'] }, projectDir).live.label, 'Live');
});

test('checkLive: entries outside the contract are refused with a reason', () => {
  const problem = (entry) => checkLive(entry, projectDir).problem;
  assert.match(problem('node srv.js'), /must be an object/);
  assert.match(problem([]), /must be an object/);
  assert.match(problem({ command: ['node'], env: {} }), /live\.env is not part of the contract/);
  assert.match(problem({ command: 'node srv.js' }), /argv array/);
  assert.match(problem({ command: [] }), /argv array/);
  assert.match(problem({ command: ['node', 3] }), /command\[1\]/);
  assert.match(problem({ command: ['  '] }), /must not be empty/);
  assert.match(problem({ command: ['npm.cmd', 'start'] }), /not a \.cmd or \.bat/);
  assert.match(problem({ command: ['run.BAT'] }), /not a \.cmd or \.bat/);
  assert.match(problem({ command: ['node'], label: 'a\nb' }), /one line/);
  assert.match(problem({ command: ['node'], label: 'x'.repeat(121) }), /120/);
});

test('checkLive and launchOf: cwd stays inside the project', () => {
  const problem = (cwd) => checkLive({ command: ['node'], cwd }, projectDir).problem;
  assert.match(problem('..'), /leaves the project/);
  assert.match(problem('sub/../../elsewhere'), /leaves the project/);
  assert.match(problem(path.resolve(root)), /not an absolute path/);
  assert.match(problem('C:\\Windows'), /not an absolute path/);
  assert.match(problem('\\\\server\\share'), /not an absolute path/);
  assert.match(problem('.git'), /\.git or \.studio/);
  assert.match(problem('.studio/tasks'), /\.git or \.studio/);
  assert.equal(problem('sub'), null);
  assert.equal(problem('./sub/'), null);
  const l = launchOf({ command: ['node', 'srv.js'], cwd: 'sub' }, projectDir, '/the/studio/node');
  assert.deepEqual(l, { file: '/the/studio/node', args: ['srv.js'], cwd: path.join(projectDir, 'sub') });
  assert.equal(launchOf({ command: ['python', 'x.py'], cwd: '.' }, projectDir).file, 'python');
  assert.throws(() => launchOf({ command: ['node'], cwd: '..' }, projectDir), /escapes the project/);
});

// ---------- ready line ----------
test('parseReadyLine: loopback http URLs only; other output is not a ready line', () => {
  const ok = parseReadyLine('{"atelierLive":1,"url":"http://127.0.0.1:5173/#k=abcdef123"}');
  assert.equal(ok.url, 'http://127.0.0.1:5173/#k=abcdef123');
  assert.deepEqual(ok.secrets, ['k=abcdef123', 'abcdef123']);
  assert.equal(parseReadyLine('  {"atelierLive":1,"url":"http://localhost:9000/app/"}  ').url, 'http://localhost:9000/app/');
  // ordinary output and junk
  for (const line of ['', 'listening on 5173', '{"atelierLive":1, not json', '{"atelierLive":2,"url":"http://127.0.0.1:1/"}', '{"other":1}', '["atelierLive"]']) {
    assert.equal(parseReadyLine(line), null, line);
  }
  // claims to be ready, refused
  const refused = (url) => parseReadyLine(JSON.stringify({ atelierLive: 1, url }))?.error;
  assert.match(parseReadyLine('{"atelierLive":1}').error, /no url/);
  assert.match(refused('http://example.com:80/'), /not example\.com/);
  assert.match(refused('http://0.0.0.0:5173/'), /not 0\.0\.0\.0/);
  assert.match(refused('http://192.168.1.4:5173/'), /not 192\.168\.1\.4/);
  assert.match(refused('http://127.0.0.1.evil.com:80/'), /not 127\.0\.0\.1\.evil\.com/);
  assert.match(refused('https://127.0.0.1:5173/'), /only http/);
  assert.match(refused('file:///C:/x.html'), /only http/);
  assert.match(refused('http://127.0.0.1/'), /name its port/);
  assert.match(refused('http://me:pw@127.0.0.1:5173/'), /user or password/);
  assert.match(refused('not a url'), /does not parse/);
  assert.equal(loopbackUrl('http://localhost:1/').url.port, '1');
});

// ---------- masking ----------
test('maskSecrets: fragments, k= values and known secrets never show', () => {
  const t = 'deadbeefcafe';
  assert.equal(maskUrl(`http://127.0.0.1:5173/#k=${t}`), 'http://127.0.0.1:5173/#•••');
  assert.equal(maskSecrets(`open http://localhost:1/x?y=1#k=${t} now`), 'open http://localhost:1/x?y=1#••• now');
  assert.equal(maskSecrets(`{"atelierLive":1,"url":"http://127.0.0.1:2/#k=${t}"}`), '{"atelierLive":1,"url":"http://127.0.0.1:2/#•••"}');
  assert.equal(maskSecrets(`token ${t}`), `token ${t}`); // unknown yet
  assert.equal(maskSecrets(`token ${t}`, [t]), 'token •••');
  assert.equal(maskSecrets(`see #k=${t} and ?k=${t}&a=1`), 'see #k=••• and ?k=•••&a=1');
  assert.equal(maskUrl(null), null);
  const ring = createLogRing(3);
  ring.push('stdout', `token ${t}`, []);
  ring.push('stderr', 'x'.repeat(5000), []);
  ring.remask([t]);
  assert.equal(ring.all()[0].text, 'token •••');
  assert.ok(ring.all()[1].text.length <= 2001);
  for (let i = 0; i < 5; i++) ring.push('stdout', `line ${i}`, []);
  assert.equal(ring.size, 3);
  assert.equal(ring.all().at(-1).text, 'line 4');
});

test('frameOrigin: only this studio\'s loopback origins', () => {
  assert.equal(frameOrigin('http://localhost:4747', 4747), 'http://localhost:4747');
  assert.equal(frameOrigin('http://127.0.0.1:4747', 4747), 'http://127.0.0.1:4747');
  assert.equal(frameOrigin('http://evil.com', 4747), 'http://127.0.0.1:4747');
  assert.equal(frameOrigin('http://localhost:9999', 4747), 'http://127.0.0.1:4747');
  assert.equal(frameOrigin(null, 4800), 'http://127.0.0.1:4800');
});

test('serveLiveFrame: a 302 with no referrer when running, a 409 page when off', () => {
  const res = () => ({ head: null, body: null, writeHead(s, h) { this.head = { s, h }; }, end(b) { this.body = b; } });
  const on = res();
  serveLiveFrame(on, 'http://127.0.0.1:2/#k=abc');
  assert.equal(on.head.s, 302);
  assert.equal(on.head.h.Location, 'http://127.0.0.1:2/#k=abc');
  assert.equal(on.head.h['Referrer-Policy'], 'no-referrer');
  assert.equal(on.head.h['Cache-Control'], 'no-store');
  const off = res();
  serveLiveFrame(off, null);
  assert.equal(off.head.s, 409);
  assert.match(String(off.body), /Live is not running/);
});

// ---------- the service with a FAKE server ----------
function setup({ mode = 'ok', cwd = '.', readyTimeoutMs = 15000 } = {}) {
  const manifest = { kind: 'web-app', live: { label: 'Fake live', command: ['node', 'fake-live.mjs', `--mode=${mode}`], cwd } };
  const events = [];
  const runs = createRunRegistry();
  const consentFile = path.join(root, `consent-${Math.random().toString(36).slice(2)}.json`);
  const svc = createLive({
    loadProject: async (id) => { if (id !== 'p_one' && id !== 'p_two') throw Object.assign(new Error('nope'), { status: 404 }); return { path: projectDir, manifest }; },
    emit: (type, payload) => events.push({ type, payload }),
    runs, consentFile, port: 4747, studioDir: root, readyTimeoutMs,
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test-should-not-leak', FAKE_LIVE_TOKEN: 'tok3n5ecretvalue' },
  });
  services.push(svc);
  const allow = (id = 'p_one') => svc.allow(id, { command: manifest.live.command, cwd: manifest.live.cwd });
  return { svc, manifest, events, runs, consentFile, allow };
}
const settled = (svc, id = 'p_one') => until(async () => { const s = await svc.status(id); return s.state !== 'starting' ? s : null; });

test('consent: nothing starts without it, and a changed command or cwd asks again', async () => {
  const { svc, manifest, allow, consentFile } = setup();
  let s = await svc.status('p_one');
  assert.equal(s.state, 'off');
  assert.deepEqual(s.consent, { allowed: false, allowedAt: null, changed: false });
  await assert.rejects(svc.start('p_one'), (e) => e.status === 403 && e.code === 'live_consent_needed');
  // the click must be on what is in the manifest now
  await assert.rejects(svc.allow('p_one', { command: ['node', 'other.js'], cwd: '.' }), (e) => e.status === 409 && e.code === 'live_changed');
  s = await allow();
  assert.equal(s.consent.allowed, true);
  assert.ok(fs.existsSync(consentFile));
  assert.equal(consentKey({ folder: projectDir, command: ['a'], cwd: '.' }), consentKey({ folder: projectDir, command: ['a'], cwd: '.' }));
  assert.notEqual(consentKey({ folder: projectDir, command: ['a'], cwd: '.' }), consentKey({ folder: projectDir, command: ['a', 'b'], cwd: '.' }));
  assert.notEqual(consentKey({ folder: projectDir, command: ['a'], cwd: '.' }), consentKey({ folder: projectDir, command: ['a'], cwd: 'sub' }));
  manifest.live.command = [...manifest.live.command, '--extra'];
  s = await svc.status('p_one');
  assert.deepEqual([s.consent.allowed, s.consent.changed], [false, true]);
  await assert.rejects(svc.start('p_one'), (e) => e.status === 403 && /changed since you allowed it/.test(e.message));
  manifest.live.command.pop();
  assert.equal((await svc.status('p_one')).consent.allowed, true);
  manifest.live.cwd = 'sub';
  assert.equal((await svc.status('p_one')).consent.allowed, false);
  manifest.live.cwd = '.';
  s = await svc.forget('p_one');
  assert.equal(s.consent.allowed, false);
  // an invalid or absent entry cannot be allowed or started
  const saved = manifest.live;
  manifest.live = { command: ['node'], cwd: '..' };
  await assert.rejects(svc.start('p_one'), (e) => e.status === 400 && e.code === 'live_invalid');
  delete manifest.live;
  await assert.rejects(svc.allow('p_one', {}), (e) => e.status === 400 && e.code === 'live_not_declared');
  manifest.live = saved;
});

test('start and stop a FAKE live server: masked answers, the frame URL, the env, the whole tree ends', { timeout: 40000 }, async () => {
  const { svc, events, runs, allow } = setup();
  await allow();
  let s = await svc.start('p_one', { origin: 'http://localhost:4747' });
  assert.equal(s.state, 'starting');
  await assert.rejects(svc.start('p_one'), (e) => e.status === 409 && e.code === 'live_running');
  s = await settled(svc);
  assert.equal(s.state, 'running', s.reason);
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/#•••$/);
  const full = svc.frameUrl('p_one');
  assert.match(full, /#k=tok3n5ecretvalue$/);
  // the page answers, and allows exactly the studio's origin as frame-ancestor
  const res = await fetch(full);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Fake live server/);
  assert.equal(res.headers.get('content-security-policy'), 'frame-ancestors http://localhost:4747');
  // the token is nowhere in the status, the log or the events, also where it was printed before the ready line
  const text = JSON.stringify({ s, events, runs: runs.list() });
  assert.ok(!text.includes('tok3n5ecretvalue'), 'token leaked');
  const log = s.log.map((l) => l.text);
  assert.ok(log.includes('token •••'), log.join('\n'));
  assert.ok(log.some((l) => /^listening; open http:\/\/127\.0\.0\.1:\d+\/#••• in a browser$/.test(l)), log.join('\n'));
  assert.ok(log.includes('frame origin http://localhost:4747'));
  assert.ok(log.includes('api key in env: no'));
  assert.ok(s.log.some((l) => l.stream === 'stderr' && l.text === 'a line on stderr'));
  assert.ok(events.some((e) => e.type === 'live.changed' && e.payload.projectId === 'p_one'));
  const run = runs.list().runs.find((r) => r.kind === 'live');
  assert.equal(run.state, 'Working');
  assert.match(run.latest, /^serving 127\.0\.0\.1:\d+$/);
  const pid = s.pid;
  const grandchild = Number(log.find((l) => l.startsWith('grandchild ')).split(' ')[1]);
  assert.ok(alive(pid) && alive(grandchild));
  s = await svc.stop('p_one', 'you switched Live off');
  assert.equal(s.state, 'off');
  assert.equal(s.reason, 'you switched Live off');
  assert.equal(svc.frameUrl('p_one'), null);
  await until(() => !alive(pid) && !alive(grandchild), 8000);
  assert.equal(runs.list().runs.find((r) => r.kind === 'live').state, 'Stopped');
  // a restart is explicit: start again works once off
  s = await svc.start('p_one');
  s = await settled(svc);
  assert.equal(s.state, 'running');
  const pid2 = s.pid;
  assert.deepEqual(svc.stopOthers('p_two'), ['p_one']);
  assert.equal((await svc.status('p_one')).reason, 'the project was closed');
  await until(() => !alive(pid2), 8000);
});

test('failures: no ready line in time, a non-loopback URL, a junk ready line, an early exit; each ends the process', { timeout: 40000 }, async () => {
  const cases = [
    ['silent', /no ready line within 1 s/],
    ['evil', /refused: only 127\.0\.0\.1 or localhost is accepted, not example\.com/],
    ['junk', /refused: the URL does not parse/],
    ['exit', /exited before it was ready \(code 3\)/],
  ];
  for (const [mode, reason] of cases) {
    const { svc, allow, runs } = setup({ mode, readyTimeoutMs: 1000 });
    await allow();
    const started = await svc.start('p_one');
    const pid = started.pid;
    const s = await settled(svc);
    assert.equal(s.state, 'failed', mode);
    assert.match(s.reason, reason, mode);
    assert.equal(svc.frameUrl('p_one'), null);
    assert.ok(!JSON.stringify(s).includes('tok3n5ecretvalue'), `${mode}: token leaked`);
    if (pid) await until(() => !alive(pid), 8000);
    assert.equal(runs.list().runs.find((r) => r.kind === 'live').state, 'Failed');
    // off clears the failure
    assert.equal((await svc.stop('p_one', 'you switched Live off')).state, 'off');
  }
});

test('a program that does not exist fails with its reason', async () => {
  const { svc, manifest, allow } = setup();
  manifest.live.command = ['atelier-no-such-program-xyz'];
  await allow();
  await svc.start('p_one');
  const s = await settled(svc);
  assert.equal(s.state, 'failed');
  assert.match(s.reason, /could not start atelier-no-such-program-xyz: ENOENT/);
});

test('stopAll ends every running live server (the studio quits)', { timeout: 30000 }, async () => {
  const { svc, allow } = setup();
  await allow('p_one');
  await allow('p_two');
  await svc.start('p_one');
  await svc.start('p_two');
  const a = await settled(svc, 'p_one');
  const b = await settled(svc, 'p_two');
  assert.deepEqual([a.state, b.state], ['running', 'running']);
  assert.deepEqual(svc.stopAll('the studio quit').sort(), ['p_one', 'p_two']);
  await until(() => !alive(a.pid) && !alive(b.pid), 8000);
  assert.equal((await svc.status('p_two')).reason, 'the studio quit');
});

// ---------- the switch's words (client/components/live-words.js) ----------
test('liveWords: the four states in words, with the reason; an invalid entry says why', async () => {
  const { liveWords, argvText, hostOf, liveFrameUrl } = await import('../client/components/live-words.js');
  assert.deepEqual(liveWords(null), { state: 'off', chip: 'Off', reason: null, tone: 'neutral' });
  assert.deepEqual(liveWords({ state: 'off', reason: 'you switched Live off' }), { state: 'off', chip: 'Off', reason: null, tone: 'neutral' });
  assert.equal(liveWords({ state: 'off', reason: 'the project was closed' }).reason, 'the project was closed');
  assert.deepEqual(liveWords({ state: 'starting' }), { state: 'starting', chip: 'Starting', reason: 'waiting for its ready line', tone: 'busy' });
  assert.deepEqual(liveWords({ state: 'running', url: 'http://127.0.0.1:5173/#•••' }), { state: 'running', chip: 'Running', reason: '127.0.0.1:5173', tone: 'ok' });
  assert.match(liveWords({ state: 'running', url: 'http://127.0.0.1:5173/#•••', stale: true }).reason, /^127\.0\.0\.1:5173 · atelier\.json changed/);
  assert.deepEqual(liveWords({ state: 'failed', reason: 'no ready line within 20 s' }), { state: 'failed', chip: 'Failed', reason: 'no ready line within 20 s', tone: 'danger' });
  assert.deepEqual(liveWords({ state: 'off', problem: 'live.cwd leaves the project folder: ..' }), { state: 'invalid', chip: 'Invalid', reason: 'live.cwd leaves the project folder: ..', tone: 'warn' });
  assert.equal(liveWords({ state: 'running', problem: 'x', url: 'http://localhost:1/' }).state, 'running'); // a running process is still shown as running
  assert.equal(argvText(['node', 'my app/server.js', '--atelier', '', 'say "hi"']), 'node "my app/server.js" --atelier "" "say \\"hi\\""');
  assert.equal(hostOf('nope'), null);
  assert.match(liveFrameUrl('p_a b'), /^\/live\/p_a%20b\?t=\d+$/);
});
