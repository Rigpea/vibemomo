// A project made from a template carries its own name and slug (UC1, UC2, UC12):
// title, heading, README and manifest say the project's name, the notes template
// gets its own storage key, and the template folders themselves stay unchanged.
// Runs against temp folders, never the real data dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-templates-'));
process.env.ATELIER_DATA_DIR = path.join(root, 'data');
process.env.ATELIER_PROJECTS_DIR = path.join(root, 'projects');

const projects = await import('../server/lib/projects.mjs');
const versions = await import('../server/lib/versions.mjs');
const briefing = await import('../server/lib/briefing.mjs');
const { listFiles } = await import('../server/lib/fsutil.mjs');

const deps = {
  checkpoint: (ctx, o) => versions.checkpoint(ctx, o),
  adoptHead: (ctx, o) => versions.adoptHead(ctx, o),
  regenerate: (id) => briefing.regenerate(id),
};

async function readTree(dir) {
  const out = {};
  for (const rel of await listFiles(dir)) out[rel] = await fsp.readFile(path.join(dir, rel), 'utf8');
  return out;
}

let templatesBefore;
let game, notes, sound;
before(async () => {
  await fsp.mkdir(process.env.ATELIER_PROJECTS_DIR, { recursive: true });
  templatesBefore = await readTree(projects.TEMPLATES_DIR);
  game = await projects.createProject({ name: 'Room Two', kind: 'game', template: 'game-room-one' }, deps);
  notes = await projects.createProject({ name: 'Notes Two', kind: 'web-app', template: 'web-app-notes' }, deps);
  sound = await projects.createProject({ name: 'Sound Two', kind: 'audio', template: 'audio-sound-sketch' }, deps);
});
after(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

const projectDir = (r) => path.join(process.env.ATELIER_PROJECTS_DIR, r.project.slug);

test('game template: the new project is titled with its own name everywhere', async () => {
  const dir = projectDir(game);
  const html = await fsp.readFile(path.join(dir, 'src', 'index.html'), 'utf8');
  assert.match(html, /<title>Room Two<\/title>/);
  assert.match(html, /<h1 id="help-title">Room Two<\/h1>/);
  const tree = await readTree(dir);
  for (const [rel, text] of Object.entries(tree)) {
    assert.ok(!text.includes('Room One'), `${rel} still says "Room One"`);
    assert.ok(!/(?<![a-z0-9-])room-one\b/.test(text), `${rel} still says "room-one"`);
  }
  assert.match(tree['README.md'], /^# Room Two/);
  const manifest = JSON.parse(tree['atelier.json']);
  assert.equal(manifest.name, 'Room Two');
  assert.ok(Array.isArray(manifest.cues) && manifest.cues.length > 0, 'manifest kept its other fields');
});

test('notes template: the new project gets its own storage key', async () => {
  const dir = projectDir(notes);
  const html = await fsp.readFile(path.join(dir, 'src', 'index.html'), 'utf8');
  assert.match(html, /<html[^>]*\sdata-storage-key="notes-two"/);
  assert.match(html, /<title>Notes Two<\/title>/);
  const tree = await readTree(dir);
  for (const [rel, text] of Object.entries(tree)) {
    assert.ok(!text.includes('Quick Notes'), `${rel} still says "Quick Notes"`);
    assert.ok(!text.includes('quick-notes'), `${rel} still says "quick-notes"`);
  }
  assert.equal(JSON.parse(tree['atelier.json']).name, 'Notes Two');
});

test('audio template: titled with its own name, its own storage key, and its selfcheck passes', async () => {
  const dir = projectDir(sound);
  const html = await fsp.readFile(path.join(dir, 'src', 'index.html'), 'utf8');
  assert.match(html, /<title>Sound Two<\/title>/);
  assert.match(html, /<h1>Sound Two<\/h1>/);
  assert.match(html, /<html[^>]*\sdata-storage-key="sound-two"/);
  const tree = await readTree(dir);
  for (const [rel, text] of Object.entries(tree)) {
    assert.ok(!text.includes('Sound Sketch'), `${rel} still says "Sound Sketch"`);
    assert.ok(!/(?<![a-z0-9-])sound-sketch\b/.test(text), `${rel} still says "sound-sketch"`);
  }
  assert.match(tree['README.md'], /^# Sound Two/);
  assert.match(tree['src/sketch.js'], /"sound-two"\) \+ "\.muted"/);
  const manifest = JSON.parse(tree['atelier.json']);
  assert.equal(manifest.name, 'Sound Two');
  assert.equal(manifest.kind, 'audio');
  assert.equal(sound.project.kind, 'audio');
  assert.deepEqual(manifest.cues.map((c) => c.id), ['tap', 'blip', 'tick', 'swell']);
  // selfcheck.mjs is not copied into a project; run it there anyway, against the renamed files.
  const { execFileSync } = await import('node:child_process');
  const check = path.join(dir, 'selfcheck.mjs');
  await fsp.copyFile(path.join(projects.TEMPLATES_DIR, 'audio-sound-sketch', 'selfcheck.mjs'), check);
  try {
    assert.match(execFileSync(process.execPath, [check], { encoding: 'utf8' }), /all checks passed/);
  } finally {
    await fsp.rm(check, { force: true });
  }
});

test('the first checkpoint already carries the new name', async () => {
  const { execFileSync } = await import('node:child_process');
  const shown = execFileSync('git', ['show', 'HEAD:src/index.html'], { cwd: projectDir(game), encoding: 'utf8' });
  assert.match(shown, /<title>Room Two<\/title>/);
});

test('template folders are unchanged by project creation', async () => {
  const after = await readTree(projects.TEMPLATES_DIR);
  assert.deepEqual(Object.keys(after), Object.keys(templatesBefore));
  for (const rel of Object.keys(after)) assert.equal(after[rel], templatesBefore[rel], `${rel} changed`);
  for (const text of Object.values(after)) {
    assert.ok(!text.includes('Room Two') && !text.includes('Notes Two') && !text.includes('notes-two'));
  }
});

// ---- Template drift. The route is a one-line call of templateDrift; the "template moved on" case
// points it at a temp copy of the templates, because other test files read the real folder meanwhile.
const { templateDrift, templateDriftDiff, DRIFT_NOTE } = await import('../server/lib/template-drift.mjs');
const { catchUpTask, driftWords, driftPieces, templatesOfKind } = await import('../client/components/template-drift.js');

const driftOf = async (r) => templateDrift(await projects.loadProject(r.project.id));
const differing = (d) => d.files.filter((f) => !f.same && !f.ownValues).map((f) => f.path);
const insideDir = (r, rel) => path.join(projectDir(r), ...rel.split('/'));

test('Set offers only the templates of the project\'s kind, and copes with no list', async () => {
  const offered = templatesOfKind(await projects.listTemplates(), 'audio');
  assert.deepEqual(offered.map((t) => t.name), ['audio-sound-sketch']);
  assert.deepEqual(templatesOfKind(await projects.listTemplates(), 'studio'), []);
  assert.deepEqual(templatesOfKind(undefined, 'audio'), []);
});

test('template drift: every template, freshly copied under another name, is up to date', async () => {
  for (const r of [game, notes, sound]) {
    const d = await driftOf(r);
    assert.equal(d.behind, 0, JSON.stringify(d.files));
    assert.ok(d.available);
    assert.ok(d.files.some((f) => f.path === 'atelier.json'), 'the manifest lists are compared');
    assert.ok(d.files.some((f) => f.path.startsWith('src/')));
    assert.equal(d.note, DRIFT_NOTE);
  }
  const record = (await projects.loadProject(sound.project.id)).project.template;
  assert.equal(record.name, 'audio-sound-sketch');
  assert.ok(record.at);
});

test('template drift: a changed, a missing and a CRLF file, the manifest lists and the tuning file', async () => {
  const r = await projects.createProject({ name: 'Sound Drift', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  const dir = projectDir(r);
  await fsp.appendFile(path.join(dir, 'src', 'sketch.js'), '\n// changed\n');
  let d = await driftOf(r);
  assert.deepEqual(differing(d), ['src/sketch.js']);
  assert.equal(d.behind, 1);
  assert.equal(d.files.find((f) => f.path === 'src/sketch.js').projectHas, true);

  await fsp.rm(path.join(dir, 'src', 'style.css'));
  d = await driftOf(r);
  assert.deepEqual(differing(d), ['src/sketch.js', 'src/style.css']);
  assert.equal(d.files.find((f) => f.path === 'src/style.css').projectHas, false);

  // Line endings alone are not a change: git may check text out that way.
  const html = path.join(dir, 'src', 'index.html');
  await fsp.writeFile(html, (await fsp.readFile(html, 'utf8')).replace(/\r?\n/g, '\r\n'));
  assert.ok(!differing(await driftOf(r)).includes('src/index.html'));

  // The tuning file holds the project's own values: listed, never behind.
  await fsp.writeFile(path.join(dir, 'src', 'tuning.js'), 'window.ATELIER_TUNING = { "volume": 0.1 };\n');
  d = await driftOf(r);
  const tuning = d.files.find((f) => f.path === 'src/tuning.js');
  assert.equal(tuning.same, false);
  assert.equal(tuning.ownValues, true);
  assert.equal(d.behind, 2);

  // The manifest counts for its lists, not its other fields.
  const manifestPath = path.join(dir, 'atelier.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, JSON.stringify({ ...manifest, description: 'Mine', name: 'Other name' }, null, 2));
  assert.ok(!differing(await driftOf(r)).includes('atelier.json'), 'description and name are the project\'s');
  await fsp.writeFile(manifestPath, JSON.stringify({ ...manifest, readiness: ['Only this'] }, null, 2));
  assert.ok(differing(await driftOf(r)).includes('atelier.json'));
  await fsp.rm(manifestPath);
  const gone = (await driftOf(r)).files.find((f) => f.path === 'atelier.json');
  assert.deepEqual(gone, { path: 'atelier.json', same: false, projectHas: false });
});

test('template drift: a renamed project still compares against the name its files were copied with', async () => {
  const r = await projects.createProject({ name: 'Before Rename', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  await projects.patchProject(r.project.id, { name: 'After Rename' });
  assert.equal((await driftOf(r)).behind, 0);
  const html = path.join(projectDir(r), 'src', 'index.html');
  await fsp.writeFile(html, (await fsp.readFile(html, 'utf8')).replaceAll('Before Rename', 'After Rename'));
  assert.equal((await driftOf(r)).behind, 0, 'the files may also have followed the new name');
});

test('template drift: a template that moved on, in a temp copy', async () => {
  const templatesDir = path.join(root, 'templates-copy');
  const copy = path.join(templatesDir, 'audio-sound-sketch');
  const r = await projects.createProject({ name: 'Sound Behind', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  const ctx = await projects.loadProject(r.project.id);
  await fsp.cp(path.join(projects.TEMPLATES_DIR, 'audio-sound-sketch'), copy, { recursive: true });
  assert.equal((await templateDrift(ctx, { templatesDir })).behind, 0);
  await fsp.appendFile(path.join(copy, 'src', 'style.css'), '\n/* moved on */\n');
  await fsp.writeFile(path.join(copy, 'src', 'added.js'), '// new in the template\n');
  const d = await templateDrift(ctx, { templatesDir });
  assert.deepEqual(differing(d), ['src/added.js', 'src/style.css']);
  assert.equal(d.files.find((f) => f.path === 'src/added.js').projectHas, false);
  assert.equal(d.folder, copy);
  await fsp.rm(copy, { recursive: true, force: true });
  const missing = await templateDrift(ctx, { templatesDir });
  assert.deepEqual([missing.template, missing.available, missing.behind, missing.files], ['audio-sound-sketch', false, 0, []], 'a template no longer there');
});

test('template drift: no record, and a record that points out of templates/', async () => {
  const blank = await projects.createProject({ name: 'Blank Drift', kind: 'web-app' }, deps);
  const none = await driftOf(blank);
  assert.deepEqual([none.template, none.behind, none.files], [null, 0, []]);
  assert.equal((await projects.loadProject(blank.project.id)).project.template, undefined);

  const project = (await projects.loadProject(blank.project.id)).project;
  await projects.saveProject(projectDir(blank), { ...project, template: { name: '../game-room-one' } });
  const outside = await driftOf(blank);
  assert.deepEqual([outside.available, outside.folder, outside.files], [false, null, []]);
});

test('template drift: a name that cannot be a template is refused, and .. above all, because templates/.. is the studio', async () => {
  const blank = await projects.createProject({ name: 'Blank Names', kind: 'web-app' }, deps);
  const project = (await projects.loadProject(blank.project.id)).project;
  const withName = async (name) => {
    await projects.saveProject(projectDir(blank), { ...project, template: { name } });
    return driftOf(blank);
  };
  for (const name of ['..', '.', '.hidden', '../game-room-one', 'a/b', 'a\\b', '..\\game-room-one', 5]) {
    const d = await withName(name);
    assert.deepEqual([d.template, d.available, d.reason, d.folder, d.files, d.behind], [name, false, 'not a template name', null, [], 0], String(name));
    assert.equal(driftWords(d), 'not a template name');
  }
  // A plain name that is simply not there is the other answer, with its own words.
  const gone = await withName('no-such-template');
  assert.deepEqual([gone.available, gone.reason], [false, undefined]);
  assert.equal(driftWords(gone), 'no longer in the studio');
  assert.equal((await withName('audio-sound-sketch')).available, true);
});

test('template drift diff: a differing file gives a unified diff from the template after the rename to the project', async () => {
  const r = await projects.createProject({ name: 'Diff Sound', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  const ctx = await projects.loadProject(r.project.id);
  const css = path.join(projectDir(r), 'src', 'style.css');
  await fsp.appendFile(css, '\n/* mine */\n');
  const out = await templateDriftDiff(ctx, 'src/style.css');
  assert.equal(out.path, 'src/style.css');
  assert.equal(out.truncated, false);
  assert.match(out.diff, /^--- template\/src\/style\.css\n\+\+\+ project\/src\/style\.css\n@@ /);
  assert.match(out.diff, /^\+\/\* mine \*\/$/m);

  // After the copy's rename: the template's own name is no difference, only the line that was changed.
  const html = path.join(projectDir(r), 'src', 'index.html');
  await fsp.writeFile(html, (await fsp.readFile(html, 'utf8')).replace('</body>', '<!-- mine -->\n</body>'));
  const page = (await templateDriftDiff(ctx, 'src/index.html')).diff;
  assert.match(page, /^\+<!-- mine -->$/m);
  assert.deepEqual(page.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l)), ['+<!-- mine -->'], page);

  // Line endings alone are no difference here, as on the line.
  await fsp.writeFile(css, (await fsp.readFile(css, 'utf8')).replace(/\r?\n/g, '\r\n'));
  const crlf = (await templateDriftDiff(ctx, 'src/style.css')).diff;
  assert.ok(!crlf.includes('\r'), 'no line reads as changed by its ending');
  assert.ok(!/^-[^-]/m.test(crlf), 'nothing of the template reads as removed');
  assert.match(crlf, /^\+\/\* mine \*\/$/m);

  // A missing file: everything removed, and the header says so.
  await fsp.rm(css);
  const gone = await templateDriftDiff(ctx, 'src/style.css');
  assert.match(gone.diff, /^--- template\/src\/style\.css\n\+\+\+ \/dev\/null\n@@ /);
  assert.ok(!/^\+[^+]/m.test(gone.diff));
});

test('template drift diff: a path outside the list, a matching file and the tuning file are refused', async () => {
  const r = await projects.createProject({ name: 'Diff Refused', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  const ctx = await projects.loadProject(r.project.id);
  const tuning = (await templateDrift(ctx)).files.find((f) => f.ownValues).path;
  await fsp.writeFile(insideDir(r, tuning), 'window.ATELIER_TUNING = { "volume": 0.1 };\n');
  await fsp.writeFile(insideDir(r, 'README.md'), 'mine\n');
  for (const rel of [tuning, 'README.md', '../secret.txt', '.git/config', '.studio/project.json', 'src/index.html', '']) {
    await assert.rejects(templateDriftDiff(ctx, rel), (err) => err.status === 400 && err.code === 'not_in_drift', `refused: ${rel}`);
  }
});

test('template drift diff: the manifest shows its two lists only; a binary file has no diff; a long diff is cut', async () => {
  const r = await projects.createProject({ name: 'Diff Lists', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  const ctx = await projects.loadProject(r.project.id);
  const manifestPath = insideDir(r, 'atelier.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, JSON.stringify({ ...manifest, description: 'Mine', readiness: ['Only this'] }, null, 2));
  const lists = await templateDriftDiff(ctx, 'atelier.json');
  assert.match(lists.diff, /^--- template\/atelier\.json \(cues and readiness lists\)\n/);
  assert.match(lists.diff, /^\+.*Only this/m);
  assert.ok(!lists.diff.includes('Mine'), 'the fields that are not compared stay out');
  assert.match(lists.note, /cues and readiness lists are compared/);

  const css = insideDir(r, 'src/style.css');
  await fsp.writeFile(css, `${'/* mine */\n'.repeat(500)}`);
  const cut = await templateDriftDiff(ctx, 'src/style.css', { maxDiffBytes: 200 });
  assert.equal(cut.truncated, true);
  const cutBytes = Buffer.byteLength(cut.diff);
  assert.ok(cutBytes <= 200 && cutBytes > 196, `${cutBytes} bytes`);
  await fsp.writeFile(css, Buffer.from([0x89, 0x50, 0x00, 0x01]));
  await assert.rejects(templateDriftDiff(ctx, 'src/style.css'), (err) => err.status === 400 && err.code === 'not_text');
});

test('template drift diff: a cut over the limit stays within it and ends on a whole character', async () => {
  const r = await projects.createProject({ name: 'Diff Multibyte', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  const ctx = await projects.loadProject(r.project.id);
  await fsp.writeFile(insideDir(r, 'src/style.css'), '€😀é'.repeat(500));
  const full = (await templateDriftDiff(ctx, 'src/style.css')).diff;
  const start = Buffer.byteLength(full.slice(0, full.indexOf('€')));
  // Every byte position of one run of the text, so the cut falls inside a character of each width.
  for (let maxDiffBytes = start + 1; maxDiffBytes <= start + 12; maxDiffBytes++) {
    const cut = await templateDriftDiff(ctx, 'src/style.css', { maxDiffBytes });
    assert.equal(cut.truncated, true);
    const bytes = Buffer.byteLength(cut.diff);
    assert.ok(bytes <= maxDiffBytes && bytes > maxDiffBytes - 4, `${bytes} bytes at a limit of ${maxDiffBytes}`);
    assert.ok(!cut.diff.includes('�'), 'no broken character');
    assert.ok(full.startsWith(cut.diff), 'nothing but a cut');
  }
});

test('template drift: a text file outside the rename list that differs by line endings alone is named, and has no diff', async () => {
  const templatesDir = path.join(root, 'templates-endings');
  const copy = path.join(templatesDir, 'audio-sound-sketch');
  const r = await projects.createProject({ name: 'Sound Endings', kind: 'audio', template: 'audio-sound-sketch' }, deps);
  const ctx = await projects.loadProject(r.project.id);
  await fsp.cp(path.join(projects.TEMPLATES_DIR, 'audio-sound-sketch'), copy, { recursive: true });
  await fsp.writeFile(path.join(copy, 'src', 'icon.svg'), '<svg>\n<circle/>\n</svg>\n');
  const svg = insideDir(r, 'src/icon.svg');
  const entry = async () => {
    const d = await templateDrift(ctx, { templatesDir });
    return [d, d.files.find((f) => f.path === 'src/icon.svg')];
  };

  await fsp.writeFile(svg, '<svg>\n<circle/>\n</svg>\n');
  assert.deepEqual((await entry())[1], { path: 'src/icon.svg', same: true, projectHas: true }, 'identical: no flag');

  await fsp.writeFile(svg, '<svg>\r\n<circle/>\r\n</svg>\r\n');
  const [d, file] = await entry();
  assert.deepEqual(file, { path: 'src/icon.svg', same: true, projectHas: true, lineEndingsOnly: true });
  assert.equal(d.behind, 0);
  assert.match(driftWords(d), /^src and manifest up to date · src\/icon\.svg differs only by line endings/);
  assert.deepEqual(driftPieces(d).filter((p) => p.path), [], 'no button: there is no diff to open');
  await assert.rejects(templateDriftDiff(ctx, 'src/icon.svg', { templatesDir }), (err) => err.code === 'not_in_drift');

  // A real change in such a file shows that change alone.
  await fsp.writeFile(svg, '<svg>\r\n<rect/>\r\n</svg>\r\n');
  const [changed, real] = await entry();
  assert.deepEqual(real, { path: 'src/icon.svg', same: false, projectHas: true });
  assert.equal(changed.behind, 1);
  const { diff } = await templateDriftDiff(ctx, 'src/icon.svg', { templatesDir });
  assert.deepEqual(diff.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l)), ['-<circle/>', '+<rect/>']);

  // A file the copy renames is flagged the same way; bytes still decide a binary file.
  const html = insideDir(r, 'src/index.html');
  await fsp.rm(svg);
  await fsp.writeFile(html, (await fsp.readFile(html, 'utf8')).replace(/\r?\n/g, '\r\n'));
  const page = (await templateDrift(ctx, { templatesDir })).files.find((f) => f.path === 'src/index.html');
  assert.deepEqual([page.same, page.lineEndingsOnly], [true, true]);
  await fsp.writeFile(path.join(copy, 'src', 'icon.svg'), Buffer.from([0x89, 0x0d, 0x0a, 0x00]));
  await fsp.writeFile(svg, Buffer.from([0x89, 0x0a, 0x00]));
  assert.deepEqual((await entry())[1], { path: 'src/icon.svg', same: false, projectHas: true });
});

test('template drift: the words on the Identity line and the catch-up task', () => {
  const file = (path, same = false) => ({ path, same, projectHas: true });
  const base = { template: 'audio-sound-sketch', folder: 'C:\\t\\audio-sound-sketch', available: true, note: DRIFT_NOTE };
  const own = { path: 'src/tuning.js', same: false, projectHas: true, ownValues: true };
  assert.equal(driftWords({ ...base, files: [file('src/a.js', true)], behind: 0 }), 'src and manifest up to date');
  assert.equal(driftWords({ ...base, files: [file('src/a.js', true), own], behind: 0 }), 'src and manifest up to date · tuning values are yours');
  assert.equal(driftWords({ ...base, files: [file('src/a.js')], behind: 1 }), '1 src file differs: src/a.js');
  assert.equal(driftWords({ ...base, files: [file('src/a.js'), own], behind: 1 }), '1 src file differs: src/a.js · tuning values are yours');
  const two = { ...base, files: [file('src/a.js'), file('src/b.css')], behind: 2 };
  assert.equal(driftWords(two), '2 src files differ: src/a.js, src/b.css');
  const four = { ...base, files: ['a', 'b', 'c', 'd'].map((x) => file(`src/${x}.js`)), behind: 4 };
  assert.equal(driftWords(four), '4 src files differ: src/a.js, src/b.js, src/c.js, src/d.js', 'every path is named: each one opens its diff');
  assert.equal(driftWords({ ...base, files: [file('atelier.json')], behind: 1 }), 'manifest differs: atelier.json');
  assert.equal(driftWords({ ...base, files: [file('src/a.js'), file('atelier.json')], behind: 2 }), '1 src file differs: src/a.js · manifest differs: atelier.json');
  assert.equal(driftWords({ ...base, available: false, files: [], behind: 0 }), 'no longer in the studio');
  // The buttons: each differing path, and never the tuning file.
  const pieces = driftPieces({ ...two, files: [...two.files, own, file('atelier.json')] }).filter((p) => p.path).map((p) => p.path);
  assert.deepEqual(pieces, ['src/a.js', 'src/b.css', 'atelier.json']);

  const task = catchUpTask({ ...two, files: [...two.files, own, { path: 'atelier.json', same: false, projectHas: true }], behind: 3 });
  assert.equal(task.title, 'Catch up with the template audio-sound-sketch');
  assert.deepEqual(task.files, ['src/a.js', 'src/b.css', 'atelier.json'], 'the tuning file is not asked for');
  assert.equal(task.mode, 'handle');
  assert.match(task.request, /C:\\t\\audio-sound-sketch/);
  assert.match(task.request, /apart from the project name/);
  assert.match(task.request, /tuning\.js/);
  assert.match(task.request, /byte comparison/);
  assert.match(task.request, /selfcheck\.mjs/);
  assert.match(task.request, /atelier\.json: only its cues and readiness lists/);
  assert.ok(!catchUpTask(two).request.includes('atelier.json'), 'only when the manifest differs');
});

test('names are escaped for the file type (JSON stays valid, HTML stays well-formed)', async () => {
  const r = await projects.createProject({ name: 'Tom & "Jerry"', kind: 'web-app', template: 'web-app-notes' }, deps);
  const dir = projectDir(r);
  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'atelier.json'), 'utf8'));
  assert.equal(manifest.name, 'Tom & "Jerry"');
  const html = await fsp.readFile(path.join(dir, 'src', 'index.html'), 'utf8');
  assert.match(html, /<title>Tom &amp; &quot;Jerry&quot;<\/title>/);
  assert.match(html, /data-storage-key="tom-jerry"/);
});
