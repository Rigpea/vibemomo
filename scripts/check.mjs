// `npm run check` — the proportional health check: syntax of every module,
// template self-checks, the test suite, and (if running) the server's health.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { failureLines } from './test-failures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function walk(dir, exts, skip = ['node_modules', '.git', '.local', 'dist', 'dist-app']) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, exts, skip)));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

// 1. syntax
const files = await walk(ROOT, ['.mjs', '.js']);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    console.log(`   syntax: ${path.relative(ROOT, f)}\n${r.stderr}`);
  }
}
record('syntax of all .mjs/.js files', bad === 0, `${files.length} files, ${bad} failures`);

// 2. template self-checks
const templates = path.join(ROOT, 'templates');
for (const t of await fsp.readdir(templates)) {
  const sc = path.join(templates, t, 'selfcheck.mjs');
  try {
    await fsp.access(sc);
  } catch {
    record(`template ${t} selfcheck`, true, 'no selfcheck.mjs (skipped)');
    continue;
  }
  const r = spawnSync(process.execPath, [sc], { encoding: 'utf8', cwd: ROOT });
  record(`template ${t} selfcheck`, r.status === 0, (r.stdout || r.stderr).trim().split('\n').pop());
}

// 3. tests
const t = spawnSync(process.execPath, ['--test', 'tests/'], { encoding: 'utf8', cwd: ROOT });
const summary = (t.stdout.match(/ℹ (tests|pass|fail) \d+/g) || []).join(' ');
record('node --test tests/', t.status === 0, summary);
if (t.status !== 0) for (const line of failureLines(t.stdout, t.stderr)) console.log(`   ${line}`);

// 4. server health (optional)
try {
  const res = await fetch(`http://127.0.0.1:${process.env.ATELIER_PORT || 4747}/api/health`);
  record('server health', res.ok, res.ok ? 'running' : `status ${res.status}`);
} catch {
  record('server health', true, 'not running (start with npm start)');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
