// budget.json: ceilings, reserve, observed balance, pause flag.
// The file is created lazily (first read) with the defaults below.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BUDGET = Object.freeze({
  grantUsd: 200,
  reserveUsd: 20,
  activeAllocationUsd: 180,
  liveCeilingUsd: 40,
  cycle: { start: null, end: null, source: 'unknown' },
  observed: { balanceUsd: null, asOf: null, note: 'Console > Billing > Promotional credits' },
  otherAppsReserveUsd: 0,
  paused: false,
  pausedReason: null,
  pausedAt: null,
  maxConcurrent: 2,
  maxOutputTokens: 2000,
  maxRetries: 1,
});

// Derived fields that budget.get() adds; patch() ignores them so a UI can round-trip the object.
const DERIVED = new Set(['observedAvailableUsd', 'effectiveAllocationUsd', 'spentUsd', 'reservedUsd', 'remainingUsd', 'pricingVersion', 'warnings', 'warningMessages']);

const MONEY = ['grantUsd', 'reserveUsd', 'activeAllocationUsd', 'liveCeilingUsd', 'otherAppsReserveUsd'];
const INTS = { maxConcurrent: [1, 16], maxOutputTokens: [64, 32000], maxRetries: [0, 3] };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pauses the studio sets itself; every other pause is the person's. */
export const STUDIO_PAUSE_REASONS = Object.freeze(['ceiling_reached', 'observed_balance_exhausted']);

export class BudgetInputError extends Error {}

/** YYYY-MM-DD of a Date in local time (the day the person sees on their calendar). */
export function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The refusal text for a paused budget: one sentence pair, no jargon. Only the person's own pause
 *  has a Resume; the studio's lifts when the cause is gone, so its sentence names what to change. */
export function pausedMessage(b) {
  const day = typeof b?.pausedAt === 'string' && !Number.isNaN(Date.parse(b.pausedAt)) ? localDate(new Date(b.pausedAt)) : null;
  const on = day ? ` on ${day}` : '';
  const [why, next] = {
    user: [`by you${on}`, 'Resume them in Budget to run this.'],
    ceiling_reached: [`the live ceiling was reached${on}`, 'Raise the ceiling or set a new cycle in Budget to run this.'],
    observed_balance_exhausted: [`the observed balance reached the reserve${on}`, 'Enter a newer balance in Budget to run this.'],
  }[b?.pausedReason || 'user'] || [`${b.pausedReason}${on}`, 'See Budget.'];
  return `API utilities are paused (${why}). ${next} Nothing was spent.`;
}

function merge(stored) {
  const b = { ...structuredClone(DEFAULT_BUDGET), ...(stored || {}) };
  b.cycle = { ...DEFAULT_BUDGET.cycle, ...(stored?.cycle || {}) };
  b.observed = { ...DEFAULT_BUDGET.observed, ...(stored?.observed || {}) };
  return b;
}

export function effectiveAllocation(b) {
  const bal = b.observed?.balanceUsd;
  return typeof bal === 'number' && bal < b.activeAllocationUsd ? bal : b.activeAllocationUsd;
}

const money = (n) => `$${n.toFixed(2)}`;

/** What the observed balance does to the figures on the Budget page: warning code plus one
 *  sentence naming the numbers. available = balance - spent since it was observed - reserve;
 *  ceilingRemaining = what the live ceiling alone would still allow; remaining = the figure shown,
 *  which also subtracts reserved, held for the inFlight runs. */
export function balanceWarnings(b, { available, ceilingRemaining, remaining, reserved = 0, inFlight = 0 }) {
  const bal = b.observed?.balanceUsd;
  if (typeof bal !== 'number') return [];
  const out = [];
  const since = Math.max(0, bal - b.reserveUsd - available);
  const spentNote = since >= 0.005 ? `, less ${money(since)} spent since,` : '';
  if (available <= 0) {
    const where = available < 0 ? 'below' : 'at';
    const ceiling = ceilingRemaining > 0 ? `; the live ceiling has ${money(0)} left for the same reason` : '';
    out.push(['observed_balance_below_reserve', `Your observed balance (${money(bal)})${spentNote} is ${where} the ${money(b.reserveUsd)} reserve, so no utility runs until the balance is above it${ceiling}.`]);
  } else if (remaining < ceilingRemaining) {
    const less = since >= 0.005 ? `minus ${money(since)} spent since and the ${money(b.reserveUsd)} reserve` : `minus the ${money(b.reserveUsd)} reserve`;
    const held = reserved >= 0.005 ? money(reserved) : 'under $0.01'; // a small reservation must not read as $0.00
    const flight = reserved > 0 ? `, with ${held} reserved for ${inFlight > 1 ? `${inFlight} runs` : 'a run'} in flight,` : '';
    out.push(['observed_balance_below_remaining_ceiling', `Your observed balance (${money(bal)}) ${less} leaves ${money(available)}, so the live ceiling has ${money(remaining)} left${flight} rather than ${money(ceilingRemaining)}.`]);
  }
  if (bal < b.activeAllocationUsd) out.push(['observed_balance_below_allocation', `The active allocation (${money(b.activeAllocationUsd)}) is reduced to your observed balance (${money(bal)}).`]);
  return out;
}

export function createBudgetStore(dataDir, { now = () => new Date() } = {}) {
  const file = path.join(dataDir, 'budget.json');

  function write(b) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(b, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return b;
  }

  function read() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return write(merge(null));
      throw e;
    }
    return merge(JSON.parse(raw));
  }

  /** Validates and applies a partial update; throws BudgetInputError with a readable message. */
  function patch(partial) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new BudgetInputError('budget patch must be an object');
    const b = read();
    for (const [k, v] of Object.entries(partial)) {
      if (DERIVED.has(k)) continue;
      if (MONEY.includes(k)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BudgetInputError(`${k} must be a non-negative number`);
        b[k] = Math.round(v * 1e6) / 1e6;
      } else if (Object.hasOwn(INTS, k)) {
        const [lo, hi] = INTS[k];
        if (!Number.isInteger(v) || v < lo || v > hi) throw new BudgetInputError(`${k} must be an integer from ${lo} to ${hi}`);
        b[k] = v;
      } else if (k === 'paused') {
        if (typeof v !== 'boolean') throw new BudgetInputError('paused must be true or false');
        if (v && b.paused) continue; // already paused (a UI round-trip): the reason and day stay what they were
        if (!v && STUDIO_PAUSE_REASONS.includes(b.pausedReason)) continue; // a studio pause lifts only when its cause is gone (recheckAutoPause)
        b.paused = v;
        b.pausedReason = v ? (STUDIO_PAUSE_REASONS.includes(partial.pausedReason) ? partial.pausedReason : 'user') : null;
        b.pausedAt = v ? now().toISOString() : null;
      } else if (k === 'pausedAt') {
        // set by the studio when pausing; a UI round-trip may send it back unchanged
      } else if (k === 'pausedReason') {
        if (!('paused' in partial)) throw new BudgetInputError('pausedReason is set by the studio; patch paused instead');
      } else if (k === 'observed') {
        if (!v || typeof v !== 'object') throw new BudgetInputError('observed must be {balanceUsd, asOf}');
        const ov = 'observedAt' in v && !('asOf' in v) ? { ...v, asOf: v.observedAt } : v; // observedAt: alias for asOf
        const o = { ...b.observed };
        if ('balanceUsd' in ov) {
          if (ov.balanceUsd !== null && (typeof ov.balanceUsd !== 'number' || !Number.isFinite(ov.balanceUsd) || ov.balanceUsd < 0)) {
            throw new BudgetInputError('observed.balanceUsd must be a non-negative number or null');
          }
          o.balanceUsd = ov.balanceUsd === null ? null : Math.round(ov.balanceUsd * 1e6) / 1e6;
          o.asOf = ov.balanceUsd === null ? null : (ov.asOf ?? localDate(now()));
        }
        if ('asOf' in ov && ov.asOf !== undefined) {
          if (ov.asOf !== null && (typeof ov.asOf !== 'string' || Number.isNaN(Date.parse(ov.asOf)))) throw new BudgetInputError('observed.asOf must be YYYY-MM-DD, an ISO timestamp or null');
          o.asOf = ov.asOf; // stored exactly as sent: a plain YYYY-MM-DD stays a plain date (no timezone shift)
        }
        if ('note' in ov) {
          if (typeof ov.note !== 'string' || ov.note.length > 300) throw new BudgetInputError('observed.note must be a string (<= 300 chars)');
          o.note = ov.note;
        }
        b.observed = o;
      } else if (k === 'cycle') {
        if (!v || typeof v !== 'object') throw new BudgetInputError('cycle must be {start, end}');
        const c = { ...b.cycle };
        for (const f of ['start', 'end']) {
          if (!(f in v)) continue;
          if (v[f] !== null && (typeof v[f] !== 'string' || !DATE_RE.test(v[f]) || Number.isNaN(Date.parse(v[f])))) {
            throw new BudgetInputError(`cycle.${f} must be YYYY-MM-DD or null`);
          }
          c[f] = v[f];
        }
        if (c.start && c.end && c.start > c.end) throw new BudgetInputError('cycle.start must be on or before cycle.end');
        c.source = c.start || c.end ? 'user-entered' : 'unknown';
        b.cycle = c;
      } else {
        throw new BudgetInputError(`unknown budget field "${k}"`);
      }
    }
    const maxAlloc = b.grantUsd - b.reserveUsd - b.otherAppsReserveUsd;
    if (b.activeAllocationUsd > maxAlloc + 1e-9) {
      throw new BudgetInputError(`activeAllocationUsd (${b.activeAllocationUsd}) must be <= grantUsd - reserveUsd - otherAppsReserveUsd (${maxAlloc})`);
    }
    if (b.liveCeilingUsd > b.activeAllocationUsd + 1e-9) {
      throw new BudgetInputError(`liveCeilingUsd (${b.liveCeilingUsd}) must be <= activeAllocationUsd (${b.activeAllocationUsd})`);
    }
    return write(b);
  }

  /** Internal: set the pause flag without user-facing validation (auto-pause). */
  function setPaused(paused, reason) {
    const b = read();
    b.paused = paused;
    b.pausedReason = paused ? reason : null;
    b.pausedAt = paused ? now().toISOString() : null;
    return write(b);
  }

  return { file, read, patch, setPaused };
}
