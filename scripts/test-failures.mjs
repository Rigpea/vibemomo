// What `npm run check` prints when `node --test` fails: the failures, not the passes. Pure, for tests/check-output.test.mjs.
const ANSI = /\u001b\[[0-9;]*m/g;

/** The lines to show from a failing run: the reporter's "failing tests" part, or without one everything but the
 *  passes and the counts, and then stderr. Cut at `limit`: one failed hook repeats its message for every test. */
export function failureLines(stdout = '', stderr = '', { limit = 200 } = {}) {
  const lines = String(stdout).replace(ANSI, '').split(/\r?\n/);
  const at = lines.findIndex((l) => /failing tests:/.test(l));
  const picked = at >= 0 ? lines.slice(at) : lines.filter((l) => !/^\s*(✔|ℹ)/.test(l));
  const all = [...picked, ...String(stderr).replace(ANSI, '').split(/\r?\n/)];
  while (all.length && !all.at(-1).trim()) all.pop();
  while (all.length && !all[0].trim()) all.shift();
  return all.length > limit ? [...all.slice(0, limit), `… ${all.length - limit} more lines`] : all;
}
