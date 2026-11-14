// The Processes tab (beside Task inspector and Focus): a project as a hub with each run of the last hour as a node
// sending it progress reports. The picker at the head chooses whose runs: the open project (the default), another
// project with runs this hour, or All projects, where each project with runs has its own hub with its runs under it
// (capped, with how many more). The choice is kept for the session; a chosen project with nothing this hour falls
// back to the open one and says so. The edge's line is the run's state (process-words.js): dashed and moving while it
// works, dotted when queued, amber dashes while it waits for you, solid when done, red when it failed, faint when it
// stopped. A new latest action travels up the edge as a dot; a click on a node lists its reports under the graph. The
// reports are kept per run, so switching projects or views neither mixes nor drops them. Reduced motion keeps the
// lines and drops the movement.
import { el, clear } from './ui.js';
import { processModel, allProjectsModel, projectChoices, resolveChoice, addReport, pruneReports, countWords, nodeDetail, EDGE_WORDS, OPEN, ALL, NO_PROJECT } from './process-words.js';
import { agoWords } from './run-words.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  for (const k of kids) if (k) n.append(k);
  return n;
};
const txt = (s) => document.createTextNode(s);
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const CHOICE_KEY = 'atelier.processesOf';
const readChoice = () => { try { return sessionStorage.getItem(CHOICE_KEY) || OPEN; } catch { return OPEN; } };
const keepChoice = (v) => { try { sessionStorage.setItem(CHOICE_KEY, v); } catch { /* the choice lasts as long as the panel */ } };

// One group's geometry: the hub, then rows of three under it.
const PER_ROW = 3, ROW_H = 104, HUB_R = 24, FIRST = 110, GAP = 26;

export function createProcessGraph(app) {
  const reports = new Map(); // run id -> [{ text, at }]: this browser's memory of each run's latest actions
  let selected = null;
  let choice = readChoice();
  let optionsKey = '';
  const count = el('span.pg-count');
  const head = el('div.pg-head', el('span.overline', 'Processes'), count);
  const picker = el('select.input.pg-select', { 'aria-label': 'Whose processes to show' });
  picker.addEventListener('change', () => { choice = picker.value; keepChoice(choice); selected = null; render(); });
  const note = el('p.pg-note');
  const pick = el('div.pg-pick', picker);
  const stage = el('div.pg-stage');
  const legend = el('ul.pg-legend', { 'aria-label': 'What the lines mean' });
  for (const [edge, words] of EDGE_WORDS) {
    const li = el('li');
    li.append(svg('svg', { class: 'pg-key', width: 26, height: 8, 'aria-hidden': 'true' }, svg('line', { x1: 1, y1: 4, x2: 25, y2: 4, class: `pg-edge e-${edge}` })), txt(words));
    legend.append(li);
  }
  const detail = el('div.pg-detail');
  const node = el('div.process-graph', { role: 'region', 'aria-label': 'Processes' }, head, pick, note, stage, legend, detail);
  const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function choose(value) {
    choice = value; keepChoice(value); selected = null; render();
    picker.focus();
  }

  function syncPicker(choices, value) {
    const key = choices.map((c) => `${c.value}\u0001${c.label}`).join('\u0002');
    if (key !== optionsKey) {
      optionsKey = key;
      clear(picker, ...choices.map((c) => el('option', { value: c.value }, c.label)));
    }
    if (picker.value !== value) picker.value = value;
  }

  function render() {
    if (node.hidden || !node.isConnected) return;
    const now = Date.now();
    const runs = app.state.runs || [];
    const projects = app.state.projects || [];
    const activeId = app.state.activeProjectId || null;
    const fresh = new Set();
    for (const r of runs) if (addReport(reports, r, now)) fresh.add(r.id);
    pruneReports(reports, runs);

    const choices = projectChoices(runs, projects, { activeId, now });
    const view = resolveChoice(choice, choices, activeId);
    syncPicker(choices, view.value);
    const openName = app.state.bundle?.project?.name || projects.find((p) => p.id === activeId)?.name || 'This project';
    const keptName = projects.find((p) => p.id === choice)?.name || choice;
    clear(note, view.fellBack ? `${keptName} has had no runs this hour; showing ${openName} until it runs again.` : '');

    let groups;
    if (view.all) {
      const all = allProjectsModel(runs, projects, { activeId, now });
      groups = all.groups;
      const n = groups.length;
      clear(count, n ? `${n} project${n === 1 ? '' : 's'} · ${countWords(all) || 'nothing'} this hour` : 'nothing this hour');
    } else {
      const m = processModel(runs, { projectId: view.projectId, now });
      const name = view.projectId === activeId ? openName : view.projectId === null ? NO_PROJECT : projects.find((p) => p.id === view.projectId)?.name || view.projectId;
      groups = [{ projectId: view.projectId, name, open: view.projectId === activeId, ...m }];
      clear(count, m.nodes.length ? `${m.live} working · ${m.ended} ended this hour` : 'nothing this hour');
    }
    const shown = groups.flatMap((g) => g.nodes);
    if (!shown.some((n) => n.id === selected)) selected = (shown.find((n) => n.live) || shown[0])?.id || null;

    const W = Math.max(260, Math.floor(stage.getBoundingClientRect().width) || 320);
    const g = svg('svg', { class: 'pg-svg', width: W, role: 'group' });
    let y = 0;
    let first = null;
    for (const group of groups) {
      if (view.all && !group.nodes.length) continue;
      if (y) { g.append(svg('line', { x1: 16, x2: W - 16, y1: y + GAP / 2, y2: y + GAP / 2, class: 'pg-sep' })); y += GAP; }
      y += drawGroup(g, group, y, W, { all: view.all, fresh });
      first ??= group;
    }
    if (!groups.length || !groups.some((x) => x.nodes.length)) y = Math.max(y, 84);
    g.setAttribute('height', y);
    g.setAttribute('viewBox', `0 0 ${W} ${y}`);
    g.setAttribute('aria-label', view.all
      ? `All projects: ${groups.map((x) => `${x.name}, ${countWords(x) || 'nothing'}`).join('; ') || 'nothing this hour'}`
      : `${first?.name || openName}: ${groups[0].live} working, ${groups[0].ended} ended this hour`);
    clear(stage, g);
    if (!shown.length) {
      stage.append(el('p.pg-empty', view.all
        ? 'Nothing has run in any project in the last hour. Sessions, builds, phone boots, shells and queued workers show up here as they start.'
        : 'Nothing has run on this project in the last hour. Sessions, builds, phone boots and shells show up here as they start.'));
    }
    if (!view.all && groups[0].hidden) stage.append(el('p.pg-more', `${groups[0].hidden} more this hour; the timeline under the preview lists the open project's runs.`));
    renderDetail(groups);
  }

  /** Draws one hub and its runs from the top `y0`; returns the height used. */
  function drawGroup(g, group, y0, W, { all, fresh }) {
    const hubY = y0 + HUB_R + 4;
    const rows = Math.ceil(group.nodes.length / PER_ROW);
    const lastY = hubY + FIRST + (rows - 1) * ROW_H;
    const moreH = all && group.hidden ? 20 : 0;
    const h = group.nodes.length ? lastY - y0 + 56 + moreH : HUB_R * 2 + 36;
    const edges = svg('g');
    const nodes = svg('g');
    g.append(edges, nodes);
    group.nodes.forEach((n, i) => {
      const row = Math.floor(i / PER_ROW);
      const inRow = Math.min(PER_ROW, group.nodes.length - row * PER_ROW);
      const x = Math.round(W * ((i % PER_ROW) + 0.5) / inRow);
      const y = hubY + FIRST + row * ROW_H;
      // From the node to the hub, so the dashes and the report dots travel upward.
      const d = `M ${x} ${y - 20} C ${x} ${(y + hubY) / 2}, ${W / 2} ${(y + hubY) / 2 + 10}, ${W / 2} ${hubY + HUB_R}`;
      edges.append(svg('path', { d, class: `pg-edge e-${n.edge}${n.id === selected ? ' sel' : ''}` }));
      if (fresh.has(n.id) && n.live && !reduced()) {
        const move = svg('animateMotion', { dur: '0.9s', repeatCount: 1, fill: 'freeze', path: d, begin: 'indefinite' });
        // Hidden until it moves: before its motion begins the dot would sit at the SVG's corner.
        const dot = svg('circle', { r: 3.5, class: 'pg-report', visibility: 'hidden' }, move);
        edges.append(dot);
        requestAnimationFrame(() => { try { move.beginElement(); dot.setAttribute('visibility', 'visible'); } catch { /* no SMIL: no dot */ } setTimeout(() => dot.remove(), 1000); });
      }
      const label = `${all ? `${group.name}, ` : ''}${n.kindWords}: ${n.name}${n.department ? ` (${n.department} department)` : ''}. ${n.state}${n.latest ? `. Latest: ${n.latest}` : ''}`;
      const grp = svg('g', { class: `pg-node e-${n.edge}${n.live ? ' live' : ''}${n.id === selected ? ' sel' : ''}`, tabindex: 0, role: 'button', 'aria-label': label, 'data-run': n.id },
        svg('title', {}, txt(label)),
        svg('circle', { cx: x, cy: y, r: 20, class: 'pg-dot' }),
        svg('text', { x, y: y + 5, class: 'pg-mark', 'text-anchor': 'middle' }, txt(n.mark)),
        svg('text', { x, y: y + 36, class: 'pg-name', 'text-anchor': 'middle' }, txt(cut(n.name, Math.max(10, Math.floor(W / PER_ROW / 7))))),
        svg('text', { x, y: y + 50, class: 'pg-state', 'text-anchor': 'middle' }, txt(n.state)));
      const pickNode = () => { selected = n.id; render(); stage.querySelector(`[data-run="${CSS.escape(n.id)}"]`)?.focus(); };
      grp.addEventListener('click', pickNode);
      grp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickNode(); } });
      nodes.append(grp);
    });
    if (moreH) {
      nodes.append(svg('text', { x: W / 2, y: lastY + 56 + 10, class: 'pg-state pg-more-line', 'text-anchor': 'middle' }, txt(`+${group.hidden} more this hour`)));
    }
    // The hub: the project every run reports to. Among all projects it is a button that shows that project alone.
    const live = group.live > 0;
    const name = group.name || 'This project';
    const hubName = cut(name, Math.max(8, Math.floor((W / 2 - 40) / 8)));
    const hub = svg('g', { class: `pg-hub${live ? ' live' : ''}${all ? ' pickable' : ''}`, 'data-project': group.projectId ?? '' },
      svg('circle', { cx: W / 2, cy: hubY, r: HUB_R, class: 'pg-hub-dot' }),
      svg('text', { x: W / 2, y: hubY + 6, class: 'pg-hub-mark', 'text-anchor': 'middle' }, txt((name[0] || '?').toUpperCase())),
      svg('text', { x: W / 2 + 32, y: all ? hubY : hubY + 5, class: 'pg-hub-name' }, txt(hubName)),
      all ? svg('text', { x: W / 2 + 32, y: hubY + 15, class: 'pg-state' }, txt(`${countWords(group) || 'nothing'}${group.open ? ' · open' : ''}`)) : null);
    if (all) {
      const label = `${name}: ${countWords(group) || 'nothing this hour'}. Show only ${name}`;
      hub.setAttribute('tabindex', 0);
      hub.setAttribute('role', 'button');
      hub.setAttribute('aria-label', label);
      hub.prepend(svg('title', {}, txt(label)));
      const only = () => choose(group.open ? OPEN : (group.projectId ?? NO_PROJECT));
      hub.addEventListener('click', only);
      hub.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); only(); } });
    }
    nodes.append(hub);
    return h;
  }

  function renderDetail(groups) {
    let n = null, group = null;
    for (const gr of groups) { n = gr.nodes.find((x) => x.id === selected); if (n) { group = gr; break; } }
    if (!n) return clear(detail);
    const list = [...(reports.get(n.id) || [])].reverse();
    clear(detail,
      el('div.pg-detail-head', el('span', { class: `pg-state-word e-${n.edge}` }, n.state), el('strong', n.name), el('span.meta', nodeDetail(n, choice === ALL ? group.name : null))),
      list.length
        ? el('ol.pg-reports', list.map((r, i) => el('li', { class: i === 0 && n.live ? 'now' : '' }, el('span.pg-report-text', r.text), el('span.meta', agoWords(new Date(r.at).toISOString())))))
        : el('p.meta', n.live ? 'No report yet: it has just started.' : 'No reports were seen while this panel was open.'));
  }

  app.on?.('runs', render);
  app.on?.('bundle', render);
  // The reports stay: they are keyed by run, so another project's view shows the same log it showed before.
  app.on?.('project-switch', () => { selected = null; render(); });
  setInterval(() => { if (!node.hidden) render(); }, 30000).unref?.(); // the "ago" words age
  return { node, render };
}
