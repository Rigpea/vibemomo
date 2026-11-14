// Build / export: produce a real artifact (unpacked folder + zip) for the
// version at HEAD. Workbenches can override `build()`; the default copies the
// static source directory from the manifest.
import path from 'node:path';
import fsp from 'node:fs/promises';
import { zipSync } from 'fflate';
import { STUDIO_DIR, HttpError, nowIso, localDateTime } from './paths.mjs';
import { ensureDir, copyDir, listFiles, sha256File, rmrf, writeText, exists } from './fsutil.mjs';
import { stores } from './projects.mjs';
import { versionAtHead, changes, getVersion, listVersions } from './versions.mjs';
import { getTask } from './tasks.mjs';
import * as git from './git.mjs';
import { MAX_NOTES_BYTES, RELEASE_NOTES_FILE, notesBytes, lastReleased, fileName, releaseDate } from '../../client/components/release-notes.js';

async function loadWorkbench(kind) {
  const file = path.join(STUDIO_DIR, 'workbenches', kind, 'server.mjs');
  if (!(await exists(file))) return null;
  const mod = await import(`file://${file.replace(/\\/g, '/')}`);
  return mod.default || mod;
}

/** The default build: copy the manifest's source directory into outDir. Workbenches may reuse it. */
export async function staticCopy({ projectPath, manifest, outDir }) {
  const srcDir = path.join(projectPath, manifest.build?.dir || 'src');
  if (!(await exists(srcDir))) throw new HttpError(400, 'no_source_dir', `Source directory missing: ${manifest.build?.dir || 'src'}`);
  await copyDir(srcDir, outDir);
}

/** The count as it stands in the project's records (project.ui.readiness, ticked by the person). */
function readinessSummary(project, manifest) {
  const items = manifest.readiness || [];
  if (!items.length) return 'No readiness checklist at export';
  const ticked = project.ui?.readiness || {};
  return `Readiness at export: ${items.filter((text) => ticked[text]).length} of ${items.length} items met`;
}

/** Notes as typed; only whitespace counts as none. Refused before the build touches the last export. */
function checkNotes(notes) {
  if (typeof notes !== 'string') throw new HttpError(400, 'invalid_input', 'Release notes must be text');
  if (notesBytes(notes) > MAX_NOTES_BYTES) throw new HttpError(400, 'invalid_input', `Release notes are over the ${MAX_NOTES_BYTES / 1024} KB limit`);
  return notes.trim() ? notes : '';
}

const draftLine = ({ id, n, label, note }) => ({ id, n, label, note });

/**
 * Two versions of one explore task that git cannot be asked about: a session that edited the files back
 * and checkpointed again left its options in one line of commits, one an "ancestor" of the next, and
 * those versions have no role. What the finish kept is never an option. Once both have a role the options
 * branched for real, so git's answer is the true one: siblings when neither descends from the other,
 * and one built on the other when it does.
 */
async function optionsOfOneTask(projectPath, a, b) {
  if (!a.taskId || a.taskId !== b.taskId || a.sha === b.sha) return false;
  if (a.role === 'finish' || b.role === 'finish' || (a.role && b.role)) return false;
  const record = await getTask(projectPath, a.taskId).catch(() => null);
  return record?.task?.mode === 'explore';
}

/**
 * What the release notes draft of a version is made from: the versions that are its ancestors and not
 * the last release's, oldest first. Commits with no version record are not listed. A second record of
 * the released commit counts as released: an export of it holds the same files. sibling: neither commit
 * descends from the other, so the list runs back to their merge base and is not "newer than" the release.
 * The release and the version being linear options of one explore task also makes them siblings: the
 * list is then that option alone, because what came before it in the line may be an option it undid.
 */
export async function releaseNotesDraftData({ path: projectPath }, versionId) {
  if (!versionId) throw new HttpError(400, 'invalid_input', 'A version id is required');
  const version = await getVersion(projectPath, versionId);
  const all = await listVersions(projectPath);
  const releases = await stores(projectPath).releases.all();
  const since = lastReleased(releases, all);
  const commits = new Set(await git.revList(projectPath, since?.sha, version.sha));
  let releasedAs = null;
  if (since?.sha === version.sha) {
    const release = releases.findLast((r) => r.versionId === since.id);
    releasedAs = { zip: fileName(release.artifact?.path || ''), date: releaseDate(release) };
  }
  const options = !!since && await optionsOfOneTask(projectPath, since, version);
  const sibling = options || (!!since && !(await git.isAncestor(projectPath, since.sha, version.sha)) && !(await git.isAncestor(projectPath, version.sha, since.sha)));
  return {
    versions: (options ? [version] : all.filter((v) => commits.has(v.sha)).sort((a, b) => a.n - b.n)).map(draftLine),
    since: since ? draftLine(since) : null,
    earlierRelease: !since && releases.length > 0,
    releasedAs,
    sibling,
  };
}

export async function buildProject(ctx, { notes: typed = '' } = {}) {
  const { path: projectPath, project, manifest } = ctx;
  const notes = checkNotes(typed);
  const tree = await changes(projectPath);
  if (tree.dirty) throw new HttpError(409, 'uncommitted_changes', 'Keep a version before building so the artifact matches a checkpoint');
  const version = await versionAtHead(projectPath);
  if (!version) throw new HttpError(409, 'no_version', 'No version to build');
  const outRoot = path.join(projectPath, manifest.build?.out || 'dist');
  const name = `${project.slug}-v${version.n}`;
  const outDir = path.join(outRoot, name);
  await rmrf(outDir);
  await ensureDir(outDir);
  const workbench = await loadWorkbench(manifest.kind);
  let built;
  if (workbench?.build) {
    built = await workbench.build({ projectPath, project, manifest, version, outDir });
  } else {
    await staticCopy({ projectPath, manifest, outDir });
    built = { note: 'static copy' };
  }
  const builtAt = nowIso();
  const builtLocal = localDateTime(builtAt);
  await writeText(
    path.join(outDir, 'VERSION.txt'),
    `${project.name}\nversion #${version.n} ${version.label}\ncommit ${version.sha}\nbuilt ${builtAt} by Atelier\n`
  );
  if (notes) {
    await writeText(
      path.join(outDir, RELEASE_NOTES_FILE),
      `# ${project.name}: #${version.n} ${version.label}\n\n${notes}\n\n${builtLocal} · ${version.sha}\n`
    );
  }
  const files = await listFiles(outDir, { skip: [] });
  const zipInput = {};
  for (const f of files) zipInput[`${name}/${f}`] = new Uint8Array(await fsp.readFile(path.join(outDir, f)));
  const zipped = zipSync(zipInput, { level: 6 });
  const zipPath = path.join(outRoot, `${name}.zip`);
  await fsp.writeFile(zipPath, zipped);
  const stat = await fsp.stat(zipPath);
  const sha256 = await sha256File(zipPath);
  const readiness = { items: (manifest.readiness || []).map((text) => ({ text, met: null, evidence: '' })) };
  const release = await stores(projectPath).releases.add({
    createdAt: builtAt,
    builtLocal,
    versionId: version.id,
    artifact: { path: zipPath, unpacked: outDir, sha256, bytes: stat.size, files: files.length },
    readiness,
    notes,
    readinessSummary: readinessSummary(project, manifest),
    workbench: built,
  });
  await stores(projectPath).history.append('build', { releaseId: release.id, versionId: version.id, sha256 });
  return { release, artifact: release.artifact, versionId: version.id };
}
