// The Skills tab: client/components/skill-words.js on its own (the frontmatter reader, the category table and its
// inference, the filter, the grouping), and server/lib/skills.mjs on real temp folders (the project's .claude/skills,
// a stand-in Claude config folder with its own skills and plugins in both record shapes, the read guard, and install
// from a folder or a .zip with every refusal). The panel's layout is scripts/ui-check/verify-skills.cjs's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import * as words from '../client/components/skill-words.js';
import { listSkills, readSkill, installSkill, pluginFolders, cleanRel, revealFolder } from '../server/lib/skills.mjs';
import { toBase64 } from '../client/components/skill-add.js';

const md = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nDo the thing.\n`;
const b64 = (s) => Buffer.from(s).toString('base64');

// ---------- the pure parts ----------
test('parseFrontmatter: plain, quoted, folded and literal values, lists both ways, no frontmatter', () => {
  const { meta, body, hasFrontmatter } = words.parseFrontmatter('\uFEFF---\r\nname: "my-skill"\r\ndescription: >\r\n  Makes charts\r\n  look good.\r\ntags: [design, "charts"]\r\nnotes: |\r\n  line one\r\n  line two\r\nlist:\r\n  - a\r\n  - \'b\'\r\nlong: first part\r\n  second part\r\n---\r\nBody here\r\n');
  assert.equal(hasFrontmatter, true);
  assert.equal(meta.name, 'my-skill');
  assert.equal(meta.description, 'Makes charts look good.');
  assert.deepEqual(meta.tags, ['design', 'charts']);
  assert.equal(meta.notes, 'line one\nline two');
  assert.deepEqual(meta.list, ['a', 'b']);
  assert.equal(meta.long, 'first part second part');
  assert.equal(body, 'Body here\r\n');
  assert.deepEqual(words.parseFrontmatter('# Just a title\n'), { meta: {}, body: '# Just a title\n', hasFrontmatter: false });
  assert.equal(words.parseFrontmatter("---\ndescription: 'it''s fine: really'\n---\n").meta.description, "it's fine: really");
});

test('inferCategory: the brief\'s keywords land in their categories, the name counts more than the description', () => {
  assert.equal(words.inferCategory('dataviz', 'Charts, colour and typography for dashboards'), 'Design');
  assert.equal(words.inferCategory('onboarding-flow', 'First-run journey and usability'), 'UX');
  assert.equal(words.inferCategory('', 'Accessibility review of a page'), 'UX', 'one UX word against one Testing word: the earlier category wins the tie');
  assert.equal(words.inferCategory('postgres-helper', 'Database schema and SQL'), 'Backend');
  assert.equal(words.inferCategory('react-components', 'Build components'), 'Frontend/Code');
  assert.equal(words.inferCategory('code-review', 'Review the diff for bugs'), 'Testing & review');
  assert.equal(words.inferCategory('docx', 'Create and edit Word documents'), 'Docs & writing');
  assert.equal(words.inferCategory('weather', 'Tells the forecast'), 'Other');
  assert.equal(words.inferCategory('api-design', 'Shape the server endpoints'), 'Backend', 'two Backend words in the description beat a tie in the name');
  assert.equal(words.inferCategory('', 'A typescript helper'), 'Frontend/Code', 'type is not a Design word inside typescript');
  assert.equal(words.inferCategory('', 'Tests for the auth server'), 'Backend');
  // Seen on the real plugin list: Claude Code tooling read as Design through "layout" and "colors" before these words.
  assert.equal(words.inferCategory('plugin-structure', 'Scaffold a plugin and understand the plugin directory layout'), 'Frontend/Code');
  assert.equal(words.inferCategory('configure', 'Set up the channel: save the bot token and review access policy'), 'Frontend/Code');
  assert.equal(words.inferCategory('', 'Independent workers answer questions'), 'Other', 'worker is not a Backend word');
  for (const cat of Object.keys(words.KEYWORDS)) assert.ok(words.CATEGORIES.includes(cat), `${cat} is a category`);
});

test('categoryOf: the category field, then tags, then the keywords; a field that names nothing known falls through', () => {
  assert.deepEqual(words.categoryOf({ name: 'x', description: 'database', category: 'Design' }), { category: 'Design', from: 'category' });
  assert.deepEqual(words.categoryOf({ name: 'x', description: 'database', category: 'testing' }), { category: 'Testing & review', from: 'category' });
  assert.deepEqual(words.categoryOf({ name: 'x', description: 'database', tags: ['misc', 'ux'] }), { category: 'UX', from: 'tags' });
  assert.deepEqual(words.categoryOf({ name: 'x', description: 'database', tags: 'docs, misc' }), { category: 'Docs & writing', from: 'tags' });
  assert.deepEqual(words.categoryOf({ name: 'x', description: 'database', category: 'misc' }), { category: 'Backend', from: 'keywords' });
});

test('skillProblem, oneLine, sourceWords, filterSkills and groupSkills', () => {
  assert.match(words.skillProblem({}, false), /no frontmatter/);
  assert.match(words.skillProblem({ description: 'd' }, true), /no name/);
  assert.match(words.skillProblem({ name: '../up', description: 'd' }, true), /cannot be a folder name/);
  assert.match(words.skillProblem({ name: 'ok' }, true), /no description/);
  assert.equal(words.skillProblem({ name: 'ok-1.2_x', description: 'd' }, true), null);
  assert.equal(words.oneLine('First sentence. Second one.'), 'First sentence.');
  assert.equal(words.oneLine('x'.repeat(200), 20).length, 20);
  assert.equal(words.sourceWords({ kind: 'plugin', plugin: 'figma' }).chip, 'Plugin figma');
  assert.equal(words.sourceWords({ kind: 'user' }).chip, 'Your skills');
  const skills = [
    { name: 'b-chart', description: 'Charts', category: 'Design', source: { kind: 'user' }, path: '/u/b' },
    { name: 'a-chart', description: 'More charts', category: 'Design', source: { kind: 'project' }, path: '/p/a' },
    { name: 'db', description: 'SQL', category: 'Backend', source: { kind: 'plugin', plugin: 'data' }, path: '/x/db' },
    { name: 'odd', description: '', category: 'Not a category', source: { kind: 'user' }, path: '/u/odd' },
  ];
  assert.deepEqual(words.filterSkills(skills, '  ').length, 4);
  assert.deepEqual(words.filterSkills(skills, 'chart project').map((s) => s.name), ['a-chart']);
  assert.deepEqual(words.filterSkills(skills, 'plugin data').map((s) => s.name), ['db']);
  assert.deepEqual(words.filterSkills(skills, 'BACKEND').map((s) => s.name), ['db']);
  assert.deepEqual(words.groupSkills(skills).map(([c, l]) => [c, l.map((s) => s.name)]), [['Design', ['a-chart', 'b-chart']], ['Backend', ['db']], ['Other', ['odd']]]);
});

test('toBase64 matches Buffer for sizes across its chunk', () => {
  const u8 = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 251);
  assert.equal(toBase64(u8), Buffer.from(u8).toString('base64'));
  assert.equal(toBase64(new Uint8Array(0)), '');
});

// ---------- the server on real folders ----------
const roots = [];
after(() => Promise.all(roots.map((r) => fsp.rm(r, { recursive: true, force: true }))));
async function world() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-skills-'));
  roots.push(root);
  const projectPath = path.join(root, 'proj');
  const configDir = path.join(root, 'claude');
  const put = async (rel, text) => { const f = path.join(root, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, text); };
  await put('proj/.claude/skills/palette/SKILL.md', md('palette', 'Choose a colour palette for the UI.'));
  await put('proj/.claude/skills/not-a-skill/readme.txt', 'no SKILL.md here');
  await put('claude/skills/sql-help/SKILL.md', md('sql-help', 'Write SQL against the database.', 'category: backend\n'));
  await put('claude/skills/broken/SKILL.md', 'no frontmatter at all');
  await put('claude/plugins/cache/mkt/figma/1.0.0/skills/frames/SKILL.md', md('frames', 'Lay out frames.'));
  await put('claude/plugins/cache/mkt/figma/1.0.0/.claude-plugin/plugin.json', '{"name":"figma"}');
  await put('outside/SKILL.md', md('outside', 'Not listed anywhere.'));
  return { root, projectPath, configDir, put };
}

test('listSkills: project, user and plugin skills with their source, category and folder; folders without SKILL.md are left out', async () => {
  const w = await world();
  const ctx = { projectPath: w.projectPath, configDir: w.configDir };
  const out = await listSkills(ctx);
  const by = Object.fromEntries(out.skills.map((s) => [s.name, s]));
  assert.deepEqual(out.skills.map((s) => s.name).sort(), ['broken', 'frames', 'palette', 'sql-help']);
  assert.deepEqual(by.palette.source, { kind: 'project' });
  assert.equal(by.palette.category, 'Design');
  assert.equal(by.palette.path, path.join(w.projectPath, '.claude', 'skills', 'palette'));
  assert.deepEqual([by['sql-help'].category, by['sql-help'].categoryFrom], ['Backend', 'category']);
  assert.deepEqual(by.frames.source, { kind: 'plugin', plugin: 'figma' }, 'found by its .claude-plugin/plugin.json with no installed_plugins.json');
  assert.match(by.broken.problem, /no frontmatter/);
  assert.deepEqual(out.places.map((p) => p.kind), ['project', 'user', 'plugin']);
  // installed_plugins.json, v2 shape: the record names the folder and the plugin, and the walk is not needed.
  await w.put('elsewhere-plugin/skills/tests/SKILL.md', md('tests', 'Write tests.'));
  await w.put('claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'qa@mkt': [{ scope: 'user', installPath: path.join(w.root, 'elsewhere-plugin') }] } }));
  assert.deepEqual((await pluginFolders(w.configDir)).map((p) => p.name), ['qa']);
  const again = await listSkills(ctx);
  assert.deepEqual(again.skills.find((s) => s.name === 'tests').source, { kind: 'plugin', plugin: 'qa' });
  // v1 shape: one install per key.
  await w.put('claude/plugins/installed_plugins.json', JSON.stringify({ version: 1, plugins: { 'figma@mkt': { installPath: path.join(w.configDir, 'plugins', 'cache', 'mkt', 'figma', '1.0.0') } } }));
  assert.deepEqual((await pluginFolders(w.configDir)).map((p) => p.name), ['figma']);
  // No project: only the person's and the plugins'.
  assert.ok((await listSkills({ configDir: w.configDir })).skills.every((s) => s.source.kind !== 'project'));
});

test('readSkill: a listed skill\'s SKILL.md and folder names; any other folder is refused', async () => {
  const w = await world();
  const ctx = { projectPath: w.projectPath, configDir: w.configDir };
  const out = await readSkill(ctx, path.join(w.configDir, 'skills', 'sql-help'));
  assert.match(out.content, /^---\nname: sql-help/);
  assert.deepEqual(out.files, ['SKILL.md']);
  assert.equal(out.truncated, false);
  await assert.rejects(readSkill(ctx, path.join(w.root, 'outside')), { status: 404, code: 'not_a_skill' });
  await assert.rejects(readSkill(ctx, path.join(w.projectPath, '.claude', 'skills', 'not-a-skill')), { status: 404 });
  await assert.rejects(readSkill(ctx, path.join(w.projectPath, '.claude', 'skills', 'palette', '..', '..', '..', '..', 'outside')), { status: 404 });
  await assert.rejects(readSkill(ctx, ''), { status: 400 });
});

test('revealFolder opens only a listed skill\'s folder or a place the listing looked in, and only when it exists', async () => {
  const w = await world();
  const ctx = { projectPath: w.projectPath, configDir: w.configDir };
  const opened = [];
  const open = async (folder) => { opened.push(folder); };
  const skillDir = path.join(w.configDir, 'skills', 'sql-help');
  assert.deepEqual(await revealFolder(ctx, skillDir, { open }), { opened: skillDir, kind: 'skill' });
  assert.deepEqual(await revealFolder(ctx, path.join(w.configDir, 'skills'), { open }), { opened: path.join(w.configDir, 'skills'), kind: 'place' });
  assert.deepEqual(opened, [skillDir, path.join(w.configDir, 'skills')]);
  const places = (await listSkills(ctx)).places;
  assert.ok(places.every((p) => typeof p.exists === 'boolean'), 'every place says whether it exists');
  await assert.rejects(revealFolder(ctx, path.join(w.root, 'outside'), { open }), { status: 404, code: 'not_a_skill' });
  await assert.rejects(revealFolder(ctx, w.root, { open }), { status: 404, code: 'not_a_skill' });
  await assert.rejects(revealFolder(ctx, path.join(skillDir, '..', '..', '..'), { open }), { status: 404 });
  await assert.rejects(revealFolder(ctx, '', { open }), { status: 400 });
  // A project with no .claude/skills yet: the place is listed but there is nothing to open.
  const bare = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-bare-'));
  const bareCtx = { projectPath: bare, configDir: w.configDir };
  assert.equal((await listSkills(bareCtx)).places[0].exists, false);
  await assert.rejects(revealFolder(bareCtx, path.join(bare, '.claude', 'skills'), { open }), { status: 404, code: 'not_found' });
  assert.equal(opened.length, 2, 'nothing refused reached the opener');
  await fsp.rm(bare, { recursive: true, force: true });
});

test('cleanRel refuses absolute and climbing paths', () => {
  assert.deepEqual(cleanRel('a\\b/./c.md'), ['a', 'b', 'c.md']);
  for (const bad of ['', '/etc/x', 'C:/x', 'c:x', 'a/../../x', '..', 'a/\0b']) assert.equal(cleanRel(bad), null, bad);
});

test('installSkill: a folder checks, then installs into the project; a zip into the person\'s folder; a collision asks; replace swaps', async () => {
  const w = await world();
  const ctx = { projectPath: w.projectPath, configDir: w.configDir };
  const folder = { files: [
    { path: 'motion/SKILL.md', data: b64(md('motion', 'Animation timing for UI.')) },
    { path: 'motion/ref/curves.md', data: b64('ease') },
    { path: 'motion/.DS_Store', data: b64('junk') },
    { path: 'stray.txt', data: b64('beside the folder, left out') },
  ] };
  const check = await installSkill(ctx, { ...folder, dryRun: true });
  assert.equal(check.name, 'motion');
  assert.equal(check.category, 'Design');
  assert.equal(check.fileCount, 2);
  assert.deepEqual(check.destinations.project, { path: path.join(w.projectPath, '.claude', 'skills', 'motion'), exists: false });
  assert.deepEqual(check.destinations.user, { path: path.join(w.configDir, 'skills', 'motion'), exists: false });
  await assert.rejects(fsp.stat(check.destinations.project.path), 'a check writes nothing');

  const done = await installSkill(ctx, { ...folder, target: 'project' });
  assert.deepEqual([done.installed, done.replaced, done.target], [true, false, 'project']);
  assert.equal(await fsp.readFile(path.join(done.path, 'ref', 'curves.md'), 'utf8'), 'ease');
  assert.deepEqual((await fsp.readdir(path.join(w.projectPath, '.claude', 'skills'))).sort(), ['motion', 'not-a-skill', 'palette'], 'no temp folder left behind');

  const again = await installSkill(ctx, { ...folder, dryRun: true });
  assert.equal(again.destinations.project.exists, true);
  await assert.rejects(installSkill(ctx, { ...folder, target: 'project' }), { status: 409, code: 'skill_exists' });
  const changed = { files: [{ path: 'SKILL.md', data: b64(md('motion', 'Animation timing, second edition.')) }] };
  const swapped = await installSkill(ctx, { ...changed, target: 'project', replace: true });
  assert.equal(swapped.replaced, true);
  assert.deepEqual(await fsp.readdir(swapped.path), ['SKILL.md'], 'the old folder\'s files are gone');
  assert.match(await fsp.readFile(path.join(swapped.path, 'SKILL.md'), 'utf8'), /second edition/);

  const zip = Buffer.from(zipSync({ 'release-notes/SKILL.md': strToU8(md('release-notes', 'Write the changelog.')), 'release-notes/': new Uint8Array(0), '__MACOSX/._x': strToU8('x') })).toString('base64');
  const z = await installSkill(ctx, { zip, target: 'user' });
  assert.equal(z.path, path.join(w.configDir, 'skills', 'release-notes'));
  assert.equal(z.category, 'Docs & writing');
  assert.ok((await listSkills(ctx)).skills.some((s) => s.name === 'release-notes' && s.source.kind === 'user'));
  await assert.rejects(installSkill({ configDir: w.configDir }, { zip, target: 'project' }), { status: 400 }, 'no project, no project target');
  assert.equal((await installSkill({ configDir: w.configDir }, { zip, dryRun: true })).destinations.project, null);
});

test('installSkill refuses what is not one valid skill, and paths that leave the folder', async () => {
  const w = await world();
  const ctx = { projectPath: w.projectPath, configDir: w.configDir };
  const one = (p, text) => ({ files: [{ path: p, data: b64(text) }], target: 'project' });
  await assert.rejects(installSkill(ctx, one('x/readme.md', 'hi')), { status: 400, code: 'no_skill_md' });
  await assert.rejects(installSkill(ctx, one('SKILL.md', '# no frontmatter')), { status: 400, code: 'invalid_skill', message: /no frontmatter/ });
  await assert.rejects(installSkill(ctx, one('SKILL.md', '---\nname: x\n---\n')), { status: 400, message: /no description/ });
  await assert.rejects(installSkill(ctx, one('SKILL.md', md('../escape', 'd'))), { status: 400, message: /cannot be a folder name/ });
  await assert.rejects(installSkill(ctx, one('../SKILL.md', md('up', 'd'))), { status: 400, code: 'path_outside' });
  await assert.rejects(installSkill(ctx, one('C:/Windows/SKILL.md', md('abs', 'd'))), { status: 400, code: 'path_outside' });
  const zipUp = Buffer.from(zipSync({ '../evil/SKILL.md': strToU8(md('evil', 'd')) })).toString('base64');
  await assert.rejects(installSkill(ctx, { zip: zipUp, target: 'user' }), { status: 400, code: 'path_outside' });
  await assert.rejects(installSkill(ctx, { zip: b64('not a zip'), target: 'user' }), { status: 400, code: 'bad_zip' });
  await assert.rejects(installSkill(ctx, { files: [{ path: 'a/SKILL.md', data: b64(md('a', 'd')) }, { path: 'b/SKILL.md', data: b64(md('b', 'd')) }], target: 'user' }), { code: 'several_skills' });
  await assert.rejects(installSkill(ctx, { files: [{ path: 'SKILL.md', data: b64(md('ok', 'd')) }], target: 'elsewhere' }), { status: 400 });
  await assert.rejects(installSkill(ctx, {}), { status: 400 });
  await assert.rejects(fsp.stat(path.join(w.root, 'evil')));
  assert.deepEqual((await fsp.readdir(path.join(w.projectPath, '.claude', 'skills'))).sort(), ['not-a-skill', 'palette'], 'nothing was written');
});
