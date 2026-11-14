// Restart the studio from inside it (the top bar's restart button, Ctrl+Alt+R, the tray's Restart studio): the
// server hands the restart to scripts/restart.mjs in a detached process (POST /api/studio/restart), which stops this
// very server and starts a fresh one on the same port; the page waits for a health answer with a new start time,
// then reloads. Needed because the desktop app attaches to a server it did not start and leaves it running on quit,
// so closing and reopening the window never loads new server code.
import { el, confirmDialog, toast } from './ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** What the server's worker queue holds now (GET /api/workers), or null from a server without the route. */
async function workerOverview() {
  try {
    const res = await fetch('/api/workers', { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/**
 * The confirmation's sentences after the first. working: the names of the runs that would be cut off (sessions,
 * workers, builds, shells); workers: GET /api/workers ({ active: [{ name }], queued, held }) or null when unknown.
 * Workers mid-task are said apart from the other runs, because the studio tells their managers after the restart.
 */
export function restartWords({ working = [], workers = null } = {}) {
  const mid = workers?.active?.length || 0;
  const workerNames = new Set((workers?.active || []).map((w) => w.name).filter(Boolean));
  const others = working.filter((n) => !workerNames.has(n)); // a worker's run carries its task's name
  const parts = [];
  if (mid) parts.push(`${mid === 1 ? '1 worker is' : `${mid} workers are`} mid-task and will be interrupted; ${mid === 1 ? 'its manager is' : 'their managers are'} told and can continue ${mid === 1 ? 'it' : 'them'}.`);
  if (others.length === 1) parts.push(`${others[0]} is working now and will be stopped.`);
  else if (others.length) parts.push(`${others.length} ${mid ? 'other runs are' : 'runs are'} working now and will be stopped: ${others.slice(0, 4).join(', ')}${others.length > 4 ? '…' : ''}.`);
  if (workers?.queued) parts.push(`${workers.queued === 1 ? '1 queued task starts' : `${workers.queued} queued tasks start`} again after the restart.`);
  if (!workers && working.length) parts.push('Tasks keep their status.');
  return parts.join(' ');
}

/** working: the names of the runs that would be cut off (sessions, workers, builds, shells). */
export async function restartStudio({ working = [] } = {}) {
  const workers = await workerOverview();
  const words = restartWords({ working, workers });
  const danger = working.length || workers?.active?.length;
  const ok = await confirmDialog({ title: 'Restart the studio?', message: `The studio's server stops and starts again with the code on disk, and this window reloads.${words ? ` ${words}` : ''}`, confirm: 'Restart', variant: danger ? 'danger' : 'primary' });
  if (!ok) return false;
  const before = await health();
  const veil = el('div.restart-veil', { role: 'status', 'aria-live': 'polite' }, el('span.spinner', { 'aria-hidden': 'true' }), el('span', 'Restarting the studio…'));
  document.body.append(veil);
  try {
    const res = await fetch('/api/studio/restart', { method: 'POST' });
    if (!res.ok) throw new Error(res.status === 404 ? 'This server is older than the restart button; run npm run restart in the studio folder once.' : `The server answered ${res.status}.`);
  } catch (err) {
    veil.remove();
    toast(`Restart failed: ${err.message}`, { tone: 'danger', timeout: 9000 });
    return false;
  }
  for (let i = 0; i < 60; i++) { // up to 30 s
    await sleep(500);
    const h = await health();
    if (h?.ok && h.startedAt !== before?.startedAt) { location.reload(); return true; }
  }
  veil.remove();
  toast('The studio did not answer within 30 s after the restart. See .local/restart.log in the studio folder.', { tone: 'danger', timeout: 12000 });
  return false;
}
