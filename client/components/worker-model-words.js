// A worker model as the client reads and chooses it (docs/ARCHITECTURE.md section 17). The stored value is one
// string: a Claude Code model id, or `codex:<model>` / `codex:<model>@<effort>` for a worker on the person's Codex
// CLI (server/lib/models.mjs parseWorkerModel; tests/codex-worker.test.mjs holds the two readers together). No DOM.
// The Codex models and efforts offered come from the status route the Codex tab reads (GET /api/console/codex).
import { COMPANION_MODELS } from './companion-words.js';

export const WORKER_DEFAULT = 'claude-fable-5-2';
export const CODEX_PREFIX = 'codex:';
const CODEX_MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const CODEX_EFFORT_RE = /^[a-z]{2,12}$/;

/** { backend: 'claude-code', model } | { backend: 'codex', model, effort } | null (a value the studio does not take). */
export function parseWorker(value) {
  if (typeof value !== 'string') return null;
  if (COMPANION_MODELS.some(([m]) => m === value)) return { backend: 'claude-code', model: value };
  if (!value.startsWith(CODEX_PREFIX)) return null;
  const rest = value.slice(CODEX_PREFIX.length);
  const at = rest.lastIndexOf('@');
  const model = at < 0 ? rest : rest.slice(0, at);
  const effort = at < 0 ? null : rest.slice(at + 1);
  if (!CODEX_MODEL_RE.test(model) || (effort !== null && !CODEX_EFFORT_RE.test(effort))) return null;
  return { backend: 'codex', model, effort };
}

/** A worker model in the person's words: "Opus 5.5", or "Codex · GPT-6-Astra · xhigh effort" (status: the Codex
 *  status route's answer, for the model's name; without it the id). No effort named: the one Codex is configured with. */
export function workerName(value, status = null) {
  const w = parseWorker(value);
  if (!w) return value || 'model not set';
  if (w.backend !== 'codex') return COMPANION_MODELS.find(([m]) => m === w.model)[1];
  const name = status?.models?.find((m) => m.id === w.model)?.name || w.model;
  return `Codex · ${name} · ${w.effort ? `${w.effort} effort` : 'Codex\'s configured effort'}`;
}

/** The form's two controls for a stored value: the model select's value and the effort select's ('' for none named). */
export function workerPick(value) {
  const w = parseWorker(value);
  if (!w) return { model: 'default', effort: '' };
  return w.backend === 'codex' ? { model: `${CODEX_PREFIX}${w.model}`, effort: w.effort || '' } : { model: w.model, effort: '' };
}

/** The two controls back as the value to store: 'default', a Claude Code model id, or codex:<model>[@<effort>]. */
export function workerValue(model, effort = '') {
  if (!model || model === 'default') return 'default';
  return model.startsWith(CODEX_PREFIX) && effort ? `${model}@${effort}` : model;
}

export const isCodexChoice = (model) => typeof model === 'string' && model.startsWith(CODEX_PREFIX);

/** The Codex models as choices of the model select: the status route's list; a stored Codex model the list lacks
 *  (or with no list read) stays offered, so the form never drops what is chosen. */
export function codexWorkerOptions(status, current = null) {
  const out = (status?.cli === false ? [] : status?.models || []).map((m) => [`${CODEX_PREFIX}${m.id}`, `Codex · ${m.name || m.id}`]);
  const kept = parseWorker(current);
  if (kept?.backend === 'codex' && !out.some(([v]) => v === `${CODEX_PREFIX}${kept.model}`)) out.push([`${CODEX_PREFIX}${kept.model}`, `Codex · ${kept.model}`]);
  return out;
}

/** The efforts the chosen Codex model takes, after "the effort Codex is configured with" (no effort named). */
export function codexWorkerEfforts(status, model, current = '') {
  const id = isCodexChoice(model) ? model.slice(CODEX_PREFIX.length) : '';
  const efforts = status?.models?.find((m) => m.id === id)?.efforts || [];
  const configured = status?.defaults?.model === id && status?.defaults?.effort ? ` (${status.defaults.effort})` : '';
  const out = [['', `Effort Codex is configured with${configured}`], ...efforts.map((e) => [e, `${e} effort`])];
  if (current && !out.some(([e]) => e === current)) out.push([current, `${current} effort`]);
  return out;
}

/** Under the worker model field when a Codex model is chosen: what stands in the way, else what such a worker is. */
export function codexWorkerHint(status) {
  if (status?.cli === false || status?.loggedIn === false) return status.problem || 'Codex is not ready on this machine.';
  return 'A Codex worker runs your Codex CLI on its saved login, in Codex\'s workspace-write sandbox: it cannot commit (the studio keeps its version), reach the internet, run checks that need your own account (a Unity compile or test) or take an explore task.';
}
