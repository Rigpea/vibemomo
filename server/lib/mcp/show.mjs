// studio.show: what a companion may ask the open studio window to show (docs/ARCHITECTURE.md section 11).
// Shared by the MCP tool (server/lib/mcp/tools.mjs), the route POST /api/studio/show (server/index.mjs) and,
// through the same names, the client's handler (client/components/studio-show.js). Pure: no fs, no fetch.

export const SHOW_VIEWS = ['workbench', 'learning', 'inspiration', 'console', 'tasks', 'memory', 'settings'];
export const SHOW_PANELS = ['devices', 'phone', 'play', 'tuning', 'audio', 'page', 'source'];

/**
 * The request as the event carries it, or { error } in words. A panel or Point mode lives in the Workbench,
 * so it implies view 'workbench' and refuses any other view; Point mode is the Phone panel's, so it implies
 * panel 'phone' and refuses any other panel; a file opens in the Source panel, so it implies panel 'source' and
 * refuses any other panel (Point mode included). line needs file. A lesson (its id) opens in the Learning view, so it
 * implies view 'learning' and refuses a panel, a file, Point mode or any other view.
 */
export function checkShow(body = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  if (b.projectId != null) {
    if (typeof b.projectId !== 'string' || !/^p_[a-z0-9]+$/.test(b.projectId)) return { error: 'projectId must be a project id' };
    out.projectId = b.projectId;
  }
  if (b.view != null && !SHOW_VIEWS.includes(b.view)) return { error: `view must be one of ${SHOW_VIEWS.join(', ')}` };
  if (b.panel != null && !SHOW_PANELS.includes(b.panel)) return { error: `panel must be one of ${SHOW_PANELS.join(', ')}` };
  if (b.point != null && typeof b.point !== 'boolean') return { error: 'point must be true or false' };
  if (b.file != null && (typeof b.file !== 'string' || !b.file.trim() || b.file.length > 400 || /[\r\n]/.test(b.file))) return { error: 'file must be a project path of at most 400 characters on one line' };
  if (b.line != null && !(Number.isInteger(b.line) && b.line >= 1)) return { error: 'line must be a whole number from 1' };
  if (b.line != null && b.file == null) return { error: 'line needs file' };
  if (b.lesson != null) {
    if (typeof b.lesson !== 'string' || !/^les_[a-z0-9]{4,40}$/.test(b.lesson)) return { error: 'lesson must be a lesson id (les_…)' };
    if (b.panel != null || b.file != null || b.point != null) return { error: 'a lesson opens in the learning view, which has no panels, files or Point mode; ask for those in another call' };
    if (b.view != null && b.view !== 'learning') return { error: `a lesson opens in the learning view, not ${b.view}` };
    out.view = 'learning';
    out.lesson = b.lesson;
    return { show: out };
  }
  const panel = b.panel ?? (b.point ? 'phone' : b.file != null ? 'source' : null);
  if (b.point && panel !== 'phone') return { error: 'Point mode belongs to the phone panel' };
  if (b.file != null && panel !== 'source') return { error: `a file opens in the source panel, not the ${panel} panel; ask for the ${panel} panel in another call` };
  const view = b.view ?? (panel ? 'workbench' : null);
  if (panel && view !== 'workbench') return { error: `the ${panel} panel is in the workbench view, not ${view}` };
  if (view) out.view = view;
  if (panel) out.panel = panel;
  if (b.point != null) out.point = b.point;
  if (b.file != null) out.file = b.file.trim();
  if (b.line != null) out.line = b.line;
  if (!out.view && !out.file && !out.projectId) return { error: 'Nothing to show: name a project, a view, a panel or a file' };
  return { show: out };
}
