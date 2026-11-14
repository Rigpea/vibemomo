// The Codex tab's words, apart from the DOM (workbenches/codex/panel.js; docs/ARCHITECTURE.md section 21): the header
// line that names the brain, the model, effort and sandbox choices as the person reads them, the choices kept per
// project, and the state line with its three states of its own (no CLI, signed out, a refused model). Every word comes
// from the status route (GET /api/console/codex) or the session record. tests/codex-panel.test.mjs reads it directly.
import { companionState } from './companion-words.js';

export const CODEX_SANDBOXES = [['read-only', 'Sandbox: read-only'], ['workspace-write', 'Sandbox: may edit files']];
export const SANDBOX_TITLE = 'Read-only: Codex reads files and runs commands that change nothing. May edit files: Codex can change files in this project\'s folder. The studio never runs Codex without a sandbox.';
export const sandboxWords = (id) => (id === 'workspace-write' ? 'may edit files in this folder' : 'read-only');

/** A model's name as Codex lists it; an id the list lacks reads as it is; none is Codex's own default. */
export const codexModelName = (status, id) => (id ? status?.models?.find((m) => m.id === id)?.name || id : 'Codex\'s default model');

/** The model select's options: the list from the status route; a model on the session the list lacks stays chosen. */
export function codexModelOptions(status, current = null) {
  const out = (status?.models || []).map((m) => [m.id, m.name || m.id]);
  if (current && !out.some(([id]) => id === current)) out.unshift([current, current]);
  if (!out.length) out.push(['', 'Codex\'s default model']);
  return out;
}

const EFFORT_WORDS = { low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra high effort', max: 'Max effort', ultra: 'Ultra effort' };
export const effortWords = (e) => (e ? EFFORT_WORDS[e] || `${e} effort` : 'Default effort');
/** The efforts the chosen model takes ('' leaves Codex's default for it). */
export function codexEffortOptions(status, model) {
  const m = status?.models?.find((x) => x.id === model);
  const efforts = m?.efforts?.length ? m.efforts : ['low', 'medium', 'high', 'xhigh'];
  return [['', 'Default effort'], ...efforts.map((e) => [e, effortWords(e)])];
}
export const takesEffort = (status, model, effort) => !effort || codexEffortOptions(status, model).some(([e]) => e === effort);

/** Who pays, as `codex login status` said it: the person's ChatGPT login, or an API key they saved in Codex. */
export function loginWords(status) {
  if (!status) return 'checking the login…';
  if (status.cli === false) return 'CLI not found';
  if (status.loggedIn === false) return 'signed out';
  if (status.login === 'chatgpt') return 'your ChatGPT login';
  if (status.login === 'api-key') return 'an API key saved in Codex';
  return 'your Codex login';
}

/** The header line: who answers, in words ("Codex · GPT-6-Astra · your ChatGPT login"). */
export const codexBrainLine = (status, model) => `Codex · ${codexModelName(status, model)} · ${loginWords(status)}`;

/** The choices before a session exists: what the person kept for this project (project.ui.codex), else what
 *  ~/.codex/config.toml says (the status route's defaults). The sandbox is not kept: a new session starts read-only. */
export function codexChoices(ui, status) {
  const kept = ui?.codex || {};
  const has = (id) => !!status?.models?.some((m) => m.id === id);
  const model = has(kept.model) ? kept.model : status?.defaults?.model || '';
  const wanted = typeof kept.effort === 'string' && has(kept.model) ? kept.effort : status?.defaults?.effort || '';
  return { model, effort: takesEffort(status, model, wanted) ? wanted : '', sandbox: 'read-only' };
}

/** What stands in the way before any message: the one sentence to act on, or null. */
export const codexProblem = (status) => (status && typeof status.problem === 'string' && status.problem ? status.problem : null);

/**
 * The tab's state in one word and its reason: { word, reason, tone }. The Companion's rule (companion-words.js),
 * after Codex's own three: no CLI on this machine, signed out, and a model Codex refused.
 */
export function codexState({ status = null, session = null, running = false, startedAt = null, lastTool = null, now = Date.now() } = {}) {
  if (status?.cli === false) return { word: 'No Codex', reason: 'the Codex CLI was not found · Settings › Console', tone: 'danger' };
  const last = running ? null : [...(session?.turns || [])].reverse().find((t) => t.role !== 'user');
  // Signed out now (the CLI's own answer), or the last run found no login and nothing newer says otherwise. Once the
  // CLI says it is signed in again, that run is a failed message to send again, not the state of the login.
  if (!running && (status?.loggedIn === false || (last?.signedOut && status?.loggedIn !== true))) return { word: 'Signed out', reason: 'run codex login in a terminal, then send again', tone: 'danger' };
  if (last?.signedOut) return { word: 'Failed', reason: 'the last message found no login · send it again', tone: 'danger' };
  if (last?.modelRefused) return { word: 'Model refused', reason: `Codex refused ${last.model || 'the model'} · choose another model`, tone: 'danger' };
  return companionState({ session, running, startedAt, lastTool, now });
}

export const CODEX_HINT = 'Ask for a second opinion on this project. Enter sends; Shift+Enter adds a line.';
export const codexPlaceholder = (pinsSelected) => (pinsSelected ? 'Ask Codex about the selected part…' : 'Ask Codex…');
