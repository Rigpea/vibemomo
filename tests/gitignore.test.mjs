// What .gitignore keeps out of the studio's own history: product folders kept inside a checkout, the data folder's
// files, .studio, .local and env files, while source of the same names deeper down still tracks. Asked of git itself
// (check-ignore), with made-up generic paths only: no real project name belongs in a public test. A ZIP download has
// no .git, so the tests skip there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
const inRepo = git('rev-parse', '--show-toplevel');
const skip = inRepo.status !== 0 || path.resolve(inRepo.stdout.trim()).toLowerCase() !== ROOT.toLowerCase()
  ? 'not a git checkout of the studio (a ZIP download, or git missing)' : false;

/** Whether git would ignore this path, by the rules alone (--no-index: tracked or not, present or not). */
function ignored(rel) {
  const r = git('check-ignore', '--no-index', '-q', '--', rel);
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore ${rel}: ${r.stderr}`);
  return r.status === 0;
}

test('product folders and studio data inside a checkout are ignored', { skip }, () => {
  const kept = [
    'projects/sample-game/index.html', 'projects/sample-game/.studio/project.json',
    'products/sample-app/src/app.js', 'workspace/demo/README.md', 'workspaces/a/b/notes.md',
    'Atelier projects/sample/index.html',
    'registry.json', 'registry-export.json', 'secrets.json', 'secrets.backup.json', 'live-consent.json',
    'workers.json', 'resources.json', 'memory/m_1.json', 'usage/2026-11.jsonl',
    'console/cs_sample.json', 'console/cs_sample.jsonl', 'studio-look.json', 'studio-look/ins_sample.png', 'budget.json',
    '.studio/project.json', '.studio/tasks/t_1/brief.md', '.atelier/registry.json', '.local/server.pid',
    '.env', '.env.local', 'docs/evidence/model-participation.json',
  ];
  const leaked = kept.filter((rel) => !ignored(rel));
  assert.deepEqual(leaked, [], 'these private paths would be committed');
});

test('source of the same names deeper down still tracks', { skip }, () => {
  const source = [
    'client/index.html', 'server/lib/registry.mjs', 'server/lib/secrets.mjs', 'tests/secrets.test.mjs',
    'templates/web-app-notes/src/store.js', 'templates/projects/sample/index.html', 'workbenches/README.md',
    'workbenches/projects/panel.js', 'tests/fixtures/projects/a.json', 'tests/fixtures/registry.json',
    'server/lib/memory/index.mjs', 'docs/GUIDE.md', 'app/icon.ico', '.env.example', 'atelier.json',
    'server/lib/console.mjs', 'server/lib/studio-look.mjs', 'server/api-utility/budget.mjs',
    'tests/fixtures/console/a.json', 'tests/fixtures/budget.json',
  ];
  const lost = source.filter((rel) => ignored(rel));
  assert.deepEqual(lost, [], 'these source paths would be ignored');
});

test('no tracked file matches an ignore rule (a rule does not untrack it)', { skip }, () => {
  const r = git('ls-files', '--cached', '--ignored', '--exclude-standard');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('\n').filter(Boolean), [], 'tracked despite .gitignore: run git rm --cached on them');
});
