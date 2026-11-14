// Give the studio project its first fixed rules (server/lib/rules-seed.mjs: what docs/DESIGN.md and the accepted
// decisions already fix, each with its source). Writes <studio>/.studio/rules.json through the rules module, and only
// when that list holds nothing: rules the person has are never written over.
// Run: node scripts/seed-studio-rules.mjs            (this studio folder)
//      node scripts/seed-studio-rules.mjs <folder>   (another project folder, for a look at the seeds)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedRules, STUDIO_RULES } from '../server/lib/rules-seed.mjs';
import { RULES_FILE, rulesCount, listRules } from '../server/lib/rules.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.resolve(process.argv[2] || studio);
const out = await seedRules(folder);
const now = await listRules(folder);
console.log(out.seeded
  ? `Seeded ${out.seeded} of ${STUDIO_RULES.length} rules into ${path.join(folder, RULES_FILE)}: ${rulesCount(now)}.`
  : `Nothing written: ${path.join(folder, RULES_FILE)} already holds ${rulesCount(now)}; they are the person's.`);
