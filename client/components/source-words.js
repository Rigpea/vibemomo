// The Source tab's words and paths, apart from the DOM (workbenches/source/panel.js draws them). No imports, so
// client/components/task-activity.js (an Activity row's file button) and tests/source-tab.test.mjs read it directly.

/** The files route's cut: a longer file is shown up to here, with a line saying so. */
export const CUT_BYTES = 400 * 1024;
/** One line of the text in px: the gutter, the mark and the scroll all count in it (client/views.css .source-text). */
export const LINE_PX = 20;

/** Folders a reader does not want in the tree: tools' own (a name starting with a dot), caches and dependencies. The
 *  tree leaves them out behind "n tool folders hidden · Show" (decision row 117); files are never hidden. */
export const TOOL_FOLDERS = new Set(['__pycache__', 'node_modules']);
export const isToolFolder = (e) => e?.type === 'dir' && (TOOL_FOLDERS.has(e.name) || String(e.name || '').startsWith('.'));

/** Tool calls whose summary is the file they act on (server/lib/console.mjs puts input.file_path first). */
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'atelier_read_file']);

const slashes = (s) => String(s ?? '').trim().replace(/\\/g, '/');
const isAbsolute = (s) => /^[a-zA-Z]:\//.test(s) || s.startsWith('/');

/**
 * A path as the files route takes it (relative to the project folder, forward slashes), or null when it is not inside
 * the project: an absolute path under another folder, a path climbing out with .., or nothing at all. An absolute path
 * is compared without case on a drive letter, as Windows does.
 */
export function projectRel(raw, projectPath = '') {
  let p = slashes(raw);
  if (!p) return null;
  if (isAbsolute(p)) {
    const root = slashes(projectPath).replace(/\/+$/, '');
    if (!root) return null;
    const win = /^[a-zA-Z]:\//.test(root);
    const same = win ? p.toLowerCase().startsWith(`${root.toLowerCase()}/`) : p.startsWith(`${root}/`);
    if (!same) return null;
    p = p.slice(root.length + 1);
  }
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** The file a tool call names (Read, Edit, Write, the companion's read_file), as its summary carries it; else null. */
export function fileOfEvent(e) {
  const bare = String(e?.name || '').replace(/^mcp__.+?__/, '');
  if (!FILE_TOOLS.has(bare)) return null;
  const s = String(e?.summary ?? '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try { const o = JSON.parse(s); return typeof (o.file_path ?? o.path) === 'string' ? o.file_path ?? o.path : null; } catch { return null; }
  }
  return s;
}

export const childPath = (dir, name) => (dir ? `${dir}/${name}` : name);
export const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** Every folder above a path, the top first: 'a/b/c.js' -> ['a', 'a/b']. */
export const foldersAbove = (p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'));

/**
 * What changed since the current version, from bundle.changes and the version list: the changed files that exist
 * (a deleted file has no row to mark), the folders holding them, and the words a dot and the path line use.
 */
export function changedFrom(bundle) {
  const ch = bundle?.changes;
  const files = new Set((ch?.files || []).filter((f) => !/D/.test(f.status || '')).map((f) => slashes(f.path).replace(/\/$/, '')));
  const folders = new Set([...files].flatMap(foldersAbove));
  const v = (bundle?.versions || []).find((x) => x.id === ch?.sinceVersionId);
  const since = v ? `#${v.n}` : null;
  return {
    files, folders, since,
    fileWords: since ? `changed since ${since}` : 'changed since the last version',
    folderWords: since ? `holds files changed since ${since}` : 'holds files changed since the last version',
    sig: JSON.stringify([ch?.sinceVersionId || null, (ch?.files || []).map((f) => `${f.status} ${f.path}`).sort()]),
  };
}

export function sizeWords(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The line a cut file shows above its text. */
export const cutWords = (answer) => `Cut at ${sizeWords(answer.shownBytes ?? CUT_BYTES)} of ${sizeWords(answer.bytes)}: the rest of the file is not shown here.`;
export const NOT_TEXT = 'Not a text file';

/** The text's lines; a cut file drops its last, partial line, so every numbered line is a whole one. */
export function linesOf(answer) {
  const lines = String(answer?.content ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (answer?.truncated && lines.length > 1) lines.pop();
  if (!answer?.truncated && lines.length > 1 && lines.at(-1) === '') lines.pop(); // a final newline is not a line
  return lines;
}

/** The gutter's text: 1..n, one per line. */
export const gutterOf = (n) => Array.from({ length: n }, (_, i) => String(i + 1)).join('\n');

/** A line within the file, or null: a line past the end (or not a whole number from 1) marks nothing. */
export const lineIn = (line, count) => (Number.isInteger(line) && line >= 1 && line <= count ? line : null);

/** Where the text scrolls so a line sits a third of the way down the box. */
export const scrollFor = (line, boxHeight) => Math.max(0, (line - 1) * LINE_PX - Math.round((boxHeight || 0) / 3));

/** "src/a.js:12" from a file and a line. */
export const refOf = (path, line) => (line ? `${path}:${line}` : path);
