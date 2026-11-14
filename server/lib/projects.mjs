// Projects: real folders with their own git repo and a .studio/ record set.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { STUDIO_DIR, PROJECTS_DIR, newId, nowIso, slugify, HttpError, insideProject, folderKey } from './paths.mjs';
import { readJson, writeJson, writeText, ensureDir, exists, copyDir, listFiles } from './fsutil.mjs';
import * as git from './git.mjs';
import { loadRegistry, updateRegistry } from './registry.mjs';
import { listStore, historyLog } from './stores.mjs';
import { checkWorkerModel } from './models.mjs';

export const TEMPLATES_DIR = path.join(STUDIO_DIR, 'templates');

export function studioPath(projectPath, ...rest) {
  return path.join(projectPath, '.studio', ...rest);
}

export function stores(projectPath) {
  return {
    decisions: listStore(studioPath(projectPath, 'decisions.json'), 'd'),
    feedback: listStore(studioPath(projectPath, 'feedback.json'), 'f'),
    releases: listStore(studioPath(projectPath, 'releases.json'), 'rel'),
    resources: listStore(studioPath(projectPath, 'resources.json'), 'r'),
    history: historyLog(studioPath(projectPath, 'history.jsonl')),
  };
}

function defaultProject({ id, name, slug, kind }) {
  const ts = nowIso();
  return {
    id,
    name,
    slug,
    kind,
    purpose: '',
    audience: '',
    inspiration: '',
    direction: '',
    currentPiece: { title: '', why: '', acceptance: [] },
    nextRelease: { title: '', definition: [], targetVersionId: null },
    components: [],
    unresolved: [],
    ui: { layout: {} },
    createdAt: ts,
    updatedAt: ts,
  };
}

export async function listTemplates() {
  if (!(await exists(TEMPLATES_DIR))) return [];
  const entries = await fsp.readdir(TEMPLATES_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifest = await readJson(path.join(TEMPLATES_DIR, e.name, 'atelier.json'), null);
    out.push({ name: e.name, kind: manifest?.kind || 'web-app', title: manifest?.name || e.name, description: manifest?.description || '' });
  }
  return out;
}

export async function readManifest(projectPath) {
  const m = await readJson(path.join(projectPath, 'atelier.json'), null);
  if (m) return m;
  // Inferred manifest for imported folders without one.
  const hasIndex = await exists(path.join(projectPath, 'index.html'));
  const hasSrcIndex = await exists(path.join(projectPath, 'src', 'index.html'));
  return {
    kind: 'web-app',
    name: path.basename(projectPath),
    entry: hasSrcIndex ? 'src/index.html' : hasIndex ? 'index.html' : null,
    build: { type: 'static', dir: hasSrcIndex ? 'src' : '.', out: 'dist' },
    inferred: true,
  };
}

/** Keep .studio/ and the generated CLAUDE.md out of product history without touching the product's .gitignore. */
export async function ensureExcludes(projectPath, { excludeClaudeMd }) {
  const excludeFile = path.join(projectPath, '.git', 'info', 'exclude');
  await ensureDir(path.dirname(excludeFile));
  let text = '';
  try {
    text = await fsp.readFile(excludeFile, 'utf8');
  } catch {
    text = '';
  }
  const lines = new Set(text.split(/\r?\n/).filter(Boolean));
  const wanted = ['.studio/', 'dist/'];
  if (excludeClaudeMd) wanted.push('CLAUDE.md');
  let changed = false;
  for (const w of wanted) {
    if (!lines.has(w)) {
      lines.add(w);
      changed = true;
    }
  }
  if (changed) await fsp.writeFile(excludeFile, [...lines].join('\n') + '\n', 'utf8');
}

export async function getEntry(id) {
  const reg = await loadRegistry();
  const entry = reg.projects.find((p) => p.id === id);
  if (!entry) throw new HttpError(404, 'not_found', `Project ${id} not found`);
  return entry;
}

export async function loadProject(id) {
  const entry = await getEntry(id);
  if (!(await exists(entry.path))) throw new HttpError(410, 'project_missing', `Project folder is missing: ${entry.path}`);
  const project = await readJson(studioPath(entry.path, 'project.json'), null);
  if (!project) throw new HttpError(500, 'records_missing', `Project records missing in ${entry.path}/.studio`);
  const manifest = await readManifest(entry.path);
  return { entry, project, manifest, path: entry.path };
}

export async function saveProject(projectPath, project) {
  project.updatedAt = nowIso();
  await writeJson(studioPath(projectPath, 'project.json'), project);
  return project;
}

const PATCHABLE = ['name', 'purpose', 'audience', 'inspiration', 'direction', 'currentPiece', 'nextRelease', 'components', 'unresolved', 'ui', 'template', 'workerModel'];

/** The record createProject writes, for a template that exists and is of the project's kind. The client names only the template. */
async function templateRecord(value, kind, projectName) {
  const template = (await listTemplates()).find((t) => t.name === value?.name);
  if (!template) throw new HttpError(400, 'invalid_input', `No template named ${value?.name}`);
  if (template.kind !== kind) throw new HttpError(400, 'invalid_input', `Template ${template.name} is for ${template.kind} projects, this project is ${kind}`);
  return { name: template.name, at: nowIso(), projectName };
}

const recordQueues = new Map(); // project folder -> the end of its queue

/** One read, change and write of project.json at a time per folder, within this process: two requests that
 *  read the same list would otherwise each write their own copy, and the later one would undo the earlier. */
export function withProjectRecord(projectPath, run) {
  const done = (recordQueues.get(projectPath) || Promise.resolve()).then(run);
  const tail = done.catch(() => {});
  recordQueues.set(projectPath, tail);
  tail.then(() => { if (recordQueues.get(projectPath) === tail) recordQueues.delete(projectPath); });
  return done;
}

/** The per-item operations: they change the stored list, so a client's old copy of it cannot lose anything. */
function applyUnresolvedOperations(list, { unresolvedAdd, unresolvedResolve }) {
  let next = list;
  if (unresolvedResolve !== undefined) {
    if (!Array.isArray(unresolvedResolve) || unresolvedResolve.some((id) => typeof id !== 'string')) throw new HttpError(400, 'invalid_input', 'unresolvedResolve must be a list of item ids');
    next = next.filter((u) => !unresolvedResolve.includes(u.id)); // an id no longer there was resolved by someone else
  }
  if (unresolvedAdd !== undefined) {
    if (!Array.isArray(unresolvedAdd) || unresolvedAdd.some((a) => typeof a?.text !== 'string' || !a.text.trim())) throw new HttpError(400, 'invalid_input', 'unresolvedAdd must be a list of { text } with text in it');
    next = [...next, ...unresolvedAdd.map((a) => ({ id: newId('u'), text: a.text.trim(), createdAt: nowIso() }))];
  }
  return next;
}

/** project.ui merged one level deep: a caller sends the keys it changes, a key set to null is removed, a map that is
 *  not a map is refused. The dock's saveUi sends the whole map, which merges to the same thing; a partial map from a
 *  script no longer wipes the dock tab, the companion session and the rest (decision row 112). */
export function mergeUi(current, partial) {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) throw new HttpError(400, 'invalid_input', 'ui must be a map of keys to values');
  const next = { ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}) };
  for (const [k, v] of Object.entries(partial)) { if (v === null) delete next[k]; else next[k] = v; }
  return next;
}

export async function patchProject(id, partial) {
  const projectPath = (await getEntry(id)).path;
  const project = await withProjectRecord(projectPath, async () => {
    const { entry, project } = await loadProject(id);
    const { unresolvedAdd, unresolvedResolve, ...fields } = partial || {};
    // Checked before anything is assigned, so a refused value leaves the record as it was.
    const workerModel = 'workerModel' in fields ? checkWorkerModel(fields.workerModel) : undefined;
    for (const key of Object.keys(fields)) {
      if (!PATCHABLE.includes(key)) throw new HttpError(400, 'invalid_field', `Cannot patch ${key}`);
      if (key === 'workerModel') continue;
      project[key] = key === 'ui' ? mergeUi(project.ui, fields.ui) : fields[key];
    }
    // The worker model (server/lib/workers.mjs): absent means the studio default, so default or null removes it.
    if (workerModel === null) delete project.workerModel;
    else if (workerModel !== undefined) project.workerModel = workerModel;
    if ('template' in fields) {
      if (fields.template === null) delete project.template; // absent, as on a project with no record
      else project.template = await templateRecord(fields.template, entry.kind, project.name);
    }
    if (Array.isArray(project.unresolved)) {
      project.unresolved = project.unresolved.map((u) =>
        typeof u === 'string' ? { id: newId('u'), text: u, createdAt: nowIso() } : { id: u.id || newId('u'), createdAt: u.createdAt || nowIso(), ...u }
      );
    }
    if (unresolvedAdd !== undefined || unresolvedResolve !== undefined) {
      project.unresolved = applyUnresolvedOperations(Array.isArray(project.unresolved) ? project.unresolved : [], { unresolvedAdd, unresolvedResolve });
    }
    return saveProject(projectPath, project);
  });
  if (partial?.name) await updateRegistry((reg) => {
    const e = reg.projects.find((p) => p.id === id);
    if (e) e.name = partial.name;
  });
  return project;
}

async function registerEntry({ id, name, slug, kind, projectPath, createdAt = nowIso() }) {
  return updateRegistry((reg) => {
    const entry = { id, name, slug, kind, path: projectPath, createdAt, lastOpenedAt: nowIso() };
    reg.projects.push(entry);
    reg.activeProjectId = id;
    return entry;
  });
}

async function writeInitialRecords(projectPath, project) {
  await ensureDir(studioPath(projectPath, 'memory'));
  await ensureDir(studioPath(projectPath, 'tasks'));
  await writeJson(studioPath(projectPath, 'project.json'), project);
  for (const f of ['versions.json', 'decisions.json', 'feedback.json', 'releases.json', 'resources.json']) {
    if (!(await exists(studioPath(projectPath, f)))) await writeJson(studioPath(projectPath, f), []);
  }
}

const RENAME_EXTENSIONS = new Set(['.html', '.md', '.json', '.js', '.css', '.txt']);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapeJsString = (s) => JSON.stringify(s).slice(1, -1);

/** Whether the copy renames inside a file of this path at all. */
export const templateRenames = (rel) => RENAME_EXTENSIONS.has(path.extname(rel).toLowerCase());

/**
 * A template's title and slug are replaced by the project's name and slug at creation,
 * in the copied text files only (whole word, case-sensitive). Names are escaped for the
 * file type so atelier.json stays valid JSON and HTML stays well-formed.
 * Pure: `rel` only chooses the escaping. Text holding a NUL is left as it is.
 */
export function renameTemplateText(text, rel, from, to) {
  if (text.includes('\u0000')) return text;
  // Title: not inside a longer word. Slug: not inside a longer slug ("game-room-one"),
  // but "quick-notes.backup" or "quick-notes-2026" still count.
  // One pass, so a replacement is never matched again.
  const re = new RegExp(
    `((?<![\\p{L}\\p{N}_])${escapeRegExp(from.title)}(?![\\p{L}\\p{N}_]))|((?<![A-Za-z0-9_-])${escapeRegExp(from.slug)}(?![A-Za-z0-9_]))`,
    'gu'
  );
  const ext = path.extname(rel).toLowerCase();
  const esc = ext === '.html' ? escapeHtml : ext === '.json' || ext === '.js' ? escapeJsString : (s) => s;
  return text.replace(re, (m, title) => (title ? esc(to.title) : to.slug));
}

export async function renameCopiedTemplate(projectPath, from, to) {
  const files = await listFiles(projectPath, { skip: ['.git', 'node_modules', '.studio'] });
  for (const rel of files) {
    if (!templateRenames(rel)) continue;
    const file = path.join(projectPath, rel);
    const text = await fsp.readFile(file, 'utf8');
    const next = renameTemplateText(text, rel, from, to);
    if (next !== text) await fsp.writeFile(file, next);
  }
}

/** Create a project from a template (or a blank one) and take its first checkpoint. */
export async function createProject({ name, kind = 'web-app', template = null, path: customPath = null, purpose = '', inspiration = '' }, deps) {
  if (!name || !String(name).trim()) throw new HttpError(400, 'invalid_input', 'A project name is required');
  const slug = slugify(name);
  const projectPath = path.resolve(customPath || path.join(PROJECTS_DIR, slug));
  if (path.resolve(projectPath) === path.resolve(STUDIO_DIR)) throw new HttpError(400, 'invalid_path', 'The studio folder cannot be a project');
  if (await exists(projectPath)) {
    const existing = await fsp.readdir(projectPath);
    if (existing.length) throw new HttpError(409, 'folder_exists', `Folder already exists and is not empty: ${projectPath}`);
  }
  await ensureDir(projectPath);
  let manifest = null;
  if (template) {
    const src = path.join(TEMPLATES_DIR, template);
    if (!(await exists(src))) throw new HttpError(404, 'template_missing', `Template ${template} not found`);
    await copyDir(src, projectPath, { skip: ['node_modules', '.git', 'selfcheck.mjs'] });
    const templateManifest = await readJson(path.join(src, 'atelier.json'), null);
    if (templateManifest?.name) await renameCopiedTemplate(projectPath, { title: templateManifest.name, slug: slugify(templateManifest.name) }, { title: name, slug });
    manifest = await readJson(path.join(projectPath, 'atelier.json'), null);
    if (manifest) {
      manifest.name = name;
      await writeJson(path.join(projectPath, 'atelier.json'), manifest);
    }
  }
  if (!manifest) {
    manifest = { kind, name, entry: 'src/index.html', build: { type: 'static', dir: 'src', out: 'dist' }, readiness: [] };
    await writeJson(path.join(projectPath, 'atelier.json'), manifest);
    await writeText(
      path.join(projectPath, 'src', 'index.html'),
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${name}</title>\n<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#111;color:#eee}</style>\n</head>\n<body>\n<main><h1>${name}</h1><p>Edit <code>src/index.html</code> to begin.</p></main>\n</body>\n</html>\n`
    );
  }
  const id = newId('p');
  const project = defaultProject({ id, name, slug, kind: manifest.kind || kind });
  project.purpose = purpose;
  project.inspiration = inspiration;
  // projectName: the files carry the name given here, even after the project is renamed.
  if (template) project.template = { name: template, at: nowIso(), projectName: name };
  if (!(await git.isRepo(projectPath))) await git.init(projectPath);
  const templateHasClaudeMd = await exists(path.join(projectPath, 'CLAUDE.md'));
  await ensureExcludes(projectPath, { excludeClaudeMd: !templateHasClaudeMd });
  await writeInitialRecords(projectPath, project);
  const entry = await registerEntry({ id, name, slug, kind: project.kind, projectPath });
  const version = await deps.checkpoint({ path: projectPath, project }, { label: 'Initial version', note: template ? `Created from template ${template}` : 'Blank project', origin: 'studio', state: 'integrated' });
  await deps.regenerate(id);
  return { entry, project, manifest, version };
}

/** Register an existing folder as a project (git init + first checkpoint if needed).
 *  A folder that already has records comes back as itself: everything in its project.json stays, the name and
 *  kind included (the dialog fills Name from the folder, which is no choice by the person), and only missing
 *  fields take defaults. It keeps its id, unless another registered folder holds that id: then it is a copy. */
export async function importProject({ path: folder, name = null, kind = null }, deps) {
  if (!folder) throw new HttpError(400, 'invalid_input', 'A folder path is required');
  const projectPath = path.resolve(folder);
  if (!(await exists(projectPath))) throw new HttpError(404, 'folder_missing', `Folder not found: ${projectPath}`);
  const reg = await loadRegistry();
  const already = reg.projects.find((p) => folderKey(p.path) === folderKey(projectPath));
  if (already) throw Object.assign(new HttpError(409, 'already_registered', `Already in the studio as ${already.name}`), { details: { projectId: already.id, name: already.name } });
  // Past this point no row holds this folder, under any case or through a junction whose target exists, so a row with
  // the stored id is another folder: this one is its copy. Two paths the system does not resolve to one folder still pass.
  const manifest = await readManifest(projectPath);
  const projectName = name || manifest.name || path.basename(projectPath);
  const found = await readJson(studioPath(projectPath, 'project.json'), null);
  const stored = found && typeof found === 'object' && !Array.isArray(found) ? found : null;
  const keepsId = /^p_[a-z0-9]+$/.test(stored?.id) && !reg.projects.some((p) => p.id === stored.id);
  const id = keepsId ? stored.id : newId('p');
  const project = { ...defaultProject({ id, name: projectName, slug: slugify(projectName), kind: kind || manifest.kind || 'web-app' }), ...stored, id };
  if (!(await git.isRepo(projectPath))) await git.init(projectPath);
  const ownsClaudeMd = await exists(path.join(projectPath, 'CLAUDE.md'));
  await ensureExcludes(projectPath, { excludeClaudeMd: !ownsClaudeMd });
  await writeInitialRecords(projectPath, project);
  const entry = await registerEntry({ id, name: project.name, slug: project.slug, kind: project.kind, projectPath, createdAt: project.createdAt });
  const head = await git.headSha(projectPath);
  const known = head ? await deps.versionAtHead(projectPath) : null; // a second record of one commit would say something happened
  let version;
  if (known) {
    version = known;
  } else if (!head) {
    version = await deps.checkpoint({ path: projectPath, project }, { label: 'Imported version', note: 'First checkpoint after import', origin: 'import', state: 'integrated' });
  } else {
    version = await deps.adoptHead({ path: projectPath, project }, { label: 'Imported version', origin: 'import' });
  }
  await deps.regenerate(id);
  return { entry, project, manifest, version };
}

export async function setActive(id) {
  await getEntry(id);
  await updateRegistry((reg) => {
    reg.activeProjectId = id;
    const e = reg.projects.find((p) => p.id === id);
    if (e) e.lastOpenedAt = nowIso();
  });
}

export async function unregisterProject(id) {
  await updateRegistry((reg) => {
    reg.projects = reg.projects.filter((p) => p.id !== id);
    if (reg.activeProjectId === id) reg.activeProjectId = reg.projects[0]?.id || null;
  });
}

/** UTF-8 with no NUL byte: what the Source tab shows as text. A cut buffer may end inside a character, so up to three
 *  trailing bytes are dropped before giving up. Answers the decoded text or null. */
export function textOf(buffer, { cut = false } = {}) {
  if (buffer.includes(0)) return null;
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (let drop = 0; drop <= (cut ? 3 : 0); drop++) {
    try { return dec.decode(buffer.subarray(0, buffer.length - drop)); } catch { /* try a shorter tail */ }
  }
  return null;
}

/** Read a file or list a directory inside the project (capped at 512 KB). A file answer carries text: false when it
 *  is not UTF-8 text (content then is the lossy decode, as before). max (bytes, the Source tab sends 400 KB): a longer
 *  file is answered with its first max bytes and truncated: true instead of the 413. */
export async function readProjectPath(projectPath, rel = '', { max = null } = {}) {
  const target = insideProject(projectPath, rel);
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) throw new HttpError(404, 'not_found', `No such path: ${rel}`);
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return {
      path: rel,
      type: 'dir',
      entries: entries
        .filter((e) => !['.git', '.studio', 'node_modules'].includes(e.name))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)),
    };
  }
  const limit = Number.isInteger(max) && max > 0 ? Math.min(max, 512 * 1024) : null;
  if (limit && stat.size > limit) {
    const fh = await fsp.open(target, 'r');
    try {
      const buf = Buffer.alloc(limit);
      const { bytesRead } = await fh.read(buf, 0, limit, 0);
      const text = textOf(buf.subarray(0, bytesRead), { cut: true });
      return { path: rel, type: 'file', content: text ?? '', text: text !== null, truncated: true, shownBytes: bytesRead, bytes: stat.size };
    } finally { await fh.close(); }
  }
  if (stat.size > 512 * 1024) throw new HttpError(413, 'too_large', 'File is larger than 512 KB');
  const buf = await fsp.readFile(target);
  const text = textOf(buf);
  return { path: rel, type: 'file', content: text ?? buf.toString('utf8'), text: text !== null, bytes: stat.size };
}

export async function writeProjectPath(projectPath, rel, content) {
  if (!rel) throw new HttpError(400, 'invalid_input', 'A file path is required');
  const target = insideProject(projectPath, rel);
  await writeText(target, String(content));
  return { path: rel, bytes: Buffer.byteLength(String(content)) };
}

export async function projectFiles(projectPath) {
  return listFiles(projectPath);
}
