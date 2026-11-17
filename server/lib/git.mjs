// Thin, explicit git wrapper. Checkpoints are commits + tags; restore is a
// hard reset after a safety checkpoint. Everything is run with `git -C <dir>`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError, folderKey } from './paths.mjs';

const execFileP = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'Atelier',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'atelier@local',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'Atelier',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'atelier@local',
  GIT_TERMINAL_PROMPT: '0',
};

export async function git(dir, args, { encoding = 'utf8', maxBuffer = 64 * 1024 * 1024, allowFail = false } = {}) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], { encoding, maxBuffer, env: GIT_ENV, windowsHide: true });
    return stdout;
  } catch (err) {
    if (allowFail) return null;
    const msg = (err.stderr || err.message || '').toString().trim();
    throw new HttpError(500, 'git_failed', `git ${args[0]} failed: ${msg}`);
  }
}

export async function isRepo(dir) {
  // Being inside a parent's work tree is insufficient: checkpoints stage with -A,
  // and restores reset the whole repo. Each project must own its repository root.
  const out = await git(dir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  return out !== null && folderKey(out.trim()) === folderKey(dir);
}

export async function init(dir) {
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
}

export async function headSha(dir) {
  const out = await git(dir, ['rev-parse', 'HEAD'], { allowFail: true });
  return out ? out.trim() : null;
}

/** Porcelain status -> [{path, status}] where status is M/A/D/R/?? etc. */
export async function status(dir) {
  const out = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const code = p.slice(0, 2);
    let file = p.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      // rename: next entry is the original path
      i++;
    }
    files.push({ path: file, status: code.trim() || '?' });
  }
  return files;
}

export async function commitAll(dir, message) {
  await git(dir, ['add', '-A']);
  // --allow-empty so a first checkpoint always exists even for empty templates
  await git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return headSha(dir);
}

export async function tag(dir, name, sha, message) {
  await git(dir, ['tag', '-f', '-a', name, sha, '-m', message || name]);
}

export async function resetHard(dir, sha) {
  await git(dir, ['reset', '-q', '--hard', sha]);
  // remove untracked files that the target version did not have; ignored/excluded (.studio) untouched
  await git(dir, ['clean', '-fdq']);
}

/** Read a file from a commit as a Buffer; null when missing. */
export async function showFile(dir, sha, relPosix) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'show', `${sha}:${relPosix}`], {
      encoding: 'buffer',
      maxBuffer: 256 * 1024 * 1024,
      env: GIT_ENV,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function listTree(dir, sha) {
  const out = await git(dir, ['ls-tree', '-r', '--name-only', '-z', sha]);
  return out.split('\0').filter(Boolean);
}

/** The unified diff of two files named relative to dir, in or out of a repo. git answers 1 when they differ, so that is no failure. */
export async function diffFiles(dir, a, b) {
  try {
    await execFileP('git', ['-C', dir, '-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--text', '--', a, b], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: GIT_ENV, windowsHide: true });
    return '';
  } catch (err) {
    if (err.code === 1) return err.stdout;
    throw new HttpError(500, 'git_failed', `git diff failed: ${(err.stderr || err.message || '').toString().trim()}`);
  }
}

/** At most max bytes of text, ending on a whole character: a cut inside one steps back to where it began. */
export function cutToBytes(text, max) {
  const bytes = Buffer.from(text);
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // a UTF-8 continuation byte: the character runs across the cut
  return bytes.subarray(0, end).toString('utf8');
}

/** Compare two refs ("head" means the working tree). */
export async function diffSummary(dir, a, b, { maxDiffBytes = 200 * 1024 } = {}) {
  const refArgs = b === 'head' ? [a] : [a, b];
  const numstat = await git(dir, ['diff', '--numstat', '-z', ...refArgs, '--']);
  const nameStatus = await git(dir, ['diff', '--name-status', '-z', ...refArgs, '--']);
  const statusByPath = new Map();
  const ns = nameStatus.split('\0').filter((s) => s !== '');
  for (let i = 0; i < ns.length; i += 2) {
    const code = ns[i];
    const p = ns[i + 1];
    if (code && p) statusByPath.set(p, code[0]);
    if (code && (code[0] === 'R' || code[0] === 'C')) i++; // rename has old+new
  }
  const files = [];
  const rows = numstat.split('\0').filter((s) => s !== '');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const m = row.match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let p = m[3];
    if (p === '') {
      // rename: numstat -z emits "a\tb\t\0old\0new\0"
      p = rows[i + 2] || rows[i + 1];
      i += 2;
    }
    files.push({
      path: p,
      status: statusByPath.get(p) || 'M',
      additions: m[1] === '-' ? null : Number(m[1]),
      deletions: m[2] === '-' ? null : Number(m[2]),
    });
  }
  let diff = await git(dir, ['diff', '--no-color', ...refArgs, '--']);
  let truncated = false;
  if (Buffer.byteLength(diff) > maxDiffBytes) {
    diff = cutToBytes(diff, maxDiffBytes);
    truncated = true;
  }
  return { files, diff, truncated };
}

export async function log(dir, { from, to = 'HEAD', max = 50 } = {}) {
  const range = from ? `${from}..${to}` : to;
  const out = await git(dir, ['log', `--max-count=${max}`, '--format=%H%x00%aI%x00%s', range], { allowFail: true });
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, subject] = line.split('\0');
      return { sha, date, subject };
    });
}

/** Commits on either side of two commits, or null when git cannot compare them. */
export async function commitsApart(dir, a, b) {
  const out = await git(dir, ['rev-list', '--count', `${a}...${b}`], { allowFail: true });
  return out ? Number(out.trim()) : null;
}

/** Whether this repository holds the commit. */
export async function commitExists(dir, sha) {
  return (await git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true })) !== null;
}

/** Whether a is b or behind it. False too when git cannot compare them. */
export async function isAncestor(dir, a, b) {
  return (await git(dir, ['merge-base', '--is-ancestor', a, b], { allowFail: true })) !== null;
}

/** The commit two commits branched from, or null when they share none or git cannot compare them. */
export async function mergeBase(dir, a, b) {
  const out = await git(dir, ['merge-base', a, b], { allowFail: true });
  return out ? out.trim() : null;
}

/** Commits reachable from `to` and not from `from` (all of `to`'s history without `from`). */
export async function revList(dir, from, to) {
  const out = await git(dir, ['rev-list', from ? `${from}..${to}` : to]);
  return out.split('\n').filter(Boolean);
}

export async function changedFilesBetween(dir, from, to = 'HEAD') {
  const out = await git(dir, ['diff', '--name-only', '-z', from, to, '--'], { allowFail: true });
  return out ? out.split('\0').filter(Boolean) : [];
}
