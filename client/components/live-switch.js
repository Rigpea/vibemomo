// The Workbench's Live switch (docs/ARCHITECTURE.md section 20): shown only when the project's atelier.json declares
// live. The switch, a state chip with its reason, and a Live log disclosure (masked by the server). The first start
// of a command asks the person to allow it, showing the exact argv and folder. Nothing starts without a click.
// onChange(running, flipped) after every new state: flipped tells the Workbench to show the live URL in the frame
// (running) or the files on disk again; the reason of a failure is the Workbench's line under the preview (words()),
// because the toolbar has no room for it at laptop width.
import { el, clear, button, stateChip, dialog, toast, toastError } from './ui.js';
import { api } from '../api.js';
import { liveWords, argvText, hostOf, LIVE_NOTE } from './live-words.js';

const LOG_SHOWN = 200;

export function createLiveSwitch(app, { onChange } = {}) {
  const box = el('input', { type: 'checkbox', role: 'switch', onchange: () => toggle(box.checked) });
  const sw = el('label.check.live-switch', box, el('span', 'Live'));
  const chipSlot = el('span.live-state');
  const logCount = el('span.live-log-count');
  const info = el('div.live-log-info');
  const lines = el('pre.live-log-lines', { tabindex: '0', 'aria-label': 'Live log, newest last' });
  const details = el('details.wb-more.live-log', { ontoggle: () => { if (details.open) { refresh(); armClose(); } } },
    el('summary.btn.quiet.sm', { title: 'Live log: what Live runs and what it printed (the token is masked)', 'aria-label': 'Live log' }, 'Log', logCount),
    el('div.wb-more-menu.live-log-menu', { role: 'region', 'aria-label': 'Live log' }, info, lines));
  const node = el('span.live-ctl', { hidden: true }, sw, chipSlot, details);
  let projectId = null;
  let declared = false;
  let status = null;
  let busy = false;
  let seq = 0;

  function armClose() {
    const close = (ev) => { if (!details.contains(ev.target)) { details.open = false; document.removeEventListener('pointerdown', close); } };
    document.addEventListener('pointerdown', close);
  }

  const running = () => status?.state === 'running';

  function set(s) {
    const was = running();
    status = s;
    draw();
    onChange?.(running(), running() !== was);
  }

  async function refresh() {
    if (!projectId) return;
    const id = projectId;
    const my = ++seq;
    try {
      const s = await api.live(id);
      if (id === projectId && my === seq) set(s);
    } catch (err) {
      if (id !== projectId || my !== seq) return;
      status = { state: 'failed', reason: `the studio did not answer: ${err.message}`, declared: null, consent: {}, log: [] };
      draw();
      onChange?.(running(), false);
    }
  }

  function draw() {
    const show = declared || (status && ['starting', 'running'].includes(status.state));
    node.hidden = !show;
    if (!show) return;
    const w = liveWords(status);
    const label = status?.declared?.label || status?.running?.label || 'Live';
    box.checked = w.state === 'starting' || w.state === 'running';
    box.disabled = busy || w.state === 'invalid' || !status;
    box.setAttribute('aria-label', `Live: ${label}`);
    sw.title = w.state === 'invalid' ? `atelier.json's live entry is not valid: ${w.reason}` : `${label}. On runs the project's own server and shows it in the preview; off returns to the files on disk.`;
    clear(chipSlot, stateChip(w.chip, w.tone, w.reason ? `${w.chip}: ${w.reason}` : w.chip));
    const log = status?.log || [];
    logCount.textContent = log.length ? ` · ${log.length}` : '';
    const cmd = status?.running && box.checked ? status.running : status?.declared;
    clear(info,
      el('p.live-log-label', label),
      cmd ? el('p.small', el('span.muted', 'Command '), el('code', argvText(cmd.command))) : null,
      status?.cwdPath ? el('p.small', el('span.muted', 'Folder '), el('code', status.cwdPath)) : null,
      status?.url ? el('p.small', el('span.muted', 'Address '), el('code', status.url)) : null,
      status?.problem ? el('p.small.live-problem', `atelier.json's live entry is not valid: ${status.problem}`) : null,
      el('p.small.muted', LIVE_NOTE),
      status?.consent?.allowed && !box.checked
        ? button('Forget the allowance', { small: true, variant: 'quiet', title: 'The next start asks again', onclick: forget })
        : null);
    lines.textContent = log.length ? log.slice(-LOG_SHOWN).map((l) => `${l.stream === 'stderr' ? '! ' : ''}${l.text}`).join('\n') : 'Nothing printed yet.';
    if (details.open) lines.scrollTop = lines.scrollHeight;
  }

  async function forget() {
    try { set(await api.liveForget(projectId)); toast('Live will ask again before it starts', { timeout: 2500 }); } catch (err) { toastError(err, 'Allowance not forgotten'); }
  }

  /** The person's question: the exact argv and folder, before anything runs. Resolves true when allowed. */
  function askConsent(s) {
    const d = s.declared;
    return dialog({
      title: 'Allow this project\'s live server?',
      body: el('div.prose.live-consent',
        el('p', el('strong', d.label)),
        el('p', s.consent?.changed ? 'The command changed since you allowed it. The studio will run this command, without a shell:' : 'The studio will run this command, without a shell:'),
        el('pre.live-cmd', argvText(d.command)),
        el('p', 'in this folder:'),
        el('pre.live-cmd', s.cwdPath || d.cwd),
        el('p.small.muted', 'It runs as you, with your files, until you switch Live off, open another project or quit the studio. The studio asks again if the command or the folder changes.')),
      actions: [{ label: 'Cancel', value: false }, { label: 'Allow and start', variant: 'primary', value: true }],
    }).done.then((v) => v === true);
  }

  async function toggle(on) {
    if (!projectId || busy) return;
    const id = projectId;
    busy = true;
    draw();
    try {
      if (!on) { set(await api.liveStop(id)); return; }
      let s = status || await api.live(id);
      if (!s.declared) throw new Error(s.problem ? `atelier.json's live entry is not valid: ${s.problem}` : 'This project declares no live server');
      if (!s.consent?.allowed) {
        if (!(await askConsent(s)) || id !== projectId) return;
        s = await api.liveAllow(id, { command: s.declared.command, cwd: s.declared.cwd });
        if (id === projectId) set(s);
      }
      const started = await api.liveStart(id, { origin: location.origin });
      if (id === projectId) set(started);
    } catch (err) {
      if (id === projectId) toastError(err, on ? 'Live did not start' : 'Live did not stop');
      await refresh();
    } finally {
      busy = false;
      if (id === projectId) draw();
    }
  }

  const offLive = app.on('live', (d) => {
    if (!d || d.projectId !== projectId) return;
    if (d.log && !details.open) return; // a log line: the count catches up on the next state change or when opened
    refresh();
  });

  return {
    node,
    running,
    /** The state in words while the project declares live (or runs it), else null. */
    words: () => (node.hidden ? null : liveWords(status)),
    label: () => status?.running?.label || status?.declared?.label || 'Live',
    host: () => hostOf(status?.url),
    /** Another project (or none): forget the old state without telling the Workbench, which reloads anyway. */
    setProject(b) {
      projectId = b?.project?.id || null;
      declared = !!b?.manifest?.live;
      status = null;
      seq++;
      details.open = false;
      draw();
      if (projectId) refresh();
    },
    /** The same project's bundle again: atelier.json may have gained, changed or lost its live entry. */
    update(b) {
      const had = declared;
      declared = !!b?.manifest?.live;
      if (declared || had) refresh(); else draw();
    },
    destroy() { offLive?.(); },
  };
}
