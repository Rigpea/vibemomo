// The Page dock tab's server half (docs/ARCHITECTURE.md section 13): the other HTML pages beside the web entry, and
// Point on the preview, which reads the element in the browser and asks here only for the files that likely hold it.
// The candidate search is the Phone's (server/lib/devices/inspect.mjs), over the entry's folder and nothing outside it.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { HttpError, insideProject } from './paths.mjs';
import { findCandidates, searchRootOf } from './devices/inspect.mjs';

export const MAX_SIBLINGS = 40;
const posix = (p) => p.split(path.sep).join('/');

/** The .html files in the entry's own folder other than the entry, sorted, project-relative with forward slashes.
 *  [] when the entry is not an HTML page or its folder cannot be read. */
export async function siblingPages(projectPath, entry) {
  if (typeof entry !== 'string' || !/\.html?$/i.test(entry.trim())) return [];
  const rel = entry.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const dir = path.posix.dirname(rel);
  let abs;
  try { abs = insideProject(projectPath, dir); } catch { return []; }
  const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
    .filter((p) => p !== rel)
    .sort()
    .slice(0, MAX_SIBLINGS);
}

const text = (v, max, name) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `${name} must be text`);
  return v.slice(0, max);
};

/**
 * POST /page/inspect: { selector, id, classes, text, page? } -> { ok, element, candidates, searched }.
 * page, when given, is the project-relative HTML file the element is on (from the preview's URL); the search then
 * reads that file's folder, which must lie inside the entry's folder: a path outside it is refused with 400.
 */
export async function pageInspect({ path: projectPath, manifest }, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.classes != null && (!Array.isArray(b.classes) || b.classes.length > 40 || b.classes.some((c) => typeof c !== 'string'))) {
    throw new HttpError(400, 'invalid_input', 'classes must be a list of up to 40 class names');
  }
  const element = {
    selector: text(b.selector, 500, 'selector'),
    id: text(b.id, 200, 'id') || null,
    classes: (b.classes || []).map((c) => c.slice(0, 100)),
    text: text(b.text, 160, 'text'),
  };
  if (!element.id && !element.classes.length && !element.text.trim()) throw new HttpError(400, 'invalid_input', 'Give an id, classes or text to search for');
  const entryDir = searchRootOf(manifest || {});
  const entryAbs = insideProject(projectPath, entryDir);
  let rootAbs = entryAbs;
  if (b.page != null) {
    const page = text(b.page, 500, 'page').replace(/\\/g, '/').replace(/^\/+/, '');
    const want = path.resolve(projectPath, path.posix.dirname(page) || '.');
    const within = path.relative(entryAbs, want);
    if (within.startsWith('..') || path.isAbsolute(within)) throw new HttpError(400, 'path_outside_entry', `${page} is outside the entry's folder ${posix(entryDir)}; the search reads only that folder`);
    rootAbs = insideProject(projectPath, path.relative(projectPath, want));
  }
  const candidates = await findCandidates({ projectPath, root: rootAbs, element });
  const searched = posix(path.relative(projectPath, rootAbs)) || '.';
  return { ok: true, element, candidates, searched };
}
