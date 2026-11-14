// How far a project's files stand from the template it was made from: each file under the template's
// src/ and the template's cues and readiness lists, against the project's, after the same rename the
// copy did. Reads only; nothing here changes a file.
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { slugify, insideProject, isPlainName, HttpError } from './paths.mjs';
import { readJson, exists, listFiles } from './fsutil.mjs';
import { TEMPLATES_DIR, renameTemplateText, templateRenames } from './projects.mjs';
import { diffFiles, cutToBytes } from './git.mjs';

export const DRIFT_NOTE = 'a file that differs may be your own change; read the diff before catching up';
const MAX_DIFF_BYTES = 200 * 1024; // what a version's compare shows too

const readOrNull = (file) => fsp.readFile(file).catch(() => null);
const lf = (s) => s.replace(/\r\n/g, '\n'); // git may check text out with CRLF; that is not a change of the file

/** The names a copied file may carry: the project's now and the one it was created under. */
function renames(templateTitle, project) {
  const from = { title: templateTitle, slug: slugify(templateTitle) };
  return [...new Set([project.name, project.template.projectName || project.name])].map((title) => ({ from, to: { title, slug: project.slug } }));
}

const isText = (buffer) => {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
};

/** { same, lineEndingsOnly? }. Text compares apart from its line endings, whatever its extension; other files by bytes. */
function compareFile(rel, ours, theirs, names) {
  if (!ours) return { same: false };
  if (!isText(ours) || !isText(theirs)) return { same: ours.equals(theirs) };
  const text = ours.toString('utf8');
  const source = theirs.toString('utf8');
  const sources = templateRenames(rel) && names.length ? names.map(({ from, to }) => renameTemplateText(source, rel, from, to)) : [source];
  if (sources.includes(text)) return { same: true };
  return sources.some((s) => lf(s) === lf(text)) ? { same: true, lineEndingsOnly: true } : { same: false };
}

/** atelier.json counts only for its cues and readiness lists: its name and the rest are the project's. */
const manifestLists = (m) => ({ cues: m?.cues ?? [], readiness: m?.readiness ?? [] });

function manifestEntry(templateManifest, projectManifest, names) {
  const theirs = JSON.stringify(manifestLists(templateManifest));
  const same = !!projectManifest && (names.length
    ? names.some(({ from, to }) => isDeepStrictEqual(JSON.parse(renameTemplateText(theirs, 'atelier.json', from, to)), manifestLists(projectManifest)))
    : isDeepStrictEqual(JSON.parse(theirs), manifestLists(projectManifest)));
  return { path: 'atelier.json', same, projectHas: !!projectManifest };
}

/**
 * { template, folder, available, reason?, files: [{path, same, projectHas, ownValues?, lineEndingsOnly?}], behind, note }.
 * A file with lineEndingsOnly is same, and has no diff to show. template is null when the record names none; reason says a record's name cannot be a template's. The manifest's tuning file holds the project's own
 * values: it is listed with ownValues and never counts as behind, because a catch-up keeps it.
 */
export async function templateDrift({ path: projectPath, project }, { templatesDir = TEMPLATES_DIR } = {}) {
  const name = project.template?.name;
  if (!name) return { template: null, folder: null, available: false, files: [], behind: 0, note: DRIFT_NOTE };
  // The record is a file a person can edit: a name must stay one folder under templates/. templates/.. is the studio, which has an atelier.json of its own.
  if (!isPlainName(name)) return { template: name, folder: null, available: false, reason: 'not a template name', files: [], behind: 0, note: DRIFT_NOTE };
  const folder = path.join(templatesDir, name);
  if (!(await exists(path.join(folder, 'atelier.json')))) return { template: name, folder: null, available: false, files: [], behind: 0, note: DRIFT_NOTE };

  const templateManifest = await readJson(path.join(folder, 'atelier.json'), null);
  const projectManifest = await readJson(insideProject(projectPath, 'atelier.json'), null).catch(() => null);
  const names = templateManifest?.name ? renames(templateManifest.name, project) : [];
  const srcDir = path.join(folder, 'src');
  const rels = (await exists(srcDir)) ? (await listFiles(srcDir)).map((r) => `src/${r}`) : [];
  const files = [];
  for (const rel of rels) {
    const ours = await readOrNull(insideProject(projectPath, rel));
    const theirs = await fsp.readFile(path.join(folder, rel));
    const { same, lineEndingsOnly } = compareFile(rel, ours, theirs, names);
    const entry = { path: rel, same, projectHas: !!ours };
    if (lineEndingsOnly) entry.lineEndingsOnly = true;
    if (rel === templateManifest?.tuning) entry.ownValues = true;
    files.push(entry);
  }
  files.push(manifestEntry(templateManifest, projectManifest, names));
  return { template: name, folder, available: true, files, behind: files.filter((f) => !f.same && !f.ownValues).length, note: DRIFT_NOTE };
}

/** The hunks of one unified diff; the headers git writes name its temp files, not these. */
async function hunks(ours, theirs) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-drift-'));
  try {
    await fsp.writeFile(path.join(dir, 'template'), theirs);
    await fsp.writeFile(path.join(dir, 'project'), ours);
    const out = await diffFiles(dir, 'template', 'project');
    const at = out.indexOf('\n@@ ');
    return at < 0 ? '' : out.slice(at + 1);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The text a file is compared as, once per name it may carry: compared the way compareFile compares it, so a diff never shows what the line does not count. */
async function comparedTexts(rel, ours, theirs, names) {
  if (!isText(theirs) || (ours && !isText(ours))) throw new HttpError(400, 'not_text', `${rel} is not a text file, so it has no diff to show`);
  const source = theirs.toString('utf8');
  const text = ours ? lf(ours.toString('utf8')) : '';
  if (!templateRenames(rel) || !names.length) return [{ ours: text, theirs: lf(source) }];
  return names.map(({ from, to }) => ({ ours: text, theirs: lf(renameTemplateText(source, rel, from, to)) }));
}

/** Only the two lists count for atelier.json, so only they are diffed: the project's name and other fields would read as differences the line does not count. */
function comparedManifests(templateManifest, projectManifest, names) {
  const pretty = (lists) => `${JSON.stringify(lists, null, 2)}\n`;
  const ours = projectManifest ? pretty(manifestLists(projectManifest)) : '';
  const theirs = JSON.stringify(manifestLists(templateManifest));
  if (!names.length) return [{ ours, theirs: pretty(JSON.parse(theirs)) }];
  return names.map(({ from, to }) => ({ ours, theirs: pretty(JSON.parse(renameTemplateText(theirs, 'atelier.json', from, to))) }));
}

/**
 * { path, diff, truncated, note? }: the unified diff from the template's file, after the copy's rename, to the project's.
 * Only a path the drift counts as differing has one, which also keeps the path inside src/ or the manifest and leaves out the tuning file.
 */
export async function templateDriftDiff({ path: projectPath, project }, rel, { templatesDir = TEMPLATES_DIR, maxDiffBytes = MAX_DIFF_BYTES } = {}) {
  const drift = await templateDrift({ path: projectPath, project }, { templatesDir });
  const entry = drift.files.find((f) => f.path === rel && !f.same && !f.ownValues);
  if (!entry) throw new HttpError(400, 'not_in_drift', `${rel || 'That path'} is not a file that differs from the template`);
  const templateManifest = await readJson(path.join(drift.folder, 'atelier.json'), null);
  const names = templateManifest?.name ? renames(templateManifest.name, project) : [];
  const isManifest = rel === 'atelier.json';
  const texts = isManifest
    ? comparedManifests(templateManifest, await readJson(insideProject(projectPath, rel), null).catch(() => null), names)
    : await comparedTexts(rel, await readOrNull(insideProject(projectPath, rel)), await fsp.readFile(path.join(drift.folder, rel)), names);
  // A project may carry the name it has now or the one it was created under: the smaller diff is the one it was copied with.
  const all = await Promise.all(texts.map((t) => hunks(t.ours, t.theirs)));
  const body = all.reduce((best, d) => (d.length < best.length ? d : best));
  const label = isManifest ? `${rel} (cues and readiness lists)` : rel;
  const diff = `--- template/${label}\n+++ ${entry.projectHas ? `project/${label}` : '/dev/null'}\n${body}`;
  const truncated = Buffer.byteLength(diff) > maxDiffBytes;
  return {
    path: rel,
    diff: truncated ? cutToBytes(diff, maxDiffBytes) : diff,
    truncated,
    ...(isManifest ? { note: 'Only the cues and readiness lists are compared; the name and other fields are the project\'s.' } : {}),
  };
}
