// The companion's MCP server (docs/ARCHITECTURE.md section 11). Risks covered: the hand-written protocol answers
// what a client expects (initialize, ping, tools/list, tools/call, notifications, unknown methods, parse errors);
// a failing or refused tool is an isError result, never a crash; every tool works against the real studio API (a
// server process on a private port with the fake adb, as tests/http.test.mjs starts it) and names its project;
// read_file's guard keeps paths inside the project and out of .git and .studio; the screenshot is an image block;
// studio_show reaches the event stream; a studio that does not answer gives every tool the same sentence; the bin
// speaks over stdio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handleMessage, serveStdio, checkArgs, PROTOCOL_VERSION } from '../server/lib/mcp/stdio.mjs';
import { createTools, checkRel, numberLines, diffOfPath, pageRefs, importSpecs, resolveRef, unreachable, MEMORY_KINDS, FILE_LINES } from '../server/lib/mcp/tools.mjs';
import { KINDS } from '../server/lib/memory.mjs';
import { startFakeCdp } from './fixtures/fake-cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

let n = 0;
const rpc = (method, params) => ({ jsonrpc: '2.0', id: ++n, method, ...(params ? { params } : {}) });
const textOf = (res) => res.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// ---------- every tool against the real studio API ----------
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-mcp-'));
let child;
let cdp;
let projectId;
let projectName;
let other; // a second project, named explicitly
let tools;
const call = async (name, args = {}) => handleMessage(rpc('tools/call', { name, arguments: args }), { tools });
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};

before(async () => {
  await fsp.mkdir(path.join(root, 'projects'), { recursive: true });
  // The person's own skills, for atelier_list_skills: three, placed through the studio's route once it runs.
  for (const [name, description] of [['tidy-copy', 'Rewrite interface copy so it reads plainly. Use for labels and errors.'], ['grid-check', 'Check a layout grid against its spacing scale.'], ['lonely-skill', 'Nobody placed this one yet.']]) {
    await fsp.mkdir(path.join(root, 'claude', 'skills', name), { recursive: true });
    await fsp.writeFile(path.join(root, 'claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  }
  cdp = await startFakeCdp();
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects'), ATELIER_PID_FILE: path.join(root, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs'), ATELIER_ADB: `"${process.execPath}" "${path.join(ROOT, 'tests', 'fixtures', 'fake-adb.mjs')}"`, FAKE_ADB_CDP_PORT: String(cdp.port) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', (code) => { exit = code; });
  const t0 = Date.now();
  let up = false;
  while (exit === null && Date.now() - t0 < 30000) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) throw new Error(`server did not start on port ${PORT} after ${Date.now() - t0} ms (exit ${exit}): ${stderr.slice(-500)}`);
  const made = await api('POST', '/api/projects', { name: 'Mcp Room', kind: 'game', template: 'game-room-one' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  projectId = made.data.project.id;
  projectName = made.data.project.name;
  other = (await api('POST', '/api/projects', { name: 'Other Notes', kind: 'web-app', template: 'web-app-notes' })).data.project;
  // A phone for the look tools (the fake adb answers for com.example.probe), and a module the page imports.
  await api('PUT', `/api/projects/${projectId}/files`, { path: 'capacitor.config.json', content: JSON.stringify({ appId: 'com.example.probe', webDir: 'src' }) });
  await api('PUT', `/api/projects/${projectId}/files`, { path: 'src/boot.js', content: "import { start } from './game-start.js';\nimport lit from 'lit';\nstart();\n" });
  const index = (await api('GET', `/api/projects/${projectId}/files?path=src/index.html`)).data.content;
  await api('PUT', `/api/projects/${projectId}/files`, { path: 'src/index.html', content: index.replace('</body>', '  <button id="start" class="btn primary">Start the round now</button>\n  <script type="module" src="boot.js"></script>\n</body>') });
  tools = createTools({ studio: BASE, project: projectId });
});

after(async () => {
  child?.kill();
  await cdp?.close();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

// ---------- the plumbing, on a stub tool table ----------
const STUB = [
  { name: 'stub_echo', description: 'Echo.', inputSchema: { type: 'object', properties: { say: { type: 'string', minLength: 1 }, times: { type: 'integer', minimum: 1 }, how: { type: 'string', enum: ['loud', 'soft'] } }, required: ['say'], additionalProperties: false }, run: async (a) => `${a.say}`.repeat(a.times ?? 1) },
  { name: 'stub_fail', description: 'Fails.', inputSchema: { type: 'object', properties: {} }, run: async () => { throw new Error('the studio said no'); } },
];
const opts = { tools: STUB, serverInfo: { name: 'atelier', version: '9.9.9' } };

test('initialize answers protocol 2025-06-18, tools capability and serverInfo; ping answers {}; a notification gets no answer', async () => {
  const init = await handleMessage(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }), opts);
  assert.equal(init.jsonrpc, '2.0');
  assert.deepEqual(init.result, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'atelier', version: '9.9.9' } });
  assert.equal(PROTOCOL_VERSION, '2025-06-18');
  const ping = await handleMessage(rpc('ping'), opts);
  assert.deepEqual(ping.result, {});
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 7, result: {} }, opts), null, 'a response from the client asks nothing');
});

test('unknown methods answer -32601; an unknown tool -32602; a message that is not JSON-RPC 2.0 -32600; a batch is refused', async () => {
  const m = rpc('resources/list');
  const res = await handleMessage(m, opts);
  assert.equal(res.id, m.id);
  assert.equal(res.error.code, -32601);
  assert.match(res.error.message, /resources\/list/);
  assert.equal((await handleMessage(rpc('tools/call', { name: 'nope', arguments: {} }), opts)).error.code, -32602);
  assert.equal((await handleMessage({ id: 1, method: 'ping' }, opts)).error.code, -32600);
  assert.equal((await handleMessage([rpc('ping')], opts)).error.code, -32600);
});

test('a failing tool and bad arguments answer a result with isError true and a text block', async () => {
  const fail = await handleMessage(rpc('tools/call', { name: 'stub_fail', arguments: {} }), opts);
  assert.deepEqual(fail.result, { content: [{ type: 'text', text: 'the studio said no' }], isError: true });
  for (const [args, words] of [[{}, /say is required/], [{ say: 5 }, /say must be a string/], [{ say: 'a', times: 0 }, /at least 1/], [{ say: 'a', how: 'odd' }, /one of loud, soft/], [{ say: 'a', extra: 1 }, /extra is not an argument/], [{ say: '  ' }, /must not be empty/]]) {
    const r = await handleMessage(rpc('tools/call', { name: 'stub_echo', arguments: args }), opts);
    assert.equal(r.result.isError, true, JSON.stringify(args));
    assert.match(textOf(r), words);
  }
  const ok = await handleMessage(rpc('tools/call', { name: 'stub_echo', arguments: { say: 'ab', times: 2 } }), opts);
  assert.deepEqual(ok.result, { content: [{ type: 'text', text: 'abab' }] });
  assert.equal(checkArgs({ type: 'object', properties: { list: { type: 'array', items: { type: 'string' } } } }, { list: ['a', 2] }), 'every entry of list must be a string');
});

test('serveStdio: one message per line in, one answer per line out; a bad line answers -32700; stderr is not touched', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => { out += d; });
  const done = serveStdio({ input, output, ...opts });
  input.write(`${JSON.stringify(rpc('initialize', {}))}\r\n{not json}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n${JSON.stringify(rpc('tools/list'))}`);
  input.end();
  await done;
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, out);
  assert.equal(lines.find((l) => l.result?.protocolVersion).result.serverInfo.name, 'atelier');
  assert.equal(lines.find((l) => l.error).error.code, -32700);
  assert.deepEqual(lines.find((l) => l.result?.tools).result.tools.map((t) => t.name), ['stub_echo', 'stub_fail']);
});

// ---------- pure helpers of the tool table ----------
test('the guard: absolute paths, climbing out, .git and .studio are refused; inside paths are normalised', () => {
  for (const bad of ['/etc/passwd', 'C:\\Windows\\win.ini', 'c:/x', '..', '../x', 'src/../../x', '..\\x', '.git/config', '.GIT/HEAD', '.studio/project.json', 'src/../.studio/x', '\\\\server\\share\\x']) {
    assert.throws(() => checkRel(bad), Error, bad);
  }
  assert.equal(checkRel('src\\game.js'), 'src/game.js');
  assert.equal(checkRel('./src/./a/../game.js'), 'src/game.js');
  assert.equal(checkRel(''), '');
  assert.equal(checkRel('.'), '');
  assert.equal(checkRel('src/'), 'src');
  assert.equal(checkRel('.gitignore'), '.gitignore', 'a file that starts like .git is not .git');
});

test('numberLines caps at 400 lines, numbers from the asked line and reports the total', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join('\n');
  const all = numberLines(text);
  assert.deepEqual([all.from, all.to, all.total], [1, FILE_LINES, 1000]);
  assert.equal(all.body.split('\n').length, FILE_LINES);
  const mid = numberLines(text, 990, 2000);
  assert.deepEqual([mid.from, mid.to], [990, 1000]);
  assert.equal(mid.body.split('\n')[0].trim(), '990  l990');
  assert.equal(numberLines('a\nb\n').total, 2, 'a final newline is not a line');
});

test('page parsing: script src, module src, link href, inline module imports, comments skipped; import lines of a module', () => {
  const html = '<!-- <script src="old.js"></script> -->\n<link rel="stylesheet" href="style.css">\n<link rel=icon href=/favicon.png>\n<script src="a.js"></script>\n<script type="module" src="./main.js?v=2"></script>\n<script type="module">\nimport { x } from "./inline.js";\nimport lit from "lit";\n</script>\n<script src="https://cdn.example/x.js"></script>';
  assert.deepEqual(pageRefs(html), [
    { ref: 'a.js', as: 'script' }, { ref: './main.js?v=2', as: 'module' }, { ref: './inline.js', as: 'module', inline: true }, { ref: 'lit', as: 'module', inline: true },
    { ref: 'https://cdn.example/x.js', as: 'script' }, { ref: 'style.css', as: 'stylesheet' }, { ref: '/favicon.png', as: 'icon' },
  ]);
  const js = "import a from './a.js';\nimport {\n  b,\n  c,\n} from '../lib/b.js';\nimport './side.js';\nexport * from './all.js';\nexport { d } from \"./d.js\";\nconst s = 'import x from \"./not.js\"';\n";
  assert.deepEqual(importSpecs(js), ['./a.js', '../lib/b.js', './side.js', './all.js', './d.js']);
  assert.deepEqual(resolveRef('src/index.html', 'style.css'), { rel: 'src/style.css' });
  assert.deepEqual(resolveRef('src/index.html', '/favicon.png'), { rel: 'favicon.png' });
  assert.deepEqual(resolveRef('src/index.html', '../../x.js'), { outside: '../../x.js' });
  assert.deepEqual(resolveRef('src/a.js', 'lit', { isImport: true }), { bare: 'lit' });
  assert.deepEqual(resolveRef('src/a.js', 'https://x/y.js', { isImport: true }), { external: 'https://x/y.js' });
});

test('diffOfPath keeps the sections of one file', () => {
  const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@\n-1\n+2\ndiff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@\n+3\n';
  assert.equal(diffOfPath(diff, 'b.js'), 'diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@\n+3\n');
  assert.equal(diffOfPath(diff, 'c.js'), '');
});

test('memory kinds are server/lib/memory.mjs KINDS', () => {
  assert.deepEqual(MEMORY_KINDS, KINDS);
});

test('a studio that does not answer: every tool answers isError with the one sentence', async () => {
  const port = await freePort(); // free a moment ago, so nothing listens there
  const studio = `http://127.0.0.1:${port}`;
  const tools = createTools({ studio, project: 'p_none' });
  const args = { atelier_read_file: { path: 'a.txt' }, atelier_read_diff: { version: '#1' }, atelier_phone_inspect: { x: 1, y: 1 }, atelier_create_task: { request: 'r' }, atelier_start_task: { task: 't_x1' }, atelier_review_task: { task: 't_x1', verdict: 'accept' }, atelier_add_unresolved: { text: 't' }, atelier_add_memory: { kind: 'lesson', text: 't' }, atelier_keep_version: { label: 'l' }, atelier_studio_show: { view: 'tasks' }, atelier_show_lesson: { title: 't', html: '<p>h</p>' }, atelier_set_worker_model: { scope: 'studio', model: 'default' } };
  for (const t of tools) {
    const r = await handleMessage(rpc('tools/call', { name: t.name, arguments: args[t.name] || {} }), { tools });
    assert.equal(r.result.isError, true, t.name);
    assert.equal(textOf(r), unreachable(studio), t.name);
  }
  // tools/list still answers: the department input falls back to its fixed words.
  const logged = [];
  const list = await handleMessage(rpc('tools/list'), { tools, log: (l) => logged.push(l) });
  const dept = list.result.tools.find((t) => t.name === 'atelier_create_task').inputSchema.properties.department;
  assert.match(dept.description, /the studio starts with Design, UX, Frontend, Backend, QA and review, Docs and writing/);
  assert.match(logged.join('\n'), /atelier_create_task: listed the fixed schema/);
});

const named = (r) => assert.ok(textOf(r).includes(`${projectName} (${projectId})`), `names the project: ${textOf(r).slice(0, 200)}`);

test('tools/list names every tool, each atelier_<verb>_<noun> with a description and an object schema', async () => {
  const r = await handleMessage(rpc('tools/list'), { tools });
  const names = r.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['atelier_read_briefing', 'atelier_read_memory', 'atelier_read_file', 'atelier_list_files', 'atelier_list_versions', 'atelier_read_diff', 'atelier_read_inspiration', 'atelier_read_rules', 'atelier_read_references', 'atelier_list_skills', 'atelier_phone_status', 'atelier_phone_screenshot', 'atelier_phone_inspect', 'atelier_live_status', 'atelier_page_files', 'atelier_studio_show', 'atelier_show_lesson', 'atelier_list_lessons', 'atelier_create_task', 'atelier_start_task', 'atelier_task_report', 'atelier_review_task', 'atelier_set_worker_model', 'atelier_worker_usage', 'atelier_add_unresolved', 'atelier_add_memory', 'atelier_keep_version']);
  for (const t of r.result.tools) {
    assert.match(t.name, /^atelier_[a-z]+(_[a-z]+)+$/);
    assert.ok(t.description.length > 120, `${t.name} explains itself`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    for (const key of t.inputSchema.required || []) assert.ok(t.inputSchema.properties[key], `${t.name} requires a described ${key}`);
  }
  // atelier_create_task carries a described department input, naming the departments the running studio has now.
  const create = r.result.tools.find((t) => t.name === 'atelier_create_task');
  assert.equal(create.inputSchema.properties.department.type, 'string');
  assert.match(create.inputSchema.properties.department.description, /Give every task one: the worker is told to use that department's skills/);
  assert.match(create.inputSchema.properties.department.description, /The studio's departments now: Design, UX, Frontend, Backend, QA and review \(qa\), Docs and writing \(docs\)\./);
  assert.match(create.description, /department names the skill department .*atelier_list_skills/);
  assert.ok(!create.inputSchema.required.includes('department'), 'optional for the route; the prompt asks for it');
  const added = await api('POST', '/api/skills/departments', { action: 'add', name: 'Motion' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const again = await handleMessage(rpc('tools/list'), { tools });
  assert.match(again.result.tools.find((t) => t.name === 'atelier_create_task').inputSchema.properties.department.description, /Docs and writing \(docs\), Motion\./, 'listed live, not fixed at start');
  await api('POST', '/api/skills/departments', { action: 'remove', id: 'motion' });
});

test('read: briefing, memory, files and folders of the bound project and of one named by name', async () => {
  const brief = await call('atelier_read_briefing');
  assert.equal(brief.result.isError, undefined, textOf(brief));
  named(brief);
  assert.match(textOf(brief), /# Continuation briefing/);
  const otherBrief = await call('atelier_read_briefing', { project: 'other notes' });
  assert.ok(textOf(otherBrief).includes(`Other Notes (${other.id})`));
  const missing = await call('atelier_read_briefing', { project: 'p_nothere' });
  assert.equal(missing.result.isError, true);
  assert.match(textOf(missing), new RegExp(`No registered project p_nothere\\. Registered: .*${projectId} Mcp Room`));

  const empty = await call('atelier_read_memory', { scope: 'project' });
  assert.match(textOf(empty), /scope project: no records/);

  const file = await call('atelier_read_file', { path: 'src/index.html', from: 2, to: 4 });
  named(file);
  assert.match(textOf(file), /src\/index\.html in .*, lines 2-4 of \d+:\n2  /);
  const dir = await call('atelier_list_files', { path: 'src' });
  named(dir);
  assert.match(textOf(dir), /\ngame\.js\n/);
  const top = await call('atelier_list_files');
  assert.match(textOf(top), /\nsrc\/\n/);
  assert.ok(!textOf(top).includes('.studio'), 'records are not listed');
  const asFolder = await call('atelier_read_file', { path: 'src' });
  assert.equal(asFolder.result.isError, true);
  assert.match(textOf(asFolder), /is a folder/);
});

test('read_file guard: outside paths, .git and .studio never reach the studio and answer isError', async () => {
  for (const p of ['../package.json', '.git/config', '.studio/project.json', 'C:\\Windows\\win.ini', 'src/../../x']) {
    const r = await call('atelier_read_file', { path: p });
    assert.equal(r.result.isError, true, p);
    assert.match(textOf(r), /absolute|climbs out|\.git|\.studio/, p);
  }
  const ls = await call('atelier_list_files', { path: '../' });
  assert.equal(ls.result.isError, true);
});

test('create_task with a preview pin on a page with an aura adds the aura line to the brief; no note, no line', async () => {
  const ui = (await api('GET', `/api/projects/${projectId}`)).data.project.ui || {};
  await api('PATCH', `/api/projects/${projectId}`, { ui: { ...ui, pages: { 'index.html#case': { aura: 'calm, careful' } } } });
  const a = (await api('POST', `/api/projects/${projectId}/companion/pins`, { source: 'preview', element: 'ul#case-grid', pageKey: 'index.html#case', pageName: 'The case' })).data;
  const b = (await api('POST', `/api/projects/${projectId}/companion/pins`, { source: 'preview', element: 'h1', pageKey: 'index.html#account', pageName: 'Account' })).data;
  try {
    const task = await call('atelier_create_task', { title: 'Grid air', request: 'Give the grid more air.', pins: [1, b.id] });
    assert.equal(task.result.isError, undefined, textOf(task));
    assert.match(textOf(task), /with the aura line of the pinned page/);
    const id = textOf(task).match(/Created task (t_[a-z0-9]+)/)[1];
    const rec = (await api('GET', `/api/projects/${projectId}/tasks/${id}`)).data.task;
    assert.equal(rec.request, 'Give the grid more air.\n\nAura of The case: calm, careful');
    const plain = await call('atelier_create_task', { title: 'Plain', request: 'Nothing pinned.', pins: [2] });
    const pid = textOf(plain).match(/Created task (t_[a-z0-9]+)/)[1];
    assert.equal((await api('GET', `/api/projects/${projectId}/tasks/${pid}`)).data.task.request, 'Nothing pinned.');
    const missing = await call('atelier_create_task', { request: 'x', pins: [9] });
    assert.equal(missing.result.isError, true);
    assert.match(textOf(missing), /has no pin 9; it has 2 pins/);
  } finally {
    for (const p of [a, b]) await api('DELETE', `/api/projects/${projectId}/companion/pins/${p.id}`);
  }
});

test('work: create a task, add an unresolved item and a memory record, keep a version and nothing to keep', async () => {
  const task = await call('atelier_create_task', { request: 'Make the crate heavier. Then the rest.', acceptance: ['the crate falls faster'], mode: 'teach' });
  named(task);
  const id = textOf(task).match(/Created task (t_[a-z0-9]+)/)[1];
  const rec = (await api('GET', `/api/projects/${projectId}/tasks/${id}`)).data.task;
  assert.deepEqual([rec.status, rec.mode, rec.title, rec.acceptance], ['ready', 'teach', 'Make the crate heavier.', ['the crate falls faster']]);
  assert.match(textOf(task), /Nothing was handed over/);
  const events = (await api('GET', `/api/projects/${projectId}/tasks/${id}`)).data.events.map((e) => e.type);
  assert.ok(!events.includes('handed_to_console') && !events.includes('started'), events.join(','));

  const u = await call('atelier_add_unresolved', { text: '  The jump feels late on the phone.  ' });
  named(u);
  const project = (await api('GET', `/api/projects/${projectId}`)).data.project;
  assert.equal(project.unresolved.at(-1).text, 'The jump feels late on the phone.');

  const m = await call('atelier_add_memory', { kind: 'lesson', text: 'Crates read heavier with a short dry thud.' });
  named(m);
  assert.match(textOf(m), /lesson, inferred, source companion/);
  const mem = await call('atelier_read_memory', { scope: 'project' });
  assert.match(textOf(mem), /- lesson · inferred · project: Crates read heavier with a short dry thud\./);
  const badKind = await call('atelier_add_memory', { kind: 'rumour', text: 'x' });
  assert.equal(badKind.result.isError, true);

  const kept = await call('atelier_keep_version', { label: 'Phone and boot module', note: 'for the page files' });
  named(kept);
  assert.match(textOf(kept), /Kept #2 "Phone and boot module"/);
  const again = await call('atelier_keep_version', { label: 'Again' });
  assert.equal(again.result.isError, undefined);
  assert.match(textOf(again), /Nothing to keep in .*: the files on disk match #2 Phone and boot module\./);
});

test('departments for managers: atelier_list_skills by department with Shared marked, unplaced and places; a task\'s department in the overview', async () => {
  for (const op of [{ id: 'design', skills: ['tidy-copy', 'grid-check'] }, { id: 'docs', skills: ['tidy-copy'] }, { id: 'qa', skills: ['grid-check', 'gone-skill'] }]) {
    const out = await api('POST', '/api/skills/departments', { action: 'place', member: true, ...op });
    assert.equal(out.status, 200, JSON.stringify(out.data));
  }
  const r = await call('atelier_list_skills');
  assert.equal(r.result.isError, undefined, textOf(r));
  named(r);
  const text = textOf(r);
  assert.match(text, /can see: 3, in 6 departments, 1 placed in none\./);
  assert.match(text, /\nDesign \(design\): 2 skills\n- grid-check \(Your skills · Shared · also in QA and review\): Check a layout grid against its spacing scale\.\n- tidy-copy \(Your skills · Shared · also in Docs and writing\): Rewrite interface copy so it reads plainly\.\n/, 'one line of description, the place, Shared');
  assert.match(text, /\nUX \(ux\): 0 skills\n\(none placed yet\)\n/);
  assert.match(text, /\nQA and review \(qa\): 1 skill\n- grid-check \(Your skills · Shared · also in Design\): .*\nPlaced here but not installed where these sessions can see them: gone-skill\./);
  assert.match(text, /\nPlaced in no department: 1\n- lonely-skill \(Your skills\): Nobody placed this one yet\./);
  assert.ok(text.includes(`\nWhere they live:\n- Your skills: ${path.join(root, 'claude', 'skills')}`), text.slice(-400));

  const qa = textOf(await call('atelier_list_skills', { department: 'qa and review' }));
  assert.match(qa, /\nQA and review \(qa\): 1 skill\n/);
  assert.ok(!/Design \(design\)|Placed in no department|Where they live/.test(qa), 'one department alone');
  const nope = await call('atelier_list_skills', { department: 'Sales' });
  assert.equal(nope.result.isError, true);
  assert.match(textOf(nope), /No department named Sales; the studio has Design, UX, Frontend, Backend, QA and review, Docs and writing\./);

  const made = await call('atelier_create_task', { title: 'Tidy the labels', request: 'Tidy the button labels with tidy-copy.', department: 'Docs and writing' });
  assert.match(textOf(made), /department Docs and writing/);
  const tid = textOf(made).match(/Created task (t_[a-z0-9]+)/)[1];
  const overview = textOf(await call('atelier_task_report'));
  assert.match(overview, new RegExp(`\\n- ${tid} · ready · will run on claude-fable-5-2 \\(studio default\\) · Docs and writing department · Tidy the labels`));
  assert.match(overview, / · ready · will run on claude-fable-5-2 \(studio default\) · no department · Make the crate heavier\./, 'a task without one says so');
  assert.match(overview, /\nWorker model of Mcp Room \(p_[a-z0-9]+\): claude-fable-5-2 \(studio default\); studio default claude-fable-5-2 \(built in; none stored\)\./, 'the overview names the project\'s worker model and where it comes from');
  // The bundle's task summaries (the Tasks view's rows) carry it too.
  const summaries = (await api('GET', `/api/projects/${projectId}`)).data.tasks;
  assert.deepEqual(summaries.find((t) => t.id === tid).department, { id: 'docs', name: 'Docs and writing' });
  assert.equal(summaries.find((t) => t.title === 'Make the crate heavier.').department, null);
  assert.equal((await api('PATCH', `/api/projects/${projectId}/tasks/${tid}`, { action: 'cancel' })).status, 200);
});

test('versions and diffs: the list, a version against its parent, one file, the first version and a missing one', async () => {
  const list = await call('atelier_list_versions');
  named(list);
  assert.match(textOf(list), /The files on disk are exactly #2\./);
  assert.match(textOf(list), /\n#2 Phone and boot module · experiment · [0-9a-f]{8} · /);
  const diff = await call('atelier_read_diff', { version: '#2' });
  named(diff);
  assert.match(textOf(diff), /#2 Phone and boot module against #1 /);
  assert.match(textOf(diff), /\nA src\/boot\.js \+3 -0\n/);
  assert.match(textOf(diff), /\+import \{ start \} from '\.\/game-start\.js';/);
  const one = await call('atelier_read_diff', { version: '2', path: 'capacitor.config.json' });
  assert.match(textOf(one), /capacitor\.config\.json only: 1 file\./);
  assert.ok(!textOf(one).includes('boot.js'), 'one file only');
  const first = await call('atelier_read_diff', { version: '#1' });
  assert.match(textOf(first), /#1 .* has no parent version to compare with/);
  const none = await call('atelier_read_diff', { version: '#9' });
  assert.equal(none.result.isError, true);
  assert.match(textOf(none), /has no version #9; it has #1 to #2/);
});

test('look: live status through the real routes; consent, the frame redirect with the token, a masked tool text, stop', { timeout: 60000 }, async () => {
  const id = other.id;
  const none = await call('atelier_live_status', { project: id });
  assert.equal(none.result.isError, undefined, textOf(none));
  assert.match(textOf(none), /atelier\.json declares no live server/);
  // The FAKE server inside the project, declared in its manifest.
  await api('PUT', `/api/projects/${id}/files`, { path: 'fake-live.mjs', content: await fsp.readFile(path.join(ROOT, 'tests', 'fixtures', 'fake-live.mjs'), 'utf8') });
  const manifest = JSON.parse((await api('GET', `/api/projects/${id}/files?path=atelier.json`)).data.content);
  manifest.live = { label: 'Fake live', command: ['node', 'fake-live.mjs'], cwd: '.' };
  await api('PUT', `/api/projects/${id}/files`, { path: 'atelier.json', content: JSON.stringify(manifest, null, 2) });
  let s = (await api('GET', `/api/projects/${id}/live`)).data;
  assert.deepEqual([s.state, s.consent.allowed, s.declared.label], ['off', false, 'Fake live']);
  assert.match(textOf(await call('atelier_live_status', { project: id })), /Allowed by the person: no/);
  const refused = await api('POST', `/api/projects/${id}/live/start`, {});
  assert.deepEqual([refused.status, refused.data.error.code], [403, 'live_consent_needed']);
  assert.equal((await api('POST', `/api/projects/${id}/live/consent`, { command: ['node', 'other.mjs'], cwd: '.' })).status, 409);
  assert.equal((await api('POST', `/api/projects/${id}/live/consent`, { command: manifest.live.command, cwd: '.' })).status, 200);
  const off = await fetch(`${BASE}/live/${id}`, { redirect: 'manual' });
  assert.equal(off.status, 409);
  s = (await api('POST', `/api/projects/${id}/live/start`, { origin: BASE })).data;
  assert.equal(s.state, 'starting');
  const t0 = Date.now();
  while (s.state === 'starting' && Date.now() - t0 < 20000) {
    await new Promise((r) => setTimeout(r, 100));
    s = (await api('GET', `/api/projects/${id}/live`)).data;
  }
  assert.equal(s.state, 'running', s.reason);
  // The one place the token leaves the studio: the frame's 302. It must match the token the server printed.
  const frame = await fetch(`${BASE}/live/${id}?t=1`, { redirect: 'manual' });
  assert.equal(frame.status, 302);
  assert.equal(frame.headers.get('referrer-policy'), 'no-referrer');
  const token = new URL(frame.headers.get('location')).hash.replace('#k=', '');
  assert.match(token, /^[0-9a-f]{24}$/);
  assert.match((await (await fetch(frame.headers.get('location'))).text()), /Fake live server/);
  const tool = textOf(await call('atelier_live_status', { project: id }));
  assert.match(tool, /State: running \(127\.0\.0\.1:\d+\)/);
  assert.match(tool, /Allowed by the person: yes/);
  assert.match(tool, /frame origin http:\/\/127\.0\.0\.1:\d+/);
  assert.ok(!tool.includes(token) && !JSON.stringify(s).includes(token), 'the token leaked');
  // Activating another project closes this one's live server.
  await api('POST', `/api/projects/${projectId}/activate`);
  s = (await api('GET', `/api/projects/${id}/live`)).data;
  assert.deepEqual([s.state, s.reason], ['off', 'the project was closed']);
  assert.equal((await fetch(`${BASE}/live/${id}`, { redirect: 'manual' })).status, 409);
  const again = (await api('POST', `/api/projects/${id}/live/start`, {})).data;
  assert.equal(again.state, 'starting');
  const stopped = (await api('POST', `/api/projects/${id}/live/stop`)).data;
  assert.deepEqual([stopped.state, stopped.reason], ['off', 'you switched Live off']);
});

test('look: phone status, the screenshot as an image block with its size, inspect with the element and its file', async () => {
  const status = await call('atelier_phone_status');
  named(status);
  assert.match(textOf(status), /Device: Booted · Fake_Pixel/);
  assert.match(textOf(status), /App: App running/);

  const shot = await call('atelier_phone_screenshot');
  assert.equal(shot.result.isError, undefined, textOf(shot));
  const [image, text] = shot.result.content;
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.deepEqual([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
  assert.equal(text.type, 'text');
  assert.match(text.text, /Phone screen of Mcp Room \(p_[a-z0-9]+\) on emulator-5554: 10×20 device pixels, 1 KB\./);

  const seen = await call('atelier_phone_inspect', { x: 5, y: 12 });
  assert.equal(seen.result.isError, undefined, textOf(seen));
  named(seen);
  assert.match(textOf(seen), /Element: button#start\.btn\.primary/);
  assert.match(textOf(seen), /- src\/index\.html:\d+ \(matches start/);
  const bad = await call('atelier_phone_inspect', { x: -1, y: 2 });
  assert.equal(bad.result.isError, true);

  const noPhone = await call('atelier_phone_status', { project: other.id });
  assert.equal(noPhone.result.isError, true);
  assert.match(textOf(noPhone), /No device provider applies/);

  // Another app in front (the fake's front app is com.example.probe): the readout's words, as an error.
  const config = (await api('GET', `/api/projects/${projectId}/files?path=capacitor.config.json`)).data.content;
  await api('PUT', `/api/projects/${projectId}/files`, { path: 'capacitor.config.json', content: config.replace('com.example.probe', 'com.example.hidden') });
  try {
    const covered = await call('atelier_phone_inspect', { x: 5, y: 12 });
    assert.equal(covered.result.isError, true, textOf(covered));
    assert.match(textOf(covered), /com\.example\.hidden is not on the screen: com\.example\.probe is/);
  } finally {
    await api('PUT', `/api/projects/${projectId}/files`, { path: 'capacitor.config.json', content: config });
  }
});

test('page files: the entry, its scripts and stylesheet, a module and what it imports, a missing import and a package name', async () => {
  const r = await call('atelier_page_files');
  named(r);
  const t = textOf(r);
  assert.match(t, /\nsrc\/index\.html \(entry\)\n/);
  for (const line of ['- src/style.css (stylesheet)', '- src/tuning.js (script)', '- src/game.js (script)', '- src/boot.js (module)', '  - src/game-start.js (import, missing)', '  - lit (import, package name: not a project path)']) {
    assert.ok(t.includes(line), `${line}\n${t}`);
  }
});

test('studio_show emits studio.show with the request, opens a file in the Source panel, and refuses a panel outside the workbench', async () => {
  const listening = new AbortController();
  const stream = await fetch(`${BASE}/api/events`, { signal: listening.signal });
  let seen = '';
  const reading = (async () => { const d = new TextDecoder(); for await (const c of stream.body) seen += d.decode(c); })().catch(() => {});
  let r;
  try {
    await new Promise((res) => setTimeout(res, 100));
    r = await call('atelier_studio_show', { file: 'src/game.js', line: 12 });
    await new Promise((res) => setTimeout(res, 300));
  } finally {
    listening.abort();
    await reading;
  }
  assert.equal(r.result.isError, undefined, textOf(r));
  named(r);
  assert.match(textOf(r), /the Workbench view, the Source panel, src\/game\.js:12\./);
  assert.doesNotMatch(textOf(r), /no source viewer/);
  assert.match(textOf(r), /1 studio window received it\./);
  assert.ok(seen.includes('event: studio.show\n'), seen);
  const payload = JSON.parse(seen.split('event: studio.show\n')[1].split('\n')[0].slice('data:'.length));
  assert.deepEqual({ ...payload, ts: 0 }, { projectId, view: 'workbench', panel: 'source', file: 'src/game.js', line: 12, ts: 0 });
  const both = await call('atelier_studio_show', { point: true, file: 'src/game.js' });
  assert.equal(both.result.isError, true);
  assert.match(textOf(both), /Point mode belongs to the phone panel|a file opens in the source panel/);
  const page = await call('atelier_studio_show', { panel: 'page' });
  assert.equal(page.result.isError, undefined, textOf(page));
  assert.match(textOf(page), /the Workbench view, the Page panel\./);

  const none = await call('atelier_studio_show', { view: 'tasks' });
  assert.match(textOf(none), /No studio window is open, so nothing on screen changed\./);
  const wrong = await call('atelier_studio_show', { view: 'tasks', panel: 'phone' });
  assert.equal(wrong.result.isError, true);
  assert.match(textOf(wrong), /the phone panel is in the workbench view, not tasks/);
  const escape = await call('atelier_studio_show', { file: '../secret.txt' });
  assert.equal(escape.result.isError, true);
  assert.equal((await api('POST', '/api/studio/show', { view: 'nowhere' })).status, 400);
  assert.equal((await api('POST', '/api/studio/show', { projectId: 'p_gone' })).status, 404);
});

test('lessons through the studio: show_lesson writes .studio/lessons, emits lessons.changed and studio.show for Learning; list_lessons; the routes refuse bad ids and oversize html', async () => {
  const listening = new AbortController();
  const stream = await fetch(`${BASE}/api/events`, { signal: listening.signal });
  let seen = '';
  const reading = (async () => { const d = new TextDecoder(); for await (const c of stream.body) seen += d.decode(c); })().catch(() => {});
  let made;
  try {
    await new Promise((res) => setTimeout(res, 100));
    made = await call('atelier_show_lesson', { title: 'Login and storage', topic: 'login', html: '<h1>Login</h1><ol class="steps"><li class="step">a</li><li class="step">b</li><li class="step">c</li></ol>', open: true });
    await new Promise((res) => setTimeout(res, 300));
  } finally {
    listening.abort();
    await reading;
  }
  assert.equal(made.result.isError, undefined, textOf(made));
  named(made);
  const id = textOf(made).match(/lesson (les_[a-z0-9]+)/)[1];
  assert.match(textOf(made), /1 studio window received it\./);
  assert.ok(seen.includes('event: lessons.changed\n'), seen);
  const show = JSON.parse(seen.split('event: studio.show\n')[1].split('\n')[0].slice('data:'.length));
  assert.deepEqual({ ...show, ts: 0 }, { projectId, view: 'learning', lesson: id, ts: 0 });
  const folder = (await api('GET', '/api/projects')).data.find((x) => x.id === projectId).path;
  const file = JSON.parse(await fsp.readFile(path.join(folder, '.studio', 'lessons', `${id}.json`), 'utf8'));
  assert.equal(file.title, 'Login and storage');
  const listed = await call('atelier_list_lessons');
  assert.match(textOf(listed), new RegExp(`- ${id} · "Login and storage" · login · 1 KB`));
  assert.equal((await api('GET', `/api/projects/${projectId}/lessons`)).data.lessons[0].id, id);
  assert.equal((await api('GET', `/api/projects/${projectId}/lessons/${id}`)).data.html.includes('class="step"'), true);
  assert.equal((await api('GET', `/api/projects/${projectId}/lessons/..%2F..%2Fproject`)).status, 404, 'a traversal id is not a lesson');
  assert.equal((await api('DELETE', `/api/projects/${projectId}/lessons/les_nothere1`)).status, 404);
  assert.equal((await api('POST', `/api/projects/${projectId}/lessons`, { id: '../x', title: 't', html: 'h' })).status, 400);
  assert.equal((await api('POST', `/api/projects/${projectId}/lessons`, { title: 'big', html: 'x'.repeat(400 * 1024 + 1) })).status, 413);
  assert.equal((await api('POST', '/api/studio/show', { view: 'learning', lesson: '../x' })).status, 400);
  assert.deepEqual((await api('DELETE', `/api/projects/${projectId}/lessons/${id}`)).data, { removed: id });
  assert.match(textOf(await call('atelier_list_lessons')), /has no lessons yet/);
});

test('worker models from a manager session: set and clear at task, project and studio scope; the started worker\'s session record shows the model; usage from the session records', async () => {
  const set = (args) => call('atelier_set_worker_model', args);
  const here = `${projectName} \\(${projectId}\\)`;
  const settingsOnDisk = async () => JSON.parse(await fsp.readFile(path.join(root, 'data', 'registry.json'), 'utf8')).settings;

  // The studio default: stored in the registry, named in the answer and in every briefing.
  let r = await set({ scope: 'studio', model: 'claude-sonnet-5-5' });
  assert.equal(r.result.isError, undefined, textOf(r));
  assert.match(textOf(r), /^The studio default is claude-sonnet-5-5 now, stored for every project that names no model\./);
  assert.match(textOf(r), new RegExp(`Worker model now: project ${here}: none of its own · studio default: claude-sonnet-5-5\\. The next worker of ${here}, on a task with no model of its own, starts on claude-sonnet-5-5 \\(studio default\\)\\. A running worker keeps the model it started on\\.$`));
  assert.equal((await settingsOnDisk()).workerModel, 'claude-sonnet-5-5');
  assert.deepEqual((await api('GET', '/api/settings/worker-model')).data.studio, { stored: 'claude-sonnet-5-5', fallback: 'claude-fable-5-2', model: 'claude-sonnet-5-5' });
  assert.equal((await api('GET', '/api/state')).data.settings.workerModel, 'claude-sonnet-5-5', 'the client reads it from the state');
  assert.match(textOf(await call('atelier_read_briefing')), /- Worker model: claude-sonnet-5-5 \(studio default\)/, 'the briefing was written again');
  assert.match(textOf(await call('atelier_read_briefing', { project: other.id })), /- Worker model: claude-sonnet-5-5 \(studio default\)/, 'every project\'s');

  // The project's own model outranks it.
  r = await set({ scope: 'project', model: 'claude-opus-5-5' });
  assert.match(textOf(r), new RegExp(`^${here}: its workers start on claude-opus-5-5 when their task names no model\\. Worker model now: project ${here}: claude-opus-5-5 · studio default: claude-sonnet-5-5\\. The next worker of ${here}, on a task with no model of its own, starts on claude-opus-5-5 \\(set for this project\\)\\.`));
  assert.equal((await api('GET', `/api/projects/${projectId}`)).data.project.workerModel, 'claude-opus-5-5');

  // A task's own model outranks both: given at create, cleared and set again from the session.
  const made = await call('atelier_create_task', { title: 'Routine sweep', request: 'Sweep the labels.', model: 'claude-haiku-5-5' });
  assert.match(textOf(made), /mode handle, worker model claude-haiku-5-5 \(set for this task\), status ready/);
  const tid = textOf(made).match(/Created task (t_[a-z0-9]+)/)[1];
  assert.equal((await api('GET', `/api/projects/${projectId}/tasks/${tid}`)).data.task.workerModel, 'claude-haiku-5-5');
  let overview = textOf(await call('atelier_task_report'));
  assert.match(overview, new RegExp(`\\nWorker model of ${here}: claude-opus-5-5 \\(set for this project\\); studio default claude-sonnet-5-5\\. A task's own model outranks both\\.\\n`));
  assert.match(overview, new RegExp(`\\n- ${tid} · ready · will run on claude-haiku-5-5 \\(task\\) · no department · Routine sweep`));
  assert.match(overview, / · ready · will run on claude-opus-5-5 \(project\) · /, 'a task with no model of its own: the project\'s');
  r = await set({ scope: 'task', task: tid, model: 'default' });
  assert.match(textOf(r), new RegExp(`^Task ${tid} in ${here} has no worker model of its own now\\. Worker model now: task ${tid}: none of its own · project ${here}: claude-opus-5-5 · studio default: claude-sonnet-5-5\\. The next worker of task ${tid} starts on claude-opus-5-5 \\(set for this project\\)\\.`));
  assert.equal('workerModel' in (await api('GET', `/api/projects/${projectId}/tasks/${tid}`)).data.task, false);
  r = await set({ scope: 'task', task: tid, model: 'claude-fable-5-1' });
  assert.match(textOf(r), new RegExp(`^Task ${tid} in ${here}: its workers start on claude-fable-5-1\\. .*The next worker of task ${tid} starts on claude-fable-5-1 \\(set for this task\\)\\.`));
  const noTask = await set({ scope: 'task', model: 'claude-haiku-5-5' });
  assert.equal(noTask.result.isError, true);
  assert.match(textOf(noTask), /scope task needs task/);

  // An unknown model: the tool answers an error, because every route behind it answers the same 400 naming the choices
  // (the model input is a described string since Codex workers: decision row 182).
  const schema = await set({ scope: 'studio', model: 'gpt-5' });
  assert.equal(schema.result.isError, true);
  const NAMED = /^workerModel must be one of claude-fable-5-2, claude-fable-5-1, claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, or default \(got "gpt-5"\); or codex:<model> or codex:<model>@<effort> for a worker on the Codex CLI$/;
  const tool = tools.find((t) => t.name === 'atelier_set_worker_model');
  for (const scope of ['studio', 'project', 'task']) await assert.rejects(() => tool.run({ scope, model: 'gpt-5', task: tid }), (err) => err.status === 400 && NAMED.test(err.message), scope);
  for (const [method, p, body] of [['PUT', '/api/settings/worker-model', { workerModel: 'gpt-5' }], ['PATCH', '/api/settings', { workerModel: 'gpt-5' }], ['PATCH', `/api/projects/${projectId}`, { workerModel: 'gpt-5' }], ['PUT', `/api/projects/${projectId}/tasks/${tid}/worker-model`, { workerModel: 'gpt-5' }], ['POST', `/api/projects/${projectId}/tasks`, { request: 'Never made.', workerModel: 'gpt-5' }], ['POST', `/api/projects/${projectId}/workers`, { taskId: tid, workerModel: 'gpt-5' }]]) {
    const out = await api(method, p, body);
    assert.equal(out.status, 400, `${method} ${p}`);
    assert.match(out.data.error.message, NAMED, `${method} ${p}`);
  }
  assert.equal((await api('PUT', '/api/settings/worker-model', {})).status, 400, 'an empty body clears nothing');
  assert.deepEqual([(await settingsOnDisk()).workerModel, (await api('GET', `/api/projects/${projectId}`)).data.project.workerModel, (await api('GET', `/api/projects/${projectId}/tasks/${tid}`)).data.task.workerModel], ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'], 'the refusals changed nothing');
  assert.equal((await api('GET', `/api/projects/${projectId}/workers`)).data.active, null, 'and started nothing');

  // Start it with a model: the task takes it, and the worker's console session record shows it.
  const started = await call('atelier_start_task', { task: tid, model: 'claude-haiku-5-5' });
  assert.match(textOf(started), new RegExp(`^Task ${tid} in ${here} went to a worker \\(session cs_[a-z0-9]+\\) on claude-haiku-5-5 \\(set for this task\\)\\.`));
  const sid = textOf(started).match(/session (cs_[a-z0-9]+)/)[1];
  let rec = (await api('GET', `/api/console/sessions/${sid}`)).data;
  assert.deepEqual([rec.model, rec.worker, rec.taskId, rec.effort], ['claude-haiku-5-5', true, tid, 'high']);
  for (let i = 0; i < 100 && (rec.status === 'running' || rec.turns.length < 2); i++) { // the fake claude answers and ends
    await new Promise((res) => setTimeout(res, 150));
    rec = (await api('GET', `/api/console/sessions/${sid}`)).data;
  }
  assert.deepEqual([rec.turns.length, rec.turns[1].model, rec.turns[1].costUsd], [2, 'claude-haiku-5-5', 0.0123], 'the CLI was started with --model claude-haiku-5-5 and its result was recorded');
  const detail = textOf(await call('atelier_task_report', { task: tid }));
  assert.match(detail, /\nWorker model: the next worker of this task would start on claude-haiku-5-5 \(set for this task\)\. Ran on: Claude Code claude-haiku-5-5 at high effort \(20\d\d-/);
  const handed = (await api('GET', `/api/projects/${projectId}/tasks/${tid}`)).data.events.find((e) => e.type === 'handed_to_console');
  assert.deepEqual([handed.data.backend, handed.data.model, handed.data.effort, handed.data.modelSource, handed.data.sessionId], ['claude-code', 'claude-haiku-5-5', 'high', 'task', sid]);

  // The usage tally reads that session record: sessions and turns per model, the figures the result event reported.
  const usage = await call('atelier_worker_usage');
  assert.equal(usage.result.isError, undefined, textOf(usage));
  assert.match(textOf(usage), /^Worker and companion usage of every project, counted from the studio's own Claude Code session records \(\d+ records? read\)/);
  for (const window of ['Last 24 hours', 'Last 7 days']) {
    assert.match(textOf(usage), new RegExp(`\\n${window}: \\d+ sessions?, \\d+ turns?, by model and who ran on it\\.\\n(- .*\\n)*- claude-haiku-5-5 · workers: 1 session, 1 turn · tokens: in 2, out 4, cache read 10, cache write 0 · cost as Claude Code reported it: \\$0\\.01\\n`), window);
  }
  assert.match(textOf(usage), /By the model that answered, sub-agents included \(Claude Code's modelUsage\): .*claude-haiku-5-5 in 2, out 4, cache read 10, cache write 0/);
  assert.match(textOf(usage), /the studio does not know the plan's limits or what is left of them/);
  const elsewhere = textOf(await call('atelier_worker_usage', { project: other.id }));
  assert.ok(elsewhere.includes(`usage of Other Notes (${other.id})`), elsewhere.slice(0, 200));
  assert.match(elsewhere, /\nLast 24 hours: no turn of a studio Claude Code session ended in this window\.\n/);
  assert.equal((await api('GET', '/api/workers/usage?projectId=p_nothere1')).status, 404);

  // Cleared again, level by level; with nothing stored the built-in default applies.
  assert.match(textOf(await set({ scope: 'project', model: 'default' })), new RegExp(`^${here} has no worker model of its own now\\. .*starts on claude-sonnet-5-5 \\(studio default\\)\\.`));
  r = await set({ scope: 'studio', model: 'default' });
  assert.match(textOf(r), new RegExp(`^The studio default is cleared: nothing is stored, so the built-in claude-fable-5-2 applies\\. Worker model now: project ${here}: none of its own · studio default: claude-fable-5-2 \\(built in; none stored\\)\\. .*starts on claude-fable-5-2 \\(studio default\\)\\.`));
  assert.equal('workerModel' in (await settingsOnDisk()), false);
  // A session bound to no project can still set the studio default, and is answered without one.
  const unbound = createTools({ studio: BASE });
  const alone = await unbound.find((t) => t.name === 'atelier_set_worker_model').run({ scope: 'studio', model: 'default' });
  assert.match(alone, /^The studio default is cleared: .* The next worker of a project and task with no model of their own starts on claude-fable-5-2\. A running worker keeps the model it started on\.$/);
  await assert.rejects(() => unbound.find((t) => t.name === 'atelier_set_worker_model').run({ scope: 'project', model: 'default' }), /No project: this session is bound to none/);
  assert.equal((await api('PATCH', `/api/projects/${projectId}/tasks/${tid}`, { action: 'cancel' })).status, 200);
});

test('bin/atelier-mcp.mjs speaks over stdio: initialize, notifications/initialized, tools/list; stdout holds protocol lines only', async () => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'bin', 'atelier-mcp.mjs'), '--studio', BASE, '--project', projectId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  proc.stdin.end();
  const code = await new Promise((resolve) => proc.on('close', resolve));
  assert.equal(code, 0, err);
  const lines = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, out);
  const init = lines.find((l) => l.id === 1).result;
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual([init.protocolVersion, init.serverInfo, init.capabilities], [PROTOCOL_VERSION, { name: 'atelier', version: pkg.version }, { tools: {} }]);
  assert.match(init.instructions, /Atelier is a local creative studio/);
  assert.equal(lines.find((l) => l.id === 2).result.tools.length, 27);
  assert.match(err, /\[atelier-mcp\] v.* · studio http:\/\/127\.0\.0\.1:\d+ · project p_/);
});
