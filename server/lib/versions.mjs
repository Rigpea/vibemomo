// Versions = git commits tagged atelier/<id>, described in .studio/versions.json.
import { newId, nowIso, HttpError } from './paths.mjs';
import { readJson, writeJson } from './fsutil.mjs';
import * as git from './git.mjs';
import { studioPath, stores } from './projects.mjs';

export const STATES = ['experiment', 'integrated', 'selected', 'user-tested', 'released', 'recheck'];
/** What a version is to its task: an option of an explore task, or what the finish itself kept. A record without one predates the field. */
export const ROLES = ['option', 'finish'];

export async function listVersions(projectPath) {
  return readJson(studioPath(projectPath, 'versions.json'), []);
}

async function saveVersions(projectPath, versions) {
  await writeJson(studioPath(projectPath, 'versions.json'), versions);
}

export async function getVersion(projectPath, vid) {
  const versions = await listVersions(projectPath);
  const v = versions.find((x) => x.id === vid);
  if (!v) throw new HttpError(404, 'not_found', `Version ${vid} not found`);
  return v;
}

export async function versionAtHead(projectPath) {
  const head = await git.headSha(projectPath);
  if (!head) return null;
  const versions = await listVersions(projectPath);
  return versions.filter((v) => v.sha === head).sort((a, b) => b.n - a.n)[0] || null;
}

/** Working-tree changes relative to the last checkpoint. */
export async function changes(projectPath) {
  const files = await git.status(projectPath);
  const current = await versionAtHead(projectPath);
  return { dirty: files.length > 0, files, sinceVersionId: current?.id || null, headSha: await git.headSha(projectPath) };
}

/** Commit the working tree as a new version. 409 when nothing changed since the last version. */
export async function checkpoint({ path: projectPath, project }, { label, note = '', state = 'experiment', origin = 'user', taskId = null, role = null, baseSha = null, pieceTitle = null, force = false } = {}) {
  if (!label || !String(label).trim()) throw new HttpError(400, 'invalid_input', 'A version label is required');
  if (!STATES.includes(state)) throw new HttpError(400, 'invalid_input', `Unknown state ${state}`);
  if (role !== null && !ROLES.includes(role)) throw new HttpError(400, 'invalid_input', `Unknown role ${role}`);
  const files = await git.status(projectPath);
  const existing = await versionAtHead(projectPath);
  if (!files.length && existing && !force) {
    throw Object.assign(new HttpError(409, 'nothing_changed', 'Nothing changed since the last version'), { existing });
  }
  const versions = await listVersions(projectPath);
  const parent = existing || versions[versions.length - 1] || null;
  const sha = await git.commitAll(projectPath, `[atelier] ${label}`);
  const id = newId('v');
  await git.tag(projectPath, `atelier/${id}`, sha, label);
  const version = {
    id,
    n: versions.length + 1,
    sha,
    label: String(label).trim(),
    note,
    state,
    origin,
    parentId: parent?.id || null,
    pieceTitle: pieceTitle ?? project?.currentPiece?.title ?? '',
    taskId,
    ...(role ? { role } : {}),
    ...(baseSha ? { baseSha } : {}), // the task's base when this was made: a reopen can move the task's on
    userPreferred: false,
    verified: null,
    userEvidence: [],
    filesChanged: files.map((f) => f.path),
    createdAt: nowIso(),
  };
  versions.push(version);
  await saveVersions(projectPath, versions);
  await stores(projectPath).history.append('checkpoint', { versionId: id, sha, label, origin });
  return version;
}

/** Record the current HEAD commit of an imported repo as a version without committing. */
export async function adoptHead({ path: projectPath, project }, { label, origin = 'import', note = 'Adopted existing commit', state = 'integrated', taskId = null, role = null, baseSha = null, filesChanged = [] }) {
  const sha = await git.headSha(projectPath);
  const versions = await listVersions(projectPath);
  const id = newId('v');
  await git.tag(projectPath, `atelier/${id}`, sha, label);
  const version = {
    id, n: versions.length + 1, sha, label, note, state, origin,
    parentId: versions[versions.length - 1]?.id || null, pieceTitle: project?.currentPiece?.title || '', taskId,
    ...(role ? { role } : {}),
    ...(baseSha ? { baseSha } : {}),
    userPreferred: false, verified: null, userEvidence: [], filesChanged, createdAt: nowIso(),
  };
  versions.push(version);
  await saveVersions(projectPath, versions);
  if (taskId) await stores(projectPath).history.append('checkpoint', { versionId: id, sha, label, origin });
  return version;
}

const PATCHABLE = ['state', 'userPreferred', 'note', 'verified', 'label', 'userEvidence'];
export async function patchVersion(projectPath, vid, partial) {
  const versions = await listVersions(projectPath);
  const idx = versions.findIndex((v) => v.id === vid);
  if (idx < 0) throw new HttpError(404, 'not_found', `Version ${vid} not found`);
  for (const key of Object.keys(partial)) {
    if (!PATCHABLE.includes(key)) throw new HttpError(400, 'invalid_field', `Cannot patch ${key}`);
    if (key === 'state' && !STATES.includes(partial.state)) throw new HttpError(400, 'invalid_input', `Unknown state ${partial.state}`);
    if (key === 'verified' && partial.verified) partial.verified = { at: nowIso(), ...partial.verified };
    versions[idx][key] = partial[key];
  }
  const now = nowIso();
  versions[idx].updatedAt = now;
  // The star is the one version you would ship today, so there is one per project.
  if (partial.userPreferred) {
    for (const v of versions) {
      if (v.id !== vid && v.userPreferred) { v.userPreferred = false; v.updatedAt = now; }
    }
  }
  await saveVersions(projectPath, versions);
  return versions[idx];
}

/** Restore the working tree to a version. A safety checkpoint keeps a way back. A version whose commit
 *  is gone, or whose record names none, is refused first: the safety copy would be written and the reset would then fail. */
export async function restore({ path: projectPath, project }, vid) {
  const target = await getVersion(projectPath, vid);
  if (!target.sha) throw new HttpError(409, 'commit_gone', `#${target.n} ${target.label}: its record names no commit`);
  if (!(await git.commitExists(projectPath, target.sha))) {
    throw new HttpError(409, 'commit_gone', `#${target.n} ${target.label}: its commit ${target.sha.slice(0, 7)} is not in this repository`);
  }
  const files = await git.status(projectPath);
  let safety = null;
  if (files.length) {
    safety = await checkpoint({ path: projectPath, project }, {
      label: `Safety copy before restoring to #${target.n}`,
      note: 'Automatic safety version taken before a restore',
      origin: 'restore-safety',
      state: 'experiment',
    });
  }
  await git.resetHard(projectPath, target.sha);
  const current = await versionAtHead(projectPath);
  await stores(projectPath).history.append('restore', { toVersionId: target.id, safetyVersionId: safety?.id || null });
  return { restoredTo: target, safetyVersionId: safety?.id || null, current };
}

export async function compare({ path: projectPath }, aId, bId) {
  const a = await getVersion(projectPath, aId);
  let b = null;
  let bRef = 'head';
  if (bId && bId !== 'head') {
    b = await getVersion(projectPath, bId);
    bRef = b.sha;
  }
  const summary = await git.diffSummary(projectPath, a.sha, bRef);
  return { a, b: b || { id: 'head', label: 'Working tree', sha: await git.headSha(projectPath) }, ...summary };
}
