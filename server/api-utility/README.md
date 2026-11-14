# api-utility — bounded Claude API tasks

The only part of Atelier that calls the Claude API (ARCHITECTURE.md §6; the Console's
`claude-code` backend runs the signed-in CLI on the Claude Code plan instead, with the API
keys stripped from its env). It runs nine narrow JSON tasks (`summarize-doc`,
`extract-metadata`, `tag-resource`, `group-feedback`, `draft-session-summary`,
`draft-memory-candidates`, `prepare-context`, `explain`, `console-chat`) and nothing else.

| File | Role |
|---|---|
| `index.mjs` | `createUtility()`, `UtilityError`, `readApiKey()`, `redact()`, `pricing` |
| `tasks.mjs` | task definitions: system prefix, input/output schema, token cap, integrity checks |
| `validate.mjs` | small JSON-schema validator + conversion to the structured-outputs subset |
| `budget.mjs` | `~/.atelier/budget.json` (lazy defaults, validated patch) |
| `ledger.mjs` | `~/.atelier/usage/ledger.jsonl` (one line per attempt) |
| `pricing.mjs` | price table (`2026-11-03`) and cost formulas |
| `quality-check.mjs` | live three-fixture check against the real API |

## How it is bounded

Every `run()` goes through, in order:

1. **Key**: no key → `not_configured` (503). Nothing is called or logged.
2. **Task and input**: unknown task → `unknown_task`; input fails its schema or integrity check → `invalid_input`.
3. **Model**: a model with no pricing entry is refused (`not_configured`); it cannot be costed, so it cannot be bounded.
4. **Pause**: `budget.paused` → `budget_paused` (402).
5. **Concurrency**: more than `maxConcurrent` (default 2) runs in flight → `concurrency_limit` (429).
6. **Ceiling**: `spentThisCycle + reservedInFlight + estimatedCallMax > liveCeilingUsd` → `budget_exceeded` (402), before any call.
   The estimate is reserved while the call is in flight and released afterwards; the actual cost is written to the ledger.
   Steps 4–6 run synchronously, so concurrent runs cannot both pass on stale numbers.
7. **Output cap**: `max_tokens = min(task.maxOutputTokens, budget.maxOutputTokens)`.
8. **Attempts**: at most `1 + maxRetries` (default 2) calls per run. A 429/529/5xx or connection error is retried after 1 s, then 3 s.
   An output that fails validation gets **one** repair attempt that feeds the errors back to the model; it uses the same attempt budget.
   Each extra attempt passes the ceiling gate again. The SDK's own retries are turned off, so every attempt is gated and ledgered.
9. **Auto-pause**: once spend in the cycle reaches `liveCeilingUsd`, the budget is set to `paused: true, pausedReason: "ceiling_reached"` and `budget.changed` is emitted.
   An observed balance at or below the reserve does the same with `pausedReason: "observed_balance_exhausted"`.
   A `budget.patch` rechecks a pause the studio set: it lifts when its cause is gone. `paused: false` from a client lifts only the person's own pause; a studio pause ignores it.
10. **Cancellation**: `cancel(runId)` or the caller's `signal` aborts the request (including during backoff). The ledger line has `cancelled: true` and the cost of whatever usage came back (0 when the request was aborted mid-flight).

Outputs are constrained with structured outputs (`output_config.format`, json_schema) **and** re-validated locally,
because the API ignores `maxLength`/`minimum`/`maxItems` and cannot check cross-field rules. Local integrity checks:
`summarize-doc` links must appear in the input; `extract-metadata.officialSource` must appear in the text;
`tag-resource` tags must come from `allowedTags`; `group-feedback` must place every input id in exactly one group;
`prepare-context.relevantFiles` must be provided paths; `explain` citations must be verbatim quotes.
`draft-memory-candidates` downgrades `basis: "explicit"` to `"inferred"` unless the evidence is a verbatim quote from a note.

Budget patch rules: money fields are non-negative numbers; `activeAllocationUsd <= grantUsd - reserveUsd - otherAppsReserveUsd`;
`liveCeilingUsd <= activeAllocationUsd`; `cycle` dates are `YYYY-MM-DD`. If `observed.balanceUsd` is below
`activeAllocationUsd`, `effectiveAllocationUsd` (in `status()` and `budget.get()`) is the observed balance and a warning is listed.
That value is shown, not used for gating: the observed balance is a Console reading of what is left, while the ceiling limits what this studio spends in the cycle.

## Configuring the key

Either:

- set `STUDIO_ANTHROPIC_API_KEY` in the environment of the studio process, or
- write `~/.atelier/secrets.json` (or `$ATELIER_DATA_DIR/secrets.json`): `{ "STUDIO_ANTHROPIC_API_KEY": "sk-ant-..." }`

The environment variable wins. `readApiKey(dataDir)` implements this lookup; pass `getApiKey: () => readApiKey(DATA_DIR)` to `createUtility`.
The key is only handed to the SDK client. It is never logged, emitted over SSE, returned by `status()`, or included in errors
(anything matching `sk-ant-…` in a provider message is replaced with `sk-ant-[redacted]`).

## Running the quality check

```
node server/api-utility/quality-check.mjs --model claude-haiku-5-5
```

It runs three short fixtures (a summary that must not invent links, a six-item feedback grouping, and a question whose answer
is not in the material) and prints PASS/FAIL per check plus the total estimated cost (a fraction of a cent on Haiku).
The calls use the real budget and ledger in `~/.atelier`. Exit code 0 = all passed, 1 = a check failed, 2 = no key configured
(nothing is called and no results are invented).

## How costs are estimated, and why they differ from the Console

Cost per attempt = `input × rate.input + cacheWrite × rate.cache5m + cacheRead × rate.cacheRead + output × rate.output` (per million tokens),
using the token counts in the response's `usage`. For Claude Haiku 5.5 the higher tier applies when the prompt
(input + cache reads + cache writes) is over 100k tokens. Cache writes are priced at the 5-minute rate because that is what the utility sends.

The pre-call estimate (used for the ceiling gate and the reservation) is deliberately pessimistic: characters ÷ 3.5 for the
prompt (system prefix priced as a cache write), plus the schema, plus the full `max_tokens` output.

The studio's figures are estimates and will not match the Console exactly:

- prices are a snapshot (`pricingVersion` on every ledger line); a price change is not reflected until `pricing.mjs` is updated;
- requests that fail before a response (aborts, 5xx, network errors) are logged at $0 even if the provider billed partial work;
- the Console bills the whole organization: other apps, Claude Code sessions and other keys draw on the same balance;
- the Console groups and rounds by its own billing periods and time zone; the ledger uses UTC timestamps and your `cycle` dates.

Use `budget.observed.balanceUsd` for what the Console shows. The UI should keep the two apart (ARCHITECTURE.md §2).

Prompt caching: the task's system prefix is sent as a `cache_control: {type: "ephemeral"}` block and user content is not cached.
The prefixes are short, and a prefix below the model's minimum cacheable length is not cached at all, so
`cacheReadTokens` will usually be 0 for these tasks. The ledger records cache tokens either way.
