// Version actions: Keep version, Compare, Restore, Build/Export (dialogs over real git state).
import { el, clear, button, dialog, input, textarea, select, field, toast, toastError, loading, bytes, copyText, shortLabel } from './ui.js';
import { compareDefaults } from './compare-defaults.js';
import { unsavedTuningNote } from './tuning-note.js';
import { endSentence, readinessSentence, rendersBeforeBuild, rendersAfterBuild, previewedElsewhere, previewExportSentence } from './words.js';
import { releaseNotesDraft, releaseDate, notesBytes, notesSummary, MAX_NOTES_BYTES, RELEASE_NOTES_FILE } from './release-notes.js';

export const STATES = ['experiment', 'integrated', 'selected', 'user-tested', 'released', 'recheck'];
// Records keep the ids above; people see these labels and one-line meanings.
export const STATE_INFO = {
  experiment: { label: 'experiment', meaning: 'trying something' },
  selected: { label: 'kept', meaning: 'worth keeping' },
  integrated: { label: 'integrated', meaning: 'part of the main line' },
  'user-tested': { label: 'user-tested', meaning: 'other people have tried it' },
  released: { label: 'released', meaning: 'given to people' },
  recheck: { label: 'recheck', meaning: 'needs another look' },
};
export const stateLabel = (id) => STATE_INFO[id]?.label || id;
export const stateMeaning = (id) => STATE_INFO[id]?.meaning || '';
export const PREFERRED_MEANING = 'Preferred: the version you would ship today';

/** A state select: options show labels, the title (and an optional hint node) the chosen state's meaning. */
export function stateSelect(value, props = {}, hint = null) {
  const s = select(STATES.map((id) => [id, stateLabel(id)]), value, props);
  const sync = () => {
    s.title = `${stateLabel(s.value)}: ${stateMeaning(s.value)}`;
    if (hint) hint.textContent = `${stateLabel(s.value)}: ${stateMeaning(s.value)}.`;
  };
  s.addEventListener('change', sync);
  sync();
  return s;
}

/** "#n label" with long labels cut at a word boundary; fullName keeps the whole label (tooltips). */
export const vname = (v) => (v ? `#${v.n} ${shortLabel(v.label, 64)}` : '—');
export const fullName = (v) => (v ? `#${v.n} ${v.label}${v.note && v.note !== v.label ? `\n${v.note}` : ''}` : '—');
export const currentVersion = (b) => b?.versions?.find((v) => v.id === b.changes?.sinceVersionId) || null;

/** Keep version dialog. Resolves with the created version or undefined. */
export function keepDialog(app, { label = '' } = {}) {
  const b = app.state.bundle;
  if (!b) return; // a project is still loading: k must not open a form for a project nobody can see yet
  const cur = currentVersion(b);
  const files = b?.changes?.files || [];
  // A draft lives in the project's ui, not on disk, so a version would not include it. app.tuningApplied: panel.js.
  const tuningNote = unsavedTuningNote(b, { applied: app.tuningApplied === app.projectId() });
  // Nothing changed on disk: the server would refuse an identical version, so explain and send nothing.
  if (cur && !files.length) {
    const d = dialog({
      title: 'Keep version',
      body: tuningNote ? el('p', tuningNote) : el('div',
        el('p', endSentence(`Nothing changed on disk since ${vname(cur)}`)),
        el('p.small.muted', 'Notes or data typed into the preview live in the browser, not in files, so they are not part of a version or an export.')),
      actions: [{ label: 'Close' }, { label: 'Keep version', variant: 'primary', run: () => {} }],
    });
    const confirm = d.node.querySelector('.dialog-actions .btn.primary');
    if (confirm) { confirm.disabled = true; confirm.title = `Nothing to keep: the files match ${vname(cur)}`; }
    d.node.querySelector('.dialog-actions .btn')?.focus();
    return d.done;
  }
  const lbl = input({ value: label, placeholder: 'e.g. Higher jump', maxLength: 120, required: true });
  const note = textarea({ rows: 2, placeholder: 'What changed and why (optional)' });
  const meaning = el('span');
  const st = stateSelect('experiment', {}, meaning);
  const msg = el('div');
  const summary = files.length
    ? el('p.small.muted', `${files.length} file${files.length > 1 ? 's' : ''} changed on disk since ${cur ? vname(cur) : 'the last version'}: ${files.slice(0, 6).map((f) => f.path).join(', ')}${files.length > 6 ? '…' : ''}`)
    : null;
  const stateHint = el('span', meaning, ' The star in Versions is separate: it marks the version you would ship today.');
  return dialog({
    title: 'Keep version',
    body: el('form', { onsubmit: (e) => e.preventDefault() }, summary, tuningNote ? el('p.note', tuningNote) : null, field('Label', lbl), field('Note', note), field('State', st, stateHint), msg),
    actions: [
      { label: 'Cancel' },
      { label: 'Keep version', variant: 'primary', icon: 'bookmark', run: async (close) => {
        if (!lbl.value.trim()) { lbl.focus(); return; }
        try {
          const v = await app.api.keepVersion(app.projectId(), { label: lbl.value.trim(), note: note.value.trim(), state: st.value });
          close(v);
          toast(`Kept ${vname(v)}`, { tone: 'ok' });
          app.loadBundle({ quiet: true });
        } catch (err) {
          clear(msg, el('p.note.danger', err.code === 'nothing_changed' ? endSentence(`Nothing changed on disk since ${vname(err.existing) || 'the last version'}`) : err.message));
        }
      } },
    ],
  }).done;
}

// ---------- compare ----------
function versionOptions(b, withHead) {
  const opts = [...(b.versions || [])].reverse().map((v) => [v.id, `${vname(v)}${v.id === b.changes?.sinceVersionId ? ' (current)' : ''}`]);
  if (withHead) opts.unshift(['head', `Working tree${b.changes?.dirty ? ` (${b.changes.files.length} changed)` : ''}`]);
  return opts;
}

/** A git diff as people read it: each file is a plain name row, git's own header lines
 *  (index, ---/+++, new/deleted file, mode, rename) are hidden, hunk headers are muted. */
export function renderDiff(text) {
  const box = el('div.diff', { role: 'region', 'aria-label': 'Diff', tabIndex: 0 });
  if (!text) { box.append(el('div', 'No textual differences.')); return box; }
  let header = false; // between "diff --git" and the first hunk
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      header = true;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const name = m ? (m[1] === m[2] ? m[2] : `${m[1]} → ${m[2]}`) : line.slice(11);
      box.append(el('div.file', { title: line }, name));
      continue;
    }
    if (line.startsWith('@@')) { header = false; box.append(el('div.hunk', line.replace(/^(@@[^@]*@@).*$/, '$1'))); continue; }
    if (header) {
      if (/^Binary files /.test(line)) box.append(el('div.hunk', 'Binary file changed'));
      continue; // index, ---/+++, new file mode, deleted file mode, similarity, rename
    }
    if (line.startsWith('\\ No newline')) { box.append(el('div.hunk', 'no newline at end of file')); continue; }
    const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
    box.append(el(cls ? `div.${cls}` : 'div', line || ' '));
  }
  markChanges(box);
  return box;
}

/** Changed pairs: a run of removed lines directly followed by a run of added lines is paired
 *  line by line, and inside each pair the part that differs (common prefix and suffix trimmed,
 *  widened to whole words) is wrapped in span.chg. Unpaired lines stay as they are. */
function markChanges(box) {
  const rows = [...box.children];
  const is = (i, cls) => rows[i]?.className === cls;
  for (let i = 0; i < rows.length;) {
    let d = i; while (is(d, 'del')) d++;
    let a = d; while (is(a, 'add')) a++;
    for (let k = 0; k < Math.min(d - i, a - d); k++) markPair(rows[i + k], rows[d + k]);
    i = Math.max(a, i + 1);
  }
}

function markPair(x, y) {
  const a = x.textContent, b = y.textContent;
  const n = Math.min(a.length, b.length);
  let p = 1; // after the +/- sign
  while (p < n && a[p] === b[p]) p++;
  let s = 0;
  while (s < n - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const word = (c) => c !== undefined && /\w/.test(c);
  // Widen to whole words only where the change itself starts or ends inside a word.
  while (p > 1 && word(a[p - 1]) && (word(a[p]) || word(b[p]))) p--;
  while (s > 0 && word(a[a.length - s]) && (word(a[a.length - s - 1]) || word(b[b.length - s - 1]))) s--;
  if (p <= 1 && s === 0) return; // nothing in common: the whole line is the change
  for (const [node, t] of [[x, a], [y, b]]) {
    const mid = t.slice(p, t.length - s);
    if (mid) clear(node, t.slice(0, p), el('span.chg', mid), t.slice(t.length - s));
  }
}

export function compareDialog(app, { a, b: bRef } = {}) {
  const b = app.state.bundle;
  if (!b?.versions?.length) { toast('No versions to compare yet'); return; }
  const cur = currentVersion(b) || b.versions[b.versions.length - 1];
  const prev = b.versions.find((v) => v.n === cur.n - 1);
  const def = compareDefaults({ cur, prev, dirty: b.changes?.dirty, a, b: bRef });
  const selA = select(versionOptions(b, false), def.a, { 'aria-label': 'From version' });
  const selB = select(versionOptions(b, true), def.b, { 'aria-label': 'To version' });
  const out = el('div', { style: { marginTop: '12px' } });
  const run = async () => {
    clear(out, loading('Comparing…'));
    try {
      const r = await app.api.compare(app.projectId(), selA.value, selB.value);
      const files = r.files || [];
      const diff = renderDiff(r.diff);
      requestAnimationFrame(() => {
        const m = diff.querySelector('.chg');
        const box = diff.getBoundingClientRect();
        if (m && m.getBoundingClientRect().right > box.right - 24) diff.scrollLeft += m.getBoundingClientRect().left - box.left - 120;
      });
      clear(out,
        el('p.small.muted', `${vname(r.a)} → ${r.b.id === 'head' ? 'working tree' : vname(r.b)} · ${files.length} file${files.length === 1 ? '' : 's'}`),
        files.length ? el('ul.diff-files', files.map((f) => el('li', el('span.tag', f.status), el('span.mono', { style: { flex: 1 } }, f.path),
          el('span.plus.mono', f.additions === null ? 'bin' : `+${f.additions}`), el('span.minus.mono', f.deletions === null ? '' : `−${f.deletions}`)))) : null,
        diff,
        r.truncated ? el('p.note.warn', 'Diff truncated at 200 KB.') : null);
    } catch (err) { clear(out, el('p.note.danger', err.message)); }
  };
  selA.addEventListener('change', run);
  selB.addEventListener('change', run);
  run();
  dialog({
    title: 'Compare versions',
    wide: true,
    body: el('div', el('div.row.wrap', el('label.small.muted', 'From'), el('div', { style: { minWidth: '240px' } }, selA), el('label.small.muted', 'to'), el('div', { style: { minWidth: '240px' } }, selB)), out),
    actions: [
      { label: 'Side by side', icon: 'compare', run: async (close) => {
        close();
        const { sideBySide } = await import('./compare-side.js');
        sideBySide(app, { a: selA.value, b: selB.value });
      } },
      { label: 'Close', variant: 'primary' },
    ],
  });
}

/** Two live previews next to each other with mirrored input (see compare-side.js). */
export async function sideBySideCompare(app, opts) {
  const { sideBySide } = await import('./compare-side.js');
  return sideBySide(app, opts);
}

// ---------- restore ----------
export function restoreDialog(app, { versionId } = {}) {
  const b = app.state.bundle;
  if (!b?.versions?.length) return toast('No versions to restore');
  const cur = currentVersion(b);
  const sel = select(versionOptions(b, false), versionId || [...b.versions].reverse().find((v) => v.id !== cur?.id)?.id || cur?.id);
  const dirty = b.changes?.dirty;
  const explain = el('div');
  const update = () => {
    const target = b.versions.find((v) => v.id === sel.value);
    const n = b.changes?.files?.length || 0;
    const since = cur ? `since ${vname(cur)}` : 'since the last version';
    clear(explain,
      el('p', `${endSentence(`The project's files on disk become those of ${vname(target)}`)} The preview, builds and Claude Code will see that version.`),
      dirty
        ? el('p.note', `You have ${n} change${n > 1 ? 's' : ''} on disk ${since} that ${n > 1 ? 'are' : 'is'} not kept as a version. A safety version “Safety copy before restoring to #${target?.n}” is kept first, so nothing is lost.`)
        : el('p.note', `Everything on disk is already kept as a version, so no safety copy is needed. Every kept version stays available to restore later.`));
  };
  sel.addEventListener('change', update);
  update();
  return dialog({
    title: 'Restore a version',
    body: el('div', field('Version', sel), explain),
    actions: [
      { label: 'Cancel' },
      { label: 'Restore', variant: 'primary', icon: 'restore', run: async (close) => {
        try {
          const out = await app.api.restore(app.projectId(), sel.value);
          close(out);
          await afterRestore(app, out);
        } catch (err) { toastError(err, 'Restore'); }
      } },
    ],
  }).done;
}

async function afterRestore(app, out) {
  await app.loadBundle({ quiet: true });
  const safety = out.safetyVersionId && app.state.bundle.versions.find((v) => v.id === out.safetyVersionId);
  toast(`Restored to ${vname(out.restoredTo)}${safety ? ` · safety version ${vname(safety)} kept` : ''}`, { tone: 'ok', timeout: 6000 });
  app.workbench?.tryHead();
}

/** The export dialog's button while another version is previewed. The server keeps its safety-copy rule. */
async function restoreAndExport(app, v) {
  const progress = dialog({ title: 'Build / Export', body: loading(`Restoring ${vname(v)}…`) });
  try {
    const out = await app.api.restore(app.projectId(), v.id);
    progress.close();
    await afterRestore(app, out);
  } catch (err) {
    progress.close();
    toastError(err, 'Restore');
    return;
  }
  // A failed quiet reload leaves the old bundle: the dialog would name the version the files have just left.
  if (currentVersion(app.state.bundle)?.sha !== v.sha) { toast(`Restored ${vname(v)}, but the project could not be reloaded. Press Build/Export again.`, { tone: 'warn' }); return; }
  return buildFlow(app);
}

// ---------- build / export ----------
/** The readiness checklist as the person ticked it (manifest.readiness + project.ui.readiness). */
export function readinessState(b) {
  const items = b?.manifest?.readiness || [];
  const ticked = b?.project?.ui?.readiness || {};
  const list = items.map((text) => ({ text, met: !!ticked[text] }));
  return { items: list, met: list.filter((i) => i.met).length, total: list.length };
}

/** Build/Export: first show the readiness checklist and its state, then build on confirm. */
export async function buildFlow(app) {
  const b = app.state.bundle;
  if (!b) return;
  const cur = currentVersion(b);
  if (b.changes?.dirty || !cur) return keepFirst(app);
  const r = readinessState(b);
  const unmet = r.total - r.met;
  const kind = b.manifest?.kind;
  const renders = rendersBeforeBuild(kind);
  const drafted = app.api.releaseNotesDraft(app.projectId(), cur.id); // asked first; the dialog opens on "Drafting…"
  const notes = textarea({ rows: 8, placeholder: 'Drafting…', readOnly: true });
  const notesMsg = el('div');
  const previewed = previewedElsewhere(b, app.workbench?.previewRef?.());
  const body = el('div',
    previewed ? el('div.note.warn',
      el('p', previewExportSentence(vname(previewed), vname(cur))),
      button(`Restore #${previewed.n} and export it`, { small: true, title: `Puts #${previewed.n} back on disk, then opens this dialog again with its own release notes. Notes typed here are not carried over.`, onclick: () => { d.close(false); restoreAndExport(app, previewed); } })) : null,
    el('p', `Export ${vname(cur)} as a zip another person can run.`),
    renders ? el('p.small.muted', renders) : null,
    r.total
      ? [el('h3', `Readiness checklist: ${r.met} of ${r.total} met`),
        el('ul.readiness-list', r.items.map((i) => el(`li.${i.met ? 'met' : 'unmet'}`,
          el('span.mark', { 'aria-hidden': 'true' }, i.met ? '✓' : '–'),
          el('span', i.text),
          el('span.sr-only', i.met ? ' (met)' : ' (not met)')))),
        el('p.small.muted', unmet
          ? readinessSentence(kind)
          : 'Every item is ticked. The release records the count.')]
      : el('p.small.muted', 'No readiness checklist yet. Add one in atelier.json (readiness: [...]).'),
    field('Release notes', notes, `Written into the export as ${RELEASE_NOTES_FILE} and kept on the release record. Edit freely.`),
    notesMsg);
  const d = dialog({
    title: 'Build / Export',
    body,
    actions: [{ label: 'Cancel', value: false }, { label: unmet ? 'Export anyway' : 'Export', variant: 'primary', run: (close) => {
      // Refused here, not by the server after the dialog has gone, so the typed text is not lost.
      const size = notesBytes(notes.value);
      if (size > MAX_NOTES_BYTES) {
        clear(notesMsg, el('p.note.danger', { role: 'alert' }, `The notes are ${bytes(size)}; the limit is ${bytes(MAX_NOTES_BYTES)}. Shorten them to export.`));
        notes.focus();
        return;
      }
      close(true);
    } }],
  });
  // Export waits for the draft, so what ships is never the half-way state.
  const primary = d.node.querySelector('.dialog-actions .btn.primary');
  primary.disabled = true;
  drafted.then((draft) => { notes.value = releaseNotesDraft(draft); }, (err) => {
    clear(notesMsg, el('p.note', { role: 'status' }, `No draft: ${err.message}. Write the notes here, or leave them empty.`));
  }).finally(() => {
    notes.readOnly = false;
    notes.placeholder = '';
    primary.disabled = false;
    // The dialog focused its first field; the person may just want to read and press Export.
    if (document.activeElement === notes) primary.focus();
  });
  const go = await d.done;
  if (!go) return;
  return runBuild(app, notes.value);
}

function keepFirst(app) {
  dialog({
    title: 'Keep a version first',
    body: el('p', 'Exports are always built from a kept version, so the artifact matches a checkpoint you can return to. You have changes on disk that are not kept as a version yet.'),
    actions: [{ label: 'Cancel' }, { label: 'Keep version first', variant: 'primary', run: async (close) => {
      close();
      const v = await keepDialog(app);
      if (!v) return;
      await app.loadBundle({ quiet: true }); // keepDialog does not wait for it: the old bundle is dirty and lacks v
      buildFlow(app);
    } }],
  });
}

async function runBuild(app, notes) {
  const pid = app.projectId();
  const progress = dialog({ title: 'Build / Export', body: loading('Building the artifact from the current version…') });
  try {
    const out = await app.api.build(pid, { notes });
    progress.close();
    await app.loadBundle({ quiet: true });
    const v = app.state.bundle.versions.find((x) => x.id === out.versionId);
    const a = out.artifact;
    const copyBtn = (text) => button('', { icon: 'copy', small: true, variant: 'ghost', title: 'Copy', onclick: async () => toast((await copyText(text)) ? 'Copied' : 'Copy failed', { timeout: 1500 }) });
    const renders = rendersAfterBuild(app.state.bundle.manifest?.kind, out.release?.workbench);
    dialog({
      title: 'Export ready',
      body: el('div',
        el('p', `${endSentence(`Built from ${vname(v)}`)} Unzip and double-click index.html to run it.`),
        renders ? el('p', renders) : null,
        el('dl.kv',
          el('dt', 'Zip'), el('dd.row', el('code', { style: { flex: 1, wordBreak: 'break-all' } }, a.path), copyBtn(a.path)),
          el('dt', 'Folder'), el('dd', el('code', { style: { wordBreak: 'break-all' } }, a.unpacked || '—')),
          el('dt', 'sha256'), el('dd.row', el('code', { style: { flex: 1, wordBreak: 'break-all' } }, a.sha256), copyBtn(a.sha256)),
          el('dt', 'Size'), el('dd', `${bytes(a.bytes)} (${a.bytes} bytes) · ${a.files ?? '?'} files`),
          out.release?.workbench?.note ? [el('dt', 'Contents'), el('dd', out.release.workbench.note)] : null,
          el('dt', 'Release notes'), el('dd', notesSummary(out.release)),
          el('dt', 'Built'), el('dd', releaseDate(out.release) || '—'),
          el('dt', 'Readiness'), el('dd', out.release?.readinessSummary || '—'))),
      actions: [{ label: 'Close', variant: 'primary' }],
    });
  } catch (err) {
    progress.close();
    if (err.code === 'uncommitted_changes' || err.code === 'no_version') keepFirst(app);
    else toastError(err, 'Build');
  }
}
