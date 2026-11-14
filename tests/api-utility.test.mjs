import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUtility, UtilityError, redact, pricing } from '../server/api-utility/index.mjs';
import { createBudgetStore } from '../server/api-utility/budget.mjs';
import { costFor } from '../server/api-utility/pricing.mjs';
import { validate, toApiSchema } from '../server/api-utility/validate.mjs';

const FAKE_KEY = 'sk-ant-test-0123456789abcdef';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-utility-'));
}

const reply = (obj, usage = {}, stop_reason = 'end_turn') => ({
  content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }],
  stop_reason,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
});

/** Fake client: each create() call consumes the next handler (params, opts) => response | throws. */
function fakeClient(handlers) {
  const calls = [];
  const factory = (apiKey) => ({
    messages: {
      async create(params, opts = {}) {
        calls.push({ apiKey, params: structuredClone(params), opts });
        const h = handlers.shift();
        if (!h) throw new Error('fake client: no more canned responses');
        return h(params, opts);
      },
    },
  });
  return { factory, calls };
}

const hang = () => (_params, { signal }) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => { const e = new Error('Request was aborted.'); e.name = 'APIUserAbortError'; reject(e); }, { once: true });
});

function setup({ handlers = [], key = FAKE_KEY, now, budget } = {}) {
  const dataDir = tmpDir();
  const events = [];
  const fake = fakeClient(handlers);
  const u = createUtility({
    dataDir,
    getApiKey: () => key,
    getModel: () => 'claude-haiku-5-5',
    emit: (type, payload) => events.push({ type, payload }),
    clientFactory: fake.factory,
    now,
    backoffMs: [5, 5],
  });
  if (budget) u.budget.patch(budget);
  const ledger = () => {
    const f = path.join(dataDir, 'usage', 'ledger.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { u, dataDir, events, calls: fake.calls, ledger };
}

const summarizeInput = { title: 'Doc', url: 'https://example.com/a', text: 'See https://example.com/b for details.' };
const goodSummary = { summary: 'A doc.', keyPoints: ['one'], sourceLinks: ['https://example.com/a', 'https://example.com/b'], freshnessNotes: 'No dates or versions stated.' };

test('not_configured when the key is null; nothing is called or logged', async () => {
  const { u, calls, ledger } = setup({ key: null });
  assert.equal(u.status().configured, false);
  await assert.rejects(u.run('summarize-doc', { input: summarizeInput }), (e) => e instanceof UtilityError && e.code === 'not_configured');
  assert.equal(calls.length, 0);
  assert.equal(ledger().length, 0);
});

test('unknown_task and invalid_input are rejected before any call', async () => {
  const { u, calls } = setup();
  await assert.rejects(u.run('nope', { input: {} }), (e) => e.code === 'unknown_task' && e.status === 404);
  await assert.rejects(u.run('summarize-doc', { input: { title: 'x', text: 'y'.repeat(60001) } }), (e) => e.code === 'invalid_input');
  await assert.rejects(u.run('group-feedback', { input: { items: [{ id: 'a', text: '1' }, { id: 'a', text: '2' }] } }), (e) => e.code === 'invalid_input' && /duplicate/.test(e.message));
  assert.equal(calls.length, 0);
});

test('successful run: request shape, ledger line and exact haiku cost', async () => {
  // Hand-computed haiku (<=100k prompt) cost:
  // input 1000 * $0.10/M = 0.000100; cache write 400 * $0.125/M = 0.000050;
  // cache read 2000 * $0.01/M = 0.000020; output 500 * $0.50/M = 0.000250  => 0.000420
  const expected = 0.00042;
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 };
  const { u, calls, ledger, events, dataDir } = setup({ handlers: [() => reply(goodSummary, usage)] });
  const r = await u.run('summarize-doc', { projectId: 'p_1', taskId: 't_1', input: summarizeInput });

  assert.equal(r.validated, true);
  assert.deepEqual(r.output, goodSummary);
  assert.equal(r.costUsd, expected);
  assert.deepEqual(r.usage, { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, cacheWriteTokens: 400 });
  assert.equal(r.model, 'claude-haiku-5-5');

  const p = calls[0].params;
  assert.equal(calls[0].apiKey, FAKE_KEY);
  assert.ok(calls[0].opts.signal instanceof AbortSignal);
  assert.equal(p.max_tokens, 1500);
  assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(typeof p.messages[0].content, 'string', 'user content stays uncached');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.equal(p.output_config.format.schema.additionalProperties, false);
  assert.equal(p.output_config.format.schema.properties.summary.maxLength, undefined, 'unsupported constraints stripped for the API');

  const lines = ledger();
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.equal(l.ok, true);
  assert.equal(l.costUsd, expected);
  assert.equal(l.cacheReadTokens, 2000);
  assert.equal(l.cacheWriteTokens, 400);
  assert.equal(l.pricingVersion, pricing.version);
  assert.equal(l.projectId, 'p_1');
  assert.equal(l.taskId, 't_1');
  assert.equal(l.cancelled, false);
  assert.ok(fs.existsSync(path.join(dataDir, 'budget.json')), 'budget.json created lazily');

  const s = u.usage.summary({ projectId: 'p_1' });
  assert.equal(s.totals.costUsd, expected);
  assert.equal(s.totals.calls, 1);
  assert.equal(s.totals.byTask['summarize-doc'].calls, 1);
  assert.equal(u.status().spentUsd, expected);
  assert.ok(events.some((e) => e.type === 'utility.progress' && e.payload.phase === 'done'));
  assert.ok(!JSON.stringify(events).includes(FAKE_KEY));
  assert.ok(!fs.readFileSync(path.join(dataDir, 'usage', 'ledger.jsonl'), 'utf8').includes(FAKE_KEY));
});

test('pricing: haiku long-prompt tier and unknown model', () => {
  // 90k input + 20k cache read = 110k prompt > 100k => long tier: 90000*0.5 + 20000*0.05 + 1000*2.5 = 48500 / 1e6
  assert.equal(costFor('claude-haiku-5-5', { inputTokens: 90000, cacheReadTokens: 20000, outputTokens: 1000 }), 0.0485);
  assert.equal(costFor('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 1e6 }), 24);
  assert.equal(costFor('claude-sonnet-5-5', { cacheWriteTokens: 1e6 }, { cacheTtl: '1h' }), 4);
  assert.throws(() => costFor('claude-unknown', { inputTokens: 1 }), /No pricing/);
});

test('budget_exceeded before the call', async () => {
  const { u, calls, ledger } = setup({ handlers: [() => reply(goodSummary)], budget: { liveCeilingUsd: 0.0001 } });
  await assert.rejects(u.run('summarize-doc', { input: summarizeInput }), (e) => e.code === 'budget_exceeded' && e.status === 402);
  assert.equal(calls.length, 0);
  assert.equal(ledger().length, 0);
  assert.equal(u.status().inFlight, 0);
});

test('observed Console balance minus the reserve blocks a call even under the live ceiling', async () => {
  const { u, calls } = setup({ handlers: [() => reply(goodSummary)], budget: { liveCeilingUsd: 40, observed: { balanceUsd: 20.0005, asOf: '2026-11-01T00:00:00.000Z' } } });
  // the default reserve is $20 -> only $0.0005 is available; any call's max estimate exceeds that
  await assert.rejects(u.run('summarize-doc', { input: summarizeInput }), (e) => e.code === 'budget_exceeded' && /observed Console balance/.test(e.message));
  assert.equal(calls.length, 0);
  assert.equal(u.budget.get().observedAvailableUsd, 0.0005);
  // a healthy observed balance lets the call through
  u.budget.patch({ observed: { balanceUsd: 150, asOf: '2026-11-01T00:00:00.000Z' } });
  const res = await u.run('summarize-doc', { input: summarizeInput });
  assert.equal(res.validated, true);
  assert.equal(calls.length, 1);
});

test('budget below the reserve: the messages name the balance and the reserve, and nothing contradicts $0.00 left', async () => {
  const { u, calls } = setup({ handlers: [() => reply(goodSummary)], budget: { observed: { balanceUsd: 10, asOf: '2026-11-04' } } });
  const b = u.budget.get();
  assert.equal(b.remainingUsd, 0);
  assert.deepEqual(b.warnings, ['observed_balance_below_reserve', 'observed_balance_below_allocation']);
  assert.deepEqual(b.warningMessages, [
    'Your observed balance ($10.00) is below the $20.00 reserve, so no utility runs until the balance is above it; the live ceiling has $0.00 left for the same reason.',
    'The active allocation ($180.00) is reduced to your observed balance ($10.00).',
  ]);
  assert.ok(!b.warningMessages.join(' ').includes('may stop'));
  await assert.rejects(u.run('summarize-doc', { input: summarizeInput }), (e) => e.code === 'budget_exceeded');
  assert.equal(calls.length, 0);
  // exactly at the reserve is not "below" it, and also leaves nothing
  assert.match(u.budget.patch({ observed: { balanceUsd: 20, asOf: '2026-11-04' } }).warningMessages[0], /^Your observed balance \(\$20\.00\) is at the \$20\.00 reserve, so no utility runs/);
  // above the reserve but under the ceiling: the reserve is named and the figure agrees with the page
  const partial = u.budget.patch({ observed: { balanceUsd: 25, asOf: '2026-11-04' } });
  assert.equal(partial.remainingUsd, 5);
  assert.equal(partial.warningMessages[0], 'Your observed balance ($25.00) minus the $20.00 reserve leaves $5.00, so the live ceiling has $5.00 left rather than $40.00.');
  // a healthy balance: no reserve or ceiling message; no balance at all: none
  assert.deepEqual(u.budget.patch({ observed: { balanceUsd: 190, asOf: '2026-11-04' } }).warningMessages, []);
  assert.deepEqual(u.budget.patch({ observed: { balanceUsd: null } }).warningMessages, []);
  assert.doesNotThrow(() => u.budget.patch(u.budget.get()), 'the derived messages round-trip');
});

test('auto-pause at the ceiling, then budget_paused; paused:false does not lift it', async () => {
  const tag = { tags: ['audio'], kind: 'library', confidence: 0.8 };
  // 20000 in * 0.10/M + 100 out * 0.50/M = 0.00205 >= ceiling 0.002
  const { u, events, calls } = setup({
    handlers: [() => reply(tag, { input_tokens: 20000, output_tokens: 100 })],
    budget: { liveCeilingUsd: 0.002 },
  });
  const input = { name: 'Tone.js', description: 'Web audio framework', allowedTags: ['audio', 'web'] };
  const r = await u.run('tag-resource', { input });
  assert.equal(r.costUsd, 0.00205);
  const st = u.status();
  assert.equal(st.paused, true);
  assert.equal(st.pausedReason, 'ceiling_reached');
  assert.equal(st.remainingUsd, 0);
  assert.ok(events.some((e) => e.type === 'budget.changed' && e.payload.reason === 'ceiling_reached'));
  await assert.rejects(u.run('tag-resource', { input }), (e) => e.code === 'budget_paused' && e.status === 402);
  assert.equal(calls.length, 1);

  u.budget.patch({ paused: false });
  await assert.rejects(u.run('tag-resource', { input }), (e) => e.code === 'budget_paused');
  assert.equal(calls.length, 1);
});

test('paused:false lifts only the person\'s pause; a studio pause lifts when its cause is gone', async () => {
  const held = (u, reason, pausedAt) => {
    assert.equal(u.status().paused, true);
    assert.equal(u.status().pausedReason, reason);
    assert.equal(u.status().pausedAt, pausedAt);
  };

  // the ceiling: paused:false alone changes nothing; in the same patch as a raised ceiling, the recheck lifts it
  const c = setup({ budget: { liveCeilingUsd: 0 } }).u;
  c.budget.patch({ paused: true, pausedReason: 'ceiling_reached' });
  const atCeiling = c.status().pausedAt;
  c.budget.patch({ paused: false });
  c.budget.patch({ ...c.budget.get(), paused: false, pausedReason: null, pausedAt: null }); // a whole stale object
  held(c, 'ceiling_reached', atCeiling);
  c.budget.patch({ paused: false, liveCeilingUsd: 10 });
  assert.equal(c.status().paused, false);
  assert.equal(c.status().pausedReason, null);
  assert.equal(c.status().pausedAt, null);

  // the balance: the same, and the fields beside paused:false are still saved
  const o = setup({ budget: { observed: { balanceUsd: 20, asOf: '2020-01-01' } } }).u;
  o.budget.patch({ paused: true, pausedReason: 'observed_balance_exhausted' });
  const atBalance = o.status().pausedAt;
  assert.equal(o.budget.patch({ paused: false, liveCeilingUsd: 30 }).liveCeilingUsd, 30);
  held(o, 'observed_balance_exhausted', atBalance);
  o.budget.patch({ observed: { balanceUsd: 100, asOf: '2020-01-01' } });
  assert.equal(o.status().paused, false);

  // the person's own: paused:false resumes it, also from a record older than pausedReason
  const p = setup().u;
  p.budget.patch({ paused: true });
  assert.equal(p.budget.patch({ paused: false }).paused, false);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'budget.json'), JSON.stringify({ paused: true }));
  assert.equal(createBudgetStore(dir).patch({ paused: false }).paused, false);
});

test('pause refusal is one plain sentence pair with the day it was paused; old records without a date still read', async () => {
  const { u, calls } = setup({ now: () => new Date(2026, 10, 4, 12, 0, 0) });
  const input = { name: 'Tone.js', description: 'Web audio framework', allowedTags: ['audio', 'web'] };
  const b = u.budget.patch({ paused: true });
  assert.ok(b.pausedAt, 'pausedAt recorded');
  assert.equal(u.status().pausedAt, b.pausedAt);
  await assert.rejects(u.run('tag-resource', { input }), (e) => e.code === 'budget_paused' && e.status === 402
    && e.message === 'API utilities are paused (by you on 2026-11-04). Resume them in Budget to run this. Nothing was spent.');
  assert.equal(calls.length, 0);
  const { pausedMessage } = await import('../server/api-utility/budget.mjs');
  assert.equal(pausedMessage({ paused: true, pausedReason: 'user' }), 'API utilities are paused (by you). Resume them in Budget to run this. Nothing was spent.');
  assert.equal(u.budget.patch({ paused: false }).pausedAt, null);
});

test('each pause reason has its own refusal, and only the person\'s own says Resume', async () => {
  const { pausedMessage } = await import('../server/api-utility/budget.mjs');
  const at = new Date(2026, 10, 4, 12, 0, 0).toISOString();
  assert.equal(pausedMessage({ pausedReason: 'ceiling_reached', pausedAt: at }), 'API utilities are paused (the live ceiling was reached on 2026-11-04). Raise the ceiling or set a new cycle in Budget to run this. Nothing was spent.');
  assert.equal(pausedMessage({ pausedReason: 'observed_balance_exhausted', pausedAt: at }), 'API utilities are paused (the observed balance reached the reserve on 2026-11-04). Enter a newer balance in Budget to run this. Nothing was spent.');
  assert.match(pausedMessage({ pausedReason: 'user' }), /Resume them in Budget/);
});

test('a pause the studio set lifts when its cause is gone, and names the cause that remains', async () => {
  const tag = { tags: ['audio'], kind: 'library', confidence: 0.8 };
  const input = { name: 'Tone.js', description: 'Web audio framework', allowedTags: ['audio', 'web'] };
  const { u, calls } = setup({
    handlers: [() => reply(tag, { input_tokens: 20000, output_tokens: 100 }), () => reply(tag)], // costs 0.00205, then a little
    budget: { liveCeilingUsd: 0.002 },
  });
  await u.run('tag-resource', { input });
  assert.equal(u.status().pausedReason, 'ceiling_reached');
  const pausedAt = u.status().pausedAt;

  // A save that leaves the cause in place changes nothing, and a round-trip keeps reason and day.
  u.budget.patch({ liveCeilingUsd: 0.002 });
  u.budget.patch(u.budget.get());
  assert.equal(u.status().paused, true);
  assert.equal(u.status().pausedReason, 'ceiling_reached');
  assert.equal(u.status().pausedAt, pausedAt);

  // Room under the ceiling, but the balance is at the reserve: still paused, for the other reason.
  u.budget.patch({ liveCeilingUsd: 10, observed: { balanceUsd: 20, asOf: '2020-01-01' } });
  assert.equal(u.status().paused, true);
  assert.equal(u.status().pausedReason, 'observed_balance_exhausted');
  u.budget.patch(u.budget.get());
  assert.equal(u.status().pausedReason, 'observed_balance_exhausted', 'a round-trip does not turn it into a pause by the person');

  // A newer balance removes that cause too: the pause is gone and a run goes through.
  u.budget.patch({ observed: { balanceUsd: 100, asOf: '2020-01-01' } });
  assert.equal(u.status().paused, false);
  assert.equal(u.status().pausedReason, null);
  assert.equal(u.status().pausedAt, null);
  await u.run('tag-resource', { input });
  assert.equal(calls.length, 2);
});

test('the person\'s own pause is not lifted by saving the budget', () => {
  const { u } = setup();
  u.budget.patch({ paused: true });
  u.budget.patch({ liveCeilingUsd: 30, observed: { balanceUsd: 100, asOf: '2026-11-04' } });
  assert.equal(u.status().paused, true);
  assert.equal(u.status().pausedReason, 'user');
});

test('a stale paused:true cannot become a pause by the person, and a true studio reason is honoured', async () => {
  const claim = (pausedReason) => ({ paused: true, pausedReason });
  const { u } = setup({ budget: { observed: { balanceUsd: 20, asOf: '2020-01-01' } } });
  // the balance really is at the reserve: that reason stands; a claim of the ceiling does not
  assert.equal(u.budget.patch(claim('ceiling_reached')).paused, false);
  const held = u.budget.patch(claim('observed_balance_exhausted'));
  assert.equal(held.paused, true);
  assert.equal(held.pausedReason, 'observed_balance_exhausted');
  const stale = u.budget.get(); // what a client still holds when the pause lifts

  assert.equal(u.budget.patch({ observed: { balanceUsd: 100, asOf: '2020-01-01' } }).paused, false);
  const after = u.budget.patch({ ...stale, observed: { balanceUsd: 100, asOf: '2020-01-01' } });
  assert.equal(after.paused, false);
  assert.equal(after.pausedReason, null);
  assert.equal(after.pausedAt, null);
  assert.equal(u.budget.patch(claim('observed_balance_exhausted')).paused, false);
  assert.equal(u.status().paused, false);

  // the ceiling reason, when true (nothing left under a zero ceiling)
  const c = setup({ budget: { liveCeilingUsd: 0 } }).u;
  assert.equal(c.budget.patch(claim('ceiling_reached')).pausedReason, 'ceiling_reached');

  // anything that is not a studio reason is the person's own pause, and theirs stays theirs
  const { u: p } = setup();
  assert.equal(p.budget.patch(claim('some_new_reason')).pausedReason, 'user');
  assert.equal(p.budget.patch(claim('ceiling_reached')).pausedReason, 'user', 'already paused: the reason stays');
  assert.equal(p.status().paused, true);
  p.budget.patch({ paused: false });
  assert.equal(p.budget.patch({ paused: true }).pausedReason, 'user');
});

test('the balance warning names what is reserved for runs in flight', async () => {
  const { balanceWarnings } = await import('../server/api-utility/budget.mjs');
  const b = { reserveUsd: 20, activeAllocationUsd: 180, observed: { balanceUsd: 25 } };
  const sentence = (more) => balanceWarnings(b, { available: 5, ceilingRemaining: 38, remaining: 3, ...more })[0][1];
  assert.equal(sentence({ reserved: 2, inFlight: 1 }), 'Your observed balance ($25.00) minus the $20.00 reserve leaves $5.00, so the live ceiling has $3.00 left, with $2.00 reserved for a run in flight, rather than $38.00.');
  assert.match(sentence({ reserved: 2, inFlight: 2 }), /with \$2\.00 reserved for 2 runs in flight, rather/);
  assert.match(sentence({ reserved: 0.001, inFlight: 1 }), /with under \$0\.01 reserved for a run in flight, rather/, 'never "$0.00 reserved"');
  assert.doesNotMatch(sentence({ reserved: 0, inFlight: 0 }), /reserved for/);

  // and from a real run: the reservation shows while it runs and goes when it ends
  const { u } = setup({ handlers: [hang()], budget: { observed: { balanceUsd: 25, asOf: '2026-11-04' } } });
  const running = u.run('summarize-doc', { input: summarizeInput }, { runId: 'r_flight' });
  assert.ok(u.status().reservedUsd > 0);
  assert.match(u.budget.get().warningMessages[0], /reserved for a run in flight, rather than/);
  u.cancel('r_flight');
  await assert.rejects(running);
  assert.doesNotMatch(u.budget.get().warningMessages[0], /in flight/);
});

test('observed balance date: a plain YYYY-MM-DD round-trips unchanged; ISO timestamps are kept', () => {
  const { u } = setup({ now: () => new Date(2026, 10, 4, 23, 30, 0) });
  assert.equal(u.budget.patch({ observed: { balanceUsd: 150, asOf: '2026-11-04' } }).observed.asOf, '2026-11-04');
  assert.equal(u.budget.get().observed.asOf, '2026-11-04');
  assert.equal(u.budget.patch({ observed: { balanceUsd: 150, observedAt: '2026-11-04' } }).observed.asOf, '2026-11-04', 'observedAt is accepted as the same field');
  assert.equal(u.budget.patch({ observed: { balanceUsd: 140 } }).observed.asOf, '2026-11-04', 'no date given: today, local, as a plain date');
  assert.equal(u.budget.patch({ observed: { balanceUsd: 130, asOf: '2026-11-03T10:00:00Z' } }).observed.asOf, '2026-11-03T10:00:00Z');
  assert.equal(u.budget.patch({ observed: { balanceUsd: null } }).observed.asOf, null);
});

test('budget patch validation', () => {
  const { u } = setup();
  const bad = (p, re) => assert.throws(() => u.budget.patch(p), (e) => e.code === 'invalid_input' && re.test(e.message));
  bad({ liveCeilingUsd: -1 }, /non-negative/);
  bad({ liveCeilingUsd: '5' }, /non-negative/);
  bad({ liveCeilingUsd: 181 }, /liveCeilingUsd .* <= activeAllocationUsd/);
  bad({ activeAllocationUsd: 190 }, /grantUsd - reserveUsd - otherAppsReserveUsd/);
  bad({ otherAppsReserveUsd: 50 }, /activeAllocationUsd/); // 180 > 200-20-50
  bad({ paused: 'yes' }, /true or false/);
  bad({ maxConcurrent: 0 }, /integer/);
  bad({ cycle: { start: '2026-13-45' } }, /YYYY-MM-DD/);
  bad({ cycle: { start: '2026-11-10', end: '2026-11-01' } }, /on or before/);
  bad({ observed: { balanceUsd: -3 } }, /balanceUsd/);
  bad({ surprise: 1 }, /unknown budget field/);
  // Failed patches leave the file untouched.
  assert.equal(u.budget.get().liveCeilingUsd, 40);

  const b = u.budget.patch({ liveCeilingUsd: 25, observed: { balanceUsd: 120, asOf: '2026-11-03T10:00:00Z' }, cycle: { start: '2026-11-01', end: '2026-11-30' } });
  assert.equal(b.liveCeilingUsd, 25);
  assert.equal(b.effectiveAllocationUsd, 120, 'observed balance below allocation becomes the effective allocation');
  assert.equal(u.status().effectiveAllocationUsd, 120);
  assert.equal(b.cycle.source, 'user-entered');
  assert.equal(u.budget.patch({ paused: true }).pausedReason, 'user');
  assert.equal(u.budget.patch({ paused: false }).pausedReason, null);
  // Derived fields round-trip harmlessly.
  assert.doesNotThrow(() => u.budget.patch(u.budget.get()));
});

test('cancellation via cancel(runId) and via an external signal', async () => {
  const { u, ledger, events } = setup({ handlers: [hang(), hang()] });
  const p = u.run('explain', { input: { question: 'q?', material: 'm' } }, { runId: 'run-a' });
  await new Promise((r) => setImmediate(r));
  assert.equal(u.status().inFlight, 1);
  assert.ok(u.status().reservedUsd > 0);
  assert.equal(u.cancel('run-a'), true);
  await assert.rejects(p, (e) => e.code === 'cancelled' && e.runId === 'run-a');
  assert.equal(u.cancel('run-a'), false);
  assert.equal(u.status().inFlight, 0);
  assert.equal(u.status().reservedUsd, 0);

  const ac = new AbortController();
  const p2 = u.run('explain', { input: { question: 'q?', material: 'm' } }, { signal: ac.signal });
  await new Promise((r) => setImmediate(r));
  ac.abort();
  await assert.rejects(p2, (e) => e.code === 'cancelled');

  const lines = ledger();
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.cancelled === true && l.costUsd === 0 && l.ok === false));
  assert.ok(events.some((e) => e.type === 'utility.progress' && e.payload.phase === 'cancelled'));
});

test('concurrency_limit beyond maxConcurrent', async () => {
  const { u } = setup({ handlers: [hang()], budget: { maxConcurrent: 1 } });
  const p = u.run('explain', { input: { question: 'q', material: 'm' } }, { runId: 'r1' });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(u.run('explain', { input: { question: 'q', material: 'm' } }), (e) => e.code === 'concurrency_limit');
  u.cancel('r1');
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('invalid JSON output is repaired once with the validation errors fed back', async () => {
  const { u, calls, ledger } = setup({ handlers: [() => reply('Sure! Here is the summary: {oops'), () => reply(goodSummary)] });
  const r = await u.run('summarize-doc', { input: summarizeInput });
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.output, goodSummary);
  // Both attempts billed: 2 * (100*0.10 + 50*0.50)/1e6
  assert.equal(r.costUsd, 0.00007);
  const second = calls[1].params.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  assert.match(second[2].content, /failed validation[\s\S]*not valid JSON/);
  const lines = ledger();
  assert.deepEqual(lines.map((l) => l.ok), [false, true]);
  assert.match(lines[0].error, /^invalid_output/);
});

test('invented links fail validation and become invalid_output after one repair', async () => {
  const invented = { ...goodSummary, sourceLinks: ['https://example.com/a', 'https://invented.example.org/x'] };
  const { u, calls } = setup({ handlers: [() => reply(invented), () => reply(invented), () => reply(goodSummary)] });
  await assert.rejects(u.run('summarize-doc', { input: summarizeInput }), (e) => e.code === 'invalid_output' && /invented\.example\.org/.test(e.message) && e.costUsd > 0);
  assert.equal(calls.length, 2, 'exactly one repair attempt');
});

test('schema violations (maxLength, enum, missing field) are rejected locally', async () => {
  const tooLong = { ...goodSummary, summary: 'x'.repeat(1201) };
  const { u } = setup({ handlers: [() => reply(tooLong), () => reply({ summary: 'ok' })] });
  await assert.rejects(u.run('summarize-doc', { input: summarizeInput }), (e) => e.code === 'invalid_output' && /keyPoints: is required/.test(e.message));
  assert.deepEqual(validate({ type: 'string', enum: ['a'] }, 'b').length, 1);
  assert.deepEqual(validate({ type: 'number', minimum: 0, maximum: 1 }, 1.5).length, 1);
  assert.equal(toApiSchema({ type: 'object', properties: { n: { type: 'number', minimum: 0 } } }).properties.n.minimum, undefined);
});

test('529 is retried with backoff, then succeeds', async () => {
  const overloaded = () => { const e = new Error('Overloaded'); e.status = 529; throw e; };
  const { u, calls, ledger, events } = setup({ handlers: [overloaded, () => reply(goodSummary)] });
  const r = await u.run('summarize-doc', { input: summarizeInput });
  assert.equal(r.attempts, 2);
  assert.equal(calls.length, 2);
  const lines = ledger();
  assert.deepEqual(lines.map((l) => l.ok), [false, true]);
  assert.match(lines[0].error, /529/);
  assert.equal(lines[0].costUsd, 0);
  assert.ok(events.some((e) => e.payload.phase === 'retrying'));
});

test('429 after retries are spent maps to rate_limited; key is redacted from errors', async () => {
  const limited = () => { const e = new Error(`rate limited for key ${FAKE_KEY}`); e.status = 429; throw e; };
  const { u, ledger } = setup({ handlers: [limited, limited] });
  await assert.rejects(u.run('summarize-doc', { input: summarizeInput }), (e) => e.code === 'rate_limited' && !e.message.includes(FAKE_KEY) && e.message.includes('sk-ant-[redacted]'));
  assert.equal(ledger().length, 2);
  assert.ok(ledger().every((l) => !JSON.stringify(l).includes(FAKE_KEY)));
  assert.equal(redact('x sk-ant-api03-AbC_d-9 y'), 'x sk-ant-[redacted] y');
});

test('group-feedback integrity: itemIds must cover the input exactly once', async () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, text: `feedback ${id}` }));
  const bad = { groups: [{ label: 'One', itemIds: ['a', 'b', 'zz'], proposedNextPiece: 'x' }, { label: 'Two', itemIds: ['b'], proposedNextPiece: 'y' }] };
  const good = { groups: [{ label: 'One', itemIds: ['a', 'b'], proposedNextPiece: 'x' }, { label: 'Two', itemIds: ['c', 'd'], proposedNextPiece: 'y' }] };

  const s1 = setup({ handlers: [() => reply(bad), () => reply(bad)] });
  await assert.rejects(s1.u.run('group-feedback', { input: { items } }), (e) => {
    assert.equal(e.code, 'invalid_output');
    assert.match(e.message, /"zz" does not exist/);
    assert.match(e.message, /"b" appears in 2 groups/);
    assert.match(e.message, /"c" is missing/);
    return true;
  });

  const s2 = setup({ handlers: [() => reply(bad), () => reply(good)] });
  const r = await s2.u.run('group-feedback', { input: { items } });
  assert.deepEqual(r.output, good);
  assert.match(s2.calls[1].params.messages[2].content, /"d" is missing/);
});

test('draft-memory-candidates: "explicit" without a verbatim quote is downgraded to inferred', async () => {
  const out = { candidates: [
    { kind: 'preference', scope: 'user', text: 'Prefers previews first.', basis: 'explicit', evidence: 'I like to try previews before we talk code' },
    { kind: 'lesson', scope: 'project', text: 'Jump should be snappier.', basis: 'explicit', evidence: 'the user seems to want snappy jumps' },
  ] };
  const { u } = setup({ handlers: [() => reply(out)] });
  const r = await u.run('draft-memory-candidates', { input: { notes: ['I like to try previews before we talk code.', 'Jump felt floaty.'] } });
  assert.deepEqual(r.output.candidates.map((c) => c.basis), ['explicit', 'inferred']);
});

test('tag-resource sends allowedTags as an enum and rejects other tags', async () => {
  const { u, calls } = setup({ handlers: [() => reply({ tags: ['made-up'], kind: 'library', confidence: 0.5 }), () => reply({ tags: ['web'], kind: 'library', confidence: 0.5 })] });
  const r = await u.run('tag-resource', { input: { name: 'x', description: 'y', allowedTags: ['audio', 'web'] } });
  assert.deepEqual(calls[0].params.output_config.format.schema.properties.tags.items.enum, ['audio', 'web']);
  assert.deepEqual(r.output.tags, ['web']);
});

test('usage.summary only counts lines inside the budget cycle', async () => {
  let t = Date.parse('2026-10-15T12:00:00Z');
  const { u } = setup({ now: () => new Date(t), handlers: [() => reply(goodSummary), () => reply(goodSummary)] });
  await u.run('summarize-doc', { input: summarizeInput });
  t = Date.parse('2026-11-03T12:00:00Z');
  await u.run('summarize-doc', { input: summarizeInput });
  assert.equal(u.usage.summary().totals.calls, 2);
  u.budget.patch({ cycle: { start: '2026-11-01', end: '2026-11-30' } });
  assert.equal(u.usage.summary().totals.calls, 1);
  assert.equal(u.usage.recent(5).length, 2);
  assert.equal(u.usage.recent(5)[0].ts, '2026-11-03T12:00:00.000Z', 'recent is newest first');
});

test('status lists all nine tasks with schemas and never exposes the key', () => {
  const { u } = setup();
  const st = u.status();
  assert.deepEqual(st.availableTasks.map((t) => t.name).sort(), ['console-chat', 'draft-memory-candidates', 'draft-session-summary', 'explain', 'extract-metadata', 'group-feedback', 'prepare-context', 'summarize-doc', 'tag-resource']);
  assert.equal(st.configured, true);
  assert.ok(!JSON.stringify(st).includes(FAKE_KEY));
  assert.ok(!JSON.stringify(u.budget.get()).includes(FAKE_KEY));
});
