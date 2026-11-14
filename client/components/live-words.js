// Words for a project's live server (server/lib/live.mjs; docs/ARCHITECTURE.md section 20). Pure, no DOM, so the
// tests read the same sentences the Workbench shows.

export const LIVE_TONES = { off: 'neutral', starting: 'busy', running: 'ok', failed: 'danger', invalid: 'warn' };

/** What the Page, Select, Phone and side-by-side panels still read while the frame shows the live server. Said in the
 *  switch's Log only; no line under the preview carries it (the person wanted that height for the preview). */
export const LIVE_NOTE = 'Live shows the project\'s own server. Page, Select, Phone and side by side still read the files on disk.';
/** The Select button's tooltip while it is disabled because the frame shows the live server. */
export const LIVE_SELECT_TITLE = 'Select reads the files on disk, not the live server: switch Live off to use it.';

/**
 * The switch's state from GET /api/projects/:id/live: { state, chip, reason, tone }.
 * state is off, starting, running or failed, or invalid when atelier.json's live entry breaks the contract.
 * reason is a few words or null; the chip is a capitalised state word.
 */
export function liveWords(s) {
  if (!s) return { state: 'off', chip: 'Off', reason: null, tone: LIVE_TONES.off };
  if (s.problem && !['starting', 'running'].includes(s.state)) return { state: 'invalid', chip: 'Invalid', reason: s.problem, tone: LIVE_TONES.invalid };
  const state = ['off', 'starting', 'running', 'failed'].includes(s.state) ? s.state : 'off';
  let reason = null;
  if (state === 'starting') reason = 'waiting for its ready line';
  else if (state === 'running') {
    reason = hostOf(s.url);
    if (s.stale) reason = `${reason ? `${reason} · ` : ''}atelier.json changed; switch off and on to run the new command`;
  } else if (state === 'failed') reason = s.reason || 'it stopped';
  else if (s.reason && s.reason !== 'you switched Live off') reason = s.reason; // off because the project closed or the studio quit
  const chip = { off: 'Off', starting: 'Starting', running: 'Running', failed: 'Failed' }[state];
  return { state, chip, reason, tone: LIVE_TONES[state] };
}

/** host:port of a (masked) URL, or null. */
export function hostOf(url) {
  try { return url ? new URL(url).host : null; } catch { return null; }
}

/** An argv array as one line a person can read: arguments with spaces or quotes are double-quoted. */
export function argvText(argv) {
  return (argv || []).map((a) => (a === '' || /[\s"'\\]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/** The Workbench frame's address for a running live server; the server answers with a 302 to the full URL. */
export const liveFrameUrl = (projectId) => `/live/${encodeURIComponent(projectId)}?t=${Date.now()}`;
