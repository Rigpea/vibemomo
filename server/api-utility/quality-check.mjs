#!/usr/bin/env node
// Live quality check for the API utility: three small fixtures against the real API.
//   node server/api-utility/quality-check.mjs [--model claude-haiku-5-5]
// Calls are gated by ~/.atelier/budget.json and recorded in usage/ledger.jsonl like any other run.
// Exit codes: 0 all checks passed, 1 a check failed, 2 not configured (no key) or bad arguments.

import os from 'node:os';
import path from 'node:path';
import { createUtility, readApiKey, DEFAULT_MODEL } from './index.mjs';
import { hasPricing } from './pricing.mjs';

const args = process.argv.slice(2);
const mi = args.indexOf('--model');
const model = mi >= 0 ? args[mi + 1] : DEFAULT_MODEL;
if (!model || !hasPricing(model)) {
  console.error(`quality-check: unknown or unpriced model "${model}".`);
  process.exit(2);
}
const dataDir = path.resolve(process.env.ATELIER_DATA_DIR || path.join(os.homedir(), '.atelier'));
if (!readApiKey(dataDir)) {
  console.error('quality-check: no API key configured. Set STUDIO_ANTHROPIC_API_KEY or add it to '
    + `${path.join(dataDir, 'secrets.json')} as {"STUDIO_ANTHROPIC_API_KEY": "..."}. No calls were made and no results are reported.`);
  process.exit(2);
}

const utility = createUtility({ dataDir, getApiKey: () => readApiKey(dataDir), getModel: () => model, emit: () => {} });

const DOC_URLS = ['https://tonejs.github.io/', 'https://github.com/Tonejs/Tone.js'];
const fixtures = [
  {
    name: 'summarize-doc: no invented links',
    task: 'summarize-doc',
    input: {
      title: 'Tone.js overview',
      url: DOC_URLS[0],
      text: `Tone.js is a Web Audio framework for creating interactive music in the browser. It provides
synths, effects and a global Transport for scheduling events in musical time (bars, beats, sixteenths).
Instruments include Synth, FMSynth and Sampler. The source lives at ${DOC_URLS[1]} under the MIT license.
Audio can only start after a user gesture, so call Tone.start() from a click handler.`,
    },
    checks: (o) => [
      ['summary is non-empty', o.summary.trim().length > 0],
      ['every sourceLink is one of the two input URLs', o.sourceLinks.every((u) => DOC_URLS.includes(u))],
      ['keyPoints present', o.keyPoints.length > 0],
    ],
  },
  {
    name: 'group-feedback: 6 items, exact coverage',
    task: 'group-feedback',
    input: { items: [
      { id: 'f1', text: 'The jump feels floaty, I wanted it snappier.' },
      { id: 'f2', text: 'Falling takes too long after a jump.' },
      { id: 'f3', text: 'No sound when collecting a coin.' },
      { id: 'f4', text: 'Music is too loud compared to effects.' },
      { id: 'f5', text: 'I did not know how to restart after losing.' },
      { id: 'f6', text: 'Controls were not explained anywhere.' },
    ] },
    checks: (o, input) => {
      const ids = o.groups.flatMap((g) => g.itemIds);
      const want = input.items.map((i) => i.id);
      return [
        ['each item in exactly one group', ids.length === want.length && want.every((id) => ids.filter((x) => x === id).length === 1)],
        ['at least two groups', o.groups.length >= 2],
        ['every group proposes a next piece', o.groups.every((g) => g.proposedNextPiece.trim().length > 0)],
      ];
    },
  },
  {
    name: 'explain: answer absent from material',
    task: 'explain',
    input: {
      question: 'What sample rate does the exported WAV file use?',
      material: 'The audio workbench lets you assign a cue to each game event. Cues have an id, a label and a trigger key. '
        + 'Pressing the trigger plays the cue in the preview. The volume slider scales all cues together.',
    },
    checks: (o) => [
      ['answer says "not in the material"', /not in the material/i.test(o.answer)],
      ['no citations for an absent answer', o.citations.length === 0],
    ],
  },
];

let totalCost = 0;
let failed = 0;
console.log(`Atelier API utility quality check — model ${model}, data ${dataDir}`);
for (const f of fixtures) {
  process.stdout.write(`\n${f.name}\n`);
  try {
    const r = await utility.run(f.task, { projectId: null, taskId: 'quality-check', input: f.input });
    totalCost += r.costUsd;
    console.log(`  PASS  validated output (${r.attempts} attempt${r.attempts > 1 ? 's' : ''}, $${r.costUsd.toFixed(6)}, ${r.durationMs} ms)`);
    for (const [label, ok] of f.checks(r.output, f.input)) {
      if (!ok) failed++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    }
    if (f.checks(r.output, f.input).some(([, ok]) => !ok)) console.log(`  output: ${JSON.stringify(r.output).slice(0, 600)}`);
  } catch (e) {
    failed++;
    totalCost += e.costUsd || 0;
    console.log(`  FAIL  ${e.code || 'error'}: ${e.message}`);
    if (e.code === 'budget_paused' || e.code === 'budget_exceeded' || e.code === 'not_configured') break;
  }
}
console.log(`\nTotal estimated cost: $${totalCost.toFixed(6)} (studio estimate, pricing ${utility.pricing.version}; the Console is authoritative)`);
console.log(failed ? `${failed} check(s) failed.` : 'All checks passed.');
process.exit(failed ? 1 : 0);
