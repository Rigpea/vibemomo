// Give the studio project its first references (server/lib/references-seed.mjs: links, code and conventions this
// repository already records, each with its source). Writes <studio>/.studio/references.json through the references
// module, and only when that list holds nothing: entries the person has are never written over. The two links ask
// their pages for a title through the guarded fetch (server/lib/link-preview.mjs); a page that does not answer leaves
// a plain link that says why.
// Run: node scripts/seed-studio-references.mjs            (this studio folder)
//      node scripts/seed-studio-references.mjs <folder>   (another project folder, for a look at the seeds)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedReferences, STUDIO_REFERENCES } from '../server/lib/references-seed.mjs';
import { REFS_FILE, refsCount, listRefs, refLine } from '../server/lib/references.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.resolve(process.argv[2] || studio);
const out = await seedReferences(folder);
const now = await listRefs(folder);
console.log(out.seeded
  ? `Seeded ${out.seeded} of ${STUDIO_REFERENCES.length} references into ${path.join(folder, REFS_FILE)}: ${refsCount(now)}.`
  : `Nothing written: ${path.join(folder, REFS_FILE)} already holds ${refsCount(now)}; they are the person's.`);
for (const e of now) console.log(`- ${refLine(e)}${e.preview?.ok === false ? ` · ${e.preview.reason}` : ''}`);
