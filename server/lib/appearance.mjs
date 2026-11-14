// Appearance (docs/ARCHITECTURE.md section 24): the person's own look for the studio, kept per person in
// ~/.atelier/registry.json as settings.appearance and never in a project. A patch is checked by the same pure code
// the settings view draws with (client/components/appearance-model.js; it has no DOM), so an accent the screen
// refuses for its contrast is refused here in the same sentence. The fixed rules win (section 23): a control whose
// token the studio project's rules lock cannot be moved off its default through this module, whatever the client sends.
import { HttpError, STUDIO_DIR, folderKey } from './paths.mjs';
import { loadRegistry, updateRegistry } from './registry.mjs';
import { listRules, lockedTokens } from './rules.mjs';
import { checkAppearancePatch, patchSets, mergeAppearance, cleanAppearance, effectiveAppearance, controlLocks, lockSentence } from '../../client/components/appearance-model.js';

/** The studio as a registered project: the one of kind studio in the studio's own folder, else the first of that
 *  kind (as the console names it to companion sessions), else none. */
export function studioProjectOf(reg) {
  const list = (reg?.projects || []).filter((p) => p.kind === 'studio');
  const own = folderKey(STUDIO_DIR);
  return list.find((p) => folderKey(p.path) === own) || list[0] || null;
}

/**
 * What the studio project's rules lock, per control: { project: { id, name } | null, locks, unread }.
 * No studio project is no locks. Rules that cannot be read are not read as none: unread is true, and a change is
 * refused until they can be.
 */
export async function studioLocks(reg) {
  const p = studioProjectOf(reg);
  if (!p) return { project: null, locks: {}, unread: false };
  const project = { id: p.id, name: p.name };
  try {
    return { project, locks: controlLocks(lockedTokens(await listRules(p.path))), unread: false };
  } catch (err) {
    console.error('[atelier] appearance: the studio project\'s rules could not be read', err.message);
    return { project, locks: {}, unread: true };
  }
}

/** The answer of GET /api/settings/appearance and the appearance part of GET /api/state: what is stored, what is in
 *  effect once the locks are taken out, the locks with the rule each comes from, and the project they belong to. */
export async function appearanceFacts(reg = null) {
  const registry = reg || await loadRegistry();
  const { project, locks, unread } = await studioLocks(registry);
  const stored = cleanAppearance(registry.settings?.appearance);
  return { stored, effective: unread ? {} : effectiveAppearance(stored, locks), locks, rulesProject: project, rulesUnread: unread };
}

/**
 * Check and store a patch: null resets every choice; otherwise any of accent, density, textSize, radius, motion.
 * A value that is no option or no hex is a 400 invalid_input; an accent under AA contrast a 400 low_contrast with
 * the nearest shade that passes; a control a fixed rule locks a 409 token_locked naming the rule. A refusal writes
 * nothing. Taking a choice back to its default is never refused.
 */
export async function saveAppearance(body) {
  const checked = checkAppearancePatch(body);
  if (!checked.ok) throw new HttpError(400, checked.code, checked.message);
  const sets = patchSets(checked.patch);
  if (sets.length) {
    const { project, locks, unread } = await studioLocks(await loadRegistry());
    if (unread) throw new HttpError(409, 'rules_unread', `${project.name}'s fixed rules could not be read, so the look cannot change until they can: a rule may lock what this would change.`);
    const key = sets.find((k) => locks[k]);
    if (key) throw new HttpError(409, 'token_locked', `${lockSentence(key, locks[key], project.name)} Change or remove that rule first (Inspiration, Fixed rules).`);
  }
  await updateRegistry((reg) => {
    const settings = { ...(reg.settings || {}) };
    const next = mergeAppearance(settings.appearance, checked);
    if (Object.keys(next).length) settings.appearance = next; else delete settings.appearance;
    reg.settings = settings;
  });
  return appearanceFacts();
}
