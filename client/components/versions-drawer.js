// Versions drawer: newest-first table with state, preference, verification and recovery actions.
// Fits the workbench column at 1280x720 without sideways scrolling: origin and age sit under the
// label, and the row actions wrap instead of widening the table.
import { el, clear, button, icon, stateChip, ago, when, toast, toastError, dialog, input, field, empty } from './ui.js';
import { vname, fullName, compareDialog, restoreDialog, stateSelect, stateLabel, stateMeaning, PREFERRED_MEANING } from './version-actions.js';
import { versionRowId } from './version-strip.js';

const ORIGIN = { user: 'you', 'claude-code': 'Claude Code', 'restore-safety': 'safety copy', import: 'import', studio: 'studio' };
const VERIFY_MEANING = 'Mark that you tried this version and it works';

export function renderVersions(host, app, { viewing } = {}) {
  const b = app.state.bundle;
  if (!b) return clear(host, el('div.loading', el('span.spinner'), 'Loading versions…'));
  const versions = [...(b.versions || [])].sort((x, y) => y.n - x.n);
  if (!versions.length) return clear(host, empty('No versions yet. Keep version records the files on disk as #1.'));
  const cur = b.changes?.sinceVersionId;
  const heads = [['#', 'num'], ['Version', ''], ['State', ''], ['Preferred', '', PREFERRED_MEANING], ['Verified', '', VERIFY_MEANING], ['', '']];
  const table = el('table.table.versions-table',
    el('colgroup', el('col', { style: { width: '36px' } }), el('col'), el('col', { style: { width: '128px' } }), el('col', { style: { width: '76px' } }), el('col', { style: { width: '88px' } }), el('col', { style: { width: '188px' } })),
    el('thead', el('tr', heads.map(([h, cls, title]) => el('th', { scope: 'col', class: cls, title }, h || el('span.sr-only', 'Actions'))))),
    el('tbody', versions.map((v) => row(app, v, { current: v.id === cur, viewing: v.id === viewing, dirty: b.changes?.dirty }))));
  clear(host, table);
}

function row(app, v, { current, viewing, dirty }) {
  const pid = app.projectId();
  const patch = async (partial, msg) => {
    try {
      await app.api.patchVersion(pid, v.id, partial);
      if (msg) toast(msg, { tone: 'ok', timeout: 1800 });
      app.loadBundle({ quiet: true });
    } catch (err) { toastError(err); }
  };
  const stateSel = stateSelect(v.state, { 'aria-label': `State of ${vname(v)}`, onchange: (e) => patch({ state: e.target.value }, `${vname(v)} is now ${stateLabel(e.target.value)} (${stateMeaning(e.target.value)})`) });
  const star = el('button.btn.ghost.sm.icon-only.star-btn', {
    type: 'button', 'aria-pressed': String(!!v.userPreferred),
    title: v.userPreferred ? `${PREFERRED_MEANING} (click to clear)` : `Mark as preferred: the version you would ship today`,
    'aria-label': `Preferred: ${vname(v)}`, onclick: () => patch({ userPreferred: !v.userPreferred }),
  }, icon('star'));
  const verified = v.verified
    ? el('span', { title: `${v.verified.by}${v.verified.note ? ': ' + v.verified.note : ''} · ${when(v.verified.at)}` }, stateChip('Verified', 'ok'))
    : button('Verify', { small: true, variant: 'quiet', title: VERIFY_MEANING, onclick: () => verifyDialog(v, patch) });
  const meta = [ORIGIN[v.origin] || v.origin, ago(v.createdAt), current ? (dirty ? 'current · changed on disk since' : 'current') : null].filter(Boolean).join(' · ');
  const paths = v.filesChanged || [];
  const note = v.note?.trim();
  // The id and tabindex let a mark on the version strip open the drawer at this row (focusVersionRow).
  return el(`tr${current ? '.current' : ''}${viewing ? '.viewing' : ''}`, { id: versionRowId(v.id), tabIndex: -1 },
    el('td.num.mono', v.n),
    el('td', { style: { minWidth: 0 } },
      el('div.ellipsis', { title: fullName(v), style: { fontWeight: 600 } }, vname(v).replace(/^#\d+ /, '')),
      note && note !== v.label ? el('div.small.muted.ellipsis', { title: note }, note) : null,
      el('div.small.muted.ellipsis', { title: when(v.createdAt) }, meta,
        paths.length ? el('span', { title: paths.join('\n') }, ` · ${paths.length} file${paths.length === 1 ? '' : 's'}`) : null),
      viewing ? el('div.small', { style: { color: 'var(--warn)' } }, 'in preview') : null),
    el('td', stateSel),
    el('td', star),
    el('td', verified),
    el('td', el('div.row-actions',
      button('Try', { small: true, variant: 'quiet', title: `Try this version: preview ${vname(v)} (not the files on disk)`, onclick: () => app.workbench?.viewVersion(v.id) }),
      button('Compare', { small: true, variant: 'quiet', title: !current ? `Compare ${vname(v)} with the current version` : dirty ? `Compare ${vname(v)} with the files on disk now` : `Compare ${vname(v)} with the version before it`, onclick: () => compareDialog(app, { a: v.id }) }),
      button('Restore', { small: true, variant: 'quiet', title: current && !dirty ? 'Already the current version' : `Restore ${vname(v)}`, disabled: current && !dirty, onclick: () => restoreDialog(app, { versionId: v.id }) }))));
}

function verifyDialog(v, patch) {
  const note = input({ placeholder: 'e.g. played to the door twice' });
  dialog({
    title: `Verify ${vname(v)}`,
    body: el('div', el('p.small.muted', `${VERIFY_MEANING}.`), field('What did you check?', note, 'Separate from your preference (the star) and from real users’ feedback.')),
    actions: [{ label: 'Cancel' }, { label: 'Mark verified', variant: 'primary', run: (close) => { close(); patch({ verified: { by: 'manual', note: note.value.trim() } }, `${vname(v)} marked verified`); } }],
  });
}
