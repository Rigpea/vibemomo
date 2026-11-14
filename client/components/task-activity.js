// The Activity part of a task row (docs/ARCHITECTURE.md section 4): the Chat session that runs the task, drawn with
// the Companion tab's pieces. Who runs it (brainLine), the request's first sentence as its intent when it says more
// than the title (intentLine; a title made from the request is that sentence, so no line repeats it), the session's
// state in one word and its reason (companionState), then its tool calls as time · verb · file rows (toolRows with
// trajectoryLabel), each result opening to its full text as rowNodes does. Every row is one of the session's own
// events; nothing is summarised or invented. Records are read lazily (on open, or at once for a running session) and
// grow live from the app's 'console' topic without a fetch per chunk; the record is read once more when a run ends.
import { el, clear, button, stateChip } from './ui.js';
import { toolRows } from './transcript.js';
import { matchRows } from './transcript-match.js';
import { brainLine, trajectoryLabel, companionState, questionWords, toolObject, intentLine, firstSentenceOf } from './companion-words.js';
import { projectRel, fileOfEvent } from './source-words.js';

export const TERMINAL_LINE = 'Activity: the studio does not see a terminal session\'s tool calls';
export { intentLine, firstSentenceOf }; // the words live in companion-words.js (the server puts intent on task summaries)

/** The tool events of a record in order: every assistant turn's, then the live run's. */
export function activityEvents(session, live) {
  const stored = (session?.turns || []).filter((t) => t.role !== 'user').flatMap((t) => t.events || []);
  return [...stored, ...(live?.items || [])].filter((e) => e.kind !== 'status' && e.kind !== 'text');
}

/** The count in the summary: the rows toolRows draws (calls and unmatched refusals or failures). */
export const rowCount = (events) => matchRows(events).filter(Boolean).length;

export function activitySummary(n) {
  if (n === null) return 'Activity';
  return `Activity · ${n ? `${n} tool call${n === 1 ? '' : 's'}` : 'no tool calls yet'}`;
}

/** The state line's words: the Companion tab's vocabulary, with the task row's two reasons (no turn yet, a question). */
export function activityState({ session, running, startedAt, lastTool, now = Date.now() }) {
  const s = companionState({ session, running, startedAt, lastTool, now });
  if (!running && session && !(session.turns || []).length) return { ...s, reason: 'not started' };
  if (s.word === 'Needs you') {
    const last = [...(session.turns || [])].reverse().find((t) => t.role !== 'user');
    return { ...s, reason: questionWords(last?.text) || s.reason };
  }
  return s;
}

const runStart = (s) => { const u = [...(s?.turns || [])].reverse().find((t) => t.role === 'user'); const ms = Date.parse(u?.at); return Number.isFinite(ms) ? ms : Date.now(); };

/**
 * One controller per task list. node(t, source) draws a row's Activity; source is null (no session, no line),
 * { terminal: true } (the one sentence), or { id, running } (the session and whether the sessions list says it runs).
 */
export function createActivity(app) {
  const recs = new Map(); // session id -> { session, error, loading, running, live: { items, startedAt, missed } | null }
  const open = new Set(); // task ids whose Activity the person left open
  const autoOpened = new Set(); // session ids already opened by themselves once seen running
  let mounted = new Map(); // session id -> { t, summary, body, state } of the latest render
  let timer = null;
  const off = typeof app.on === 'function' ? app.on('console', onEvent) : null;

  const rec = (sid) => { if (!recs.has(sid)) recs.set(sid, { session: null, error: null, loading: false, running: false, live: null }); return recs.get(sid); };

  async function load(sid) {
    const r = rec(sid);
    if (r.loading) return;
    r.loading = true;
    r.error = null;
    paint(sid);
    try {
      const out = await app.api.consoleGet(sid);
      const session = out?.session || out;
      keepIdentity(session, r.live);
      r.session = session;
      if (session.status === 'running') {
        if (!r.running || !r.live) r.live = { items: r.live?.items || [], startedAt: r.live?.startedAt || runStart(session), missed: !r.live };
        r.running = true;
      } else { r.running = false; r.live = null; }
    } catch (err) {
      r.error = err;
    } finally {
      r.loading = false;
    }
    tick();
    paint(sid);
  }

  /** A run that ended is read again; its events that arrived live keep their objects, so an opened result stays open. */
  function keepIdentity(session, live) {
    if (!live?.items?.length) return;
    const byKey = new Map(live.items.filter((x) => x.id).map((x) => [`${x.kind}:${x.id}`, x]));
    for (const t of session.turns || []) {
      t.events = (t.events || []).map((e) => { const mine = e.id && byKey.get(`${e.kind}:${e.id}`); return mine ? Object.assign(mine, e) : e; });
    }
  }

  function onEvent({ name, data } = {}) {
    const sid = data?.sessionId;
    if (!sid || !mounted.has(sid)) return; // a session no row holds changes nothing
    const r = rec(sid);
    if (name === 'console.started') {
      r.running = true;
      r.live = { items: [], startedAt: Date.now(), missed: false };
      openRunning(sid);
    } else if (name === 'console.chunk') {
      if (!r.running || !r.live) { r.running = true; r.live = { items: r.live?.items || [], startedAt: r.live?.startedAt || Date.now(), missed: !r.live }; openRunning(sid); }
      if (data.kind !== 'text' && data.kind !== 'status') r.live.items.push({ kind: data.kind, id: data.id, name: data.name, summary: data.summary, detail: data.detail, ok: data.ok, ms: data.ms });
    } else if (name === 'console.done' || name === 'console.error') {
      r.running = false;
      load(sid); // the record is the truth: read once more, and the line settles
      return;
    } else return;
    tick();
    paint(sid);
  }

  /** A running session opens its row's Activity the first time it is seen running, and is read at once. */
  function openRunning(sid) {
    const m = mounted.get(sid);
    if (!autoOpened.has(sid)) {
      autoOpened.add(sid);
      if (m) { open.add(m.t.id); if (m.details) m.details.open = true; }
    }
    const r = rec(sid);
    if (!r.session && !r.loading && !r.error) load(sid);
  }

  /** The clock ticks once a second only while a mounted session runs. */
  function tick() {
    const any = [...mounted.keys()].some((sid) => recs.get(sid)?.running);
    if (any && !timer) timer = setInterval(() => { for (const sid of mounted.keys()) if (recs.get(sid)?.running) paintState(sid); }, 1000);
    if (!any && timer) { clearInterval(timer); timer = null; }
  }

  function paint(sid) {
    const m = mounted.get(sid);
    if (!m) return;
    const r = rec(sid);
    clear(m.summary, summaryText(r));
    if (m.details?.open) clear(m.body, ...bodyNodes(m.t, sid, r, m));
  }

  function paintState(sid) {
    const m = mounted.get(sid);
    if (m?.state && m.details?.open) clear(m.state, ...stateNodes(rec(sid)));
  }

  const summaryText = (r) => (r.session || r.live ? activitySummary(rowCount(activityEvents(r.session, r.live))) : activitySummary(null));

  function stateNodes(r) {
    const tools = r.running ? (r.live?.items || []).filter((x) => x.kind === 'tool') : [];
    const s = activityState({ session: r.session || {}, running: r.running, startedAt: r.live?.startedAt, lastTool: tools.at(-1) || null });
    return [stateChip(s.word, s.tone, `${s.word} · ${s.reason}`), el('span.cmp-sep', ' · '), el('span.cmp-reason', s.reason)];
  }

  /** A row's file name as a button that opens it in the Source tab (app.openSource), when the call names a file inside
   *  the task's project and that project is the active one (actions act on the active project); else the plain text. */
  function fileButtons(t) {
    if (typeof app.openSource !== 'function') return null;
    return (e, text) => {
      const active = app.projectId?.();
      if (t.projectId && t.projectId !== active) return text;
      const root = app.state?.projects?.find?.((p) => p.id === (t.projectId || active))?.path || '';
      const rel = projectRel(fileOfEvent(e), root);
      const name = toolObject(e?.summary, e?.name);
      if (!rel || !name || !text.endsWith(name)) return text;
      return [text.slice(0, text.length - name.length), button(name, { small: true, variant: 'quiet', class: 'activity-file', title: `Open ${rel} in the Source tab`, onclick: () => app.openSource({ path: rel }) })];
    };
  }

  /** A bundle summary carries intent from the server (no request rides the bundle); a full record has its request. */
  const intentOf = (t) => (typeof t?.intent === 'string' || t?.intent === null ? t.intent || null : intentLine(t));

  function bodyNodes(t, sid, r, m) {
    if (r.error) return [el('p.small.activity-error', `Activity could not be read: ${r.error.message || r.error}`), button('Retry', { small: true, onclick: () => load(sid) })];
    if (!r.session && !r.live) return [el('p.meta', r.loading ? 'Reading the session…' : 'Not read yet.')];
    m.state = el('div.activity-state', stateNodes(r));
    const rows = toolRows(activityEvents(r.session, r.live), trajectoryLabel, fileButtons(t));
    return [
      el('p.meta.activity-who', { title: r.session ? `${r.session.title || 'Chat session'} · ${sid}` : sid }, brainLine(r.session?.model)),
      intentOf(t) ? el('p.activity-intent', intentOf(t)) : null,
      m.state,
      rows || el('p.meta', r.running ? 'No tool call yet.' : 'No tool calls.'),
      r.running && r.live?.missed ? el('p.meta', 'Calls made before this view opened show when the run ends.') : null,
    ].filter(Boolean);
  }

  return {
    /** Called at the start of each list render: rows drawn from here on replace the mounted set. */
    begin() { mounted = new Map(); },
    /** Called after each list render, so the clock stops when no running session is on screen. */
    end() { tick(); },
    node(t, source) {
      if (!source) return null;
      if (source.terminal) return el('p.meta.task-activity-none', TERMINAL_LINE);
      const sid = source.id;
      const r = rec(sid);
      if (source.running && !r.session && !r.error) r.running = true;
      const m = { t, summary: el('summary', summaryText(r)), body: el('div.activity-body'), state: null, details: null };
      mounted.set(sid, m);
      if (r.running) openRunning(sid);
      m.details = el('details.more.task-activity', {
        open: open.has(t.id),
        ontoggle: (e) => {
          if (e.target.open === open.has(t.id)) return;
          if (e.target.open) { open.add(t.id); if (!r.session && !r.loading) load(sid); else paint(sid); } else open.delete(t.id);
        },
      }, m.summary, m.body);
      if (open.has(t.id)) {
        if (!r.session && !r.loading && !r.error) load(sid);
        clear(m.body, ...bodyNodes(t, sid, r, m));
      }
      return m.details;
    },
    destroy() { off?.(); clearInterval(timer); timer = null; mounted = new Map(); },
    _recs: recs,
  };
}
