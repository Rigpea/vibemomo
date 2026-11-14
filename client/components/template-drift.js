// Words and the catch-up task for GET /api/projects/:id/template-drift. Pure (no DOM), so tests read them.

const differing = (drift) => drift.files.filter((f) => !f.same && !f.ownValues).map((f) => f.path);

const MANIFEST = 'atelier.json';

/** The part after "Template: name · " as strings and { path } pieces: Focus makes each path a button that opens its diff.
 *  It says what is compared, src/ and the manifest's lists: README and the rest are not, and the tuning file is listed as the project's own. */
export function driftPieces(drift) {
  if (!drift.available) return [drift.reason || 'no longer in the studio'];
  const paths = differing(drift);
  const src = paths.filter((p) => p !== MANIFEST);
  const pieces = [];
  if (!paths.length) pieces.push('src and manifest up to date');
  if (src.length) pieces.push(src.length === 1 ? '1 src file differs: ' : `${src.length} src files differ: `);
  src.forEach((path, i) => pieces.push(...(i ? [', '] : []), { path }));
  if (paths.includes(MANIFEST)) pieces.push(src.length ? ' · manifest differs: ' : 'manifest differs: ', { path: MANIFEST });
  // Plain words, not buttons: such a file counts as the same, so it has no diff to open.
  const endings = drift.files.filter((f) => f.lineEndingsOnly && !f.ownValues).map((f) => f.path);
  if (endings.length) pieces.push(` · ${endings.join(', ')} ${endings.length === 1 ? 'differs' : 'differ'} only by line endings`);
  if (drift.files.some((f) => f.ownValues)) pieces.push(' · tuning values are yours');
  return pieces;
}

export const driftWords = (drift) => driftPieces(drift).map((piece) => piece.path ?? piece).join('');

/** What Set offers a project with no template record: the server refuses any other kind. */
export const templatesOfKind = (templates, kind) => (templates || []).filter((t) => t.kind === kind);

export const catchUpTitle = (name) => `Catch up with the template ${name}`;

/** The createTask body for a catch-up. The session gets the template folder through addDirs. */
export function catchUpTask(drift) {
  const paths = differing(drift);
  const manifest = paths.includes('atelier.json') ? ' For atelier.json: only its cues and readiness lists follow the template; its name and other fields stay the project\'s.' : '';
  return {
    title: catchUpTitle(drift.template),
    mode: 'handle',
    files: paths,
    request: `Catch up with the template ${drift.template}, in the folder ${drift.folder}, which this session can read. These files differ from it: ${paths.join(', ')}. Make each one identical to the template's apart from the project name (the template's name and slug become this project's, as the copy did).${manifest} Keep tuning.js and the project's own values. A file that differs may be the person's own change: read the diff first, and if a file holds work the template does not have, ask with task question instead of overwriting it. Confirm each file with a byte comparison against the template, apart from the project name. Run the template's self-check: copy its selfcheck.mjs into this project's folder, run it with node, then delete the copy.`,
    acceptance: ['Each listed file matches the template apart from the project name, by a byte comparison', 'The project\'s tuning values are unchanged', 'The template\'s selfcheck.mjs passes against this project'],
  };
}
