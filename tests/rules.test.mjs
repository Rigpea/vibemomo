// Fixed rules (t_coydia7ucq; docs/ARCHITECTURE.md section 23). Risks covered: a rule is stored in .studio/rules.json
// and survives edit and removal as written; a locked token is a real CSS custom property with one value that can end
// no declaration, hide no text and load no file, and a bad name or value is refused with a sentence that writes
// nothing; one token has one rule; two writes at once lose neither; the brief has its "Must stay the same" section
// (also saying so when there are none); the briefing lists the rules with their count; the watcher reports a hand
// edit; and through a real server process the routes, the briefing, a new task's brief and atelier_read_rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { addRule, patchRule, removeRule, listRules, rulesAnswer, lockedTokens, checkToken, checkTokenName, checkTokenValue, checkKind, rulesCount, ruleLine, byKind, briefLines, briefingLines, briefRules, RULE_KINDS, RULE_ID, MAX_RULES, TEXT_MAX, WHY_MAX, TOKEN_VALUE_MAX } from '../server/lib/rules.mjs';
import { STUDIO_RULES, seedRules } from '../server/lib/rules-seed.mjs';
import { renderBrief } from '../server/lib/tasks.mjs';
import { watchEvent } from '../server/lib/watch-events.mjs';
import { createTools } from '../server/lib/mcp/tools.mjs';
import { handleMessage } from '../server/lib/mcp/stdio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpProject = async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-rules-'));
  await fsp.mkdir(path.join(dir, '.studio'), { recursive: true });
  return dir;
};
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const stored = async (dir) => JSON.parse(await fsp.readFile(path.join(dir, '.studio', 'rules.json'), 'utf8'));

// ---------- the store ----------
test('rules: text, kind, why and a locked token; kept in .studio/rules.json in the order added; edit and remove', async () => {
  const dir = await tmpProject();
  try {
    assert.deepEqual(await listRules(dir), [], 'no file yet is no rules');
    const dark = await addRule(dir, { text: '  Dark   only ', kind: 'Color', why: '  the person, \n 2026-11-06 ' });
    assert.match(dark.id, RULE_ID);
    assert.deepEqual([dark.text, dark.kind, dark.why, dark.token], ['Dark only', 'color', 'the person, 2026-11-06', null]);
    const accent = await addRule(dir, { text: 'Amber is the one accent', kind: 'color', token: { name: ' --accent ', value: '  #d6a455 ' } });
    assert.deepEqual(accent.token, { name: '--accent', value: '#d6a455' });
    const motion = await addRule(dir, { text: 'Motion 160 ms or less', kind: 'motion', token: { name: '', value: '  ' } });
    assert.equal(motion.token, null, 'both token fields empty is no lock');
    assert.equal((await addRule(dir, { text: 'Every control acts on real state', kind: 'behavior' })).kind, 'behaviour', 'the other spelling is the same kind');
    const file = await stored(dir);
    assert.deepEqual(Object.keys(file), ['rules']);
    assert.deepEqual(file.rules.map((r) => r.text), ['Dark only', 'Amber is the one accent', 'Motion 160 ms or less', 'Every control acts on real state'], 'the order they were added');
    assert.deepEqual(Object.keys(file.rules[1]), ['id', 'text', 'kind', 'why', 'token', 'createdAt', 'updatedAt']);

    const edited = await patchRule(dir, dark.id, { text: 'Dark by default', why: '' });
    assert.deepEqual([edited.text, edited.why, edited.kind, edited.createdAt], ['Dark by default', '', 'color', dark.createdAt], 'only what was sent changes');
    assert.deepEqual((await patchRule(dir, motion.id, { token: { name: '--t', value: '140ms' } })).token, { name: '--t', value: '140ms' });
    assert.equal((await patchRule(dir, motion.id, { token: null })).token, null, 'null takes the lock off');
    assert.equal((await patchRule(dir, accent.id, { kind: 'tone' })).token.name, '--accent', 'a change of kind keeps the lock');
    assert.deepEqual(lockedTokens(await listRules(dir)), [{ name: '--accent', value: '#d6a455', ruleId: accent.id, text: 'Amber is the one accent' }]);
    const answer = await rulesAnswer(dir);
    assert.deepEqual([answer.kinds, answer.where, answer.locked.length, answer.limits.rules], [RULE_KINDS, { file: '.studio/rules.json' }, 1, MAX_RULES]);

    assert.deepEqual(await removeRule(dir, dark.id), { removed: dark.id });
    await assert.rejects(() => removeRule(dir, dark.id), { status: 404 });
    assert.deepEqual((await listRules(dir)).map((r) => r.id).includes(dark.id), false);
    // An entry that is not a rule (a hand edit gone wrong) is left out, not a reason to fail.
    await fsp.writeFile(path.join(dir, '.studio', 'rules.json'), JSON.stringify({ rules: [{ id: 'x', text: 'no id shape', kind: 'color' }, { id: 'rule_ok12345', text: 'Kept', kind: 'tone', token: { name: '--x' } }, null, 'words'] }));
    assert.deepEqual(await listRules(dir), [{ id: 'rule_ok12345', text: 'Kept', kind: 'tone', token: null }], 'half a token is no token');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a locked token is a CSS custom property and one safe value: every other name or value is refused with a sentence', () => {
  for (const name of ['--accent', '--s1', '--font-size_2', '--Accent', '--2xl']) assert.equal(checkTokenName(` ${name} `), name);
  for (const name of ['accent', '-accent', '--', '---', '--acc ent', '--accent:', '--a;b', '$accent', 'var(--accent)', `--${'a'.repeat(63)}`, 5, null]) {
    assert.throws(() => checkTokenName(name), { status: 400, message: /A locked token is a CSS custom property such as --accent: two dashes, then letters, digits, - or _ \(at most 64 characters\); ".*" is not one/ }, String(name));
  }
  for (const [value, kept] of [['#d6a455', '#d6a455'], [' 140ms ', '140ms'], ['rgba(214, 164, 85, 0.16)', 'rgba(214, 164, 85, 0.16)'], ['"Source Serif 4",  "Georgia", serif', '"Source Serif 4", "Georgia", serif'],
    ['0 12px 32px rgba(0, 0, 0, 0.45)', '0 12px 32px rgba(0, 0, 0, 0.45)'], ['calc(var(--s2) * 2)', 'calc(var(--s2) * 2)'], ['cubic-bezier(0.2, 0, 0, 1)', 'cubic-bezier(0.2, 0, 0, 1)'], ["'a (b'", "'a (b'"]]) {
    assert.equal(checkTokenValue(value), kept, value);
  }
  const refused = [
    ['', /needs its value, such as #d6a455 or 140ms/], ['   ', /needs its value/], [7, /needs its value/],
    ['red; background: url(x)', /cannot hold ;/], ['red } body { color: blue', /cannot hold }/], ['{', /cannot hold \{/], ['</style><script>', /cannot hold </], ['a > b', /cannot hold >/],
    ['\\75 rl(x)', /cannot hold \\/], ['red !important', /cannot hold !/], ['red /* note */', /cannot hold a comment/], ['4px */', /cannot hold a comment/],
    ['url(https://example.com/a.png)', /cannot load or read anything/], ['URL (x)', /cannot load or read anything/], ['image-set("a.png" 1x)', /cannot load or read anything/], ['attr(data-x)', /cannot load or read anything/],
    ['env(safe-area-inset-top)', /cannot load or read anything/], ['@import "x"', /cannot load or read anything/], ['rgba(0, 0, 0', /must close every quote and parenthesis/], ['"Inter', /must close every quote and parenthesis/], ['4px)', /must close every quote and parenthesis/],
    ['a\u0000b', /holds a control character/], ['x'.repeat(TOKEN_VALUE_MAX + 1), new RegExp(`at most ${TOKEN_VALUE_MAX} characters; this one is ${TOKEN_VALUE_MAX + 1}`)],
  ];
  for (const [value, words] of refused) assert.throws(() => checkTokenValue(value), (err) => err.status === 400 && err.code === 'invalid_input' && words.test(err.message), String(value).slice(0, 40));
  // A name inside another word is not that function: a custom property called --image-url is only read through var().
  for (const fine of ['curl', 'var(--image-url)', 'var(--env)', 'minmax(280px, 1fr)']) assert.equal(checkTokenValue(fine), fine);
  assert.equal(checkToken(null), null);
  assert.equal(checkToken({ name: ' ', value: '' }), null);
  assert.throws(() => checkToken({ name: '--accent', value: '' }), { status: 400, message: 'A locked token needs both its name and its value; --accent has no value' });
  assert.throws(() => checkToken({ name: '', value: '#fff' }), { status: 400, message: /this value has no name \(such as --accent\)/ });
  assert.throws(() => checkToken('--accent: #fff'), { status: 400, message: /token must be \{ name, value \}/ });
  assert.throws(() => checkKind('colour'), { status: 400, message: 'Choose what kind of rule it is: color, type, layout, motion, tone, behaviour' });
});

test('unfit input writes nothing: no words, a long rule, no kind, a bad token, a token another rule locks, a full list, an id of another shape', async () => {
  const dir = await tmpProject();
  try {
    const accent = await addRule(dir, { text: 'Amber is the one accent', kind: 'color', token: { name: '--accent', value: '#d6a455' } });
    const other = await addRule(dir, { text: 'Warm charcoal canvas', kind: 'color' });
    const before = await fsp.readFile(path.join(dir, '.studio', 'rules.json'), 'utf8');
    const refusals = [
      [{ kind: 'color' }, 400, /A rule needs its words/], [{ text: '   ', kind: 'color' }, 400, /A rule needs its words/], [{ text: ['x'], kind: 'color' }, 400, /A rule must be text/],
      [{ text: 'x'.repeat(TEXT_MAX + 1), kind: 'color' }, 400, new RegExp(`A rule is at most ${TEXT_MAX} characters; this one is ${TEXT_MAX + 1}`)],
      [{ text: 'A rule', kind: 'tone', why: 'y'.repeat(WHY_MAX + 1) }, 400, new RegExp(`why is at most ${WHY_MAX} characters`)],
      [{ text: 'A rule' }, 400, /Choose what kind of rule it is/], [{ text: 'A rule', kind: 'sound' }, 400, /Choose what kind of rule it is/],
      [{ text: 'A rule', kind: 'color', token: { name: 'accent', value: '#fff' } }, 400, /"accent" is not one/],
      [{ text: 'A rule', kind: 'color', token: { name: '--bg', value: 'red; color: blue' } }, 400, /cannot hold ;/],
      [{ text: 'A rule', kind: 'color', token: { name: '--accent', value: '#00ffcc' } }, 409, /^--accent is already locked to #d6a455 by the rule "Amber is the one accent"; change that rule, or take its lock off first$/],
      [{ text: 'Same value, second rule', kind: 'color', token: { name: '--accent', value: '#d6a455' } }, 409, /already locked/],
    ];
    for (const [body, status, words] of refusals) await assert.rejects(() => addRule(dir, body), (err) => err.status === status && words.test(err.message), JSON.stringify(body).slice(0, 70));
    await assert.rejects(() => patchRule(dir, other.id, { token: { name: '--accent', value: '#fff' } }), { status: 409, code: 'token_locked' });
    await assert.rejects(() => patchRule(dir, other.id, { text: '' }), { status: 400 });
    assert.equal((await patchRule(dir, accent.id, { token: { name: '--accent', value: '#d6a455' } })).token.value, '#d6a455', 'a rule may keep its own token');
    for (const id of ['rule_gone1234', '../project', 'ins_abc12345', '', null, 'rule_' + 'a'.repeat(41)]) {
      await assert.rejects(() => patchRule(dir, id, { why: 'x' }), { status: 404 }, String(id));
      await assert.rejects(() => removeRule(dir, id), { status: 404 }, String(id));
    }
    const now = await stored(dir);
    assert.deepEqual(now.rules.map((r) => [r.text, r.token?.value || null]), JSON.parse(before).rules.map((r) => [r.text, r.token?.value || null]), 'no refusal changed a rule');
    assert.deepEqual((await fsp.readdir(path.join(dir, '.studio'))).sort(), ['rules.json'], 'and nothing else was written');
    await fsp.writeFile(path.join(dir, '.studio', 'rules.json'), JSON.stringify({ rules: Array.from({ length: MAX_RULES }, (_, i) => ({ id: `rule_n${String(i).padStart(6, '0')}`, text: `Rule ${i}`, kind: 'tone' })) }));
    await assert.rejects(() => addRule(dir, { text: 'One too many', kind: 'tone' }), { status: 409, code: 'rules_full', message: `A project keeps at most ${MAX_RULES} fixed rules; remove one first` });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('writes at once lose nothing: twelve rules added together are all kept, and one token still has one rule', async () => {
  const dir = await tmpProject();
  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => addRule(dir, { text: `Rule ${i}`, kind: RULE_KINDS[i % RULE_KINDS.length] })));
    assert.equal((await listRules(dir)).length, 12);
    const both = await Promise.allSettled([addRule(dir, { text: 'First lock', kind: 'color', token: { name: '--bg', value: '#232221' } }), addRule(dir, { text: 'Second lock', kind: 'color', token: { name: '--bg', value: '#000' } })]);
    assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(lockedTokens(await listRules(dir)).length, 1);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ---------- the studio's own first rules ----------
test('the studio\'s seed rules: each is a valid rule that names its source; a locked token holds the value client/styles.css has; a list with rules is never written over', async () => {
  const css = await fsp.readFile(path.join(ROOT, 'client', 'styles.css'), 'utf8');
  const dark = css.slice(css.indexOf(':root, [data-theme="dark"] {'), css.indexOf('[data-theme="light"] {'));
  const shared = css.slice(css.indexOf('\n:root {'));
  assert.deepEqual(RULE_KINDS.filter((k) => !STUDIO_RULES.some((s) => s.kind === k)), [], 'every kind has a rule');
  for (const seed of STUDIO_RULES) {
    assert.match(seed.why, /DESIGN\.md|CLAUDE\.md|decision|direction/, `${seed.text} names where it comes from`);
    if (seed.token) assert.ok((dark + shared).includes(`${seed.token.name}: ${seed.token.value};`), `${seed.token.name} is ${seed.token.value} in client/styles.css`);
  }
  assert.deepEqual(STUDIO_RULES.filter((s) => s.token).map((s) => s.token.name), ['--bg', '--ink', '--accent', '--serif'], 'the look\'s identity is locked; scales and the motion bound are rules in words');
  const dir = await tmpProject();
  try {
    assert.deepEqual(await seedRules(dir), { seeded: STUDIO_RULES.length });
    const rules = await listRules(dir);
    assert.deepEqual(rules.map((r) => [r.kind, r.text, r.why, r.token]), STUDIO_RULES.map((s) => [s.kind, s.text, s.why, s.token || null]), 'stored as written: nothing was cut or refused');
    assert.equal(rulesCount(rules), `${STUDIO_RULES.length} rules (4 lock a design token)`);
    await removeRule(dir, rules[0].id);
    assert.deepEqual(await seedRules(dir), { seeded: 0, kept: STUDIO_RULES.length - 1 }, 'the person\'s list stays as it is');
    assert.equal((await listRules(dir)).length, STUDIO_RULES.length - 1);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

// ---------- what Claude reads ----------
const RULES = [
  { id: 'rule_motion0001', text: 'Motion 160 ms or less', kind: 'motion', why: 'docs/DESIGN.md section 1', token: null },
  { id: 'rule_accent0001', text: 'Amber is the one accent', kind: 'color', why: '', token: { name: '--accent', value: '#d6a455' } },
  { id: 'rule_chips00001', text: 'Chips only for states', kind: 'tone', why: 'docs/DESIGN.md sections 1 and 3', token: null },
  { id: 'rule_canvas0001', text: 'Warm charcoal canvas', kind: 'color', why: 'the look', token: { name: '--bg', value: '#232221' } },
];

test('the words: the count, one line per rule, by kind; the brief lines and the briefing lines; none says so', () => {
  assert.equal(rulesCount(RULES), '4 rules (2 lock a design token)');
  assert.equal(rulesCount([RULES[1]]), '1 rule (1 locks a design token)');
  assert.equal(rulesCount([RULES[0]]), '1 rule');
  assert.equal(rulesCount([]), 'no rules');
  assert.deepEqual(byKind(RULES).map((r) => r.id), ['rule_accent0001', 'rule_canvas0001', 'rule_motion0001', 'rule_chips00001'], 'the kinds in their order, the order added within a kind');
  assert.equal(ruleLine(RULES[1]), 'color · Amber is the one accent · locked: `--accent: #d6a455`');
  assert.equal(ruleLine(RULES[0]), 'motion · Motion 160 ms or less · why: docs/DESIGN.md section 1');
  assert.equal(ruleLine(RULES[3], { full: true }), 'color rule_canvas0001 · Warm charcoal canvas · locked: `--bg: #232221` · why: the look');
  const brief = briefLines(RULES);
  assert.equal(brief[0], "The project's fixed rules: 4 rules (2 lock a design token) in `.studio/rules.json`. They are the person's, and only the person changes them; everything else is free to change. Keep to every one in this task, and leave a locked token at its exact value. If the request cannot be done without breaking one, or asks to change one, ask with task question instead of breaking it.");
  assert.deepEqual(brief.slice(1), ['- color · Amber is the one accent · locked: `--accent: #d6a455`', '- color · Warm charcoal canvas · locked: `--bg: #232221` · why: the look', '- motion · Motion 160 ms or less · why: docs/DESIGN.md section 1', '- tone · Chips only for states · why: docs/DESIGN.md sections 1 and 3'], 'every rule, none cut');
  assert.deepEqual(briefLines([]), ["No fixed rules are recorded for this project (`.studio/rules.json`; the studio's Inspiration view keeps them under Fixed rules)."]);
  const briefing = briefingLines(RULES);
  assert.equal(briefing[0], "The project's fixed rules: 4 rules (2 lock a design token) in `.studio/rules.json`; atelier_read_rules reads them. Keep to them unless the person says otherwise; a locked token keeps its exact value.");
  assert.deepEqual(briefing.slice(1), brief.slice(1));
  assert.match(briefingLines([])[0], /^- _no fixed rules yet_ \(`\.studio\/rules\.json`/);
});

test('every brief has one "Must stay the same" section between the request and the inspiration; a list that cannot be read says so', async () => {
  const task = { id: 't_x1', title: 'T', mode: 'handle', route: 'claude-code', createdAt: 'now', request: 'Do it', inspiration: 'Celeste dashes', acceptance: [], unresolved: [], context: { files: [] } };
  const ctx = { project: { name: 'P', kind: 'web-app', id: 'p_1' }, manifest: { entry: 'src/index.html' }, entry: { path: 'C:/p' }, version: null };
  const lines = briefLines(RULES);
  const brief = renderBrief(task, { ...ctx, rules: lines });
  assert.ok(brief.includes(`\n## Request\nDo it\n\n## Must stay the same\n${lines.join('\n')}\n\n## Inspiration\nCeleste dashes\n\n## Project\n`), 'after the request, before the references');
  assert.equal(brief.match(/## Must stay the same/g).length, 1);
  const none = renderBrief({ ...task, inspiration: '' }, { ...ctx, rules: briefLines([]) });
  assert.ok(none.includes('\n## Must stay the same\nNo fixed rules are recorded for this project (`.studio/rules.json`;'), 'a project with no rules says so');
  assert.ok(none.includes('Fixed rules).\n\n\n## Project\n'), 'and the sections after it stand as before');
  const dir = await tmpProject();
  try {
    assert.deepEqual(await briefRules(dir), briefLines([]));
    await addRule(dir, { text: 'Dark only', kind: 'color' });
    assert.deepEqual((await briefRules(dir)).slice(1), ['- color · Dark only']);
    await fsp.rm(path.join(dir, '.studio', 'rules.json'));
    await fsp.mkdir(path.join(dir, '.studio', 'rules.json')); // a folder where the file should be: it cannot be read
    assert.deepEqual(await briefRules(dir), ["The project's fixed rules could not be read from `.studio/rules.json`. Ask with task question before changing the look."], 'unreadable is not the same as none');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('the rules record under .studio reaches the stream as rules.changed; its temp files say nothing', () => {
  assert.deepEqual(watchEvent('rules.json'), { type: 'rules.changed', data: { file: 'rules.json' } });
  assert.equal(watchEvent('rules.json.123.456.tmp'), null);
  assert.equal(watchEvent('rules.json.corrupt-1'), null);
  assert.deepEqual(watchEvent('inspiration.json'), { type: 'inspiration.changed', data: { file: 'inspiration.json' } }, 'the board as before');
  assert.equal(watchEvent('project.json').type, 'project.changed');
});

// ---------- the routes, the briefing, a new task's brief and the companion's tool, against a real studio ----------
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-rules-http-'));
let child;
let project;
let second;
const api = async (method, p, body) => {
  const res = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
before(async () => {
  await fsp.mkdir(path.join(root, 'projects'), { recursive: true });
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(root, 'data'), ATELIER_PROJECTS_DIR: path.join(root, 'projects'), ATELIER_PID_FILE: path.join(root, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') },
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
  const made = await api('POST', '/api/projects', { name: 'Rule Notes', kind: 'web-app', template: 'web-app-notes' });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  project = made.data.project;
  const other = await api('POST', '/api/projects', { name: 'Other Notes', kind: 'web-app', template: 'web-app-notes' });
  assert.equal(other.status, 200, JSON.stringify(other.data));
  second = other.data.project;
});
after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

test('routes: add, edit, remove; refusals as sentences; each project its own rules; the briefing, a new brief and the tool', async () => {
  const R = `/api/projects/${project.id}/rules`;
  const empty = await api('GET', R);
  assert.deepEqual([empty.status, empty.data.rules, empty.data.kinds, empty.data.locked, empty.data.where], [200, [], RULE_KINDS, [], { file: '.studio/rules.json' }]);
  assert.match((await api('GET', `/api/briefing?projectId=${project.id}`)).data.markdown, /\n## Must stay the same\n- _no fixed rules yet_ \(`\.studio\/rules\.json`/);
  // With no rules a new brief still has the section, saying so.
  const bare = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Tidy the list.' })).data;
  assert.match((await api('GET', `/api/projects/${project.id}/tasks/${bare.id}`)).data.brief, /\n## Request\nTidy the list\.\n\n## Must stay the same\nNo fixed rules are recorded for this project/);

  const motion = (await api('POST', R, { text: 'Motion 160 ms or less', kind: 'motion', why: 'docs/DESIGN.md section 1' })).data;
  const accent = await api('POST', R, { text: 'Amber is the one accent', kind: 'color', token: { name: '--accent', value: '#d6a455' } });
  assert.equal(accent.status, 200, JSON.stringify(accent.data));
  const chips = (await api('POST', R, { text: 'Chips only for states', kind: 'tone' })).data;
  const folder = path.join(root, 'projects', project.slug || 'rule-notes', '.studio');
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(folder, 'rules.json'), 'utf8')).rules.map((r) => r.id), [motion.id, accent.data.id, chips.id]);
  assert.deepEqual((await api('GET', R)).data.locked, [{ name: '--accent', value: '#d6a455', ruleId: accent.data.id, text: 'Amber is the one accent' }]);
  // Another project keeps its own list.
  assert.deepEqual((await api('GET', `/api/projects/${second.id}/rules`)).data.rules, []);
  assert.equal((await api('PATCH', `/api/projects/${second.id}/rules/${motion.id}`, { why: 'x' })).status, 404, 'a rule is its own project\'s');

  const refusal = async (method, p, body, status, code, words) => {
    const r = await api(method, p, body);
    assert.deepEqual([r.status, r.data?.error?.code], [status, code], JSON.stringify(body).slice(0, 70));
    assert.match(r.data.error.message, words);
  };
  await refusal('POST', R, { text: 'Bad name', kind: 'color', token: { name: 'accent', value: '#fff' } }, 400, 'invalid_input', /A locked token is a CSS custom property such as --accent/);
  await refusal('POST', R, { text: 'Bad value', kind: 'color', token: { name: '--bg', value: 'red; } body { display: none' } }, 400, 'invalid_input', /A token's value is one CSS value: it cannot hold ;/);
  await refusal('POST', R, { text: 'Loads a file', kind: 'color', token: { name: '--bg', value: 'url(http://127.0.0.1/x)' } }, 400, 'invalid_input', /cannot load or read anything/);
  await refusal('POST', R, { text: 'Half a token', kind: 'color', token: { name: '--bg', value: '' } }, 400, 'invalid_input', /needs both its name and its value; --bg has no value/);
  await refusal('POST', R, { text: 'Taken', kind: 'color', token: { name: '--accent', value: '#fff' } }, 409, 'token_locked', /--accent is already locked to #d6a455/);
  await refusal('POST', R, { text: '', kind: 'color' }, 400, 'invalid_input', /A rule needs its words/);
  await refusal('POST', R, { text: 'No kind' }, 400, 'invalid_input', /Choose what kind of rule it is/);
  await refusal('PATCH', `${R}/${chips.id}`, { token: { name: '--x y', value: '1' } }, 400, 'invalid_input', /is not one/);
  assert.equal((await api('PATCH', `${R}/rule_nothere1234`, { why: 'x' })).status, 404);
  assert.equal((await api('PATCH', `${R}/..%2Fproject`, { why: 'x' })).status, 404);
  assert.equal((await api('GET', R)).data.rules.length, 3, 'a refusal adds nothing');

  const edited = await api('PATCH', `${R}/${chips.id}`, { text: 'Chips only for states; kinds and modes are plain words', why: 'docs/DESIGN.md sections 1 and 3' });
  assert.deepEqual([edited.status, edited.data.text, edited.data.why, edited.data.kind], [200, 'Chips only for states; kinds and modes are plain words', 'docs/DESIGN.md sections 1 and 3', 'tone']);

  // The briefing lists the rules with their count, and is written again when one comes.
  const section = "\n## Must stay the same\nThe project's fixed rules: 3 rules (1 locks a design token) in `.studio/rules.json`; atelier_read_rules reads them. Keep to them unless the person says otherwise; a locked token keeps its exact value.\n- color · Amber is the one accent · locked: `--accent: #d6a455`\n- motion · Motion 160 ms or less · why: docs/DESIGN.md section 1\n- tone · Chips only for states; kinds and modes are plain words · why: docs/DESIGN.md sections 1 and 3\n\n## Recent versions";
  assert.ok((await api('GET', `/api/briefing?projectId=${project.id}`)).data.markdown.includes(section));
  assert.ok((await fsp.readFile(path.join(folder, 'BRIEFING.md'), 'utf8')).includes(section), 'the file too');
  // A new task's brief has the section; a brief written before catches up at handover.
  const task = (await api('POST', `/api/projects/${project.id}/tasks`, { request: 'Restyle the notes list.', inspiration: 'A paper notebook' })).data;
  const brief = (await api('GET', `/api/projects/${project.id}/tasks/${task.id}`)).data.brief;
  assert.deepEqual(brief.slice(brief.indexOf('## Must stay the same'), brief.indexOf('## Inspiration')).trim().split('\n'), [
    '## Must stay the same',
    "The project's fixed rules: 3 rules (1 locks a design token) in `.studio/rules.json`. They are the person's, and only the person changes them; everything else is free to change. Keep to every one in this task, and leave a locked token at its exact value. If the request cannot be done without breaking one, or asks to change one, ask with task question instead of breaking it.",
    '- color · Amber is the one accent · locked: `--accent: #d6a455`',
    '- motion · Motion 160 ms or less · why: docs/DESIGN.md section 1',
    '- tone · Chips only for states; kinds and modes are plain words · why: docs/DESIGN.md sections 1 and 3',
  ]);
  assert.ok(brief.indexOf('## Request') < brief.indexOf('## Must stay the same') && brief.indexOf('## Must stay the same') < brief.indexOf('## Project'));
  assert.doesNotMatch((await api('GET', `/api/projects/${second.id}/tasks/${(await api('POST', `/api/projects/${second.id}/tasks`, { request: 'Other work.' })).data.id}`)).data.brief, /Amber is the one accent/, 'another project\'s brief has none of them');

  // The companion's tool: every rule by kind with its id, one kind, the locks, and its refusals.
  const tools = createTools({ studio: BASE, project: project.id });
  let n = 0;
  const call = async (args, name = 'atelier_read_rules') => (await handleMessage({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }, { tools })).result;
  const all = await call({});
  assert.equal(all.isError, undefined, all.content[0].text);
  assert.deepEqual(all.content[0].text.split('\n'), [
    `Fixed rules of Rule Notes (${project.id}): 3 rules (1 locks a design token), by kind. They must stay the same; records in .studio/rules.json of the project folder.`,
    `1. color ${accent.data.id} · Amber is the one accent · locked: \`--accent: #d6a455\``,
    `2. motion ${motion.id} · Motion 160 ms or less · why: docs/DESIGN.md section 1`,
    `3. tone ${chips.id} · Chips only for states; kinds and modes are plain words · why: docs/DESIGN.md sections 1 and 3`,
    'Locked tokens (keep each at this exact value): --accent: #d6a455',
  ]);
  assert.deepEqual((await call({ kind: 'motion' })).content[0].text.split('\n'), [
    `Fixed rules of Rule Notes (${project.id}): 3 rules (1 locks a design token); 1 of the kind motion, by kind. They must stay the same; records in .studio/rules.json of the project folder.`,
    `1. motion ${motion.id} · Motion 160 ms or less · why: docs/DESIGN.md section 1`,
  ]);
  assert.match((await call({ kind: 'type' })).content[0].text, /^No fixed rule of Rule Notes \(p_[a-z0-9]+\) is of the kind type; it has 3 rules \(1 locks a design token\), of the kinds color, motion, tone\.$/);
  assert.equal((await call({ kind: 'sound' })).isError, true);
  assert.match((await call({ project: second.id })).content[0].text, /^Other Notes \(p_[a-z0-9]+\) has no fixed rules: the person has not set anything that must stay the same/);

  // Remove: the rule goes, the lock with it; the briefing counts again.
  assert.deepEqual((await api('DELETE', `${R}/${accent.data.id}`)).data, { removed: accent.data.id });
  assert.equal((await api('DELETE', `${R}/${accent.data.id}`)).status, 404);
  assert.deepEqual((await api('GET', R)).data.locked, []);
  assert.match(await fsp.readFile(path.join(folder, 'BRIEFING.md'), 'utf8'), /The project's fixed rules: 2 rules in `\.studio\/rules\.json`/);
  assert.equal((await api('POST', R, { text: 'Teal now', kind: 'color', token: { name: '--accent', value: '#2aa198' } })).status, 200, 'the token is free again');
});
