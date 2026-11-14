// Pairs a turn's tool results and denials with their calls. Pure and free of imports, so
// tests/transcript-match.test.mjs can run it without a DOM.

/** Same call, judged by the input summary: a denial's summary is built from the tool input and
 *  may be shorter or longer than the call's. A missing summary on either side does not object. */
function sameSummary(call, e) {
  const a = call.e.summary;
  const b = e.summary;
  return !b || !a || a.startsWith(b.slice(0, 60)) || b.startsWith(a.slice(0, 60));
}

/** The call an event answers. An event with an id goes to the call with that id. Otherwise the
 *  order rule: the first earlier call of the same tool that has no answer yet (a refused call has
 *  its answer, the denial), and for denials the same input summary. An event with an id only uses
 *  the order rule on calls without an id (stored before ids existed); it never takes another
 *  call's id. */
function findCall(calls, e) {
  if (e.id) {
    const byId = calls.find((c) => c.e.id === e.id);
    if (byId) return byId;
  }
  return calls.find((c) => !c.result && !c.denied && c.e.name === e.name
    && (!e.id || !c.e.id)
    && (e.kind !== 'denied' || sameSummary(c, e)));
}

/** Match results and denials to their calls. Returns one entry per event, in event order: a call
 *  is {e, result, denied}; a matched result or denial is null (it is drawn with its call); a
 *  denial or failed result that matches nothing is {orphan, tone}; a successful result that
 *  matches nothing is null, there is no call to draw it under; anything else is {line}. */
export function matchRows(events) {
  const calls = [];
  const rows = [];
  for (const e of events) {
    if (e.kind === 'tool') { const c = { e, result: null, denied: false }; calls.push(c); rows.push(c); continue; }
    if (e.kind === 'tool-result') {
      const c = findCall(calls, e);
      if (c) { c.result = e; rows.push(null); } else rows.push(e.ok === false ? { orphan: e, tone: 'danger' } : null);
      continue;
    }
    if (e.kind === 'denied') {
      const c = findCall(calls, e);
      if (c) { c.denied = e; rows.push(null); } else rows.push({ orphan: e, tone: 'warn' });
      continue;
    }
    rows.push({ line: e });
  }
  return rows;
}
