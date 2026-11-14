// New project dialog (opened from the project list): create from a template, or import a folder.
import { el, clear, input, select, field, dialog, toast, toastError, segmented, button, shortLabel } from './ui.js';

const KINDS = ['game', 'web-app', 'action', 'audio'];
const IMPORT_KINDS = [['', 'detect automatically'], 'web-app', 'game', 'other'];

export function newProjectDialog(app) {
  const templates = app.state.templates || [];
  const name = input({ placeholder: 'e.g. My game', required: true });
  const kind = select(KINDS, 'game');
  const template = select([['', 'Blank (single index.html)'], ...templates.map((t) => [t.name, `${t.title} · ${t.kind}`])], templates[0]?.name || '');
  const purpose = input({ placeholder: 'What is it for? (optional)' });
  const inspiration = input({ placeholder: 'A game, site or sound (optional)' });
  const syncKind = () => { const t = templates.find((x) => x.name === template.value); if (t) kind.value = t.kind; kind.disabled = !!t; };
  template.addEventListener('change', syncKind);
  syncKind();
  const folder = input({ placeholder: 'C:\\Users\\…\\my-existing-project' });
  const importName = input({ placeholder: 'The folder name' });
  const importKind = select(IMPORT_KINDS, '');
  let nameTouched = false;
  importName.addEventListener('input', () => { nameTouched = !!importName.value.trim(); });
  const folderBase = () => folder.value.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const syncName = () => { if (!nameTouched) importName.value = folderBase(); };
  const refused = el('div', { role: 'status' }); // here from the start, so its words are announced when they come
  folder.addEventListener('input', () => { syncName(); clear(refused); }); // the refusal was about the path that was there
  // In the desktop app the system folder picker fills the path; in a browser it is typed.
  const pick = window.atelierDesktop?.pickFolder
    ? button('Choose folder…', { onclick: async () => {
      try {
        const chosen = await window.atelierDesktop.pickFolder();
        if (chosen) { folder.value = chosen; syncName(); clear(refused); }
      } catch (err) { toastError(err, 'Choose folder'); }
    } })
    : null;

  let mode = 'create';
  const createPart = el('div', field('Name', name), el('div.fields-2', field('Template', template), field('Kind', kind)), field('Purpose', purpose), field('Inspiration', inspiration));
  const folderField = field('Folder', folder);
  if (pick) folderField.append(el('div.row', { style: { gap: '8px', marginTop: '8px' } }, pick));
  folderField.append(refused);
  const importPart = el('div', folderField,
    el('div.fields-2', field('Name', importName), field('Kind', importKind, 'Detect: the kind in the folder\'s atelier.json, else web-app.')),
    el('p.hint', "The folder stays where it is. Git is set up if needed. A CLAUDE.md and a .studio folder are added to the folder. A folder that was in the studio before comes back with its name, kind, records, versions and tasks; any other folder's current state becomes version #1."));
  const body = el('form', { onsubmit: (e) => { e.preventDefault(); submit(); } });
  const seg = segmented([['create', 'New'], ['import', 'Import a folder']], mode, (m) => {
    mode = m;
    createPart.hidden = m !== 'create';
    importPart.hidden = m !== 'import';
    const confirm = d.node.querySelector('.dialog-actions .btn.primary');
    if (confirm) confirm.textContent = m === 'create' ? 'Create project' : 'Import';
    (m === 'create' ? name : folder).focus();
  }, { label: 'New or import' });
  importPart.hidden = true;
  clear(body, el('div', { style: { marginBottom: '16px' } }, seg.node), createPart, importPart, el('button', { type: 'submit', hidden: true }));

  /** The folder is already a project: nothing is wrong with the dialog's state, so it says so here and offers that project. */
  function showRefusal(err) {
    const { id, name: registered } = err.project;
    clear(refused, el('div.row', { style: { gap: '8px', marginTop: '8px' } }, el('span.small', err.message),
      button(`Show ${shortLabel(registered, 28)}`, { small: true, variant: 'quiet', 'aria-label': `Show ${registered}`, onclick: async () => {
        d.close(true);
        try {
          if (!app.state.projects?.some((p) => p.id === id)) await app.loadStudio(); // registered from elsewhere since the list came
          await app.selectProject(id);
          app.go('workbench');
        } catch (e) { toastError(e, `Show ${registered}`); }
      } })));
  }

  async function submit(close = d.close) {
    clear(refused);
    try {
      if (mode === 'create') {
        if (!name.value.trim()) return name.focus();
        const out = await app.api.createProject({ name: name.value.trim(), kind: kind.value, template: template.value || null, purpose: purpose.value.trim(), inspiration: inspiration.value.trim() });
        close(true);
        toast(`Created ${out.project.name} with version #1`, { tone: 'ok', clears: 'New project' });
        await app.loadStudio();
        await app.selectProject(out.project.id);
      } else {
        if (!folder.value.trim()) return folder.focus();
        const out = await app.api.importProject({ path: folder.value.trim(), name: importName.value.trim() || null, kind: importKind.value || null });
        close(true);
        toast(`Imported ${out.project.name}`, { tone: 'ok', clears: 'Import' });
        await app.loadStudio();
        await app.selectProject(out.project.id);
      }
      app.go('workbench');
    } catch (err) {
      if (err.code === 'already_registered' && err.project) showRefusal(err);
      else toastError(err, mode === 'create' ? 'New project' : 'Import');
    }
  }

  const d = dialog({
    title: 'New project',
    body,
    actions: [{ label: 'Cancel', value: false }, { label: 'Create project', variant: 'primary', run: (close) => submit(close) }],
  });
  name.focus();
  return d.done;
}
