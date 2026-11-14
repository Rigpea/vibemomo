// The Visualizer's server half (docs/ARCHITECTURE.md section 26): which stylesheets a project's web entry loads, read
// from the entry's own HTML (its <link rel="stylesheet"> and <style> elements, then every @import inside them), and
// the answer the view draws: the design those files hold (server/lib/design-read.mjs) beside the project's fixed
// rules and the colour cards of its inspiration board. It only reads: no file and no record is written, and every
// path goes through insideProject(), so a link that leaves the project, or points into .git or .studio, is left out
// and named.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { insideProject } from './paths.mjs';
import { scanCss } from './css-scan.mjs';
import { readDesign, FAR, EXACT, PLACES_MAX } from './design-read.mjs';
import { listRules, RULES_FILE } from './rules.mjs';
import { listCards, BOARD_FILE } from './inspiration.mjs';

export const MAX_SHEETS = 40;
export const SHEET_MAX_BYTES = 1024 * 1024;
export const ENTRY_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_DEPTH = 5;
export const LIMITS = { sheets: MAX_SHEETS, sheetBytes: SHEET_MAX_BYTES, far: FAR, exact: EXACT, places: PLACES_MAX };

const posix = (p) => String(p).replace(/\\/g, '/');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null; };
const linesBefore = (text, index) => { let n = 0; for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) n++; return n; };

/** The stylesheets a page names, in the order it loads them: [{ href, line }] for a link, [{ css, lineOffset }] for a
 *  <style> element. A comment hides what is inside it; a link whose media is print is not what the screen shows. */
export function sheetsInHtml(html) {
  const text = String(html ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  for (const m of text.matchAll(/<link\b[^>]*>|<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
    if (/^<link/i.test(m[0])) {
      const rel = (attr(m[0], 'rel') || '').toLowerCase().split(/\s+/);
      const href = attr(m[0], 'href');
      if (!rel.includes('stylesheet') || rel.includes('alternate') || !href || (attr(m[0], 'media') || '').trim().toLowerCase() === 'print') continue;
      out.push({ href, line: linesBefore(text, m.index) + 1 });
    } else if (m[2].trim()) {
      const start = m.index + m[0].indexOf('>') + 1;
      out.push({ css: m[2], lineOffset: linesBefore(text, start) });
    }
  }
  return out;
}

/**
 * Where an address in a page or a stylesheet leads inside the project: the project-relative candidates, in the
 * order to try. null for an address on another host (or a data URL). A path from the site's root (`/styles.css`)
 * is first read from the entry's own folder, which is the root the preview serves, then from the project's.
 */
export function hrefCandidates(href, fromFile, entryDir) {
  let clean = String(href ?? '').trim().replace(/[?#].*$/, '');
  if (!clean) return [];
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null;
  try { clean = decodeURI(clean); } catch { /* as written */ }
  if (clean.startsWith('/')) {
    const rest = clean.replace(/^\/+/, '');
    return [...new Set([path.posix.join(entryDir, rest), rest])].map((p) => path.posix.normalize(p));
  }
  return [path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean))];
}

/**
 * The stylesheets of a project's web entry: { entry, sheets: [{ file, from, lines, decls }], skipped: [{ href, from,
 * reason }] }. from is `link`, `style` (the entry itself) or `import`. entry is null when the manifest names no HTML
 * page that can be read (reason then says why).
 */
export async function findSheets(projectPath, manifestEntry) {
  const out = { entry: null, reason: null, sheets: [], skipped: [] };
  const entry = typeof manifestEntry === 'string' ? posix(manifestEntry.trim()).replace(/^\/+/, '') : '';
  if (!entry || !/\.html?$/i.test(entry)) { out.reason = entry ? `The project's entry (${entry}) is not an HTML page, so there is no stylesheet to follow from it.` : 'The project names no entry page in atelier.json, so there is no stylesheet to follow.'; return out; }
  let html;
  try {
    const abs = insideProject(projectPath, entry);
    const stat = await fsp.stat(abs);
    if (stat.size > ENTRY_MAX_BYTES) throw new Error('too large');
    html = await fsp.readFile(abs, 'utf8');
  } catch { out.reason = `The entry page ${entry} could not be read.`; return out; }
  out.entry = entry;
  const entryDir = path.posix.dirname(entry);
  const seen = new Set();

  /** A file's text, or the reason it is left out. */
  const readSheet = async (href, fromFile) => {
    const candidates = hrefCandidates(href, fromFile, entryDir);
    if (candidates === null) return { reason: 'on another site; only files of the project are read' };
    let outside = null;
    for (const rel of candidates) {
      let abs;
      try { abs = insideProject(projectPath, rel); } catch (err) { outside = err.code === 'path_forbidden' ? 'inside .git or .studio, which are not read' : 'outside the project'; continue; }
      let stat;
      try { stat = await fsp.stat(abs); } catch { continue; }
      if (!stat.isFile()) continue;
      if (stat.size > SHEET_MAX_BYTES) return { reason: `larger than ${SHEET_MAX_BYTES / 1024 / 1024} MB` };
      return { file: posix(path.relative(projectPath, abs)), text: await fsp.readFile(abs, 'utf8') };
    }
    return { reason: outside || 'not found in the project' };
  };
  const addSheet = async (file, text, from, depth, lineOffset = 0) => {
    const scanned = scanCss(text, { lineOffset });
    const same = from === 'style' ? out.sheets.find((s) => s.from === 'style' && s.file === file) : null;
    if (same) same.decls.push(...scanned.decls); // a page's second <style> element: one entry for the page
    else out.sheets.push({ file, from, lines: from === 'style' ? null : scanned.lines, decls: scanned.decls });
    for (const imp of scanned.imports) await follow(imp.href, file, 'import', depth + 1);
  };
  async function follow(href, fromFile, from, depth) {
    if (out.sheets.length >= MAX_SHEETS) { out.skipped.push({ href, from: fromFile, reason: `more than ${MAX_SHEETS} stylesheets; the rest are not read` }); return; }
    if (depth > IMPORT_DEPTH) { out.skipped.push({ href, from: fromFile, reason: `imported more than ${IMPORT_DEPTH} deep` }); return; }
    const got = await readSheet(href, fromFile);
    if (got.reason) { out.skipped.push({ href, from: fromFile, reason: got.reason }); return; }
    if (seen.has(got.file)) return; // read once, however often it is named
    seen.add(got.file);
    await addSheet(got.file, got.text, from, depth);
  }
  for (const item of sheetsInHtml(html)) {
    if (item.href != null) await follow(item.href, entry, 'link', 0);
    else if (out.sheets.length < MAX_SHEETS) await addSheet(entry, item.css, 'style', 0, item.lineOffset);
  }
  return out;
}

/**
 * A record list for the answer, never a reason not to answer: one that cannot be read says so instead of reading as
 * none. The file is parsed here first, because the records' own reader keeps a copy of a damaged file beside it, and
 * this route writes nothing at all.
 */
async function recordsOf(projectPath, file, read) {
  const failed = { list: [], error: `${file} could not be read` };
  try { JSON.parse(await fsp.readFile(insideProject(projectPath, file, { allowStudio: true }), 'utf8')); } catch (err) { if (err.code !== 'ENOENT') return failed; }
  try { return { list: await read(), error: null }; } catch { return failed; }
}

/**
 * GET /api/projects/:id/visualizer. ctx: { path, manifest } of the project. Answers the stylesheets read (and the
 * addresses left out, each with why), the colours, type, spacing, radii and motion they hold, the fixed rules with
 * each locked token checked against the files, the board's colour cards with the nearest colour in the files, a
 * summary and the limits in use.
 */
export async function visualizerAnswer({ path: projectPath, manifest }) {
  const found = await findSheets(projectPath, manifest?.entry);
  const rules = await recordsOf(projectPath, RULES_FILE, () => listRules(projectPath));
  const cards = await recordsOf(projectPath, BOARD_FILE, () => listCards(projectPath));
  const boardColors = cards.list.filter((c) => c.kind === 'color' && typeof c.hex === 'string').map((c) => ({ id: c.id, hex: c.hex, name: c.name || '' }));
  const design = readDesign(found.sheets, { rules: rules.list, boardColors });
  return {
    entry: found.entry,
    reason: found.reason,
    sheets: found.sheets.map((s) => ({ file: s.file, from: s.from, lines: s.lines, declarations: s.decls.length })),
    skipped: found.skipped,
    ...design,
    rulesError: rules.error,
    boardError: cards.error,
    boardCards: cards.list.length,
    limits: { ...LIMITS },
  };
}
