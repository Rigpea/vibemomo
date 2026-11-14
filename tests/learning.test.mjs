// The Learning view (t_3b4zpsazku; docs/ARCHITECTURE.md section 19). Risks covered: the lesson store writes only
// les_ ids under .studio/lessons (no path traversal), keeps createdAt on a replace, lists the latest written first and
// refuses html over the limit; a lesson file's change reaches the live stream as lessons.changed; the two MCP tools
// check their arguments before they reach the studio and open the Learning view through studio.show; the Learning tab
// sits right after the Workbench with its number key and the rest renumbered; the frame is sandboxed without
// allow-same-origin under a no-network CSP, and only a message of the right shape from the frame itself becomes an
// Ask line. The bridge script runs here on a stub DOM, so what it posts is what the parent accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { listLessons, getLesson, saveLesson, deleteLesson, LESSON_MAX_BYTES, LESSON_ID } from '../server/lib/lessons.mjs';
import { watchEvent } from '../server/lib/watch-events.mjs';
import { createTools } from '../server/lib/mcp/tools.mjs';
import { handleMessage } from '../server/lib/mcp/stdio.mjs';
import { lessonDocument, lessonBody, lessonBridge, readTokens, baseCss, LESSON_CSP, LESSON_TOKENS } from '../client/components/lesson-frame.js';
import { readLessonMessage, askLine, askFallback, stepWords, pickLesson, ASK_MAX } from '../client/components/lesson-words.js';

const read = (rel) => fsp.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const tmpProject = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-lessons-'));
  await fsp.mkdir(path.join(dir, '.studio'), { recursive: true });
  return dir;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE = '<h1>Login</h1><ol class="steps"><li class="step">Type</li><li class="step">Check</li><li class="step">Keep</li></ol>';

// ---------- the store ----------
test('lessons: create, replace keeps createdAt, the list puts the latest written first, delete; files are .studio/lessons/<id>.json', async () => {
  const dir = await tmpProject();
  try {
    assert.deepEqual(await listLessons(dir), [], 'no folder yet is no lessons');
    const a = await saveLesson(dir, { title: '  Login   and storage ', topic: 'login', html: SAMPLE });
    assert.match(a.id, LESSON_ID);
    assert.equal(a.title, 'Login and storage', 'one line, spaces folded');
    assert.equal(a.replaced, false);
    const file = JSON.parse(await fsp.readFile(path.join(dir, '.studio', 'lessons', `${a.id}.json`), 'utf8'));
    assert.deepEqual(Object.keys(file), ['id', 'title', 'createdAt', 'updatedAt', 'topic', 'html']);
    await wait(15);
    const b = await saveLesson(dir, { title: 'Second', html: '<p>two</p>' });
    assert.deepEqual((await listLessons(dir)).map((l) => l.id), [b.id, a.id], 'newest first');
    await wait(15);
    const again = await saveLesson(dir, { id: a.id, title: 'Login, again', html: '<p>new</p>' });
    assert.equal(again.replaced, true);
    const list = await listLessons(dir);
    assert.deepEqual(list.map((l) => l.id), [a.id, b.id], 'a replaced lesson is the latest written');
    assert.deepEqual(Object.keys(list[0]).sort(), ['bytes', 'createdAt', 'id', 'title', 'topic', 'updatedAt'], 'the list carries no html');
    const got = await getLesson(dir, a.id);
    assert.equal(got.html, '<p>new</p>');
    assert.equal(got.createdAt, file.createdAt, 'createdAt kept');
    assert.notEqual(got.updatedAt, file.updatedAt);
    assert.equal(got.topic, '', 'a replace without a topic clears it');
    assert.deepEqual(await deleteLesson(dir, b.id), { removed: b.id });
    assert.deepEqual((await listLessons(dir)).map((l) => l.id), [a.id]);
    await assert.rejects(() => deleteLesson(dir, b.id), { status: 404 });
    await assert.rejects(() => getLesson(dir, b.id), { status: 404 });
    await assert.rejects(() => saveLesson(dir, { id: 'les_gone1234', title: 'x', html: '<p>x</p>' }), { status: 404, message: /leave id out/ });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('lessons: html over the limit is 413; a missing title or html is 400; ids that are not les_ ids never become paths', async () => {
  const dir = await tmpProject();
  const outside = path.join(dir, 'outside.json');
  try {
    await assert.rejects(() => saveLesson(dir, { title: 'Big', html: 'x'.repeat(LESSON_MAX_BYTES + 1) }), { status: 413, message: /at most 400 KB; this one is 401 KB/ });
    const fits = await saveLesson(dir, { title: 'Just fits', html: 'x'.repeat(LESSON_MAX_BYTES) });
    assert.equal(fits.bytes, LESSON_MAX_BYTES);
    assert.equal(Buffer.byteLength('é'.repeat(LESSON_MAX_BYTES / 2 + 1)), LESSON_MAX_BYTES + 2);
    await assert.rejects(() => saveLesson(dir, { title: 'Bytes, not characters', html: 'é'.repeat(LESSON_MAX_BYTES / 2 + 1) }), { status: 413 });
    await assert.rejects(() => saveLesson(dir, { html: '<p>x</p>' }), { status: 400, message: /title is required/ });
    await assert.rejects(() => saveLesson(dir, { title: 'x', html: '   ' }), { status: 400, message: /html is required/ });
    await assert.rejects(() => saveLesson(dir, { title: 'x'.repeat(201), html: '<p>x</p>' }), { status: 400, message: /at most 200/ });
    await fsp.writeFile(outside, JSON.stringify({ id: '../outside', title: 't', html: 'h' }));
    for (const id of ['../outside', '..\\outside', 'les_../../outside', 'les_ABC123', 'les_a/b', 'les_', '', 'les_abc.json']) {
      await assert.rejects(() => saveLesson(dir, { id, title: 'x', html: '<p>x</p>' }), { status: 400 }, `save ${id}`);
      await assert.rejects(() => getLesson(dir, id), { status: 404 }, `get ${id}`);
      await assert.rejects(() => deleteLesson(dir, id), { status: 404 }, `delete ${id}`);
    }
    assert.ok(await fsp.stat(outside), 'nothing outside the lessons folder was touched');
    // A stray or damaged file in the folder is left out of the list, not shown broken.
    await fsp.writeFile(path.join(dir, '.studio', 'lessons', 'notes.json'), '{}');
    await fsp.writeFile(path.join(dir, '.studio', 'lessons', 'les_broken99.json'), '{ not json');
    await fsp.writeFile(path.join(dir, '.studio', 'lessons', 'les_other999.json'), JSON.stringify({ id: 'les_someone', title: 'wrong id inside', html: 'x' }));
    assert.deepEqual((await listLessons(dir)).map((l) => l.title), ['Just fits']);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a lesson file under .studio reaches the stream as lessons.changed; the folder itself and temp files say nothing', () => {
  assert.deepEqual(watchEvent('lessons/les_abc123.json'), { type: 'lessons.changed', data: { lessonId: 'les_abc123', file: 'lessons/les_abc123.json' } });
  assert.deepEqual(watchEvent('lessons\\les_abc123.json'), { type: 'lessons.changed', data: { lessonId: 'les_abc123', file: 'lessons\\les_abc123.json' } });
  assert.equal(watchEvent('lessons'), null);
  assert.equal(watchEvent('lessons/les_abc123.json.123.456.tmp'), null);
  assert.equal(watchEvent('lessons/notes.txt'), null);
  assert.equal(watchEvent('project.json').type, 'project.changed', 'the rest as before');
});

// ---------- the MCP tools, against a fake studio ----------
function fakeStudio() {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method || 'GET', u.pathname, body]);
    const answer = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/api/projects') return answer([{ id: 'p_1', name: 'Harbor', slug: 'harbor' }]);
    if (u.pathname === '/api/projects/p_1/lessons' && init.method === 'POST') return answer({ id: body.id || 'les_new12345', title: body.title, topic: body.topic, bytes: Buffer.byteLength(body.html), replaced: !!body.id });
    if (u.pathname === '/api/projects/p_1/lessons') return answer({ lessons: [{ id: 'les_new12345', title: 'Login and storage', topic: 'login', bytes: 2048, updatedAt: '2026-11-08T03:00:00.000Z' }] });
    if (u.pathname === '/api/studio/show') return answer({ ...body, delivered: 1 });
    return answer({ error: { message: 'no' } }, 404);
  };
  return { calls, tools: createTools({ studio: 'http://studio.test', project: 'p_1', fetch }) };
}
let n = 0;
const callTool = (tools, name, args) => handleMessage({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, { tools });
const textOf = (r) => r.result.content.map((c) => c.text).join('\n');

test('atelier_show_lesson: bad arguments never reach the studio; a lesson is posted, and open moves the window to Learning at it', async () => {
  const { calls, tools } = fakeStudio();
  for (const [args, words] of [
    [{ title: 'x' }, /html is required/],
    [{ html: '<p>x</p>' }, /title is required|title must not be empty/],
    [{ title: 'x', html: '<p>x</p>', colour: 'red' }, /colour is not an argument/],
    [{ title: 'x', html: '<p>x</p>', id: '../../etc' }, /is not a lesson id/],
    [{ title: '  ', html: '<p>x</p>' }, /title is required|title must not be empty/],
    [{ title: 'x', html: 'x'.repeat(LESSON_MAX_BYTES + 10) }, /over the 400 KB a lesson may hold/],
    [{ title: 'x', html: '<p>x</p>', open: 'yes' }, /open must be/],
  ]) {
    const r = await callTool(tools, 'atelier_show_lesson', args);
    assert.equal(r.result.isError, true, JSON.stringify(args).slice(0, 80));
    assert.match(textOf(r), words);
  }
  assert.deepEqual(calls, [], 'nothing reached the studio');
  const made = await callTool(tools, 'atelier_show_lesson', { title: 'Login and storage', topic: 'login', html: SAMPLE, open: true });
  assert.equal(made.result.isError, undefined, textOf(made));
  assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), ['GET /api/projects', 'POST /api/projects/p_1/lessons', 'POST /api/studio/show']);
  assert.deepEqual(calls[1][2], { title: 'Login and storage', topic: 'login', html: SAMPLE });
  assert.deepEqual(calls[2][2], { projectId: 'p_1', view: 'learning', lesson: 'les_new12345' });
  assert.match(textOf(made), /^Made lesson les_new12345 "Login and storage" in Harbor \(p_1\)/);
  assert.match(textOf(made), /1 studio window received it\. Replace it later with id les_new12345\./);
  calls.length = 0;
  const replaced = await callTool(tools, 'atelier_show_lesson', { id: 'les_new12345', title: 'Login, again', html: '<p>two</p>' });
  assert.match(textOf(replaced), /^Replaced lesson les_new12345/);
  assert.ok(!calls.some(([, p]) => p === '/api/studio/show'), 'no open, no move');
});

test('atelier_list_lessons lists the shelf; both tools say a lesson is a studio record written in the companion\'s own turn', async () => {
  const { tools } = fakeStudio();
  const r = await callTool(tools, 'atelier_list_lessons', {});
  assert.equal(textOf(r), 'Lessons of Harbor (p_1): 1, the latest first.\n- les_new12345 · "Login and storage" · login · 2 KB · written 2026-11-08T03:00:00.000Z');
  const list = await handleMessage({ jsonrpc: '2.0', id: ++n, method: 'tools/list' }, { tools });
  const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  for (const name of ['atelier_show_lesson', 'atelier_list_lessons']) {
    assert.match(byName[name].description, /studio record like memory/);
    assert.match(byName[name].description, /own turn/);
  }
  assert.match(byName.atelier_show_lesson.description, /no worker needed/);
  assert.match(byName.atelier_show_lesson.description, /class="steps"[\s\S]*class="diagram"[\s\S]*class="callout"[\s\S]*class="terms"[\s\S]*class="flow"/, 'the built-in classes are named for the author');
  assert.deepEqual(byName.atelier_show_lesson.inputSchema.required, ['title', 'html']);
  assert.match(byName.atelier_studio_show.description, /learning/);
  assert.ok(byName.atelier_studio_show.inputSchema.properties.view.enum.includes('learning'));
});

test('COMPANION_PROMPT tells the manager to teach through lessons, concrete to the project, with the diagram skills', async () => {
  const { COMPANION_PROMPT } = await import('../server/lib/companion.mjs');
  assert.match(COMPANION_PROMPT, /asks to be taught[\s\S]*atelier_show_lesson \(open: true\)[\s\S]*explain it in the chat beside it/);
  assert.match(COMPANION_PROMPT, /studio record like memory, so you write it yourself in your own turn, no worker/);
  assert.match(COMPANION_PROMPT, /real code and plans/);
  assert.match(COMPANION_PROMPT, /who talks to whom/);
  assert.match(COMPANION_PROMPT, /atelier_list_skills/);
});

// ---------- the tab and its number ----------
test('the Learning tab sits right after the Workbench; the number keys, the tab titles and the Help sheet follow the same order', async () => {
  const app = await read('client/app.js');
  const html = await read('client/index.html');
  const views = [...app.match(/const VIEWS = \{([\s\S]*?)\n\};/)[1].matchAll(/^\s*'?([\w-]+)'?: \(\) => import/gm)].map((m) => m[1]);
  assert.deepEqual(views, ['workbench', 'learning', 'inspiration', 'claude-code', 'tasks', 'memory', 'budget', 'settings']);
  const tabs = [...html.matchAll(/<a href="#\/([\w-]+)" data-view="\1" title="([^"]+)">([^<]+)<\/a>/g)];
  assert.deepEqual(tabs.map((m) => m[1]), views, 'the tabs in the same order as the routes');
  tabs.forEach((m, i) => assert.match(m[2], new RegExp(`^${m[3]} \\(${i + 1}\\)`), `${m[3]} is key ${i + 1}`));
  const help = app.match(/\['1 – (\d)', '([^']+)'\]/);
  assert.equal(Number(help[1]), views.length);
  assert.deepEqual(help[2].split(' · '), tabs.map((m) => m[3]), 'the Help sheet names them in order');
  // The key handler takes 1 up to the number of views, not a fixed 6.
  assert.match(app, /if \(\/\^\[1-9\]\$\/\.test\(k\) && Number\(k\) <= VIEW_ORDER\.length\) \{ go\(VIEW_ORDER\[Number\(k\) - 1\]\); return; \}/);
  const pattern = new RegExp(app.match(/location\.hash\.match\(\/(.+?)\/\)/)[1]);
  assert.equal(pattern.exec('#/learning')?.[1], 'learning', 'the router reads the hash');
  assert.match(html, /<link rel="stylesheet" href="\/learning\.css">/);
  assert.match(app, /es\.addEventListener\('lessons\.changed', \(e\) => emit\('lessons', data\(e\)\)\)/);
});

test('the Companion sits in the Workbench\'s own dock under the lesson, on the same panel module and session (t_391f0z2rhl)', async () => {
  const view = await read('client/views/learning.js');
  assert.match(view, /import \{ createDock \} from '\.\.\/components\/dock\.js';/, 'the dock itself, not a lookalike');
  assert.match(view, /createDock\(app, \{ \.\.\.LEARNING_DOCK,/);
  assert.match(view, /kinds: \(\) => \['companion'\]/, 'Claude Code alone');
  assert.match(view, /heightKey: 'learningDockHeight'/, 'its own height, so a pull here does not move the Workbench\'s dock');
  assert.match(view, /el\('div\.learn', shelf, el\('div\.learn-main', display, dock\.node\)\)/, 'shelf left; lesson over the dock in the middle');
  assert.match(view, /el\('section\.learn-display'[^\n]*body, steps\)/, 'Back, Next and the progress row stay in the lesson, above the dock');
  assert.doesNotMatch(view, /createSplitter|learn-companion|--learn-cmp-w/, 'the right-hand Companion column is gone');
  assert.match(view, /if \(b\?\.project\?\.id !== pid\) return;\n  if \(me\.dockPid === pid\)/, 'not before the bundle names the session (Start would make a second)');
  assert.match(view, /ui\.dock\.destroy\(\);/, 'leaving the view unmounts the panel, which keeps its box for the next mount');
  // Ask about this opens a collapsed dock first, then quotes into the box.
  assert.match(view, /const mod = await showCompanion\(\);[\s\S]*?mod\?\.insertDraft \? mod\.insertDraft\(line\)/);
  assert.match(view, /await me\.dock\.show\('companion'\)/);
  assert.match(view, /const companionModule = \(\) => import\('\/workbenches\/companion\/panel\.js'\)/, 'the same module URL the dock loads, so one panel state');
  const dock = await read('client/components/dock.js');
  assert.match(dock, /const defaultLoad = \(kind\) => import\(`\/workbenches\/\$\{kind\}\/panel\.js`\);/, 'the dock loads the same URL');
  const css = await read('client/learning.css');
  assert.match(css, /\.learn \{[^}]*grid-template-columns: var\(--shelf-w, 216px\) minmax\(0, 1fr\); \}/, 'two columns: the right panel is the app grid\'s');
});

test('the right panel shows on Learning as on the Workbench, and opening its tabs there no longer jumps to the Workbench (t_391f0z2rhl)', async () => {
  const app = await read('client/app.js');
  const styles = await read('client/styles.css');
  assert.match(app, /const PANEL_VIEWS = \['workbench', 'learning'\];/);
  assert.match(app, /showPanel: \(tab = 'task', opts = \{\}\) => \{ if \(!panelView\(\)\) go\('workbench'\);/, 'showPanel stays on Learning');
  assert.match(app, /if \(k === '\]'\) \{ if \(!panelView\(\)\) go\('workbench'\); toggleLayout\('collabCollapsed'\); return; \}/, '] toggles it where it is');
  assert.match(app, /if \(panelView\(\) && !l\.collabCollapsed\.value && !NARROW\.matches && Number\.isFinite\(cw\) && cw > 0\) root\.style\.setProperty\('--collab-w'/, 'the same width pref');
  assert.match(app, /!state\.narrowPanelOpen \|\| !panelView\(\)\) return;/, 'Esc closes the overlay on Learning too');
  assert.doesNotMatch(app, /--learn-cmp-w/);
  // The grid hides the column on every view but these two, and the narrow overlay applies to both.
  assert.match(styles, /\.app:not\(\[data-view="workbench"\]\):not\(\[data-view="learning"\]\) \.collab \{ display: none; \}/);
  assert.match(styles, /\.app:not\(\.collab-collapsed\):is\(\[data-view="workbench"\], \[data-view="learning"\]\) \.collab \{ grid-column: auto; position: absolute;/);
  // The status chip's question and the inspector's Ask open the Companion in the Learning dock while it is on screen.
  assert.match(app, /if \(state\.view === 'learning' && app\.learning\?\.showCompanion\) return app\.learning\.showCompanion\(\);/);
  const collab = await read('client/components/collab.js');
  assert.match(collab, /onAsk: \(\) => \(app\.learning\?\.showCompanion \? app\.learning\.showCompanion\(\) : app\.workbench\?\.showPanel\?\.\('companion'\)\)/);
});

test('restart: the route logs the request with its time before the script runs; the script stamps every line; a server older than the tab says restart', async () => {
  const server = await read('server/index.mjs');
  const at = server.indexOf("route('POST', '/api/studio/restart'");
  const route = server.slice(at, at + 900);
  assert.ok(route.indexOf('requested through POST /api/studio/restart') > 0 && route.indexOf('requested through POST /api/studio/restart') < route.indexOf('spawn('), 'the request line goes in before the detached script starts');
  assert.match(route, /spawn\(process\.execPath, \[path\.join\(STUDIO_DIR, 'scripts', 'restart\.mjs'\)\], \{ cwd: STUDIO_DIR, detached: true/, 'a detached process that outlives this server');
  const script = await read('scripts/restart.mjs');
  assert.match(script, /const log = \(m\) => console\.log\(`\[restart\] \$\{new Date\(\)\.toISOString\(\)\} \$\{m\}`\);/);
  assert.match(script, /spawn\(process\.execPath, \['server\/index\.mjs'\]/, 'a fresh server process loads the routes on disk');
  const restart = await read('client/components/restart.js');
  assert.match(restart, /fetch\('\/api\/studio\/restart', \{ method: 'POST' \}\)/);
  assert.match(restart, /h\?\.ok && h\.startedAt !== before\?\.startedAt\) \{ location\.reload\(\)/, 'the page reloads only for a server with a new start time');
  const app = await read('client/app.js');
  assert.match(app, /document\.getElementById\('restart-btn'\)\.addEventListener\('click', restart\);/);
  assert.match(app, /e\.ctrlKey && e\.altKey && !e\.metaKey && \(e\.key === 'r' \|\| e\.key === 'R'\)[^\n]*restart\(\);/);
  const view = await read('client/views/learning.js');
  assert.match(view, /me\.listError && olderServer\(me\.listError\)/, 'No route on the lessons list reads as an older server, with a Restart button');
});

// ---------- the frame and its messages ----------
test('the lesson document: CSP first, the studio base style before the lesson, the bridge in the head; the frame is sandboxed without same-origin', async () => {
  const doc = lessonDocument({ html: '<!doctype html><html><head><style>.x{color:red}</style><meta http-equiv="refresh" content="0;url=https://x.test"><base href="https://x.test/"></head><body><h1>Hi</h1></body></html>', title: 'A <b>title</b>' });
  const head = doc.slice(0, doc.indexOf('</head>'));
  assert.ok(head.indexOf('Content-Security-Policy') < head.indexOf('<style id="studio-base">'), 'the policy before anything that loads');
  assert.ok(head.indexOf('<style id="studio-base">') < head.indexOf('<script>'));
  assert.ok(doc.indexOf('</head>') < doc.indexOf('.x{color:red}'), 'the lesson\'s own style comes after the base, so it wins');
  assert.match(doc, /<title>A &lt;b&gt;title&lt;\/b&gt;<\/title>/);
  assert.doesNotMatch(doc, /http-equiv="refresh"/);
  assert.doesNotMatch(doc, /<base /);
  assert.match(doc, /<main class="lesson">\n<style>\.x\{color:red\}<\/style>\n<h1>Hi<\/h1>\n<\/main>/);
  assert.equal(lessonBody('<p>fragment</p>'), '<p>fragment</p>');
  assert.match(LESSON_CSP, /^default-src 'none'; /);
  for (const part of ["style-src 'unsafe-inline'", "script-src 'unsafe-inline'", 'img-src data:', "base-uri 'none'", "form-action 'none'"]) assert.ok(LESSON_CSP.includes(part), part);
  assert.doesNotMatch(LESSON_CSP, /https?:|\*/, 'no network source anywhere');
  const view = await read('client/views/learning.js');
  assert.match(view, /frame\.setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(view, /setAttribute\('sandbox', '[^']*allow-same-origin/);
  assert.match(view, /if \(!ui \|\| e\.source !== frame\.contentWindow\) return;/, 'only the frame on screen speaks');
  for (const cls of ['.step', 'figure.diagram', '.callout', 'dl.terms', '.flow', 'html.paged .step:not(.is-current)']) assert.ok(baseCss().includes(cls), cls);
});

test('the studio tokens reach the lesson; a value that could break out of the stylesheet keeps the default', () => {
  const style = { getPropertyValue: (n) => ({ '--bg': ' #101010 ', '--ink': 'red; } body { display: none', '--accent': '#abcdef' }[n] || '') };
  const t = readTokens(style, 'light');
  assert.equal(t.bg, '#101010');
  assert.equal(t.accent, '#abcdef');
  assert.equal(t.ink, LESSON_TOKENS.ink);
  assert.equal(t.scheme, 'light');
  assert.match(baseCss(t), /--bg: #101010;/);
  assert.match(baseCss(t), /color-scheme: light;/);
});

test('readLessonMessage takes only the two shapes; askLine quotes with the record\'s title; the words', () => {
  const T = 'atelier:lesson';
  assert.deepEqual(readLessonMessage({ type: T, what: 'steps', count: 3, index: 1 }), { what: 'steps', count: 3, index: 1 });
  assert.deepEqual(readLessonMessage({ type: T, what: 'steps', count: 0, index: 0 }), { what: 'steps', count: 0, index: 0 });
  assert.deepEqual(readLessonMessage({ type: T, what: 'ask', kind: 'selection', text: '  the   session\ncookie ' }), { what: 'ask', kind: 'selection', text: 'the session cookie' });
  const long = readLessonMessage({ type: T, what: 'ask', kind: 'figure', text: 'w '.repeat(400) });
  assert.equal(long.text.length, ASK_MAX);
  assert.ok(long.text.endsWith('…'));
  for (const bad of [null, 'atelier:lesson', [], { type: 'atelier:tuning', what: 'ask', kind: 'selection', text: 'x' },
    { type: T, what: 'send', text: 'x' }, { type: T, what: 'ask', kind: 'other', text: 'x' }, { type: T, what: 'ask', kind: 'selection', text: '   ' },
    { type: T, what: 'ask', kind: 'selection', text: 5 }, { type: T, what: 'ask', kind: 'selection', text: 'x'.repeat(20001) },
    { type: T, what: 'steps', count: 3, index: 3 }, { type: T, what: 'steps', count: -1, index: 0 }, { type: T, what: 'steps', count: 2.5, index: 0 }, { type: T, what: 'steps', count: 9999, index: 0 }]) {
    assert.equal(readLessonMessage(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal(askLine({ kind: 'selection', text: 'the session cookie' }, 'Login and storage'), 'About "the session cookie" in the lesson "Login and storage": ');
  assert.equal(askLine({ kind: 'figure', text: 'Who talks to whom' }, 'Login'), 'About the figure "Who talks to whom" in the lesson "Login": ');
  assert.equal(askLine({ kind: 'selection', text: 'say "hi"' }, 'A "B"'), 'About "say ”hi”" in the lesson "A ”B”": ', 'inner quotes cannot close the quote');
  assert.equal(stepWords(1, 3), 'Step 2 of 3');
  assert.equal(stepWords(0, 0), '');
  assert.equal(askFallback({ ok: true, focused: true }), null);
  assert.match(askFallback({ ok: true, focused: false, reason: 'running' }), /once the answer running now ends/);
  assert.match(askFallback({ ok: false, reason: 'no_session' }), /Start the companion session/);
  assert.equal(pickLesson({ wanted: 'les_b', last: 'les_a', ids: ['les_a'] }), 'les_b', 'studio.show wins even before the list has it');
  assert.equal(pickLesson({ last: 'les_a', ids: ['les_c', 'les_a'] }), 'les_a');
  assert.equal(pickLesson({ last: 'les_gone', ids: ['les_c', 'les_a'] }), 'les_c', 'else the newest');
  assert.equal(pickLesson({ ids: [] }), null);
});

// ---------- the bridge script itself, on a stub DOM ----------
function stubDom(tree) {
  const listeners = { doc: {}, win: {} };
  const on = (bag) => (type, fn) => { (bag[type] ||= []).push(fn); };
  const make = (tag, parent = null) => {
    const node = {
      tagName: tag.toUpperCase(), parentElement: parent, kids: [], attrs: {}, style: {}, hidden: false, textContent: '', offsetWidth: 100, listeners: {},
      classList: { set: new Set(), add(c) { this.set.add(c); }, toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, hasAttribute(k) { return k in this.attrs; }, removeAttribute(k) { delete this.attrs[k]; },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      appendChild(c) { c.parentElement = this; this.kids.push(c); return c; },
      contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; },
      closest(sel) { const tags = sel.split(',').map((s) => s.trim().replace(/\[.*$/, '')); for (let x = this; x; x = x.parentElement) if (tags.includes(x.tagName.toLowerCase())) return x; return null; },
      querySelector(sel) { return all(this).find((x) => x !== this && x.tagName.toLowerCase() === sel) || null; },
      getBoundingClientRect: () => ({ top: 40, bottom: 60, left: 20, right: 320 }),
      fire(type, extra = {}) { const ev = { target: this, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...extra }; for (const fn of this.listeners[type] || []) fn(ev); return ev; },
    };
    return node;
  };
  const all = (n) => [n, ...n.kids.flatMap(all)];
  const html = make('html');
  const body = html.appendChild(make('body'));
  const nodes = tree(make, body);
  const document = {
    readyState: 'complete', documentElement: html, body,
    querySelectorAll: (sel) => all(html).filter((x) => (sel === '.step' ? x.classList.contains('step') : x.tagName.toLowerCase() === sel)),
    createElement: (tag) => make(tag),
    addEventListener: on(listeners.doc),
  };
  const collapsed = () => ({ isCollapsed: true, toString: () => '', anchorNode: null, removeAllRanges() { selection = collapsed(); } });
  let selection = collapsed();
  const posted = [];
  const parent = { postMessage: (msg, target) => posted.push([msg, target]) };
  const window = { addEventListener: on(listeners.win), getSelection: () => selection, scrollX: 0, scrollY: 0, innerWidth: 800 };
  const fireDoc = (type, init) => { const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...init }; for (const fn of listeners.doc[type] || []) fn(ev); return ev; };
  const fireWin = (type, ev) => { for (const fn of listeners.win[type] || []) fn(ev); };
  const select = (text, anchor) => { selection = { isCollapsed: false, toString: () => text, anchorNode: anchor, getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 118, left: 50, right: 200 }) }), removeAllRanges() { selection = collapsed(); } }; };
  return { document, window, parent, posted, nodes, body, html, fireDoc, fireWin, select };
}
async function runBridge(dom) {
  const saved = { document: globalThis.document, window: globalThis.window, parent: globalThis.parent };
  Object.assign(globalThis, { document: dom.document, window: dom.window, parent: dom.parent });
  try { lessonBridge(); } finally { /* the listeners keep references to the stubs; the globals go back after the test */ }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } };
}

test('the bridge pages the steps, reports them, follows a step request only from its parent, and stops links', async () => {
  const dom = stubDom((make, body) => {
    const ol = body.appendChild(make('ol'));
    const steps = [0, 1, 2].map(() => { const li = ol.appendChild(make('li')); li.classList.add('step'); return li; });
    const a = body.appendChild(make('a')); a.setAttribute('href', 'https://elsewhere.test/');
    return { steps, a };
  });
  const restore = await runBridge(dom);
  try {
    assert.ok(dom.html.classList.contains('paged'));
    assert.deepEqual(dom.posted[0], [{ type: 'atelier:lesson', what: 'steps', count: 3, index: 0 }, '*']);
    assert.deepEqual(readLessonMessage(dom.posted[0][0]), { what: 'steps', count: 3, index: 0 }, 'what the frame posts is what the parent takes');
    assert.deepEqual(dom.nodes.steps.map((s) => s.classList.contains('is-current')), [true, false, false]);
    assert.deepEqual(dom.nodes.steps.map((s) => s.getAttribute('data-step') + '/' + s.getAttribute('data-steps')), ['1/3', '2/3', '3/3'], 'each step carries its number: a CSS counter skips the hidden ones');
    dom.fireWin('message', { source: { someone: 'else' }, data: { type: 'atelier:lesson', what: 'step', index: 2 } });
    assert.equal(dom.posted.length, 1, 'a message not from the parent is ignored');
    dom.fireWin('message', { source: dom.parent, data: { type: 'atelier:lesson', what: 'step', index: 2 } });
    assert.deepEqual(dom.nodes.steps.map((s) => s.classList.contains('is-current')), [false, false, true]);
    assert.deepEqual(dom.posted.at(-1)[0], { type: 'atelier:lesson', what: 'steps', count: 3, index: 2 });
    dom.fireDoc('keydown', { key: 'ArrowLeft', target: dom.body });
    assert.equal(dom.posted.at(-1)[0].index, 1, 'the arrow keys page inside the frame');
    dom.fireWin('message', { source: dom.parent, data: { type: 'atelier:lesson', what: 'step', index: 99 } });
    assert.equal(dom.posted.at(-1)[0].index, 2, 'clamped to the last step');
    assert.equal(dom.fireDoc('click', { target: dom.nodes.a }).defaultPrevented, true, 'a link out of the lesson does not navigate the frame');
    dom.nodes.a.setAttribute('href', '#step-2');
    assert.equal(dom.fireDoc('click', { target: dom.nodes.a }).defaultPrevented, false, 'a link inside the lesson does');
  } finally { restore(); }
});

test('the bridge offers Ask about this on a selection and on a figure, and posts the shape the parent accepts', async () => {
  const dom = stubDom((make, body) => {
    const p = body.appendChild(make('p'));
    const fig = body.appendChild(make('figure'));
    const svg = fig.appendChild(make('svg'));
    const cap = fig.appendChild(make('figcaption')); cap.textContent = '  Who talks   to whom ';
    return { p, fig, svg };
  });
  const restore = await runBridge(dom);
  try {
    assert.deepEqual(dom.posted[0][0], { type: 'atelier:lesson', what: 'steps', count: 0, index: 0 }, 'no steps: the parent hides the row');
    assert.equal(dom.nodes.fig.getAttribute('tabindex'), '0', 'a figure can be reached by keyboard');
    const btn = dom.body.kids.find((k) => k.tagName === 'BUTTON');
    assert.equal(btn.textContent, 'Ask about this');
    assert.equal(btn.hidden, true);
    dom.select('the session cookie', dom.nodes.p);
    dom.fireDoc('mouseup', { target: dom.nodes.p });
    await wait(5);
    assert.equal(btn.hidden, false);
    assert.equal(btn.style.top, '124px', 'under the selection');
    btn.fire('click');
    const asked = dom.posted.at(-1)[0];
    assert.deepEqual(asked, { type: 'atelier:lesson', what: 'ask', kind: 'selection', text: 'the session cookie' });
    assert.deepEqual(readLessonMessage(asked), { what: 'ask', kind: 'selection', text: 'the session cookie' });
    assert.equal(btn.hidden, true);
    // A press on the drawing inside a figure asks about the figure, named by its caption.
    dom.fireDoc('mouseup', { target: dom.nodes.svg });
    await wait(5);
    assert.equal(btn.hidden, false);
    assert.equal(dom.nodes.fig.hasAttribute('data-asking'), true);
    btn.fire('click');
    assert.deepEqual(dom.posted.at(-1)[0], { type: 'atelier:lesson', what: 'ask', kind: 'figure', text: 'Who talks to whom' });
    assert.equal(dom.nodes.fig.hasAttribute('data-asking'), false);
    // Elsewhere with nothing selected: the button goes.
    dom.fireDoc('mouseup', { target: dom.nodes.svg }); await wait(5);
    dom.fireDoc('mouseup', { target: dom.nodes.p }); await wait(5);
    assert.equal(btn.hidden, true);
  } finally { restore(); }
});
