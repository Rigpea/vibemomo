// Example text for the Task composer, one per project kind. Pure and free of imports, so
// tests/task-placeholders.test.mjs can run it without a DOM.

const PLACEHOLDERS = {
  game: { request: 'What should change? e.g. “Make the jump snappier and add a landing sound.”', acceptance: 'e.g. The jump feels snappier at 1280×720' },
  'web-app': { request: 'What should change? e.g. “Keep my draft when the page reloads.”', acceptance: 'e.g. The draft is still there after a reload' },
  action: { request: 'What should change? e.g. “Let me tune the fall speed from the panel.”', acceptance: 'e.g. A new fall speed takes effect without a reload' },
  audio: { request: 'What should change? e.g. “Make the landing cue shorter and drier.”', acceptance: 'e.g. The landing cue ends within 150 ms' },
  studio: { request: 'What should change? e.g. “Show the full session title on hover.”', acceptance: 'e.g. The full title shows on hover at 1280×720' },
};
// Imported folders can carry any kind ("other", or one set by hand): an example that assumes nothing.
const ANY_KIND = { request: 'What should change? e.g. “Make the first screen say what to do next.”', acceptance: 'e.g. A first-time visitor knows what to do next' };

/** { request, acceptance } placeholder text for a project kind. */
export function taskPlaceholders(kind) {
  return Object.hasOwn(PLACEHOLDERS, kind) ? PLACEHOLDERS[kind] : ANY_KIND;
}
