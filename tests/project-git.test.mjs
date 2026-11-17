// A project nested in another repo must never commit or restore its parent's files.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-project-git-'));
process.env.ATELIER_DATA_DIR = path.join(root, 'data');
process.env.ATELIER_PROJECTS_DIR = path.join(root, 'projects');
const git = await import('../server/lib/git.mjs');
const projects = await import('../server/lib/projects.mjs');
const versions = await import('../server/lib/versions.mjs');
const { folderKey } = await import('../server/lib/paths.mjs');
const deps = { ...versions, regenerate: async () => {} };

after(async () => { await fsp.rm(root, { recursive: true, force: true }); });

for (const mode of ['create', 'import']) {
  test(`${mode}: a nested project gets its own Git root and leaves the parent unchanged`, async () => {
    const parent = path.join(root, mode);
    const child = path.join(parent, 'child');
    await fsp.mkdir(child, { recursive: true });
    await fsp.writeFile(path.join(parent, '.gitignore'), 'child/\n');
    await fsp.writeFile(path.join(parent, 'important.txt'), 'original\n');
    await git.init(parent);
    const parentHead = await git.commitAll(parent, 'Parent baseline');
    await fsp.writeFile(path.join(parent, 'important.txt'), 'work in progress\n');
    const parentStatus = await git.status(parent);
    const parentTags = await git.git(parent, ['tag', '--list']);
    if (mode === 'import') await fsp.writeFile(path.join(child, 'index.html'), '<h1>Imported</h1>');

    const made = mode === 'create'
      ? await projects.createProject({ name: 'Nested notes', template: 'web-app-notes', path: child }, deps)
      : await projects.importProject({ path: child, name: 'Nested import' }, deps);
    const actualPath = made.entry.path;
    assert.equal(folderKey(actualPath), folderKey(child));
    assert.equal(folderKey((await git.git(child, ['rev-parse', '--show-toplevel'])).trim()), folderKey(child));
    assert.equal(await git.headSha(parent), parentHead);
    assert.deepEqual(await git.status(parent), parentStatus);
    assert.equal(await git.git(parent, ['tag', '--list']), parentTags);
    assert.equal(await fsp.readFile(path.join(parent, 'important.txt'), 'utf8'), 'work in progress\n');
    assert.ok(!(await git.listTree(child, 'HEAD')).includes('important.txt'));
  });
}
