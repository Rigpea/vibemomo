// "New session" dialog of the Claude Code section: the only place a backend is chosen, each
// with its one-line account statement and availability as plain text.
import { el, clear, select, field, dialog, toastError } from './ui.js';
import { BACKENDS } from './transcript.js';

export const MODES = [['plan', 'plan: read only'], ['acceptEdits', 'acceptEdits: may edit files'], ['bypassPermissions', 'bypassPermissions: runs anything']];
export const CONTEXTS = [['none', 'No context'], ['briefing', 'Project briefing'], ['history', 'Earlier turns of this session']];

/** Resolves with {session, context} once created, or undefined when cancelled. */
export function newSessionDialog(app, { backends, backendsError, models, start = 'claude-code' }) {
  const info = (id) => backends?.find((b) => b.id === id) || null;
  const availability = (id) => {
    if (!backends) return backendsError ? 'availability unknown' : 'checking…';
    const i = info(id);
    return i?.available ? 'available' : `unavailable${i?.detail ? `: ${i.detail}` : ''}`;
  };
  // The last used backend unless it cannot run; then the first that can. With none available the choice stays, and Create is disabled.
  // A backend with its own tab (Codex: the Workbench's Codex tab holds its model, effort and sandbox) is not offered here.
  const offered = Object.entries(BACKENDS).filter(([, b]) => !b.ownTab);
  if (!offered.some(([id]) => id === start)) start = 'claude-code';
  const initial = backends && !info(start)?.available ? offered.map(([id]) => id).find((id) => info(id)?.available) || start : start;
  const studioProject = app.state.projects.find((p) => p.kind === 'studio');
  const projectOpts = [
    ...app.state.projects.map((p) => [p.id, `${p.name}${p.kind === 'studio' && !/studio/i.test(p.name) ? ' (studio)' : ''}`]),
    ...(studioProject ? [] : [['', `The studio (${app.state.studio?.dir || 'studio folder'})`]]),
  ];
  const choices = el('fieldset', { style: { border: 0, padding: 0, margin: '0 0 16px' } },
    el('legend.small', { style: { color: 'var(--ink-2)', fontWeight: 500, marginBottom: '4px', padding: 0 } }, 'Talk to'),
    offered.map(([id, b]) => el('label.choice',
      el('input', { type: 'radio', name: 'backend', value: id, checked: id === initial }),
      el('span.item-title', b.label, el('span.meta', { style: { fontWeight: 400 } }, ` · ${availability(id)}`)),
      el('span.item-meta', b.account))));
  const backendValue = () => choices.querySelector('input:checked')?.value || 'claude-code';
  const project = select(projectOpts, app.projectId() || studioProject?.id || '');
  const model = select(models, models.includes('claude-opus-5-5') ? 'claude-opus-5-5' : models[0]);
  const mode = select(MODES, 'plan');
  const modeWarn = el('div');
  const ctx = select(CONTEXTS, 'briefing');
  const allowCli = el('input', { type: 'checkbox' });
  const studioTools = el('input', { type: 'checkbox' });
  // Model and mode each get the full width so the mode labels are never cut.
  const ccPart = el('div', field('Model', model), field('Permission mode', mode), modeWarn,
    el('label.check', allowCli, el('span', 'Run node, npm run, npm test and git read commands without asking (lets Claude Code report task progress through the studio CLI; node itself is unrestricted, so this is not a sandbox)')),
    el('label.check', studioTools, el('span', 'Studio tools: the studio\'s own tools run without asking (read the project, look at its phone, move this window, create tasks, add unresolved items and memory, keep versions; nothing that pushes, deletes, restores, exports or spends on the API). The studio must stay running.')));
  const otherPart = el('div', field('Context', ctx, 'Added to each message; you can change it per message.'));
  const status = el('div');
  const reason = el('span.meta.dialog-reason');
  let createBtn = null;
  const command = String(app.state.settings?.console?.command || '').trim();
  const sync = () => {
    const id = backendValue();
    const i = info(id);
    const noCommand = id === 'command' && !command;
    const blocked = noCommand || (!!i && !i.available);
    ccPart.hidden = id !== 'claude-code';
    otherPart.hidden = id === 'claude-code';
    clear(modeWarn, id === 'claude-code' && mode.value === 'bypassPermissions' ? el('div.note.warn', 'bypassPermissions lets Claude Code run any command and edit any file in the folder without asking.') : null);
    clear(status, noCommand ? el('div.note.warn', 'No command set: Settings › Console')
      : blocked ? el('div.note.warn', BACKENDS[id].fix)
        : id === 'command' ? el('div.note', { style: { overflowWrap: 'anywhere' } }, `Runs: ${command} (Settings › Console)`) : null);
    clear(reason, blocked ? `${BACKENDS[id].label} is unavailable${i?.detail ? `: ${i.detail}` : '.'}` : null);
    if (createBtn) createBtn.disabled = blocked;
  };
  choices.addEventListener('change', sync);
  mode.addEventListener('change', sync);
  sync();
  const dlg = dialog({
    title: 'New session',
    body: el('div', choices, status, field('Project', project, 'Claude Code runs in this folder and reads the project briefing when the session starts, so memory changes reach new sessions, not open ones. API and Command use the briefing as context.'), ccPart, otherPart),
    actions: [
      { label: 'Cancel', value: false },
      { label: 'Create session', variant: 'primary', run: async (close) => {
        const id = backendValue();
        const body = { backend: id, projectId: project.value || null };
        if (id === 'claude-code') Object.assign(body, { model: model.value, permissionMode: mode.value, allowStudioCli: allowCli.checked, ...(studioTools.checked ? { tools: 'studio' } : {}) });
        try {
          const out = await app.api.consoleCreate(body);
          close({ session: out.session || out, context: id !== 'claude-code' ? ctx.value : null });
        } catch (err) { toastError(err, 'New session'); }
      } },
    ],
  });
  createBtn = dlg.node.querySelector('.dialog-actions .btn.primary');
  dlg.node.querySelector('.dialog-actions').prepend(reason);
  sync();
  return dlg.done;
}
