// `npm run evidence` — tally which Claude models actually produced messages in
// recent Claude Code sessions on this machine (transcript scan, read-only) and
// list the headless probe files. Writes docs/evidence/model-participation.json.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelEvidence } from '../server/lib/evidence.mjs';
import { writeJson } from '../server/lib/fsutil.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const days = Number(process.argv[2] || 7);
const ev = await modelEvidence({ days });
const out = path.join(ROOT, 'docs', 'evidence', 'model-participation.json');
await writeJson(out, ev);
console.log(`Transcript root: ${ev.root} (last ${days} days)`);
console.log('Totals by model id:');
for (const [m, c] of Object.entries(ev.totals || {}).sort((a, b) => b[1] - a[1])) console.log(`  ${m.padEnd(22)} ${c} messages`);
console.log('Headless probes:');
for (const p of ev.probes) console.log(`  ${p.file}: ${Object.keys(p.models).join(', ')} → "${p.result}"`);
console.log(`Written: ${out}`);
