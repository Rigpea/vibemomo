// Which two versions the Compare dialog opens on. Pure, so it can be tested without a DOM.

/**
 * A non-current version compares with the current one; the current version compares with
 * the working tree if dirty, else with the version before it; no version keeps the overview.
 */
export function compareDefaults({ cur, prev, dirty, a, b }) {
  const before = prev?.id || cur.id;
  if (a && a !== cur.id) return { a, b: b || cur.id };
  if (a && !b && !dirty) return { a: before, b: cur.id };
  if (a) return { a, b: b || 'head' };
  return { a: dirty ? cur.id : before, b: b || (dirty ? 'head' : cur.id) };
}
