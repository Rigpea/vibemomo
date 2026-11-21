// Focus (the Workbench's right panel, beside Task): current piece, next release, unresolved
// questions and project identity, each edited in place. A section in edit mode keeps its form
// across live refreshes until it is saved or cancelled.
import { el, clear, button, input, select, textarea, field, toast, toastError, confirmDialog, dialog, loading, errorBox } from './ui.js';
import { releaseRows } from './release-rows.js';
import { COMPANION_MODELS } from './companion-words.js';
import { WORKER_DEFAULT, parseWorker, workerName, workerPick, workerValue, isCodexChoice, codexWorkerOptions, codexWorkerEfforts, codexWorkerHint } from './worker-model-words.js';
import { driftWords, driftPieces, catchUpTask, catchUpTitle, templatesOfKind } from './template-drift.js';
import { groupUnresolved, firstItems, groupLine, FIRST_SHOWN, ADD_FIELD, resolveKey, resolveAllKey, itemKey, groupKey, resolveLabel, resolveAllLabel, focusAfterResolve, focusAfterResolveAll } from './unresolved-groups.js';

let drift = null; // { key, data?, error? } the answer for one state of one project's files
let catchingUp = false;
let settingTemplate = null; // { projectId, name } while Set is open; every render rebuilds the row
const unresolvedOpen = new Set(); // project ids showing their whole list; every render rebuilds the section
const addDrafts = new Map(); // project id -> text typed into Add: the redraw keeps the focus there, so it must keep the words
let editing = null; // { key, node, projectId }
let last = null; // { host, app } of the last render, for re-rendering after an edit starts/stops

export function renderFocus(host, app) {
  last = { host, app };
  const b = app.state.bundle;
  if (!app.projectId()) return clear(host, el('p.meta', 'Open or create a project to set its focus.'));
  if (!b || b.project?.id !== app.projectId()) {
    return clear(host, app.state.bundleError ? el('p.meta', `Project records unavailable: ${app.state.bundleError.message}`) : el('div.loading', el('span.spinner'), 'Loading…'));
  }
  if (editing && editing.projectId !== b.project.id) editing = null;
  const active = host.contains(document.activeElement) ? document.activeElement : null;
  clear(host, pieceSection(app, b.project), releaseSection(app, b.project, b.versions, b.releases), unresolvedSection(app, b.project), identitySection(app, b.project));
  if (active?.isConnected) { if (document.activeElement !== active) active.focus(); } // a form kept across a refresh keeps its caret
  else if (active?.dataset.edit) { // redrawn: its successor, form open elsewhere or not
    const next = byEdit(host, active.dataset.edit);
    next?.focus();
    if (next?.tagName === 'INPUT') next.setSelectionRange(active.selectionStart, active.selectionStart); // the Add field, mid-sentence
  }
}

const rerender = () => last && renderFocus(last.host, last.app);
/** By comparing, not a selector: an item's id is in the key, and a plain PATCH can store any id. */
const byEdit = (host, key) => [...host.querySelectorAll('[data-edit]')].find((n) => n.dataset.edit === key);

function section(app, key, title, view, form) {
  if (editing?.key === key && editing.node) return editing.node;
  return el('section.focus-sec', { 'aria-label': title },
    el('div.focus-head', el('h2', title), form ? button('Edit', { small: true, variant: 'quiet', 'aria-label': `Edit ${title.toLowerCase()}`, dataset: { edit: key }, onclick: () => startEdit(app, key, form) }) : null),
    view);
}

function startEdit(app, key, form) {
  const node = el('section.focus-sec', form((partial) => save(app, partial), () => stopEdit(key)));
  editing = { key, node, projectId: app.projectId() };
  rerender();
  requestAnimationFrame(() => node.querySelector('input, textarea')?.focus());
}
function stopEdit(key) {
  editing = null;
  rerender();
  requestAnimationFrame(() => last?.host.querySelector(`[data-edit="${key}"]`)?.focus());
}
async function save(app, partial) {
  try {
    const project = await app.api.patchProject(app.projectId(), partial);
    app.state.bundle.project = project;
    const key = editing?.key;
    editing = null;
    app.emit('bundle');
    if (partial.name) app.loadStudio();
    toast('Saved', { tone: 'ok', timeout: 1800 });
    if (key) requestAnimationFrame(() => last?.host.querySelector(`[data-edit="${key}"]`)?.focus());
  } catch (err) {
    toastError(err, 'Could not save');
  }
}

const lines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
function formShell(title, fields, onSave, onCancel, collect) {
  return el('form', { onsubmit: (e) => { e.preventDefault(); onSave(collect()); }, onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } } },
    el('div.focus-head', el('h2', title)),
    fields,
    el('div.row', el('span.spacer'), button('Cancel', { small: true, variant: 'quiet', onclick: onCancel }), button('Save', { small: true, type: 'submit' })));
}
const placeholder = (text) => el('p.placeholder', text);

function pieceSection(app, project) {
  const p = project.currentPiece || {};
  const view = p.title
    ? el('div', el('div.focus-title', p.title), p.why ? el('p.meta', { style: { margin: '2px 0 0' } }, p.why) : null,
      p.acceptance?.length ? el('ul', p.acceptance.map((a) => el('li', a))) : placeholder('No acceptance checks yet.'))
    : placeholder('What are we making right now? Every task starts from it.');
  return section(app, 'piece', 'Current piece', view, (onSave, onCancel) => {
    const t = input({ value: p.title || '', placeholder: 'e.g. Jump that feels responsive' });
    const w = textarea({ value: p.why || '', rows: 2, placeholder: 'Why this piece matters' });
    const a = textarea({ value: (p.acceptance || []).join('\n'), rows: 3, placeholder: 'One check per line' });
    return formShell('Current piece', [field('Title', t), field('Why', w), field('Acceptance (one per line)', a)], onSave, onCancel,
      () => ({ currentPiece: { ...p, title: t.value.trim(), why: w.value.trim(), acceptance: lines(a.value) } }));
  });
}

function releaseSection(app, project, versions = [], releases = []) {
  const r = project.nextRelease || {};
  const target = versions.find((v) => v.id === r.targetVersionId);
  const next = r.title
    ? el('div', el('div.focus-title', r.title), target ? el('p.meta', { style: { margin: '2px 0 0' } }, `Target: #${target.n} ${target.label}`) : null,
      r.definition?.length ? el('ul', r.definition.map((d) => el('li', d))) : placeholder('No release definition yet.'))
    : placeholder('Name the next useful release and what it needs.');
  const rows = releaseRows(releases, versions);
  const made = rows.length
    ? el('div', { style: { marginTop: '8px' } }, el('div.meta', 'Releases'),
      // Named by what it shows: a title on the row itself became its accessible name.
      el('ul.releases', rows.map((row) => el('li', { 'aria-label': row.text }, el('span', { title: row.title }, row.text)))))
    : el('p.placeholder', { style: { margin: '8px 0 0' } }, 'No releases yet');
  const view = el('div', next, made);
  return section(app, 'release', 'Next release', view, (onSave, onCancel) => {
    const t = input({ value: r.title || '', placeholder: 'e.g. Playable room for friends' });
    const d = textarea({ value: (r.definition || []).join('\n'), rows: 4, placeholder: 'One requirement per line' });
    return formShell('Next release', [field('Title', t), field('Definition (one per line)', d)], onSave, onCancel,
      () => ({ nextRelease: { ...r, title: t.value.trim(), definition: lines(d.value) } }));
  });
}

/** The first of these controls the redraw left gets the focus. The person's own move wins, and so does an open form.
 *  Called right after the redraw, which emit runs synchronously: a frame can come late, and a window that does not paint has none. */
function focusFirst(keys, from) {
  const now = document.activeElement;
  const pressed = now === from || (now?.dataset?.edit && now.dataset.edit === from?.dataset?.edit); // a live refresh may have rebuilt it
  if ((now && now !== document.body && !pressed) || editing?.node?.contains(now)) return;
  for (const key of keys) {
    const target = last && byEdit(last.host, key);
    if (target) return target.focus();
  }
}

/** Sends one operation on the stored list and takes the answer, which holds what other clients added.
 *  Saves only that: save() would also drop a form open in another section. */
async function changeUnresolved(app, partial, focusKeys, failed) {
  const pid = app.projectId();
  const from = document.activeElement;
  try {
    const project = await app.api.patchProject(pid, partial);
    if (app.state.bundle?.project?.id !== pid) return; // the person switched project meanwhile
    app.state.bundle.project = project;
    app.emit('bundle');
    toast('Saved', { tone: 'ok', timeout: 1800 });
    focusFirst(focusKeys, from);
  } catch (err) {
    if (failed) failed(pid, err);
    else toastError(err, 'Could not save');
  }
}

/** A question the server refused goes back in its project's field, unless the person has typed there since: joining
 *  the two is the fault the early clear removes, and overwriting would lose the newer words. The toast stays until
 *  dismissed, so there it holds the words. What is typed in another project's field is that project's and stays. */
function restoreAdd(app, pid, text, err) {
  if (addDrafts.get(pid)?.trim()) return toastError(err, `Could not save “${text}”; the field holds what you typed since`);
  addDrafts.set(pid, text);
  if (app.state.bundle?.project?.id !== pid) {
    const name = app.state.projects.find((p) => p.id === pid)?.name || 'its project';
    return toastError(err, `Could not save “${text}” on ${name}; it is back in that project's Add field`);
  }
  const field = last && byEdit(last.host, ADD_FIELD);
  if (field) field.value = text;
  toastError(err, 'Could not save the question; it is back in the field');
}

function unresolvedSection(app, project) {
  const items = project.unresolved || [];
  const resolve = (ids, focusKeys) => changeUnresolved(app, { unresolvedResolve: ids }, focusKeys);
  const titles = Object.fromEntries((app.state.bundle?.tasks || []).map((t) => [t.id, t.title]));
  const view = groupUnresolved(items, titles);
  const long = view.total > FIRST_SHOWN;
  const open = unresolvedOpen.has(project.id);
  const shown = firstItems(view, long && !open ? FIRST_SHOWN : Infinity);
  const rows = (list) => el('ul.unresolved', list.map((u) => el('li', el('span', { tabIndex: -1, dataset: { edit: itemKey(u) } }, u.text),
    button('Resolve', { small: true, variant: 'quiet', title: 'Resolved: remove it from the list', 'aria-label': resolveLabel(u), dataset: { edit: resolveKey(u) }, onclick: () => resolve([u.id], focusAfterResolve(view, u)) }))));
  const groupOf = (g) => el('div.unresolved-group',
    el('div.unresolved-from', el('span.meta', { tabIndex: -1, dataset: { edit: groupKey(g) } }, groupLine(g)),
      g.items.length > 1 ? button(`Resolve all ${g.items.length}`, { small: true, variant: 'quiet', title: "Resolved: remove them from the list. The task's result keeps them.", 'aria-label': resolveAllLabel(g), dataset: { edit: resolveAllKey(g) }, onclick: () => resolve(g.items.map((u) => u.id), focusAfterResolveAll(view, g)) }) : null),
    rows(g.shown));
  const toggle = () => {
    if (open) unresolvedOpen.delete(project.id);
    else unresolvedOpen.add(project.id);
    rerender();
    byEdit(last.host, 'unresolved-all')?.focus(); // also when the click itself did not focus the button
  };
  const add = input({ placeholder: 'Add an open question', 'aria-label': 'Add an unresolved question', dataset: { edit: ADD_FIELD }, value: addDrafts.get(project.id) || '', oninput: (e) => { addDrafts.set(project.id, e.target.value); } });
  const form = el('form.row', { style: { marginTop: '8px' }, onsubmit: (e) => {
    e.preventDefault();
    const text = add.value.trim();
    if (!text) return;
    add.value = ''; // at once, not at the answer: the next question is typed before it comes
    addDrafts.delete(project.id);
    changeUnresolved(app, { unresolvedAdd: [{ text }] }, [ADD_FIELD], (pid, err) => restoreAdd(app, pid, text, err));
  } },
    add, button('Add', { small: true, type: 'submit' }));
  return el('section.focus-sec', { 'aria-label': 'Unresolved' },
    el('div.focus-head', el('h2', 'Unresolved'), items.length ? el('span.meta', String(items.length)) : null),
    items.length ? [shown.typed.length ? rows(shown.typed) : null, shown.groups.map(groupOf)] : placeholder('Nothing open.'),
    long ? button(open ? `Show first ${FIRST_SHOWN}` : `Show all ${view.total}`, { small: true, variant: 'quiet', 'aria-expanded': String(open), dataset: { edit: 'unresolved-all' }, onclick: toggle }) : null,
    form);
}

/** The project the studio shows after this one is removed: the next in rail order, or the one above the last row. */
export function nextInRail(projects, id) {
  const at = projects.findIndex((p) => p.id === id);
  return projects[at + 1] || projects[at - 1] || null;
}

/** Unregister the project (DELETE /api/projects/:id). The folder, its git history and .studio stay on disk. */
async function removeProject(app, project) {
  const shown = nextInRail(app.state.projects, project.id);
  const ok = await confirmDialog({
    title: 'Remove from studio',
    message: `Remove ${project.name} from the studio? The folder and its files stay on disk. ${shown ? `The studio shows ${shown.name} next.` : 'No project is left, so the studio shows its empty start next.'}`,
    confirm: 'Remove from studio', variant: 'danger', cancel: 'Keep it',
  });
  if (!ok) return;
  try {
    const next = nextInRail(app.state.projects, project.id);
    await app.api.removeProject(project.id);
    toast(`Removed ${project.name} from the studio. Its folder is still on disk; Import a folder brings it back.`, { tone: 'ok', timeout: 6000, clears: 'Remove from studio' });
    // Switch before loadStudio: it would pick the server's choice for a project that is gone, and selectProject does nothing for the active one.
    app.state.projects = app.state.projects.filter((p) => p.id !== project.id);
    if (next) await app.selectProject(next.id);
    await app.loadStudio();
    if (!next) await app.loadBundle();
  } catch (err) { toastError(err, 'Remove from studio'); }
}

/** Asked once per state of the files: a new head or other changed files ask again, a redraw does not. */
function askDrift(app, project) {
  const c = app.state.bundle?.changes;
  const key = [project.id, project.template.name, c?.headSha, (c?.files || []).map((f) => f.path).join('|')].join(' ');
  if (drift?.key === key) return drift;
  drift = { key };
  app.api.templateDrift(project.id).then(
    (data) => { if (drift?.key === key) { drift.data = data; rerender(); } },
    (error) => { if (drift?.key === key) { drift.error = error; rerender(); } });
  return drift;
}

const OPEN_TASK = ['ready', 'working', 'interrupted', 'needs-input'];

/** Create the task and hand it over with the template folder readable. Nothing runs without this click. */
async function catchUp(app, data) {
  if (catchingUp) return;
  catchingUp = true;
  rerender();
  const id = app.projectId();
  let task = null;
  try {
    task = await app.api.createTask(id, catchUpTask(data));
    await app.api.taskConsole(id, task.id, { addDirs: [data.folder] });
    toast('Claude Code is catching up with the template in Chat', { tone: 'ok' });
  } catch (err) {
    // A row's own Run does not add the folder, so say so rather than leave a task that looks ready to hand over.
    toastError(err, task ? `The task was created but not handed over; a Run from its row cannot read ${data.folder}` : 'Could not create the catch-up task');
  } finally {
    catchingUp = false;
    await app.loadBundle({ quiet: true });
    rerender();
  }
}

/** Saves only the template: save() would also drop a form open in another section. */
async function saveTemplate(app, name) {
  try {
    app.state.bundle.project = await app.api.patchProject(app.projectId(), { template: { name } });
    settingTemplate = null;
    app.emit('bundle');
    toast('Saved', { tone: 'ok', timeout: 1800 });
    requestAnimationFrame(() => last?.host.querySelector('[data-edit="identity"]')?.focus());
  } catch (err) {
    toastError(err, 'Could not set the template');
  }
}

/** A sentence with Set beside it. No record yet (projects from before the record, imports, blank ones), or a record whose template is gone. */
function setTemplateRow(app, project, words) {
  const kind = app.state.projects.find((p) => p.id === project.id)?.kind;
  const options = templatesOfKind(app.state.templates, kind);
  if (!options.length) return el('p.meta', { style: { margin: '6px 0 0' } }, words);
  const setting = settingTemplate?.projectId === project.id ? settingTemplate : null;
  const focusOn = (edit) => requestAnimationFrame(() => last?.host.querySelector(`[data-edit="${edit}"]`)?.focus());
  if (!setting) {
    return el('div.row', { style: { marginTop: '6px' } }, el('span.meta', words),
      button('Set', { small: true, variant: 'quiet', 'aria-label': 'Set the template', title: 'Pick the template to compare this project with: the one it was made from, or the nearest', dataset: { edit: 'template-set' }, onclick: () => {
        settingTemplate = { projectId: project.id, name: options[0].name };
        rerender();
        focusOn('template-choice');
      } }));
  }
  const cancel = () => {
    settingTemplate = null;
    rerender();
    focusOn('template-set');
  };
  const choice = select(options.map((t) => [t.name, `${t.title} · ${t.name}`]), setting.name, { 'aria-label': 'Template', dataset: { edit: 'template-choice' }, onchange: (e) => { setting.name = e.target.value; } });
  return el('form', { style: { marginTop: '6px' }, onsubmit: (e) => { e.preventDefault(); saveTemplate(app, setting.name); }, onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } } },
    field('Template', choice, project.template?.name ? 'Cancel keeps the record as it is.' : 'Cancel keeps it unrecorded.'),
    el('div.row', el('span.spacer'), button('Cancel', { small: true, variant: 'quiet', dataset: { edit: 'template-cancel' }, onclick: cancel }), button('Save', { small: true, type: 'submit', dataset: { edit: 'template-save' } })));
}

/** One differing file's diff. Opened at once, so Esc works while it loads and the dialog's opener is this path's button. */
export function showDriftDiff(app, rel, key) {
  const pid = app.projectId();
  const body = el('div', loading());
  const { done } = dialog({ title: `${rel}: template → project`, wide: true, modal: true, body, actions: [{ label: 'Close' }] });
  app.api.templateDriftDiff(pid, rel).then(
    (out) => clear(body,
      out.note ? el('p.small.muted', out.note) : null,
      el('pre.out', { tabIndex: 0, 'aria-label': `Diff of ${rel}` }, out.diff),
      out.truncated ? el('p.small.muted', 'The diff is cut here: it is too long to show whole.') : null),
    (err) => clear(body, errorBox(err)));
  // A live refresh may have rebuilt the row behind the dialog, and the old button is gone with it.
  done.then(() => { if (document.activeElement === document.body && last) byEdit(last.host, key)?.focus(); });
}

function templateRow(app, project) {
  const name = project.template?.name;
  if (!name) return setTemplateRow(app, project, 'Template: not recorded');
  const d = askDrift(app, project);
  const line = (...words) => el('p.meta', { style: { margin: '6px 0 0' } }, `Template: ${name} · `, words);
  if (d.error) return line(`could not compare: ${d.error.message}`);
  if (!d.data) return line('comparing…');
  if (!d.data.available) return setTemplateRow(app, project, `Template: ${name} · ${driftWords(d.data)}`);
  const behind = d.data.available && d.data.behind > 0;
  const open = (app.state.bundle?.tasks || []).find((t) => t.title === catchUpTitle(name) && OPEN_TASK.includes(t.status));
  return el('div',
    line(driftPieces(d.data).map((piece) => {
      if (!piece.path) return piece;
      const key = `drift-diff-${piece.path}`;
      return button(piece.path, { small: true, variant: 'quiet', title: `Read how ${piece.path} differs from the template`, dataset: { edit: key }, onclick: () => showDriftDiff(app, piece.path, key) });
    })),
    behind ? el('p.meta', { style: { margin: '2px 0 0' } }, d.data.note) : null,
    !behind ? null : open ? el('p.meta', { style: { margin: '2px 0 0' } }, 'A catch-up task is open: see the Task panel.')
      : el('div.row', { style: { marginTop: '6px' } }, button(catchingUp ? 'Creating the task…' : 'Catch up with the template', { small: true, disabled: catchingUp, title: `Creates a task and hands it to Claude Code with ${d.data.folder} readable`, onclick: () => catchUp(app, d.data) })));
}

const IDENTITY = [['purpose', 'Purpose'], ['audience', 'Audience'], ['inspiration', 'Inspiration'], ['direction', 'Direction']];
// The model this project's workers start on (server/lib/models.mjs): none stored means the studio default, which the
// studio's settings keep (settings.workerModel, server/lib/worker-model.mjs); none stored there means the built-in one.
// A worker model is a Claude Code model id or a Codex one, codex:<model>[@<effort>] (worker-model-words.js): the
// model select offers both and a second select holds a Codex model's effort.
export { WORKER_DEFAULT };
const modelName = (id, codex = null) => workerName(id, codex);
/** The studio default as stored, when it is a model the studio takes; else null. */
export const storedStudioDefault = (settings) => (parseWorker(settings?.workerModel) ? settings.workerModel : null);
/** The studio default in effect: the stored one, else the built-in. */
export const studioWorkerDefault = (settings) => storedStudioDefault(settings) || WORKER_DEFAULT;
export const workerModelText = (project, settings, codex = null) => (parseWorker(project.workerModel) ? modelName(project.workerModel, codex) : `${modelName(studioWorkerDefault(settings), codex)} (studio default)`);
/** codex: the Codex status route's answer (null: not read, so only a stored Codex model is offered); current: the stored value. */
export const workerModelChoices = (settings, codex = null, current = null) => [['default', `Studio default (${modelName(studioWorkerDefault(settings), codex)})`], ...COMPANION_MODELS, ...codexWorkerOptions(codex, current)];
/** The studio default's own choices: nothing stored (the built-in applies), or one of the models. */
export const studioDefaultChoices = (codex = null, current = null) => [['default', `Built in (${modelName(WORKER_DEFAULT)})`], ...COMPANION_MODELS, ...codexWorkerOptions(codex, current)];
/** The form's choice as a PATCH field: only when it changed, so saving the other identity fields never touches it. */
export function workerModelPatch(project, choice) {
  const next = choice === 'default' ? null : choice;
  return next === (project.workerModel || null) ? {} : { workerModel: next };
}
/** The studio default's choice as a PATCH /api/settings body, or null when it is what the settings already hold. */
export function studioDefaultPatch(settings, choice) {
  const next = choice === 'default' ? null : choice;
  return next === storedStudioDefault(settings) ? null : { workerModel: next };
}
function identitySection(app, project) {
  const isStudio = app.state.projects.find((p) => p.id === project.id)?.kind === 'studio';
  const view = el('div',
    el('dl.kv.small', el('dt', 'Name'), el('dd', project.name), IDENTITY.flatMap(([k, label]) => [el('dt', label), el('dd', project[k] || el('span.placeholder', 'not set'))]),
      el('dt', 'Worker model'), el('dd', { title: 'The model a worker started for this project runs on, unless its task names one; a running worker keeps its own' }, workerModelText(project, app.state.settings))),
    templateRow(app, project),
    isStudio ? null : el('div.focus-remove', button('Remove from studio', { small: true, variant: 'danger', title: 'Unregister this project; its folder stays on disk', onclick: () => removeProject(app, project) })));
  return section(app, 'identity', 'Identity', view, (onSave, onCancel) => {
    const keys = ['name', ...IDENTITY.map(([k]) => k)];
    const ctl = Object.fromEntries(keys.map((k) => [k, k === 'name' ? input({ value: project[k] || '' }) : textarea({ value: project[k] || '', rows: 2 })]));
    const settings = app.state.settings;
    // Each level is a model select and, for a Codex model, its effort select beside it (hidden otherwise). The Codex
    // models are the ones the Codex tab reads (GET /api/console/codex); until that answers, and when it cannot be
    // read, only a Codex model already stored is offered, so nothing chosen is ever dropped.
    const level = (stored, choices, edit, onModel) => {
      const pick = workerPick(stored);
      const model = select(choices(null), pick.model, { dataset: { edit } });
      const effort = select(codexWorkerEfforts(null, pick.model, pick.effort), pick.effort, { dataset: { edit: `${edit}-effort` }, 'aria-label': 'Codex effort', hidden: !isCodexChoice(pick.model) });
      const note = el('div.hint', { hidden: true });
      let codex = null;
      const fill = (node, options, value) => { clear(node, options.map(([v, words]) => el('option', { value: v, selected: v === value }, words))); node.value = options.some(([v]) => v === value) ? value : options[0][0]; };
      const sync = () => {
        const on = isCodexChoice(model.value);
        effort.hidden = !on;
        if (on) fill(effort, codexWorkerEfforts(codex, model.value, model.value === pick.model ? pick.effort : ''), effort.value);
        note.hidden = !on;
        note.textContent = on ? codexWorkerHint(codex) : '';
        onModel?.();
      };
      model.addEventListener('change', sync);
      effort.addEventListener('change', () => onModel?.());
      return { model, effort, note, value: () => workerValue(model.value, effort.hidden ? '' : effort.value),
        offer: (status) => { codex = status; fill(model, choices(status), model.value); sync(); },
        // The label names the model select; the effort select follows it (under it in the narrow panel), the Codex note under the hint.
        field: (label, hint) => { const f = field(label, model, hint); const row = el('div.row.wrap'); model.replaceWith(row); row.append(model, effort); f.append(note); return f; } };
    };
    const worker = level(project.workerModel, (codex) => workerModelChoices(settings, codex, project.workerModel), 'worker-model');
    // The studio default is the studio's, not this project's: it is saved to the studio's settings, before the project.
    const studio = level(storedStudioDefault(settings), (codex) => studioDefaultChoices(codex, storedStudioDefault(settings)), 'studio-worker-model',
      () => { worker.model.options[0].textContent = workerModelChoices({ workerModel: studio?.value() }, null)[0][1]; }); // the first choice names the default being chosen
    app.api.codexStatus?.().then((status) => { worker.offer(status); studio.offer(status); }).catch(() => {}); // not read: the Claude Code models and what is stored
    const saveBoth = async (partial) => {
      const patch = studioDefaultPatch(app.state.settings, studio.value());
      if (patch) {
        try { await app.api.patchSettings(patch); await app.loadStudio(); } catch (err) { return toastError(err, 'Could not save the studio default'); }
      }
      return onSave(partial);
    };
    return formShell('Identity', [...keys.map((k) => field(k[0].toUpperCase() + k.slice(1), ctl[k])),
      worker.field('Worker model', 'This project\'s workers, unless their task names a model. Applies to the next worker started; a running worker keeps its model.'),
      studio.field('Studio default', 'For every project that names no model. Applies to the next worker started.')], saveBoth, onCancel,
      () => ({ ...Object.fromEntries(keys.map((k) => [k, ctl[k].value.trim()]).filter(([k, v]) => k !== 'name' || v)), ...workerModelPatch(project, worker.value()) }));
  });
}
