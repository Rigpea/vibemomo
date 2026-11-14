// Memory (route #/memory): what the studio remembers and hands to Claude Code. Records (direct
// retrieval, no model), Decisions, Resources (capability catalogue), and the Briefing.
import { el, clear, button, tag, stateChip, input, textarea, select, field, dialog, confirmDialog, toast, toastError, loading, empty, errorBox, ago, when, segmented } from '../components/ui.js';
import { markdown } from '../components/markdown.js';

const KINDS = ['preference', 'observation', 'decision', 'method', 'resource', 'feedback', 'lesson', 'constraint'];
const MEM_STATUS = ['explicit', 'inferred', 'verified', 'retracted'];
const RES_STATUS = ['discovered', 'available', 'tested', 'used', 'outdated'];
const STATUS_TONE = { explicit: 'accent', inferred: 'neutral', verified: 'ok', retracted: 'danger', accepted: 'ok', superseded: 'neutral', open: 'warn', tested: 'ok', used: 'ok', available: 'accent', outdated: 'warn', discovered: 'neutral' };
const SECTIONS = [['memory', 'Records'], ['decisions', 'Decisions'], ['resources', 'Resources']];

let v = null;

export function mount(host, app) {
  const want = sessionStorage.getItem('atelier.knowledgeTab');
  v = { app, host, tab: SECTIONS.some(([k]) => k === want) ? want : 'memory', body: el('div'), action: el('span'), offs: [], filters: { scope: 'all', kind: '', status: '', q: '', retracted: false } };
  const seg = segmented(SECTIONS, v.tab, (k) => { v.tab = k; sessionStorage.setItem('atelier.knowledgeTab', k); show(); }, { label: 'Section' });
  clear(host, el('div.page', el('div.page-inner',
    el('div.page-head', el('h1', 'Memory'),
      button('Briefing', { title: 'The continuation briefing Claude Code reads', onclick: (e) => showBriefing(app, e.currentTarget) }), v.action),
    el('div', { style: { marginBottom: '24px' } }, seg.node),
    v.body)));
  let memTimer; // the file watcher emits several memory.changed events per write: coalesce them
  v.offs.push(app.on('memory', () => { clearTimeout(memTimer); memTimer = setTimeout(() => v && (v.tab === 'memory' ? loadMemory() : v.tab === 'resources' && show()), 250); }));
  v.pid = app.projectId();
  // The project may resolve after mount (direct load of #/memory) or change: re-render when it does.
  v.offs.push(app.on('bundle', () => {
    if (v.pid !== app.projectId()) { v.pid = app.projectId(); show(); } else if (v.tab === 'decisions') show();
  }));
  show();
}

export function unmount() { v?.offs.forEach((off) => off()); v = null; }

function show() {
  if (!v) return;
  if (v.tab === 'memory') { clear(v.action, button('Add memory', { variant: 'primary', onclick: addMemoryDialog })); memoryTab(); }
  else if (v.tab === 'decisions') { clear(v.action, button('Record a decision', { variant: 'primary', onclick: decisionDialog })); decisionsTab(); }
  else { clear(v.action); resourcesTab(); }
}

// ---------------- Records ----------------
/** From the project list, not the bundle: during a switch the bundle is still empty or the old project's. */
function projectScopeLabel() {
  const name = v.app.state.projects.find((p) => p.id === v.app.projectId())?.name;
  return name ? `This project: ${name}` : 'This project';
}

let memList = null;
function memoryTab() {
  const f = v.filters;
  const scope = select([['all', 'All scopes'], ['user', 'User-wide'], ['project', projectScopeLabel()]], f.scope, { 'aria-label': 'Scope', onchange: (e) => { f.scope = e.target.value; loadMemory(); } });
  const kind = select([['', 'Any kind'], ...KINDS], f.kind, { 'aria-label': 'Kind', onchange: (e) => { f.kind = e.target.value; loadMemory(); } });
  const status = select([['', 'Any state'], ...MEM_STATUS.slice(0, 3)], f.status, { 'aria-label': 'State', onchange: (e) => { f.status = e.target.value; loadMemory(); } });
  const retracted = el('input', { type: 'checkbox', checked: f.retracted, onchange: (e) => { f.retracted = e.target.checked; loadMemory(); } });
  let timer;
  const q = input({ type: 'search', value: f.q, placeholder: 'Search keywords or tags', 'aria-label': 'Search memory', class: 'grow' });
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { f.q = q.value.trim(); loadMemory(); }, 250); });
  memList = el('div', { 'aria-live': 'polite' });
  clear(v.body, el('div.filters', q, kind, scope, status, el('label.check.small', retracted, 'Show retracted')), memList);
  loadMemory();
}

async function loadMemory() {
  if (!v || !memList) return;
  const f = v.filters;
  const pid = v.app.projectId();
  if (!memList.firstChild) clear(memList, loading('Retrieving memory…'));
  try {
    let recs = await v.app.api.memory({ scope: f.scope, projectId: pid, q: f.q, kind: f.kind, includeRetracted: f.retracted ? 1 : undefined, limit: 200 });
    if (f.status) recs = recs.filter((r) => r.status === f.status);
    if (!memList) return;
    if (!recs.length) {
      // With no filter set, nothing listed means nothing kept: the studio writes no preference for the person.
      const none = f.scope === 'all' && !f.kind && !f.status && !f.retracted;
      return clear(memList, empty(f.q ? 'Nothing matches; try fewer or different words.' : 'No memory records yet.',
        !f.q && none ? 'The studio starts with none. Use Add memory to write down how you like to work; briefs carry what you add.' : undefined));
    }
    clear(memList, el('p.meta', { style: { padding: '0 12px' } }, `${recs.length} record${recs.length > 1 ? 's' : ''}${f.q ? ', best match first' : ''}`), recs.map(memoryRecord));
  } catch (err) { clear(memList, errorBox(err, loadMemory)); }
}

function memoryRecord(r) {
  const pid = r.scope === 'project' ? v.app.projectId() : undefined;
  const patch = async (body, msg) => {
    try {
      const out = await v.app.api.patchMemory(r.id, body, pid);
      toast(msg(out), { tone: 'ok' });
      loadMemory();
    } catch (err) { toastError(err); }
  };
  const retracted = r.status === 'retracted';
  const source = `from ${r.provenance?.source || '?'}${r.provenance?.ref ? ` (${r.provenance.ref})` : ''}`;
  // Ids stay in tooltips: people read "corrects the earlier record", not a record id.
  const idRef = !!r.supersedes && /\b[a-z]_[a-z0-9]{8,}\b/.test(r.provenance?.ref || ''); // e.g. 'corrects m_…': said in words below
  const plainSource = idRef ? `from ${r.provenance?.source || '?'}` : source;
  const meta = [r.kind, r.scope === 'project' ? 'this project' : r.scope === 'user' ? 'user-wide' : r.scope, plainSource, ago(r.updatedAt),
    (r.tags || []).length ? `#${r.tags.join(' #')}` : null].filter(Boolean).join(' · ');
  const links = [
    r.supersedes ? el('span', { title: `Earlier record ${r.supersedes} (shown with Show retracted)` }, 'corrects the earlier record') : null,
    r.supersededBy ? el('span', { title: `Newer record ${r.supersededBy}` }, 'replaced by a newer record') : null,
  ].filter(Boolean);
  return el('article.mem', { dataset: { id: r.id } },
    el('div.mem-text', r.text),
    stateChip(r.status, STATUS_TONE[r.status], r.status === 'explicit' ? 'You said it' : r.status === 'verified' ? 'Checked against evidence' : r.status === 'inferred' ? 'Inferred, not confirmed' : 'No longer retrieved or briefed'),
    el('div.mem-meta', { title: `${r.provenance?.evidence || ''}\nupdated ${when(r.updatedAt)}\nrecord ${r.id}`.trim() }, meta, links.flatMap((l) => [' · ', l])),
    el('div.mem-actions',
      retracted ? null : button('Correct', { small: true, variant: 'quiet', onclick: () => correctDialog(r, patch) }),
      retracted || r.status === 'verified' ? null : button('Mark verified', { small: true, variant: 'quiet', onclick: () => patch({ status: 'verified' }, () => 'Marked verified') }),
      retracted ? null : button('Retract', { small: true, variant: 'quiet', onclick: () => patch({ status: 'retracted' }, () => 'Retracted: no longer retrieved or briefed') }),
      button('Delete', { small: true, variant: 'danger', onclick: () => deleteMemory(r, pid) })));
}

function correctDialog(r, patch) {
  const ta = textarea({ value: r.text, rows: 4 });
  dialog({
    title: 'Correct memory',
    body: el('div', field('Corrected text', ta, 'Keeps history: a new record supersedes this one, and this one is retracted.')),
    actions: [{ label: 'Cancel' }, { label: 'Save correction', variant: 'primary', run: (close) => {
      if (!ta.value.trim() || ta.value.trim() === r.text) return ta.focus();
      close();
      patch({ text: ta.value.trim() }, (out) => el('span', { title: `${out.record?.id || 'new record'} corrects ${r.id}` }, 'Correction saved: it corrects the earlier record, which stays in history'));
    } }],
  });
}

async function deleteMemory(r, pid) {
  if (!(await confirmDialog({ title: 'Delete this memory record?', message: `“${r.text.slice(0, 140)}” is removed from disk (the deletion is logged). Retract it instead to keep history.`, confirm: 'Delete', variant: 'danger' }))) return;
  try {
    await v.app.api.deleteMemory(r.id, pid);
    toast('Memory deleted', { tone: 'ok' });
    loadMemory();
  } catch (err) { toastError(err, 'Delete'); }
}

function addMemoryDialog() {
  const hasProject = !!v.app.projectId();
  const scope = select(hasProject ? [['project', projectScopeLabel()], ['user', 'User-wide (all projects)']] : [['user', 'User-wide']], hasProject ? 'project' : 'user');
  const kind = select(KINDS, 'preference');
  const text = textarea({ rows: 3, placeholder: 'e.g. Jumps should feel snappy, not floaty.' });
  const tags = input({ placeholder: 'comma, separated, tags' });
  dialog({
    title: 'Add memory',
    body: el('div', field('Text', text), el('div.fields-2', field('Kind', kind), field('Scope', scope)), field('Tags', tags)),
    actions: [{ label: 'Cancel' }, { label: 'Add memory', variant: 'primary', run: async (close) => {
      if (!text.value.trim()) return text.focus();
      try {
        const rec = await v.app.api.addMemory({ scope: scope.value, kind: kind.value, text: text.value.trim(), tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean), projectId: scope.value === 'project' ? v.app.projectId() : undefined, status: 'explicit' });
        close();
        toast(el('span', { title: `Record ${rec.id}` }, 'Memory added'), { tone: 'ok' });
        loadMemory();
      } catch (err) { toastError(err, 'Add memory'); }
    } }],
  });
}

// ---------------- Decisions ----------------
function decisionsTab() {
  const b = v.app.state.bundle;
  if (!b) return clear(v.body, v.app.projectId() ? loading() : empty('No project open.'));
  const list = [...(b.decisions || [])].reverse();
  clear(v.body, list.length ? list.map((d) => decisionRow(d, b)) : empty('No decisions yet. Every task is briefed with the ones recorded here.'));
}

function decisionDialog() {
  const text = textarea({ rows: 2, placeholder: 'What did we decide?' });
  const reason = input({ placeholder: 'Why (optional)' });
  dialog({
    title: 'Record a decision',
    body: el('div', field('Decision', text), field('Reason', reason)),
    actions: [{ label: 'Cancel' }, { label: 'Record', variant: 'primary', run: async (close) => {
      if (!text.value.trim()) return text.focus();
      try { await v.app.api.addDecision(v.app.projectId(), { text: text.value.trim(), reason: reason.value.trim() }); close(); toast('Decision recorded', { tone: 'ok' }); await v.app.loadBundle({ quiet: true }); } catch (err) { toastError(err); }
    } }],
  });
}

function decisionRow(d, b) {
  const by = (id) => b.decisions.find((x) => x.id === id);
  const supersededBy = b.decisions.find((x) => x.supersedes === d.id);
  const meta = [d.reason, d.taskId ? `from task ${d.taskId}` : null, d.supersedes ? `supersedes “${by(d.supersedes)?.text?.slice(0, 50) || d.supersedes}”` : null,
    supersededBy ? `superseded by “${supersededBy.text.slice(0, 50)}”` : null, ago(d.createdAt)].filter(Boolean).join(' · ');
  return el('article.mem',
    el('div.mem-text', d.text),
    stateChip(d.status, STATUS_TONE[d.status]),
    el('div.mem-meta', meta),
    d.status === 'accepted' ? el('div.mem-actions', button('Supersede', { small: true, variant: 'quiet', onclick: () => supersede(d) })) : null);
}

function supersede(d) {
  const text = textarea({ value: d.text, rows: 3 });
  const reason = input({ placeholder: 'Why it changed' });
  dialog({
    title: 'Supersede decision',
    body: el('div', field('New decision', text, 'Recorded as accepted; this one is marked superseded.'), field('Reason', reason)),
    actions: [{ label: 'Cancel' }, { label: 'Supersede', variant: 'primary', run: async (close) => {
      if (!text.value.trim()) return text.focus();
      close();
      const pid = v.app.projectId();
      try {
        await v.app.api.addDecision(pid, { text: text.value.trim(), reason: reason.value.trim(), supersedes: d.id });
        await v.app.api.patchDecision(pid, d.id, { status: 'superseded' });
        toast('Decision superseded', { tone: 'ok' });
        v.app.loadBundle({ quiet: true });
      } catch (err) { toastError(err); }
    } }],
  });
}

// ---------------- Resources ----------------
async function resourcesTab() {
  clear(v.body, loading('Loading resources…'));
  const pid = v.app.projectId();
  try {
    const [user, project] = await Promise.all([v.app.api.resources(), pid ? v.app.api.projectResources(pid) : []]);
    if (!v || v.tab !== 'resources') return;
    clear(v.body, resourceSection('User-wide', user, 'user'), pid ? resourceSection('This project', project, 'project') : null);
  } catch (err) { clear(v.body, errorBox(err, resourcesTab)); }
}

function resourceSection(title, items, scope) {
  return el('section', { style: { marginBottom: '32px' } }, el('div.section-head', el('h2', title), el('span.meta', String(items.length)), el('span.spacer'), button('Add', { small: true, onclick: () => resourceDialog(scope) })),
    items.length ? el('div', { style: { overflowX: 'auto' } }, el('table.table',
      el('thead', el('tr', ['Name', 'Kind', 'State', 'Solves', 'Version', 'Verified', ''].map((h) => el('th', h)))),
      el('tbody', items.map((r) => el('tr',
        el('td', r.url ? el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.name) : r.name),
        el('td', tag(r.kind || '—')), el('td', stateChip(r.status, STATUS_TONE[r.status])),
        el('td.small', { style: { maxWidth: '220px' } }, r.problemSolved || '—'), el('td.small', r.version || '—'),
        el('td.small.muted', r.lastVerified || '—'),
        el('td', button('Edit', { small: true, variant: 'quiet', onclick: () => resourceDialog(scope, r) }))))))) : el('p.meta', 'Nothing catalogued yet.'));
}

function resourceDialog(scope, r = {}) {
  const f = { name: input({ value: r.name || '' }), kind: input({ value: r.kind || '', placeholder: 'library, engine, tutorial…' }), url: input({ value: r.url || '', type: 'url' }),
    status: select(RES_STATUS, r.status || 'discovered'), problemSolved: textarea({ value: r.problemSolved || '', rows: 2 }), version: input({ value: r.version || '' }), lastVerified: input({ type: 'date', value: r.lastVerified || '' }) };
  const label = (k) => ({ problemSolved: 'Problem it solves', lastVerified: 'Last verified', url: 'URL', status: 'State' }[k] || k[0].toUpperCase() + k.slice(1));
  dialog({
    title: r.id ? `Edit ${r.name}` : `Add resource (${scope === 'user' ? 'user-wide' : 'this project'})`,
    body: el('div', field(label('name'), f.name), el('div.fields-2', field(label('kind'), f.kind), field(label('status'), f.status)), field(label('url'), f.url), field(label('problemSolved'), f.problemSolved),
      el('div.fields-2', field(label('version'), f.version), field(label('lastVerified'), f.lastVerified))),
    actions: [{ label: 'Cancel' }, { label: 'Save', variant: 'primary', run: async (close) => {
      const body = Object.fromEntries(Object.entries(f).map(([k, c]) => [k, c.value.trim()]));
      if (!body.name) return f.name.focus();
      const api = v.app.api; const pid = v.app.projectId();
      try {
        if (scope === 'user') await (r.id ? api.patchResource(r.id, body) : api.addResource(body));
        else await (r.id ? api.patchProjectResource(pid, r.id, body) : api.addProjectResource(pid, body));
        close(); toast('Resource saved', { tone: 'ok' }); resourcesTab();
      } catch (err) { toastError(err); }
    } }],
  });
}

// ---------------- Briefing ----------------
async function showBriefing(app, btn) {
  const pid = app.projectId();
  if (!pid) return toast('Open a project first');
  // Composing takes a few seconds (it rewrites .studio/BRIEFING.md): say so on the button and in the dialog.
  const label = btn?.querySelector('span');
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); if (label) label.textContent = 'Composing…'; }
  const body = el('div', loading('Composing the briefing from memory, decisions and versions…'));
  dialog({ title: 'Briefing (what Claude Code reads)', wide: true, body, actions: [{ label: 'Close', variant: 'primary' }] });
  try {
    const out = await app.api.briefing(pid);
    clear(body, el('p.meta', `Composed from ${out.sources?.length || 0} records and written to .studio/BRIEFING.md. A Claude Code session reads it when it starts; sessions already open keep the briefing they started with.`), markdown(out.markdown));
  } catch (err) { clear(body, el('p.note.danger', err.message)); }
  finally { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); if (label) label.textContent = 'Briefing'; } }
}
