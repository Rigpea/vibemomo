// A project's unresolved list in reading order: what the person typed, then one group per task that
// left items, then carried items whose task can no longer be named. Pure (no DOM): Focus and the
// briefing share it, so both read the same way.

export const FIRST_SHOWN = 5;

export const itemCount = (n) => (n === 1 ? '1 item' : `${n} items`);

/** The line above a group's items, without its task id. */
export const groupLine = (group) => `${group.earlier ? 'From earlier tasks' : `From task: ${group.title}`} · ${itemCount(group.items.length)}`;

/** items: project.unresolved. titles: task id -> title, for items carried before they held their title.
 *  Carrying has always stamped taskId, so an item without one is typed; "earlier" is a taskId with no title anywhere. */
export function groupUnresolved(items, titles = {}) {
  const typed = [];
  const byTask = new Map();
  for (const u of items || []) {
    if (!u) continue;
    if (!u.taskId) { typed.push(u); continue; }
    if (!byTask.has(u.taskId)) byTask.set(u.taskId, { key: u.taskId, taskId: u.taskId, title: '', earlier: false, items: [] });
    const group = byTask.get(u.taskId);
    group.items.push(u);
    group.title ||= u.taskTitle || titles[u.taskId] || '';
  }
  const groups = [];
  const earlier = { key: 'earlier', taskId: null, title: '', earlier: true, items: [] };
  for (const group of byTask.values()) {
    if (group.title) groups.push(group);
    else earlier.items.push(...group.items);
  }
  if (earlier.items.length) groups.push(earlier);
  return { typed, groups, total: typed.length + groups.reduce((n, g) => n + g.items.length, 0) };
}

export const ADD_FIELD = 'unresolved-add';
export const resolveKey = (item) => `resolve-${item.id}`;
export const resolveAllKey = (group) => `resolve-all-${group.key}`;

const firstWords = (text, n) => String(text ?? '').trim().split(/\s+/).slice(0, n).join(' ');

/** The accessible name of an item's Resolve: every button would otherwise read the same. Marked … only when words were cut. */
export function resolveLabel(item) {
  const words = firstWords(item.text, 8);
  return `Resolve: ${words}${words === String(item.text ?? '').trim().replace(/\s+/g, ' ') ? '' : '…'}`;
}

export const resolveAllLabel = (group) => `Resolve all ${group.items.length} from ${group.earlier ? 'earlier tasks' : firstWords(group.title, 6)}`;

/** The text of an item and the line above a group: they can hold the focus, and a press of Enter there does nothing. */
export const itemKey = (item) => `item:${item.id}`;
export const groupKey = (group) => `group:${group.key}`;

/** Where the focus goes after this item's Resolve, best first, as data-edit keys: the next item's text in its group,
 *  else the next group's heading, else Add. Never a button, so a repeated Enter cannot resolve a second item; from an
 *  item's text, Tab reaches its Resolve. Typed items come before every group. All of the list, not what the cut
 *  shows: the redraw moves the next item up. */
export function focusAfterResolve(view, item) {
  const group = view.groups.find((g) => g.items.includes(item));
  const own = group ? group.items : view.typed;
  const later = group ? view.groups.slice(view.groups.indexOf(group) + 1) : view.groups;
  return [...own.slice(own.indexOf(item) + 1).map(itemKey), ...later.map(groupKey), ADD_FIELD];
}

/** Where the focus goes after a group's Resolve all: the next group's heading, else Add. */
export function focusAfterResolveAll(view, group) {
  return [...view.groups.slice(view.groups.findIndex((g) => g.key === group.key) + 1).map(groupKey), ADD_FIELD];
}

/** The first `limit` items in reading order. A cut group keeps all its items in `items` (its count and
 *  Resolve all speak for the whole group) and lists what is on screen in `shown`. */
export function firstItems(view, limit = Infinity) {
  let left = Math.max(0, limit);
  const typed = view.typed.slice(0, left);
  left -= typed.length;
  const groups = [];
  for (const group of view.groups) {
    if (left <= 0) break;
    const shown = group.items.slice(0, left);
    left -= shown.length;
    groups.push({ ...group, shown });
  }
  return { typed, groups };
}
