// The parts the dock's two session tabs share (workbenches/companion/panel.js and workbenches/codex/panel.js): the
// thread drawn through the transcript renderer, the live run's rows as console.chunk events arrive, the trajectory
// (the run's tool rows as time · verb · file), the state line and the pin cards. Each draws into a node its panel
// owns and holds no state of its own, so a panel keeps deciding what it shows; one style per part (DESIGN.md section 3).
import { el, clear, button, stateChip } from './ui.js';
import { renderTurn, orderedItems, liveTurn, toolRows } from './transcript.js';
import { trajectoryLabel, pinTitle } from './companion-words.js';

/** One console.chunk into a live run's items: text joins the text before it, a tool call or result is a row. */
export function addChunk(live, data) {
  const items = live.items;
  if (data.kind === 'text') {
    const last = items[items.length - 1];
    if (last?.kind === 'text') last.text += data.text || ''; else items.push({ kind: 'text', text: data.text || '' });
  } else items.push({ kind: data.kind, id: data.id, name: data.name, summary: data.summary, detail: data.detail, text: data.text, ok: data.ok, ms: data.ms });
}

/** When a session's running turn began: its last message's time (the record holds no start of its own). */
export const runStart = (s) => { const u = [...(s.turns || [])].reverse().find((t) => t.role === 'user'); const ms = Date.parse(u?.at); return Number.isFinite(ms) ? ms : Date.now(); };

/** The thread: the hint while nothing was said, the turns, then the running answer. Returns the live turn
 *  ({ node, body }) for drawLive, or null when nothing runs. The log is left scrolled to its end. */
export function drawThread(log, { session, running = false, live = null, hint = null }) {
  const turns = session.turns || [];
  let liveEl = null;
  if (running) {
    liveEl = liveTurn(session, !!live?.missed);
    clear(liveEl.body, orderedItems(live?.items || []));
  }
  clear(log,
    !turns.length && !running && hint ? el('p.meta.cmp-hint', hint) : null,
    turns.map((t) => renderTurn(t, session)),
    liveEl ? liveEl.node : null);
  log.scrollTop = log.scrollHeight;
  return liveEl;
}

/** The running answer again after a chunk; the log follows its end only when the person was reading there. */
export function drawLive(log, liveEl, live) {
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  clear(liveEl.body, orderedItems(live.items));
  if (stick) log.scrollTop = log.scrollHeight;
}

/** The run's tool rows: the live run's, or the last answer's once it finished. */
export function trajectoryEvents({ session = null, running = false, live = null } = {}) {
  if (running) return (live?.items || []).filter((x) => x.kind !== 'text');
  const last = [...(session?.turns || [])].reverse().find((t) => t.role !== 'user');
  return last?.events || [];
}

/** The trajectory's rows, or the sentence that stands for none; hidden folds it (the stacked layout). */
export function drawTrajectory(rowsNode, { session = null, running = false, live = null, hidden = false } = {}) {
  const rows = toolRows(trajectoryEvents({ session, running, live }), trajectoryLabel);
  clear(rowsNode, rows || el('p.meta', running ? 'No tool call yet.' : session ? 'No tool calls in the last answer.' : 'The run\'s tool calls show here.'));
  rowsNode.hidden = hidden;
}

/** The state line: the word as the chip, a dot and the reason, so it copies and reads aloud as "Working · 00:02 ·
 *  thinking". Stacked, the line is the button that opens and folds the trajectory. */
export function drawState(node, s, { stacked = false, open = false, onToggle = null } = {}) {
  const line = [stateChip(s.word, s.tone, `${s.word} · ${s.reason}`), el('span.cmp-sep', ' · '), el('span.cmp-reason', s.reason)];
  if (stacked) clear(node, el('button.cmp-state-btn', { type: 'button', 'aria-expanded': String(open), title: open ? 'Hide the tool calls' : 'Show the tool calls', onclick: onToggle }, line));
  else clear(node, line);
}

/** The pins under the thread: a card per pin (pressed: it rides the next message) and its Remove. */
export function drawPins(box, { pins = [], selected = new Set(), error = null, onToggle, onRemove }) {
  if (error) return clear(box, el('p.meta', `Pins not read: ${error.message}`));
  if (!pins.length) return clear(box);
  clear(box,
    el('h3.overline', `Pins · ${pins.length}`),
    el('ol.cmp-pin-list', pins.map((p, i) => {
      const on = selected.has(p.id);
      return el('li.cmp-pin',
        el('button.pin-card', {
          type: 'button', 'aria-pressed': String(on), dataset: { pin: p.id },
          title: on ? 'Selected: rides the next message. Press to leave it out' : 'Select it to attach it to the next message',
          onclick: () => onToggle(p, on),
        },
        el('span.pin-title', pinTitle(p, i + 1)),
        el('span.pin-meta', [p.text ? `"${p.text}"` : 'no text', p.page || null].filter(Boolean).join(' · '))),
        button('Remove', { small: true, variant: 'quiet', title: `Remove pin ${i + 1}`, onclick: () => onRemove(p) }));
    })));
}
