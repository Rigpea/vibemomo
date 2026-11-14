// Working now (docs/ARCHITECTURE.md section 16; DESIGN.md section 8): the open project's runs as the timeline section
// under the stage, as the reference's "Home / current run · 2 working, 1 queued": a header line, then one row per run
// (its number, its name with the live dot while it works, a bar on the last-hour axis, and the latest action as the
// state word over the action words), and a footer sentence. The Workbench hides it unless the person shows it (layout
// key runsShown, More · Show runs under the preview); shown, it stays on screen and says so when nothing runs. Every word comes from GET /api/runs; nothing is inferred.
import { el, clear } from './ui.js';
import { workingNowModel } from './run-words.js';

const TICK_MS = 30000;

/** update(runs, projectId, { name, note }) redraws from the project's runs; name: the project's; note: the server's. */
export function createWorkingNow({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const title = el('span.wn-title');
  const count = el('span.wn-count');
  const head = el('div.wn-head', title, count);
  const ticks = el('span.wn-ticks');
  const axis = el('div.wn-axis', { 'aria-hidden': 'true' }, el('span.wn-axis-label', 'Run'), ticks, el('span.wn-axis-label', 'Latest action'));
  const rows = el('ul.wn-rows');
  const foot = el('p.wn-foot');
  const node = el('section.working-now', { 'aria-label': 'Working now' }, head, axis, rows, foot);
  let runs = [];
  let name = '';
  let note = '';
  let model = null;
  let timer = null;

  const two = (n) => String(n + 1).padStart(2, '0');
  function rowNode(r, i) {
    const spec = `span.wn-bar${r.live ? '.live' : ''}${r.clipped ? '.clipped' : ''}`;
    return el('li.wn-row', { dataset: { run: r.id } },
      el('span.wn-who', el('span.wn-num', two(i)), el('span.wn-name', { title: r.name }, r.live ? el('span.wn-dot', { 'aria-hidden': 'true' }) : null, r.name)),
      el('div.wn-track', el(spec, { style: { left: `${(r.left * 100).toFixed(2)}%`, width: `${(r.width * 100).toFixed(2)}%` } })),
      el('div.wn-latest', el('span.wn-state', r.stateWords), el('span.wn-act', r.latest)));
  }

  function paint() {
    model = workingNowModel(runs, { now: now(), open: true, dismissedAt: 0 });
    const n = model?.count || 0;
    const ended = model?.ended || 0;
    clear(title, name ? `${name} / ${n ? 'current run' : 'no run'}` : 'No project');
    clear(count, n ? `${n} working${ended ? `, ${ended} ended this hour` : ''}` : ended ? `nothing working, ${ended} ended this hour` : 'nothing running');
    if (!model) {
      stopTimer();
      clear(ticks);
      clear(rows);
      clear(foot, note || 'Runs show here as the studio starts them: sessions, builds, boots and shells.');
      node.classList.add('empty');
      return;
    }
    node.classList.remove('empty');
    startTimer();
    clear(ticks, model.ticks.map((t) => el('span.wn-tick', { style: { left: `${(t.at * 100).toFixed(2)}%` } }, t.label)));
    clear(rows, model.rows.map(rowNode));
    clear(foot, n ? `${model.running.map((r) => r.name).join(', ')} ${n === 1 ? 'is' : 'are'} working; the bars cover the last hour.` : 'Nothing works now; what ended in the last hour stays listed.');
  }

  function startTimer() { if (!timer) timer = setTimer(paint, TICK_MS); }
  function stopTimer() { if (timer) { clearTimer(timer); timer = null; } }

  return {
    node,
    update(list, id, { name: projectName = '', note: serverNote = '' } = {}) {
      name = projectName;
      note = serverNote;
      runs = (list || []).filter((r) => r.projectId === id);
      paint();
    },
    model: () => model,
    destroy: stopTimer,
  };
}
