// The Learning view's words and the check of what a lesson frame posts (client/views/learning.js). Pure.
import { LESSON_MESSAGE } from './lesson-frame.js';

export const ASK_MAX = 280; // characters of a quote that reach the Companion box
const RAW_MAX = 20000; // a message longer than this is not a selection the person made

const clip = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * What a lesson frame said, or null when it is not a lesson message of a known shape. The caller has already checked
 * event.source against the frame's own window; this checks the data:
 *   { type: 'atelier:lesson', what: 'steps', count, index }      count 0..500, index inside it
 *   { type: 'atelier:lesson', what: 'ask', kind, text }           kind selection | figure, text cut to ASK_MAX
 */
export function readLessonMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.type !== LESSON_MESSAGE) return null;
  if (data.what === 'steps') {
    const { count, index } = data;
    if (!Number.isInteger(count) || count < 0 || count > 500) return null;
    if (!Number.isInteger(index) || index < 0 || index >= Math.max(count, 1)) return null;
    return { what: 'steps', count, index };
  }
  if (data.what === 'ask') {
    if (data.kind !== 'selection' && data.kind !== 'figure') return null;
    if (typeof data.text !== 'string' || data.text.length > RAW_MAX) return null;
    let text = clip(data.text);
    if (!text) return null;
    if (text.length > ASK_MAX) text = `${text.slice(0, ASK_MAX - 1).trimEnd()}…`;
    return { what: 'ask', kind: data.kind, text };
  }
  return null;
}

/** The quoted line the Companion box receives: the person writes their question after it. The lesson's title comes
 *  from the studio's record, never from the frame. */
export function askLine({ kind, text }, title) {
  const quote = (s) => String(s || '').replace(/"/g, '”');
  const name = quote(clip(title || 'this lesson'));
  return kind === 'figure'
    ? `About the figure "${quote(text)}" in the lesson "${name}": `
    : `About "${quote(text)}" in the lesson "${name}": `;
}

/** "Step 2 of 3", or '' for a lesson without steps. */
export const stepWords = (index, count) => (count > 0 ? `Step ${index + 1} of ${count}` : '');

/** Where the Ask line went, in words for a toast when the box could not take the focus (insertDraft's answer). */
export function askFallback(out) {
  if (out?.ok && out.focused) return null;
  if (out?.ok) return 'The line is in the Companion box; it can be sent once the answer running now ends.';
  if (out?.reason === 'no_session') return 'Start the companion session on the right first; then Ask about this puts the line in its box.';
  return 'The Companion box is not on screen, so the line could not be put there.';
}

/** The lesson the Learning view opens first: the one asked for when the list has it or it is being fetched, else the
 *  one last open on this project when it still exists, else the newest. ids of the list, newest first. */
export function pickLesson({ wanted = null, last = null, ids = [] } = {}) {
  if (wanted) return wanted; // studio.show names a lesson that may be newer than the list in hand
  if (last && ids.includes(last)) return last;
  return ids[0] || null;
}
