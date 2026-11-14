// The studio's own first fixed rules (docs/ARCHITECTURE.md section 23): what docs/DESIGN.md and the accepted
// decisions already fix about the studio's look, written as rules so that workers on the studio get them with every
// task. Each one names its source in its why. They are a start, not a law of the code: once written they are the
// person's to edit or remove in the studio, and seedRules never writes over a list that holds anything.
//
// Which tokens are locked: the four that carry the look's identity in the dark theme (DESIGN.md section 8: the
// charcoal canvas, the off-white ink, the one amber accent, the serif display face). The scales the rest of the
// system is built from (spacing, radii, type sizes) and the motion time are rules in words with no lock: a rule such
// as "160 ms or less" is a bound, and a lock is one exact value.
import { addRule, listRules } from './rules.mjs';

export const STUDIO_RULES = [
  { kind: 'color', text: 'Dark first: warm charcoal surfaces with warm off-white ink. The light theme stays as a choice and follows the same warm greys.',
    why: 'docs/DESIGN.md section 8 (the look) and section 5 item 5 (light and dark both checked); decision row 124. The person\'s answer of 2026-11-06 was "dark only", so dark is the default.' },
  { kind: 'color', text: 'The canvas is warm charcoal, the darkest surface; panels sit a step up and hairlines a step above that.',
    why: 'docs/DESIGN.md section 8; client/styles.css, dark theme (the light theme has its own value).', token: { name: '--bg', value: '#232221' } },
  { kind: 'color', text: 'Content is set in warm off-white ink, never pure white.',
    why: 'docs/DESIGN.md sections 2 and 8; client/styles.css, dark theme.', token: { name: '--ink', value: '#ece8e1' } },
  { kind: 'color', text: 'Amber is the one accent: the primary action, links, focus and the selected item. State colors only on the word or line that carries the state.',
    why: 'docs/DESIGN.md section 2 (color) and section 8; client/styles.css, dark theme.', token: { name: '--accent', value: '#d6a455' } },
  { kind: 'type', text: 'A serif display face for the product\'s own words and a task\'s title; everything else in the sans, and mono only for paths, ids, commands and code.',
    why: 'docs/DESIGN.md sections 2 and 8; client/styles.css.', token: { name: '--serif', value: '"Source Serif 4", "Source Serif Pro", "Iowan Old Style", "Charter", "Cambria", "Georgia", serif' } },
  { kind: 'layout', text: 'One style per component: one button, one chip, one row, one field, one dialog. A new need reuses one of them before it adds another.',
    why: 'docs/DESIGN.md section 3; the accepted decision "One style per component and chips only for states" (DESIGN.md sections 2 to 4 and 6).' },
  { kind: 'layout', text: 'One page title and one primary action in sight; whitespace and hairlines separate groups, and a card is never nested in a card.',
    why: 'docs/DESIGN.md section 1 (quiet surfaces, strong hierarchy) and section 5 item 1.' },
  { kind: 'layout', text: 'Spacing stays on the 8 px grid: 8 inside controls, 12 between related items, 16 between groups, 24 between sections, 32 under the page title.',
    why: 'docs/DESIGN.md section 2; the --s1 to --s6 scale in client/styles.css.' },
  { kind: 'motion', text: 'Motion is 160 ms or less, only for what appears, disappears or changes state, and none with reduced motion.',
    why: 'docs/DESIGN.md section 1 (nothing decorative); CLAUDE.md conventions. The token --t is 140ms today, inside the bound.' },
  { kind: 'tone', text: 'Chips only for states that change over time; kinds, backends and modes are plain words.',
    why: 'docs/DESIGN.md section 1 (words over badges) and section 3 (chip); the accepted decision "One style per component and chips only for states".' },
  { kind: 'tone', text: 'Nothing decorative: no icon without a job, no gradient, no emoji. An explanation is said once, where the choice is made.',
    why: 'docs/DESIGN.md section 1 (nothing decorative; say it once).' },
  { kind: 'behaviour', text: 'Every control acts on real state, and status is shown from evidence, never from a claim.',
    why: 'The project\'s direction ("every control acts on real state"); CLAUDE.md conventions; the person\'s constraint that status must reflect actual evidence.' },
];

/**
 * Write the seeds as the folder's first rules. Only into a list that holds nothing: a list with any rule in it is
 * the person's, and stays as it is. Answers { seeded: n } or { seeded: 0, kept: n }.
 */
export async function seedRules(projectPath, seeds = STUDIO_RULES) {
  const have = await listRules(projectPath);
  if (have.length) return { seeded: 0, kept: have.length };
  for (const seed of seeds) await addRule(projectPath, seed);
  return { seeded: seeds.length };
}
