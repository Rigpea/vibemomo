// Game workbench panel: live telemetry from the preview's atelier:event messages and the
// readiness checklist. Real data only — nothing is shown until the game reports it.
import { el, clear, stateChip } from '/components/ui.js';
import { readinessChecklist } from '/components/readiness.js';

let state = null;

export function mount(container, ctx) {
  const link = el('div');
  const metrics = el('div.metric-row');
  const log = el('ul.event-log', { 'aria-live': 'off' });
  const checklist = readinessChecklist(ctx);
  container.append(el('div.wbp',
    el('div', el('h3', 'Telemetry'), link, metrics, el('h3', 'Last events'), log),
    checklist.node));
  state = { ctx, link, metrics, log, checklist, offs: [], timer: null };
  const { bus } = ctx;
  state.offs.push(bus.on('event', render), bus.on('ready', render), bus.on('reload', () => { render(); armTimer(); }));
  armTimer();
  render();
}

export function update() { state?.checklist.render(); }

export function unmount() {
  if (!state) return;
  state.offs.forEach((off) => off());
  clearTimeout(state.timer);
  state = null;
}

function armTimer() {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => state && render(), 3000);
}

function metric(k, v, title) { return el('div.metric', { title }, el('div.k', k), el('div.v', v)); }

function render() {
  if (!state) return;
  const { bus } = state.ctx;
  const evs = bus.events;
  const waited = Date.now() - bus.loadedAt > 2500;
  clear(state.link, bus.ready
    ? el('div.panel-bar', stateChip('Connected', 'ok'), el('span.meta', 'Live from the preview'))
    : el('div.panel-bar', stateChip(waited ? 'Not reporting' : 'Waiting', waited ? 'warn' : 'neutral', waited ? 'The preview may not include the studio link (atelier:ready), or it is still loading.' : ''), el('span.meta', waited ? 'No atelier:ready from the preview yet' : 'Waiting for the game to report ready')));
  if (!evs.length) {
    clear(state.metrics);
    clear(state.log, el('li.muted', 'Play in the preview to see events.'));
    return;
  }
  const jumps = evs.filter((e) => e.name === 'jump');
  const lastJump = jumps[jumps.length - 1];
  const cleared = [...evs].reverse().find((e) => e.name === 'cleared');
  const restarts = evs.filter((e) => e.name === 'restart').length;
  const landings = evs.filter((e) => e.name === 'land');
  const hardest = landings.reduce((m, e) => Math.max(m, Number(e.data?.speed) || 0), 0);
  clear(state.metrics,
    metric('Jumps this attempt', lastJump?.data?.jumps ?? jumps.length, 'From the jump event’s counter; resets on restart'),
    metric('Time to clear', cleared ? `${(cleared.data.timeMs / 1000).toFixed(1)} s` : '—', cleared ? `Cleared with ${cleared.data.jumps} jumps` : 'Not cleared since the preview loaded'),
    metric('Restarts', restarts),
    metric('Hardest landing', hardest ? `${hardest} px/s` : '—'),
    metric('Events', evs.length, 'Since the preview loaded'));
  clear(state.log, evs.slice(-14).reverse().map((e) => el('li', `${fmtT(e.t)}  ${e.name.padEnd(8)} ${summarize(e.data)}`)));
}

const fmtT = (t) => (typeof t === 'number' ? `${(t / 1000).toFixed(2)}s` : '   —  ').padStart(7);
function summarize(data = {}) {
  return Object.entries(data).slice(0, 4).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}
