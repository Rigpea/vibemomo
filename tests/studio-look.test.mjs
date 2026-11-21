// The Studio look (t_bh07hvllso; docs/ARCHITECTURE.md section 27, docs/DESIGN.md section 15). Risks covered: the
// person's board for the studio's look lands in a project, or a project's app board is touched by it; Make a look
// proposes a colour without naming the card it came from, or a text and surface pair under AA; a look's surfaces put
// a dark canvas in the light theme or the other way round; new surfaces leave an accent kept earlier unreadable;
// Apply, Undo and Reset do not survive a reload (they live in the registry, not the window); a fixed rule's lock
// refuses the person's own look (it binds the source only, decision row 186); a brief or the briefing reads the
// person's board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { proposeLook, boardColours, fontFromBoard, radiusFromBoard, pairsWords, chroma } from '../client/components/studio-look-model.js';
import { THEMES, AA_TEXT, SIDE, CANVAS, contrast, surfaceCheck, surfaceVars, surfaceGrounds, cssVars, textPairs, checkAppearancePatch, mergeAppearance, restorePatch, cleanAppearance, accentOf, FONTS, TEXT_GROUNDS } from '../client/components/appearance-model.js';
import { addCard, listCards, removeCard, readCardFile } from '../server/lib/inspiration.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fsp.readFile(path.join(ROOT, rel), 'utf8');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const card = (id, kind, fields) => ({ id: `ins_${id}`, kind, tags: [], why: '', ...fields });
const CREAM_TEAL = [
  card('cream001', 'color', { hex: '#f3e9d7', name: 'warm cream', tags: ['color'] }),
  card('teal0001', 'color', { hex: '#2f7f79', name: 'teal', tags: ['color'] }),
  card('deep0001', 'color', { hex: '#173b3a', name: 'deep teal', tags: ['color'] }),
  card('sand0001', 'color', { hex: '#e0b98a', name: 'sand' }),
  card('note0001', 'note', { text: 'Bookish and calm: a Garamond for headings, nothing loud.', tags: ['type', 'mood'] }),
  card('note0002', 'note', { text: 'Paper and sea glass. Rounded cards like pebbles.', tags: ['layout'] }),
  card('link0001', 'link', { url: 'https://example.com/', title: 'A calm reading app', tags: ['mood'] }),
];

// ---------- Make a look ----------
test('Make a look: canvas, panel, ink, accent, display font and corners from the board, each naming its card; every text and surface pair at AA', () => {
  for (const theme of THEMES) {
    const p = proposeLook(CREAM_TEAL, theme, {});
    assert.equal(p.problem, null, theme);
    assert.deepEqual(p.rows.map((r) => r.key), ['canvas', 'panel', 'ink', 'accent', 'display', 'radius']);
    for (const r of p.rows) assert.ok(r.words.length > 8, `${theme} ${r.key} says where it came from`);
    const byKey = Object.fromEntries(p.rows.map((r) => [r.key, r]));
    // A dark theme takes the deep teal for its canvas and the cream for its ink; a light theme the other way round.
    assert.equal(byKey.canvas.card.id, theme === 'dark' ? 'ins_deep0001' : 'ins_cream001');
    assert.equal(byKey.ink.card.id, theme === 'dark' ? 'ins_cream001' : 'ins_deep0001');
    assert.match(byKey.canvas.words, theme === 'dark' ? /“Color #173b3a deep teal”/ : /“Color #f3e9d7 warm cream”/);
    assert.equal(byKey.display.value, 'garamond');
    assert.match(byKey.display.words, /“garamond” in “Note: Bookish and calm/);
    assert.equal(byKey.radius.value, 'round');
    assert.match(byKey.radius.words, /“rounded” in “Note: Paper and sea glass/);
    // The canvas is on the theme's side, and the patch passes the server's own check.
    const s = p.patch.surfaces[theme];
    assert.ok(contrast(s.canvas, SIDE[theme].away) >= SIDE[theme].need);
    assert.equal(checkAppearancePatch(p.patch, {}).ok, true);
    assert.deepEqual(Object.keys(p.patch).sort(), ['accent', 'display', 'radius', 'surfaces']);
    // Every pair the look draws text on passes, and the sentence says the lowest.
    assert.ok(p.pairs.length >= 19);
    for (const pair of p.pairs) assert.ok(pair.ratio >= AA_TEXT, `${theme}: ${pair.words} ${pair.fg} on ${pair.bg} is ${pair.ratio}`);
    assert.match(pairsWords(p.pairs), /^Every text and surface pair passes AA: \d+ pairs, the lowest .+ at \d+\.\d:1\.$/);
    // The preview is what the page would show: the canvas on --bg, the face on --serif, the corners on --r2.
    const vars = cssVars(p.preview, theme);
    assert.equal(vars['--bg'], s.canvas);
    assert.equal(vars['--serif'], FONTS.garamond.stack);
    assert.equal(vars['--r2'], '14px');
  }
  // On cream the teal is the accent, made darker to pass, and the row says both colours.
  const light = proposeLook(CREAM_TEAL, 'light', {}).rows.find((r) => r.key === 'accent');
  assert.equal(light.card.id, 'ins_teal0001');
  assert.match(light.words, /^from “Color #2f7f79 teal”, made darker from #2f7f79 to pass$/);
});

test('Make a look with less on the board: shades worked out from what is there, never a colour from nowhere; nothing at all changes nothing', () => {
  // One light colour in the dark theme: the canvas is a dark shade of it, named as such; the ink of its hue.
  const one = proposeLook([card('only0001', 'color', { hex: '#f1e6d0', name: 'cream' })], 'dark', {});
  const rows = Object.fromEntries(one.rows.map((r) => [r.key, r]));
  assert.match(rows.canvas.words, /^a dark shade of #f1e6d0, from “Color #f1e6d0 cream”$/);
  assert.equal(rows.panel.words, 'a step up from the canvas');
  assert.match(rows.accent.words, /^the studio's own #d6a455/);
  for (const pair of one.pairs) assert.ok(pair.ratio >= AA_TEXT, pair.words);
  // No colours, no words: no colour rows, a patch with nothing, nothing to Apply.
  const none = proposeLook([card('link0002', 'link', { url: 'https://example.com/', title: 'Something' })], 'dark', {});
  assert.deepEqual(none.rows.map((r) => [r.key, r.value]), [['display', null], ['radius', null]]);
  assert.deepEqual(none.patch, {});
  // A hex written in a note counts as a colour of that note.
  assert.deepEqual(boardColours([card('note0003', 'note', { text: 'Ink like #1B2A3A, paper #fff and #abcd (not a colour).' })]).map((c) => c.hex), ['#1b2a3a', '#ffffff']);
  // A face and corners are read from words; the earliest word wins and "sans-serif" is not "serif".
  assert.equal(fontFromBoard([card('n1', 'note', { text: 'Headings in a sans-serif, body in a serif.' })]).key, 'grotesk');
  assert.equal(fontFromBoard([card('n2', 'note', { text: 'A serif for the product\'s own words; everything else in the sans.' })]).key, 'source');
  assert.equal(fontFromBoard([card('n3', 'note', { text: 'Nothing about type.' })]), null);
  assert.equal(fontFromBoard([card('n6', 'note', { text: 'A serif like Garamond, bookish.' })]).word, 'garamond', 'a family name beats a plain serif and a mood word');
  assert.equal(radiusFromBoard([card('n4', 'note', { text: 'Crisp, square buttons.' })]).key, 'sharp');
  assert.equal(radiusFromBoard([card('n5', 'note', { text: 'Slightly rounded panels.' })]).key, 'soft');
  assert.ok(chroma('#2f7f79') > chroma('#808080'));
});

// ---------- surfaces at AA ----------
test('surfaces: refused on the wrong side or under AA with the nearest ink that passes; whatever is kept writes passing inks and states', () => {
  assert.match(surfaceCheck({ canvas: '#f3e9d7', panel: '#faf6ef', ink: '#173b3a' }, 'dark').sentence, /^A dark theme's canvas is dark: #f3e9d7 is 1\.\d:1 against #ffffff, under the 7:1 that needs\.$/);
  assert.match(surfaceCheck({ canvas: '#173b3a', panel: '#1f4241', ink: '#f3e9d7' }, 'light').sentence, /^A light theme's canvas is light/);
  const low = surfaceCheck({ canvas: '#232221', panel: '#2a2927', ink: '#5a5650' }, 'dark');
  assert.deepEqual([low.ok, low.reason], [false, 'low_contrast']);
  assert.match(low.sentence, /^The ink #5a5650 is \d\.\d:1 on the (canvas|panel|raised panel|field|selected control) \(#[0-9a-f]{6}\), under the 4\.5:1 text needs\. The nearest shade that passes is (#[0-9a-f]{6})\.$/);
  assert.equal(surfaceCheck({ canvas: '#232221', panel: '#2a2927', ink: low.nearest }, 'dark').ok, true, 'the shade offered passes itself');
  assert.equal(surfaceCheck({ canvas: '#232221', panel: '#2a2927', ink: 'white' }, 'dark').reason, 'not_hex');
  assert.equal(surfaceCheck({ canvas: '#232221', panel: '#2a2927', ink: '#ffffff', extra: '#000' }, 'dark').reason, 'invalid');
  assert.equal(surfaceCheck('#232221', 'dark').reason, 'invalid');
  // A spread of palettes: whatever passes the check draws every text and every state colour at AA on its surfaces.
  const palettes = { dark: [['#232221', '#2a2927', '#ece8e1'], ['#0e1a2b', '#15233a', '#c9d6e8'], ['#1d1424', '#251b2e', '#e8dcef'], ['#101010', '#1a1a1a', '#bdbdbd']], light: [['#f3f1ec', '#fbfaf7', '#1f1c18'], ['#eef4f8', '#f8fbfd', '#14304a'], ['#f6efe4', '#fbf7f0', '#3a2a1a'], ['#ffffff', '#ffffff', '#4a4a4a']] };
  for (const theme of THEMES) {
    for (const [canvas, panel, ink] of palettes[theme]) {
      const c = surfaceCheck({ canvas, panel, ink }, theme);
      assert.ok(c.ok, `${theme} ${canvas}: ${c.sentence}`);
      const look = { surfaces: { [theme]: c.surfaces } };
      for (const pair of textPairs(look, theme)) assert.ok(pair.ratio >= AA_TEXT, `${theme} ${canvas}: ${pair.words} is ${pair.ratio}`);
      const vars = surfaceVars(c.surfaces, theme);
      const grounds = surfaceGrounds(c.surfaces, theme);
      for (const k of ['--ok', '--warn', '--danger', '--busy']) for (const g of ['--bg', '--panel', '--panel-2']) assert.ok(contrast(vars[k], grounds[g]) >= AA_TEXT, `${theme} ${canvas}: ${k} on ${g}`);
      assert.ok(contrast(accentOf(look, theme), grounds['--panel']) >= AA_TEXT, 'the studio\'s own accent, moved to pass on a look\'s surfaces');
    }
  }
  assert.deepEqual(Object.keys(TEXT_GROUNDS), ['--bg', '--panel', '--panel-2', '--field', '--seg-on']);
});

test('a patch with surfaces: an accent is judged on the surfaces it will sit on, a kept accent too; Undo\'s patch brings back exactly what was', () => {
  const dark = { canvas: '#173b3a', panel: '#1f4241', ink: '#f3e9d7' };
  // #2f7f79 passes nowhere near 4.5:1 on a deep teal canvas: refused with the nearest shade.
  const refused = checkAppearancePatch({ surfaces: { dark }, accent: { dark: '#2f7f79' } }, {});
  assert.deepEqual([refused.ok, refused.code, refused.key], [false, 'low_contrast', 'accent']);
  assert.match(refused.message, /against the dark (canvas|panel|raised panel|field) \(#[0-9a-f]{6}\).*The nearest shade that passes is #[0-9a-f]{6}\.$/);
  // An accent already kept that would not pass on new surfaces: the surfaces must come with an accent.
  const stored = { accent: { dark: '#3d7a9a' } };
  assert.equal(checkAppearancePatch({ accent: { dark: '#3d7a9a' } }, {}).ok, false, 'a dim blue fails on the studio\'s canvas too');
  const kept = { accent: { dark: '#79b3dc' } };
  const deep = { canvas: '#0b2a40', panel: '#11324a', ink: '#e6eef5' };
  const lowKept = checkAppearancePatch({ surfaces: { dark: deep } }, { accent: { dark: '#5f8fb0' } });
  assert.equal(lowKept.ok, checkAppearancePatch({ accent: { dark: '#5f8fb0' } }, { surfaces: { dark: deep } }).ok, 'the same accent, the same surfaces: one answer whichever came first');
  assert.equal(checkAppearancePatch({ surfaces: { dark: deep } }, kept).ok, true, 'a light blue still reads on a deep navy');
  assert.equal(checkAppearancePatch({ surfaces: { dark: deep }, accent: null }, stored).ok, true, 'or the accent goes back to the studio\'s own with them');
  // The stored look after a patch, and the Undo patch that brings the earlier one back exactly.
  const before = { density: 'compact', accent: { light: '#1f5f8a' } };
  const after = mergeAppearance(before, checkAppearancePatch({ surfaces: { dark }, accent: { dark: '#e0b98a' }, display: 'garamond', radius: 'round' }, before));
  assert.deepEqual(Object.keys(after).sort(), ['accent', 'density', 'display', 'radius', 'surfaces']);
  const undone = mergeAppearance(after, checkAppearancePatch(restorePatch(before), after));
  assert.deepEqual(undone, cleanAppearance(before));
  assert.deepEqual(cleanAppearance({ surfaces: { dark: { canvas: '#f3e9d7', panel: '#fff', ink: '#000' } } }), {}, 'a hand-edited registry cannot put a light canvas in the dark theme');
  assert.deepEqual(cleanAppearance({ display: 'comic-sans' }), {}, 'a face is a key of the list, never a CSS value');
});

// ---------- one board module, two places ----------
test('inspiration.mjs keeps a board at any place it is given: the cards in that file and its images beside it, nothing in .studio', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-look-board-'));
  const place = { root, file: 'studio-look.json', dir: 'studio-look' };
  try {
    const color = await addCard(place, { kind: 'color', hex: '#2F7F79', name: 'teal' });
    const image = await addCard(place, { kind: 'image', data: PNG.toString('base64'), name: 'paper.png' });
    assert.deepEqual((await listCards(place)).map((c) => c.id), [image.id, color.id]);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, 'studio-look.json'), 'utf8')).cards.map((c) => c.id), [image.id, color.id]);
    assert.deepEqual(await fsp.readdir(path.join(root, 'studio-look')), [image.file]);
    assert.equal((await readCardFile(place, image.file)).type, 'png');
    await assert.rejects(() => addCard(place, { kind: 'color', hex: 'teal' }), /A color is a hex value/, 'the same guards');
    await removeCard(place, image.id);
    assert.deepEqual(await fsp.readdir(path.join(root, 'studio-look')), []);
    assert.equal(await fsp.access(path.join(root, '.studio')).then(() => true, () => false), false, 'no .studio folder at that place');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ---------- through a real server process ----------
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-studio-look-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
};
const registry = async () => JSON.parse(await fsp.readFile(path.join(tmp, 'data', 'registry.json'), 'utf8'));

before(async () => {
  await fsp.mkdir(path.join(tmp, 'projects'), { recursive: true });
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: path.join(tmp, 'projects'), ATELIER_PID_FILE: path.join(tmp, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}: ${stderr.slice(-800)}`);
    if (i > 150) throw new Error(`the server did not answer within 30 s: ${stderr.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});
after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('the Studio look board lives in the data folder; a project\'s app board, the studio\'s own included, is untouched by it', async () => {
  const studio = (await api('POST', '/api/projects', { name: 'Studio Itself', kind: 'studio' })).data.project;
  const product = (await api('POST', '/api/projects', { name: 'A Product', kind: 'web-app', template: 'web-app-notes' })).data.project;
  await api('POST', `/api/projects/${studio.id}/inspiration`, { kind: 'color', hex: '#d6a455', name: 'amber' });
  await api('POST', `/api/projects/${product.id}/inspiration`, { kind: 'note', text: 'The app board' });
  const boardFile = (p) => path.join(tmp, 'projects', p.slug, '.studio', 'inspiration.json');
  const beforeBytes = await Promise.all([studio, product].map((p) => fsp.readFile(boardFile(p), 'utf8')));

  assert.deepEqual((await api('GET', '/api/studio-look/board')).data.cards, [], 'a new person\'s board is empty');
  assert.deepEqual((await api('GET', '/api/studio-look/board')).data.where, { file: 'studio-look.json', images: 'studio-look' });
  const added = [];
  for (const body of [
    { kind: 'color', hex: '#f3e9d7', name: 'warm cream' }, { kind: 'color', hex: '#2f7f79', name: 'teal' }, { kind: 'color', hex: '#173b3a', name: 'deep teal' },
    { kind: 'note', text: 'Bookish and calm: a Garamond for headings.', tags: ['type'] }, { kind: 'note', text: 'Rounded cards like pebbles.', tags: ['layout'] },
    { kind: 'image', data: PNG.toString('base64'), name: 'sea-glass.png' },
  ]) {
    const out = await api('POST', '/api/studio-look/board', body);
    assert.equal(out.status, 200, JSON.stringify(out.data));
    added.push(out.data);
  }
  const image = added.at(-1);
  const kept = JSON.parse(await fsp.readFile(path.join(tmp, 'data', 'studio-look.json'), 'utf8'));
  assert.equal(kept.cards.length, 6, 'in ~/.atelier/studio-look.json, beside the registry');
  assert.deepEqual(await fsp.readdir(path.join(tmp, 'data', 'studio-look')), [image.file]);
  const file = await fetch(`${BASE}/api/studio-look/board/files/${image.file}`);
  assert.deepEqual([file.status, file.headers.get('content-type'), file.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
  assert.equal((await api('GET', `/api/projects/${studio.id}/inspiration/files/${image.file}`)).status, 404, 'a project route never serves the person\'s images');
  assert.equal((await api('POST', '/api/studio-look/board', { kind: 'color', hex: 'teal' })).status, 400, 'the same guards as a project board');
  const second = added[1];
  assert.equal((await api('PATCH', `/api/studio-look/board/${second.id}`, { name: 'sea teal' })).data.name, 'sea teal');
  assert.deepEqual((await api('POST', '/api/studio-look/board/move', { id: second.id, before: null })).data.order.at(-1), second.id);
  assert.equal((await api('DELETE', `/api/studio-look/board/${second.id}`)).status, 200);
  await api('POST', '/api/studio-look/board', { kind: 'color', hex: '#2f7f79', name: 'teal' });

  const afterBytes = await Promise.all([studio, product].map((p) => fsp.readFile(boardFile(p), 'utf8')));
  assert.deepEqual(afterBytes, beforeBytes, 'neither app board changed, the studio project\'s included');
  for (const p of [studio, product]) assert.equal(await fsp.access(path.join(tmp, 'projects', p.slug, '.studio', 'studio-look.json')).then(() => true, () => false), false);
  // No brief and no briefing reads the person's board.
  for (const rel of ['server/lib/tasks.mjs', 'server/lib/briefing.mjs', 'server/lib/mcp/tools.mjs']) assert.doesNotMatch(await read(rel), /studio-look|LOOK_BOARD/, `${rel} does not read the Studio look board`);
});

test('Apply, Undo and Reset: kept in the registry with the look before, so they survive a reload; refusals write nothing; a lock refuses nothing', async () => {
  // A lock on the studio project's accent, as the studio's seed has: it does not refuse the person's look.
  const studio = (await api('GET', '/api/projects')).data.find?.((p) => p.kind === 'studio') || (await api('GET', '/api/state')).data.projects.find((p) => p.kind === 'studio');
  await api('POST', `/api/projects/${studio.id}/rules`, { text: 'Amber is the one accent', kind: 'color', token: { name: '--accent', value: '#d6a455' } });
  await api('PATCH', '/api/settings', { appearance: { density: 'compact' } });
  const cards = (await api('GET', '/api/studio-look/board')).data.cards;
  const proposal = proposeLook(cards, 'dark', (await api('GET', '/api/settings/appearance')).data.stored);
  assert.equal(proposal.problem, null);

  const applied = await api('POST', '/api/studio-look/apply', { look: proposal.patch });
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(applied.data.stored, cleanAppearance({ density: 'compact', ...proposal.patch }));
  assert.deepEqual(applied.data.locked.map((t) => t.name), ['--accent'], 'the lock is named');
  assert.equal(applied.data.effective.accent.dark, proposal.patch.accent.dark, 'and the person\'s accent is in effect anyway');
  let reg = await registry();
  assert.deepEqual(reg.settings.lookUndo.before, { density: 'compact' });
  // A reload: a fresh read of the state has the look and the Undo.
  let facts = (await api('GET', '/api/state')).data.appearance;
  assert.equal(facts.stored.surfaces.dark.canvas, proposal.patch.surfaces.dark.canvas);
  assert.equal(facts.undo.words, 'the look before Apply');

  const undone = await api('POST', '/api/studio-look/undo');
  assert.deepEqual([undone.status, undone.data.stored, undone.data.undo], [200, { density: 'compact' }, null]);
  assert.deepEqual((await api('POST', '/api/studio-look/undo')).data.error.code, 'nothing_to_undo');

  await api('POST', '/api/studio-look/apply', { look: proposal.patch });
  const reset = await api('POST', '/api/studio-look/reset');
  assert.deepEqual([reset.status, reset.data.stored], [200, {}]);
  assert.equal('appearance' in (await registry()).settings, false, 'nothing chosen is nothing stored');
  assert.equal((await api('GET', '/api/state')).data.appearance.undo.words, 'the look before Reset');
  assert.equal((await api('POST', '/api/studio-look/undo')).data.stored.surfaces.dark.canvas, proposal.patch.surfaces.dark.canvas, 'Undo after Reset brings the applied look back');

  // A change in Settings leaves nothing to undo (an Undo would take it back too), and the route cannot set lookUndo.
  await api('PATCH', '/api/settings', { appearance: { textSize: 'large' }, lookUndo: { before: { radius: 'sharp' } } });
  reg = await registry();
  assert.equal(reg.settings.lookUndo, undefined);
  facts = (await api('GET', '/api/settings/appearance')).data;
  assert.equal(facts.undo, null);

  // A refusal writes nothing: surfaces on the wrong side, an ink under AA, a face that is not on the list.
  const was = JSON.stringify((await registry()).settings.appearance);
  for (const [look, code] of [
    [{ surfaces: { dark: { canvas: '#f3e9d7', panel: '#faf6ef', ink: '#173b3a' } } }, 'invalid_input'],
    [{ surfaces: { dark: { canvas: '#232221', panel: '#2a2927', ink: '#4a4844' } } }, 'low_contrast'],
    [{ display: 'papyrus' }, 'invalid_input'],
  ]) {
    const out = await api('POST', '/api/studio-look/apply', { look });
    assert.deepEqual([out.status, out.data.error.code], [400, code], JSON.stringify(look));
    assert.equal(JSON.stringify((await registry()).settings.appearance), was);
  }
  assert.equal((await api('POST', '/api/studio-look/apply', {})).status, 400, 'Apply needs a look');
  await api('PATCH', '/api/settings', { appearance: null });
});

// ---------- wiring and the design rules, as source checks ----------
test('the view: two scopes in words, the Studio look at its own address, the preview over the real studio, one primary action in sight', async () => {
  const view = await read('client/views/inspiration.js');
  const panel = await read('client/components/studio-look-panel.js');
  const css = await read('client/inspiration.css');
  const app = await read('client/app.js');
  assert.match(view, /clear\(ui\.appScope, name \? `\$\{name\}'s app` : 'The app'\);/, 'the app\'s parts are named for the open project');
  assert.match(view, /el\('span\.inspo-scope', \{ id: 'inspo-scope-look' \}, 'For you'\), lookSeg/);
  assert.match(view, /const LOOK_HASH = '#\/inspiration\/look';/);
  assert.match(view, /if \(me\.boardKey === LOOK_KEY\) return \{ name: 'your Studio look', load: \(\) => api\.lookBoard\(\)/, 'the look board has its own calls');
  assert.match(view, /ui\.addBtn\.classList\.toggle\('primary', mode !== 'look'\);/);
  assert.match(panel, /Restyles the studio for you, on this computer\./);
  assert.match(panel, /It is not \$\{project\}'s app board, and no worker reads it\./);
  assert.match(panel, /app\.previewLook\(st\.proposal\.preview && canApply\(\) \? st\.proposal\.preview : null\);/, 'a proposal is shown over the whole studio at once');
  assert.match(panel, /app\.api\.applyLook\(patch\)/);
  assert.match(panel, /makeButton\.classList\.toggle\('primary', !st\.proposal\);/, 'Apply is the one primary once a look is proposed');
  assert.match(panel, /lockLine\(lockDiffs\(shown, f\?\.locked \|\| \[\], theme\)/, 'one line when the look differs from a locked default');
  assert.match(panel, /unmount\(\) \{ st\.gone = true; offs\.forEach\(\(off\) => off\(\)\); if \(st\.proposal\) app\.previewLook\(null\); \}/, 'leaving the view ends the preview');
  assert.match(app, /es\.addEventListener\('studio-look\.changed', \(e\) => emit\('studio-look', data\(e\)\)\);/);
  for (const file of [view, panel]) assert.ok(file.split('\n').length <= 500);
  assert.doesNotMatch(panel, /stateChip|chip\(/, 'no chip for a choice');
  const own = css.slice(css.indexOf('/* ---------- two scopes in the head'));
  assert.equal(own.match(/#[0-9a-f]{3,8}\b/gi), null, 'colours come from the tokens (a swatch\'s colour is data, in --sw)');
  assert.doesNotMatch(own, /transition|animation|@keyframes/);
  assert.equal(own.match(/font-size: (13|12\.5|12|11)px/g), null);
  assert.equal(CANVAS.dark, '#232221', 'the source keeps its locked canvas');
});
