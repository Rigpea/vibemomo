// Appearance (docs/ARCHITECTURE.md section 24): the person's own look for the studio, kept per person in
// ~/.atelier/registry.json as settings.appearance and never in a project. A patch is checked by the same pure code
// the settings view and the Studio look draw with (client/components/appearance-model.js; it has no DOM), so a colour
// the screen refuses for its contrast is refused here in the same sentence.
// The studio project's fixed rules that lock a token describe the studio's shipped defaults in its source code; the
// person's look is a layer on top for them only, so a lock never refuses or removes it (decision row 186). The facts
// name the locked tokens, and the screens say once where the look differs from them.
// The Studio look's Apply and Reset keep what was there before (settings.lookUndo), so Undo works after a reload too.
import { HttpError, STUDIO_DIR, folderKey, nowIso } from './paths.mjs';
import { loadRegistry, updateRegistry } from './registry.mjs';
import { listRules, lockedTokens } from './rules.mjs';
import { checkAppearancePatch, mergeAppearance, cleanAppearance } from '../../client/components/appearance-model.js';

/** The studio as a registered project: the one of kind studio in the studio's own folder, else the first of that
 *  kind (as the console names it to companion sessions), else none. */
export function studioProjectOf(reg) {
  const list = (reg?.projects || []).filter((p) => p.kind === 'studio');
  const own = folderKey(STUDIO_DIR);
  return list.find((p) => folderKey(p.path) === own) || list[0] || null;
}

/**
 * The tokens the studio project's rules lock: { project: { id, name } | null, locked: [{ name, value, ruleId, text }],
 * unread }. No studio project is no locks; rules that cannot be read are not read as none (unread is true).
 */
export async function studioLocked(reg) {
  const p = studioProjectOf(reg);
  if (!p) return { project: null, locked: [], unread: false };
  const project = { id: p.id, name: p.name };
  try {
    return { project, locked: lockedTokens(await listRules(p.path)), unread: false };
  } catch (err) {
    console.error('[atelier] appearance: the studio project\'s rules could not be read', err.message);
    return { project, locked: [], unread: true };
  }
}

/** The answer of GET /api/settings/appearance and the appearance part of GET /api/state: what is stored and in effect
 *  (the same: a lock takes nothing out), the studio's locked tokens with the rule each comes from, the project they
 *  belong to, and whether the Studio look has something to undo ({ at, words } or null). */
export async function appearanceFacts(reg = null) {
  const registry = reg || await loadRegistry();
  const { project, locked, unread } = await studioLocked(registry);
  const stored = cleanAppearance(registry.settings?.appearance);
  const u = registry.settings?.lookUndo;
  return { stored, effective: stored, locked, rulesProject: project, rulesUnread: unread, undo: u && typeof u === 'object' ? { at: u.at || null, words: String(u.words || '') } : null };
}

/**
 * Check and store a patch: null resets every choice; otherwise any of the keys appearance-model.js names. A value
 * that is no option or no hex is a 400 invalid_input; a colour under AA a 400 low_contrast with the nearest shade
 * that passes. A refusal writes nothing. undo: words for the Studio look's Undo, which keeps the look before this
 * change; a change without them (Settings) leaves nothing to undo, since an Undo would also take that change back.
 */
export async function saveAppearance(body, { undo = null } = {}) {
  const checked = checkAppearancePatch(body, (await loadRegistry()).settings?.appearance);
  if (!checked.ok) throw new HttpError(400, checked.code, checked.message);
  await updateRegistry((reg) => {
    const settings = { ...(reg.settings || {}) };
    const before = cleanAppearance(settings.appearance);
    const next = cleanAppearance(mergeAppearance(settings.appearance, checked));
    if (undo) settings.lookUndo = { before, at: nowIso(), words: undo }; else delete settings.lookUndo;
    if (Object.keys(next).length) settings.appearance = next; else delete settings.appearance;
    reg.settings = settings;
  });
  return appearanceFacts();
}

/** The Studio look's Apply: the proposal's patch, kept with the look before it for Undo. */
export const applyLook = (patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'invalid_input', 'Apply sends the look as an object: { surfaces, accent, display, radius }');
  return saveAppearance(patch, { undo: 'the look before Apply' });
};
/** Reset to defaults from the Studio look: every choice back to the studio's own, kept for Undo. */
export const resetLook = () => saveAppearance(null, { undo: 'the look before Reset' });

/** Undo: the look kept by the last Apply or Reset comes back whole, and there is nothing more to undo. */
export async function undoLook() {
  const u = (await loadRegistry()).settings?.lookUndo;
  if (!u || typeof u !== 'object') throw new HttpError(409, 'nothing_to_undo', 'There is nothing to undo: Undo takes back the last Apply or Reset of the Studio look, and only until another change.');
  await updateRegistry((reg) => {
    const settings = { ...(reg.settings || {}) };
    const before = cleanAppearance(settings.lookUndo?.before);
    delete settings.lookUndo;
    if (Object.keys(before).length) settings.appearance = before; else delete settings.appearance;
    reg.settings = settings;
  });
  return appearanceFacts();
}
