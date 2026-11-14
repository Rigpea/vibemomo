// Bounded Claude API utility: narrow JSON tasks with a budget gate, a ledger,
// output validation, retries, cancellation and concurrency limits.
// The API key is read through getApiKey() at call time and is never logged,
// returned, emitted or included in error messages.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

import { PRICING_VERSION, PRICING_TABLE, hasPricing, costFor, estimateCallMax } from './pricing.mjs';
import { validate, toApiSchema } from './validate.mjs';
import { TASKS, TASK_MAP, describeSchema } from './tasks.mjs';
import { createLedger, aggregate, inCycle } from './ledger.mjs';
import { createBudgetStore, effectiveAllocation, balanceWarnings, BudgetInputError, pausedMessage, STUDIO_PAUSE_REASONS } from './budget.mjs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const pricing = { version: PRICING_VERSION, table: PRICING_TABLE };

const STATUS = {
  not_configured: 503, budget_paused: 402, budget_exceeded: 402, unknown_task: 404, invalid_input: 400,
  invalid_output: 502, cancelled: 499, rate_limited: 429, provider_error: 502, concurrency_limit: 429,
};

export class UtilityError extends Error {
  constructor(code, message, status = STATUS[code] ?? 400) {
    super(redact(message));
    this.name = 'UtilityError';
    this.code = code;
    this.status = status;
  }
  toJSON() { return { error: { code: this.code, message: this.message } }; }
}

/** Removes anything that looks like an Anthropic key from text. */
export function redact(text) {
  return String(text ?? '').replace(/sk-ant-[A-Za-z0-9_\-]+/g, 'sk-ant-[redacted]');
}

/**
 * Reads the key from STUDIO_ANTHROPIC_API_KEY, else <dataDir>/secrets.json.
 * Returns null when not configured. Convenience for callers; createUtility takes getApiKey.
 */
export function readApiKey(dataDir) {
  const env = process.env.STUDIO_ANTHROPIC_API_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    const k = s?.STUDIO_ANTHROPIC_API_KEY;
    return typeof k === 'string' && k.trim() ? k.trim() : null;
  } catch {
    return null;
  }
}

const newId = (prefix) => prefix + BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString(36).slice(0, 10).padStart(10, '0');
const round = (n) => Math.round(n * 1e9) / 1e9;
const BACKOFF_MS = [1000, 3000];
const MAX_USER_CHARS = 200_000;

function defaultClientFactory(apiKey) {
  // SDK-level retries are off: this module owns the retry policy so every attempt is gated and ledgered.
  return new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000 });
}

function isAbort(err, signal) {
  return signal?.aborted || err?.name === 'APIUserAbortError' || err?.name === 'AbortError';
}
function isRetryable(err) {
  const s = err?.status;
  if (typeof s === 'number') return s === 429 || s === 529 || s >= 500;
  return err?.name === 'APIConnectionError' || err?.name === 'APIConnectionTimeoutError';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UtilityError('cancelled', 'run cancelled'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(new UtilityError('cancelled', 'run cancelled')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function usageOf(resp) {
  const u = resp?.usage || {};
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
  };
}

function parseOutput(resp) {
  const text = (resp?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('').trim();
  if (!text) return { error: 'the reply contained no text' };
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return { value: JSON.parse(unfenced) };
  } catch (e) {
    return { error: `the reply was not valid JSON (${e.message.slice(0, 120)})` };
  }
}

export function createUtility({ dataDir, getApiKey, getModel, emit, clientFactory, now, backoffMs = BACKOFF_MS, runs: registry = null } = {}) {
  if (!dataDir) throw new Error('createUtility: dataDir is required');
  const clock = now || (() => new Date());
  const nowMs = () => +clock();
  const ts = () => new Date(nowMs()).toISOString();
  const makeClient = clientFactory || defaultClientFactory;
  const keyOf = () => { try { return getApiKey?.() || null; } catch { return null; } };
  const modelOf = () => (getModel?.() || DEFAULT_MODEL);
  const send = (type, payload) => { try { emit?.(type, payload); } catch { /* SSE must never break a run */ } };

  const budgetStore = createBudgetStore(dataDir, { now: clock });
  const ledger = createLedger(dataDir);
  const inFlight = new Map(); // runId -> { controller, reservedUsd, task, projectId, startedAt }

  const reservedUsd = (exceptRunId) => round([...inFlight].reduce((s, [id, r]) => (id === exceptRunId ? s : s + r.reservedUsd), 0));
  const cycleLines = (b) => ledger.readAll().filter((l) => inCycle(l, b.cycle));
  const spentUsd = (b) => aggregate(cycleLines(b)).costUsd;

  function budgetView() {
    const b = budgetStore.read();
    const spent = spentUsd(b);
    const reserved = reservedUsd();
    const eff = effectiveAllocation(b);
    const avail = observedAvailableUsd(b);
    const ceilingRemaining = Math.max(0, b.liveCeilingUsd - spent - reserved);
    const remaining = round(avail == null ? ceilingRemaining : Math.max(0, Math.min(ceilingRemaining, avail - reserved)));
    const warned = balanceWarnings(b, { available: avail, ceilingRemaining, remaining, reserved, inFlight: inFlight.size });
    return {
      ...b,
      effectiveAllocationUsd: eff,
      spentUsd: spent,
      reservedUsd: reserved,
      observedAvailableUsd: avail,
      remainingUsd: remaining,
      pricingVersion: PRICING_VERSION,
      warnings: warned.map(([code]) => code),
      warningMessages: warned.map(([, text]) => text),
    };
  }

  function listTasks() {
    return TASKS.map((t) => ({
      name: t.name,
      description: t.description,
      inputs: describeSchema(t.inputSchema),
      outputs: describeSchema(t.outputSchema),
      maxOutputTokens: t.maxOutputTokens,
    }));
  }

  function status() {
    const v = budgetView();
    return {
      configured: !!keyOf(),
      model: modelOf(),
      paused: v.paused,
      pausedReason: v.pausedReason,
      pausedAt: v.pausedAt ?? null,
      spentUsd: v.spentUsd,
      liveCeilingUsd: v.liveCeilingUsd,
      remainingUsd: v.remainingUsd,
      reservedUsd: v.reservedUsd,
      effectiveAllocationUsd: v.effectiveAllocationUsd,
      activeAllocationUsd: v.activeAllocationUsd,
      pricingVersion: PRICING_VERSION,
      warnings: v.warnings,
      inFlight: inFlight.size,
      availableTasks: listTasks(),
    };
  }

  function emitBudget(reason) {
    const v = budgetView();
    send('budget.changed', { reason, paused: v.paused, pausedReason: v.pausedReason, spentUsd: v.spentUsd, reservedUsd: v.reservedUsd, remainingUsd: v.remainingUsd, liveCeilingUsd: v.liveCeilingUsd });
  }

  /** What the user-observed Console balance still allows: balance at asOf, minus what this
   *  studio spent since then, minus the untouchable reserve. null when no balance was entered. */
  function observedAvailableUsd(b) {
    const bal = b.observed?.balanceUsd;
    if (typeof bal !== 'number') return null;
    const asOf = b.observed.asOf ? Date.parse(b.observed.asOf) : null;
    const since = ledger.readAll().filter((l) => asOf == null || Date.parse(l.ts) >= asOf).reduce((s, l) => s + (l.costUsd || 0), 0);
    return round(bal - since - b.reserveUsd);
  }

  /** Synchronous gate: paused / exceeded checks against spend + other reservations + this call's max,
   *  and against the observed provider balance (minus the reserve) when one was entered. */
  function gate(estimate, runId) {
    const b = budgetStore.read();
    if (b.paused) throw new UtilityError('budget_paused', pausedMessage(b));
    const spent = spentUsd(b);
    const reserved = reservedUsd(runId);
    if (spent + reserved + estimate > b.liveCeilingUsd + 1e-12) {
      throw new UtilityError('budget_exceeded',
        `call could cost up to $${estimate.toFixed(4)}; spent $${spent.toFixed(4)} + reserved $${reserved.toFixed(4)} would exceed the live ceiling $${b.liveCeilingUsd.toFixed(2)}`);
    }
    const avail = observedAvailableUsd(b);
    if (avail != null && reserved + estimate > avail + 1e-12) {
      throw new UtilityError('budget_exceeded',
        `call could cost up to $${estimate.toFixed(4)}, but the observed Console balance ($${b.observed.balanceUsd.toFixed(2)} as of ${b.observed.asOf || 'unknown'}) minus the $${b.reserveUsd.toFixed(2)} reserve leaves $${Math.max(0, avail).toFixed(4)}; update the balance in Usage > Budget if it has changed`);
    }
    return b;
  }

  /** The reason the studio would pause for right now, or null. */
  function autoPauseCause(b) {
    if (spentUsd(b) >= b.liveCeilingUsd) return 'ceiling_reached';
    const avail = observedAvailableUsd(b);
    return avail != null && avail <= 0 ? 'observed_balance_exhausted' : null;
  }

  function maybeAutoPause() {
    const b = budgetStore.read();
    if (b.paused) return;
    const cause = autoPauseCause(b);
    if (!cause) return;
    budgetStore.setPaused(true, cause);
    emitBudget(cause);
  }

  /** After the person changes the budget: a pause the studio set lasts only while it has a cause, and
   *  says which one. The person's own pause is theirs to resume, so it is left alone. */
  function recheckAutoPause() {
    const b = budgetStore.read();
    if (!b.paused || !b.pausedReason || b.pausedReason === 'user') return;
    const cause = autoPauseCause(b);
    if (cause !== b.pausedReason) budgetStore.setPaused(!!cause, cause);
  }

  function record(base, attempt, fields) {
    const line = ledger.append({ ts: ts(), id: newId('u_'), ...base, attempt, pricingVersion: PRICING_VERSION, ...fields });
    maybeAutoPause();
    return line;
  }

  // track: false when a caller keeps its own row for this run (a Chat session on the API backend, server/lib/console.mjs).
  async function run(taskName, { projectId = null, taskId = null, input } = {}, { signal, runId: wantedRunId, track = true } = {}) {
    // A budget pause is reported before anything else so the pause is visible even when no key is set.
    { const pb = budgetStore.read(); if (pb.paused) throw new UtilityError('budget_paused', pausedMessage(pb)); }
    const apiKey = keyOf();
    if (!apiKey) throw new UtilityError('not_configured', 'No API key configured (set STUDIO_ANTHROPIC_API_KEY or ~/.atelier/secrets.json)');
    const task = TASK_MAP.get(taskName);
    if (!task) throw new UtilityError('unknown_task', `unknown utility task "${taskName}"`);
    const inErrs = validate(task.inputSchema, input, '$');
    if (!inErrs.length && task.checkInput) inErrs.push(...task.checkInput(input));
    if (inErrs.length) throw new UtilityError('invalid_input', `input does not match ${taskName} schema: ${inErrs.slice(0, 8).join('; ')}`);
    const model = modelOf();
    if (!hasPricing(model)) throw new UtilityError('not_configured', `model "${model}" has no pricing entry (pricing ${PRICING_VERSION}); refusing to run unbounded`);
    const userText = task.buildUser(input);
    if (userText.length > MAX_USER_CHARS) throw new UtilityError('invalid_input', `input is too large (${userText.length} chars > ${MAX_USER_CHARS})`);
    if (signal?.aborted) throw new UtilityError('cancelled', 'run cancelled before it started');

    let b = budgetStore.read();
    if (b.paused) throw new UtilityError('budget_paused', pausedMessage(b));
    if (inFlight.size >= b.maxConcurrent) throw new UtilityError('concurrency_limit', `at most ${b.maxConcurrent} utility runs may be in flight`);

    const maxOut = Math.min(task.maxOutputTokens, b.maxOutputTokens);
    const outSchema = task.outputSchemaFor ? task.outputSchemaFor(input) : task.outputSchema;
    const apiSchema = toApiSchema(outSchema);
    const schemaChars = JSON.stringify(apiSchema).length;
    const messages = [{ role: 'user', content: userText }];
    const estimateFor = () => estimateCallMax(model, {
      systemChars: task.system.length,
      userChars: JSON.stringify(messages).length + schemaChars,
      overheadTokens: 50,
      maxOutputTokens: maxOut,
    });

    const runId = typeof wantedRunId === 'string' && /^[\w-]{1,64}$/.test(wantedRunId) && !inFlight.has(wantedRunId) ? wantedRunId : newId('ur_');
    let estimate = estimateFor();
    b = gate(estimate, runId); // throws budget_exceeded before any call
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    inFlight.set(runId, { controller, reservedUsd: estimate, task: taskName, projectId, startedAt: ts() });
    const startedAt = nowMs();
    const base = { runId, task: taskName, projectId, taskId, model };
    const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let totalCost = 0;
    const maxAttempts = 1 + b.maxRetries;
    let repaired = false;
    send('utility.progress', { runId, task: taskName, projectId, taskId, phase: 'started', reservedUsd: estimate });
    emitBudget('reserved');
    // The Working now row (server/lib/runs.mjs), moved by the same phases the progress events report.
    const rows = track ? registry : null;
    rows?.start({ id: runId, kind: 'utility', projectId, name: taskName });

    const addUsage = (u, c) => { for (const k of Object.keys(total)) total[k] += u[k]; totalCost = round(totalCost + c); };
    const cancelled = (u = null) => {
      const usage = u || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const cost = u ? costFor(model, u) : 0;
      addUsage(usage, cost);
      return { usage, cost };
    };

    try {
      const client = makeClient(apiKey);
      for (let attempt = 1; ; attempt++) {
        if (controller.signal.aborted) {
          record(base, attempt, { ...cancelled().usage, costUsd: 0, durationMs: 0, ok: false, error: 'cancelled', cancelled: true });
          throw new UtilityError('cancelled', 'run cancelled');
        }
        if (attempt > 1) {
          estimate = estimateFor();
          gate(estimate, runId);
          inFlight.get(runId).reservedUsd = estimate;
        }
        send('utility.progress', { runId, task: taskName, phase: 'calling', attempt });
        rows?.update(runId, { latest: `calling ${model}, attempt ${attempt}` });
        const t0 = nowMs();
        let resp;
        try {
          resp = await client.messages.create({
            model,
            max_tokens: maxOut,
            system: [{ type: 'text', text: task.system, cache_control: { type: 'ephemeral' } }],
            messages,
            output_config: { effort: task.effort || 'low', format: { type: 'json_schema', schema: apiSchema } },
          }, { signal: controller.signal });
        } catch (err) {
          const durationMs = nowMs() - t0;
          if (isAbort(err, controller.signal)) {
            record(base, attempt, { ...cancelled().usage, costUsd: 0, durationMs, ok: false, error: 'cancelled', cancelled: true });
            throw new UtilityError('cancelled', 'run cancelled');
          }
          const msg = redact(`${err?.status ?? 'network'}: ${err?.message ?? err}`).slice(0, 300);
          record(base, attempt, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs, ok: false, error: msg, cancelled: false });
          if (isRetryable(err) && attempt < maxAttempts) {
            const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
            send('utility.progress', { runId, task: taskName, phase: 'retrying', attempt, waitMs: wait, error: msg });
            rows?.update(runId, { latest: `retrying in ${Math.round(wait / 1000)} s after ${msg}` });
            await sleep(wait, controller.signal).catch((e) => {
              record(base, attempt + 1, { ...cancelled().usage, costUsd: 0, durationMs: 0, ok: false, error: 'cancelled', cancelled: true });
              throw e;
            });
            continue;
          }
          if (err?.status === 429) throw new UtilityError('rate_limited', `provider rate limit: ${msg}`);
          throw new UtilityError('provider_error', `provider error: ${msg}`);
        }

        const durationMs = nowMs() - t0;
        const usage = usageOf(resp);
        const cost = costFor(model, usage);
        if (controller.signal.aborted) {
          cancelled(usage);
          record(base, attempt, { ...usage, costUsd: cost, durationMs, ok: false, error: 'cancelled', cancelled: true });
          throw new UtilityError('cancelled', 'run cancelled');
        }
        addUsage(usage, cost);

        if (resp?.stop_reason === 'refusal') {
          record(base, attempt, { ...usage, costUsd: cost, durationMs, ok: false, error: 'refusal', cancelled: false });
          throw new UtilityError('provider_error', 'the model declined this request (stop_reason: refusal)');
        }
        let errors;
        let output;
        if (resp?.stop_reason === 'max_tokens') {
          errors = [`output was truncated at max_tokens (${maxOut})`];
        } else {
          const parsed = parseOutput(resp);
          if (parsed.error) errors = [parsed.error];
          else {
            output = parsed.value;
            errors = validate(outSchema, output, '$');
            if (!errors.length && task.check) errors = task.check(input, output);
          }
        }
        if (!errors.length) {
          if (task.normalize) output = task.normalize(input, output);
          record(base, attempt, { ...usage, costUsd: cost, durationMs, ok: true, error: null, cancelled: false });
          const result = { runId, output, usage: { ...total }, costUsd: totalCost, model, validated: true, durationMs: nowMs() - startedAt, attempts: attempt };
          send('utility.progress', { runId, task: taskName, phase: 'done', costUsd: totalCost, attempts: attempt });
          rows?.end(runId, { state: 'Done', latest: `answered after ${attempt} attempt${attempt > 1 ? 's' : ''}` });
          return result;
        }
        const errText = errors.slice(0, 10).join('; ');
        record(base, attempt, { ...usage, costUsd: cost, durationMs, ok: false, error: redact(`invalid_output: ${errText}`).slice(0, 500), cancelled: false });
        const truncated = resp?.stop_reason === 'max_tokens';
        if (repaired || truncated || attempt >= maxAttempts) {
          throw new UtilityError('invalid_output', `output failed validation${repaired ? ' after one repair' : ''}: ${errText}`);
        }
        repaired = true;
        send('utility.progress', { runId, task: taskName, phase: 'repairing', attempt, errors: errors.slice(0, 10) });
        rows?.update(runId, { latest: 'asking for a corrected answer' });
        messages.push({ role: 'assistant', content: resp.content });
        messages.push({
          role: 'user',
          content: `Your previous reply failed validation:\n- ${errors.slice(0, 20).join('\n- ')}\nReply again with only the corrected JSON object that satisfies the schema and every rule.`,
        });
      }
    } catch (err) {
      const e = err instanceof UtilityError ? err : new UtilityError('provider_error', redact(err?.message || String(err)));
      send('utility.progress', { runId, task: taskName, phase: e.code === 'cancelled' ? 'cancelled' : 'failed', code: e.code, message: e.message, costUsd: totalCost });
      rows?.end(runId, e.code === 'cancelled' ? { state: 'Stopped', reason: 'cancelled' } : { state: 'Failed', reason: e.message });
      e.runId = runId;
      e.costUsd = totalCost;
      throw e;
    } finally {
      signal?.removeEventListener('abort', onExternalAbort);
      inFlight.delete(runId);
      emitBudget('released');
    }
  }

  function cancel(runId) {
    const r = inFlight.get(runId);
    if (!r) return false;
    r.controller.abort();
    return true;
  }

  const budget = {
    get: budgetView,
    patch(partial) {
      try {
        const wasPaused = budgetStore.read().paused;
        const b = budgetStore.patch(partial);
        // A client may only state a studio pause that is true now; a stale one is dropped, not converted.
        if (!wasPaused && b.paused && STUDIO_PAUSE_REASONS.includes(b.pausedReason) && autoPauseCause(b) !== b.pausedReason) budgetStore.setPaused(false, null);
        else recheckAutoPause();
      } catch (e) {
        if (e instanceof BudgetInputError) throw new UtilityError('invalid_input', e.message);
        throw e;
      }
      emitBudget('patched');
      return budgetView();
    },
  };

  const usage = {
    summary({ projectId } = {}) {
      const b = budgetStore.read();
      let lines = cycleLines(b);
      if (projectId) lines = lines.filter((l) => l.projectId === projectId);
      return { totals: aggregate(lines), reservedUsd: reservedUsd(), inFlight: inFlight.size, cycle: b.cycle, pricingVersion: PRICING_VERSION };
    },
    recent(n = 20) {
      const lines = ledger.readAll();
      return lines.slice(-Math.max(0, Math.min(Number(n) || 20, 500))).reverse();
    },
  };

  return { status, listTasks, run, cancel, budget, usage, pricing };
}
