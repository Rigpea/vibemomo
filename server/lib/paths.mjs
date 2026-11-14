// Path resolution and confinement. Every file operation on a project must go
// through insideProject() so nothing escapes the project folder.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const STUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.resolve(process.env.ATELIER_DATA_DIR || path.join(os.homedir(), '.atelier'));
export const PROJECTS_DIR = path.resolve(process.env.ATELIER_PROJECTS_DIR || path.join(STUDIO_DIR, '..'));
export const PORT = Number(process.env.ATELIER_PORT || 4747);

export function nowIso() {
  return new Date().toISOString();
}

// Pure and shared with the client, so a release date reads the same from either side.
export { localDateTime } from '../../client/components/release-notes.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function newId(prefix) {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'project';
}

/** One folder name, safe to join under a parent the caller chose: no separator of either kind, no leading dot (so not . or ..). */
export function isPlainName(name) {
  return typeof name === 'string' && name !== '' && path.basename(name) === name && !/[\\/]/.test(name) && !name.startsWith('.');
}

/** What makes two paths one folder here: a junction, a symlink or a mapped drive leads to the same folder as its
 *  target, and Windows paths differ by case and still name the same folder. A folder that does not exist has no real path. */
export function folderKey(folder) {
  let real;
  try {
    real = fs.realpathSync.native(folder);
  } catch {
    real = path.resolve(folder);
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Resolve `rel` inside `root`; throw if it escapes or targets .git/.studio when forbidden. */
export function insideProject(root, rel = '', { allowStudio = false, allowGit = false } = {}) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel || '.');
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'path_outside_project', `Path escapes the project: ${rel}`);
  }
  const first = relative.split(/[\\/]/)[0];
  if (!allowGit && first === '.git') throw new HttpError(400, 'path_forbidden', 'The .git folder is managed by the studio');
  if (!allowStudio && first === '.studio') throw new HttpError(400, 'path_forbidden', 'Edit .studio records through the studio, not as files');
  return target;
}

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}
