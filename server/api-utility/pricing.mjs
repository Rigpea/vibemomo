// Pricing for bounded utility calls. USD per million tokens.
// Source: platform.claude.com/docs/en/about-claude/pricing, verified 2026-11-03.
// Batch API is 50% off these rates; the utility never uses batch, so it is not modelled.

export const PRICING_VERSION = '2026-11-03';

// Each model has one or more tiers; a tier applies when the request's total
// prompt length (input + cache reads + cache writes) is <= maxPromptTokens.
export const PRICING_TABLE = Object.freeze({
  'claude-fable-5-1': [{ maxPromptTokens: Infinity, input: 10, cache5m: 12.5, cache1h: 20, cacheRead: 0.25, output: 50 }],
  'claude-opus-5-5': [{ maxPromptTokens: Infinity, input: 4, cache5m: 5, cache1h: 8, cacheRead: 0.2, output: 20 }],
  'claude-sonnet-5-5': [{ maxPromptTokens: Infinity, input: 2, cache5m: 2.5, cache1h: 4, cacheRead: 0.1, output: 10 }],
  'claude-haiku-5-5': [
    { maxPromptTokens: 100_000, input: 0.1, cache5m: 0.125, cache1h: 0.2, cacheRead: 0.01, output: 0.5 },
    { maxPromptTokens: Infinity, input: 0.5, cache5m: 0.625, cache1h: 1.0, cacheRead: 0.05, output: 2.5 },
  ],
});

export function hasPricing(model) {
  return Object.hasOwn(PRICING_TABLE, model);
}

export function tierFor(model, promptTokens) {
  const tiers = PRICING_TABLE[model];
  if (!tiers) throw new Error(`No pricing entry for model "${model}" (pricing ${PRICING_VERSION})`);
  return tiers.find((t) => promptTokens <= t.maxPromptTokens) ?? tiers[tiers.length - 1];
}

const round = (n) => Math.round(n * 1e9) / 1e9;

/**
 * Exact cost of one request from its usage tokens.
 * usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
 * cacheTtl: '5m' (default, what the utility sends) or '1h'.
 */
export function costFor(model, usage, { cacheTtl = '5m' } = {}) {
  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  const read = usage.cacheReadTokens || 0;
  const write = usage.cacheWriteTokens || 0;
  const tier = tierFor(model, input + read + write);
  const writeRate = cacheTtl === '1h' ? tier.cache1h : tier.cache5m;
  return round((input * tier.input + write * writeRate + read * tier.cacheRead + output * tier.output) / 1e6);
}

export const CHARS_PER_TOKEN = 3.5;
export const estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * Worst-case cost of one call before it is made: the cacheable system prefix
 * is priced as a cache write, the rest as uncached input, plus the full output cap.
 */
export function estimateCallMax(model, { systemChars = 0, userChars = 0, overheadTokens = 0, maxOutputTokens }) {
  const sys = estimateTokens(systemChars);
  const user = estimateTokens(userChars) + overheadTokens;
  return costFor(model, { inputTokens: user, cacheWriteTokens: sys, outputTokens: maxOutputTokens });
}

export const pricing = { version: PRICING_VERSION, table: PRICING_TABLE };
