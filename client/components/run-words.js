// The words and shapes of the studio's runs (server/lib/runs.mjs; docs/ARCHITECTURE.md section 16), apart from the
// DOM: how long, the Working now row's model on its hour axis, the rail's live dot and the app bar's chip for a run
// that ended. No imports, so the server (runs.mjs) and the tests read it directly.

export const AXIS_MS = 3600 * 1000; // the Working now axis: the last hour
export const MIN_BAR = 0.006; // a run of a few seconds still shows as a sliver
export const FINISHED = ['Waiting for you', 'Done', 'Failed', 'Stopped'];

/** A duration in words: "under a minute", "4 min", "1 h 5 min". */
export function durationWords(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** How long ago, against a given clock: "just now", "4 min ago", "2 h ago". */
export function agoWords(iso, now = Date.now()) {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const isRunning = (r) => !!r && !r.endedAt && !FINISHED.includes(r.state);

/** The state as a row reads it: one word or phrase, then the reason. A working run that waits on something says so. */
export function runStateWords(r) {
  const state = r.state === 'Working' && r.waitsFor ? `Waiting for ${r.waitsFor}` : r.state;
  return r.reason ? `${state} · ${r.reason}` : state;
}

/** Latest action with how long ago: "Read copy.mjs · 2 min ago"; a run with no action yet reads "started …". */
export function latestWords(r, now = Date.now()) {
  if (r.latest) return r.latestAt ? `${r.latest} · ${agoWords(r.latestAt, now)}` : r.latest;
  return `started ${agoWords(r.startedAt, now)}`;
}

/**
 * The Working now row of one project. runs: that project's runs from GET /api/runs. open: the person opened the rows;
 * dismissedAt (ms): when they last closed them, so the runs that ended before stay out of the open list.
 * null when the row is absent: nothing running, and nothing ended in the hour that the open list still holds.
 * Otherwise { count, running: [{ id, name }], ended, rows, ticks } (ended: listed rows that are over), each row
 * { id, kind, name, state, live, stateWords, latest, left, width, clipped } with left and width as fractions of the
 * axis; a run that started before the hour sits at its left edge with clipped: true. A run that ended over an hour ago
 * is not listed at all.
 */
export function workingNowModel(runs = [], { now = Date.now(), open = false, dismissedAt = 0, axisMs = AXIS_MS } = {}) {
  const from = now - axisMs;
  const byStart = (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt);
  const running = runs.filter(isRunning).sort(byStart); // filter made a copy: the caller's list keeps its order
  const ended = runs.filter((r) => !isRunning(r) && Date.parse(r.endedAt) >= from && Date.parse(r.endedAt) > dismissedAt);
  if (!running.length && !(open && ended.length)) return null;
  const shown = open ? [...running, ...ended].sort(byStart) : running;
  const rows = shown
    .map((r) => {
      const start = Date.parse(r.startedAt);
      const end = r.endedAt ? Date.parse(r.endedAt) : now;
      const s = Math.max(start, from); // started before the hour: the bar begins at the axis' left edge
      const left = (s - from) / axisMs;
      const width = Math.max(MIN_BAR, Math.min(1 - left, (end - s) / axisMs));
      return { id: r.id, kind: r.kind, name: r.name, state: r.state, live: isRunning(r), stateWords: runStateWords(r), latest: latestWords(r, now), left, width, clipped: start < from };
    });
  const ticks = [60, 45, 30, 15, 0].map((m) => ({ at: 1 - (m * 60000) / axisMs, label: m ? `${m} min ago` : 'now' })).filter((t) => t.at >= 0);
  return { count: running.length, running: running.map((r) => ({ id: r.id, name: r.name })), ended: rows.filter((r) => !r.live).length, rows, ticks };
}

/** The rail's dot for a project: null, or { title } naming its working runs. */
export function railDot(runs = [], projectId) {
  const working = runs.filter((r) => r.projectId === projectId && isRunning(r));
  if (!working.length) return null;
  return { title: `Working now: ${working.map((r) => r.name).join(', ')}` };
}

/** The run a runs.changed event reports as just ended, or null: the chip only ever names what the server reported. */
export const endedRun = (event) => (event?.run && event.run.endedAt && FINISHED.includes(event.run.state) ? event.run : null);

/** Where a click on the run's chip goes: the Phone tab for a build or a boot, the Task tab for the rest. */
export const runChipTab = (run) => (run?.kind === 'build' || run?.kind === 'device' ? 'phone' : 'task');
