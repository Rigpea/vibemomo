// Transcript turns for the Claude Code section (DESIGN.md §3 "Transcript turn"): an 80px label
// column, the content, and one muted meta line in a fixed order:
//   model · duration · tokens · who pays
import { el, stateChip } from './ui.js';
import { markdown } from './markdown.js';
import { matchRows } from './transcript-match.js';

export const BACKENDS = {
  'claude-code': {
    label: 'Claude Code',
    account: 'Runs the claude CLI on this machine with your own login; turns count against your Claude Code plan.',
    fix: 'Install Claude Code and log in (run `claude` once in a terminal), or set the claude path in Settings › Console.',
  },
  api: {
    label: 'API',
    account: 'One bounded turn on the studio API key, within the budget ceiling.',
    fix: 'Add an API key in Settings; if the budget is paused, resume it on the Budget page.',
  },
  command: {
    label: 'Command',
    account: 'Runs the command line set in Settings › Console; local models use this computer.',
    fix: 'Set a command in Settings › Console (for example: ollama run llama3.2).',
  },
  codex: {
    label: 'Codex',
    account: 'Runs the codex CLI on this machine with the login you saved in it; turns count against that login.',
    fix: 'Install the Codex CLI and run `codex login` in a terminal, or set the codex path in Settings › Console.',
    ownTab: true, // started from the Workbench's Codex tab, not from the New session dialog
  },
};
export const backendLabel = (id) => BACKENDS[id]?.label || id || 'Assistant';

function fmtMs(ms) {
  if (typeof ms !== 'number') return null;
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}
const num = (n) => (typeof n === 'number' ? n.toLocaleString() : null);

/** The one meta line under an answer. */
export function metaLine(t, s) {
  const models = Object.keys(t.modelUsage || {});
  const u = t.usage || {};
  const inTok = num(u.input_tokens ?? u.inputTokens);
  const outTok = num(u.output_tokens ?? u.outputTokens);
  const cache = num(u.cache_read_input_tokens ?? u.cacheReadInputTokens);
  const cost = typeof t.costUsd === 'number' ? `$${t.costUsd.toFixed(t.costUsd < 0.01 ? 4 : 2)}` : null;
  const backend = t.backend || s.backend;
  // A Codex turn says which login ran it, as `codex login status` named it when the turn started (server/lib/codex.mjs).
  const codexPays = t.login === 'chatgpt' ? 'on your ChatGPT login' : t.login === 'api-key' ? 'billed to the API key saved in Codex' : 'on your Codex login';
  const pays = backend === 'claude-code' ? `covered by your Claude Code plan${cost ? ` (${cost} at list price)` : ''}`
    : backend === 'api' ? (cost ? `${cost} charged to API credits` : t.isError || t.cancelled ? null : 'charged to API credits')
      : backend === 'codex' ? codexPays
        : backend === 'command' ? null : cost;
  // A command answer names what answered first: "local command: ollama run llama3.2 · 76 ms".
  const command = backend === 'command' ? `local command${t.command ? `: ${t.command}` : ''}` : null;
  const parts = [
    t.cancelled ? 'cancelled' : null,
    typeof t.exitCode === 'number' && t.exitCode !== 0 ? `exit code ${t.exitCode}` : null,
    command,
    models.length ? models.join(', ') : backend === 'claude-code' ? 'model not reported' : backend === 'codex' ? [t.model, t.effort ? `${t.effort} effort` : null, t.sandbox ? `sandbox ${t.sandbox}` : null].filter(Boolean).join(', ') || null : null,
    fmtMs(t.durationMs),
    inTok || outTok ? `${inTok ?? '—'} in / ${outTok ?? '—'} out${cache ? ` · ${cache} cache read` : ''}` : null,
    contextLabel(t.contextUsed),
    pays,
  ].filter(Boolean);
  return parts.length ? el('div.turn-meta', parts.join(' · ')) : null;
}

/** What a command turn sent along with the message (turn.contextUsed), if anything. */
function contextLabel(c) {
  if (!c || c === 'none') return null;
  if (c === true || c === 'briefing') return 'with the project briefing';
  if (c === 'history') return 'with the recent messages';
  return typeof c === 'string' ? `with ${c}` : null;
}

const label = (name, summary) => [name, summary].filter(Boolean).join(' · ');
const clip = (s, n = 160) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** One row as nodes. A refused call (denied) is an amber chip as soon as the denial arrives, a
 *  failed result a red chip (DESIGN.md §3: chips are states); a successful result is one muted
 *  line under its call that expands to the full result when the server sent one. callLabel is used only when it is
 *  a function: a default parameter covers undefined alone, and flatMap(rowNodes) once passed the row's index here. */
const callName = (e) => label(e.name, e.summary);
/** callNode(e, text), when a function: the content of a plain call's line in place of its text (the Activity rows put
 *  a file button there); refusals and failures stay text, since they are chips. */
export function rowNodes(r, callLabel, callNode) {
  if (typeof callLabel !== 'function') callLabel = callName;
  if (r.orphan) {
    const text = `${r.tone === 'warn' ? 'denied' : 'failed'}: ${callLabel(r.orphan)}`;
    return [el('div.ev-state', stateChip(text, r.tone, text))];
  }
  if (r.line) { const text = r.line.text || label(r.line.name, r.line.summary); return [el('div', { title: text }, text)]; }
  const call = callLabel(r.e);
  if (r.denied) return [el('div.ev-state', stateChip(`denied: ${call}`, 'warn', `Refused by the permission mode, so it did not run.\n${call}`))];
  if (r.result && r.result.ok === false) return [el('div.ev-state', stateChip(`failed: ${call}`, 'danger', r.result.summary || 'The tool reported an error'))];
  return [el('div', { title: call }, typeof callNode === 'function' ? callNode(r.e, call) : call), ...(r.result ? resultNodes(r.result) : [])];
}

// Results the person opened; kept by event object so a live re-render does not collapse them.
const OPENED = new WeakSet();

/** A successful result: one muted line; with `detail` (the server's result text, up to 4000
 *  chars) the line is a disclosure that shows it in a scrollable block under the line. */
function resultNodes(res) {
  if (!res.summary && !res.detail) return [];
  if (!res.detail) return [el('div.tool-result', { title: res.summary }, clip(res.summary))];
  const pre = el('pre.tool-detail', { tabIndex: 0, 'aria-label': 'Full tool result' }, res.detail);
  const line = el('div.tool-result.disclosure', { role: 'button', tabIndex: 0 }, clip(res.summary || res.detail));
  const set = (open) => {
    pre.hidden = !open;
    line.setAttribute('aria-expanded', String(open));
    line.title = open ? 'Hide the full result' : 'Show the full result';
    if (open) OPENED.add(res); else OPENED.delete(res);
  };
  line.addEventListener('click', () => set(pre.hidden));
  line.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(pre.hidden); } });
  set(OPENED.has(res));
  return [line, pre];
}

/** Tool calls, their results and status lines as plain muted lines. */
export function eventLines(events = []) {
  if (!events?.length) return null;
  return el('div.turn-events', matchRows(events).filter(Boolean).flatMap((r) => rowNodes(r)));
}

/** The tool rows alone (status lines left out), each call drawn with callLabel(event) and its result, refusal or
 *  failure as renderTurn draws them: the Companion tab's trajectory ("00:19 · Edit · welcome.mjs"). */
export function toolRows(events = [], callLabel, callNode) {
  const rows = matchRows(events.filter((e) => e.kind !== 'status' && e.kind !== 'text')).filter(Boolean);
  return rows.length ? el('div.turn-events.traj', rows.flatMap((r) => rowNodes(r, callLabel, callNode))) : null;
}

/** The live answer in arrival order: items are {kind:'text', text} segments and tool/status
 *  events, appended as chunks arrive. Consecutive events form one muted block. */
export function orderedItems(items = []) {
  const events = items.filter((x) => x.kind !== 'text');
  const rows = matchRows(events);
  const rowOf = new Map(events.map((e, i) => [e, rows[i]]));
  const out = [];
  let block = null;
  for (const it of items) {
    if (it.kind === 'text') {
      block = null;
      if (it.text) out.push(markdown(it.text, 'prose md'));
      continue;
    }
    const r = rowOf.get(it);
    if (!r) continue;
    if (!block) { block = el('div.turn-events'); out.push(block); }
    block.append(...rowNodes(r));
  }
  return out;
}

const turn = (cls, who, ...body) => el(`div.turn${cls}`, el('div.turn-who', who), el('div.turn-body', ...body));

export function renderTurn(t, s) {
  // A worker's report reaches the manager as a message the studio sent (server/lib/workers.mjs): it reads as the studio's.
  if (t.role === 'user' && String(t.text || '').startsWith('[Studio report: not from the person]')) return turn('.user.studio-report', 'Studio', el('div.turn-text', t.text.replace('[Studio report: not from the person] ', '')));
  if (t.role === 'user') return turn('.user', 'You', el('div.turn-text', t.text), t.pending ? el('div.turn-meta', 'sending…') : null);
  // The backend refused before anything was sent: one line, and no meta line because nothing ran.
  if (t.refused) return turn('.error', backendLabel(s.backend), el('p.turn-refused', t.error));
  if (t.signedOut) return turn('.error', backendLabel(s.backend), (t.backend || s.backend) === 'codex' ? codexSignedOutNote(t) : signedOutNote(t), metaLine(t, s));
  const failed = t.isError && !t.cancelled;
  return turn(failed ? '.error' : '', backendLabel(s.backend),
    eventLines(t.events),
    t.text ? markdown(t.text, 'prose md') : failed ? el('div.note.danger', t.error || 'The run ended with an error.') : el('p.meta', t.cancelled ? 'Stopped before any text.' : '(no text)'),
    t.text && failed && t.error ? el('div.note.danger', t.error) : null,
    metaLine(t, s));
}

/** A turn the CLI could not run for want of a sign-in (decision row 129): what happened, what to do, its own words. */
export function signedOutNote(t) {
  return el('div.note.danger.signed-out', { role: 'alert' },
    el('p', 'Claude Code is signed out on this machine, so this message was not run.'),
    el('p', 'Sign in through ', el('a', { href: '#/settings' }, 'Settings › Connected accounts'), ', then send the message again.'),
    t.text ? el('p.meta', `Claude Code said: ${String(t.text).split('\n')[0].slice(0, 200)}`) : null);
}

/** A Codex turn that found no login: the server's one sentence (what happened, what to do, Codex's own words). */
export function codexSignedOutNote(t) {
  return el('div.note.danger.signed-out', { role: 'alert' }, el('p', t.error || 'Codex is signed out on this machine: run `codex login` in a terminal, then send the message again.'));
}

/** The live (streaming) turn: returns {node, body}; body takes orderedItems(). missedEarly: the
 *  run started more than 5 s before this view opened, so its earlier output is not shown yet. */
export function liveTurn(s, missedEarly) {
  const body = el('div');
  const node = el('div.turn.live', { 'aria-busy': 'true' },
    el('div.turn-who', backendLabel(s.backend)),
    el('div.turn-body', body,
      el('div.turn-meta', 'answering', el('span.spinner', { 'aria-hidden': 'true' })),
      missedEarly ? el('p.meta', 'Output that arrived before this view opened appears when the turn finishes.') : null));
  return { node, body };
}
