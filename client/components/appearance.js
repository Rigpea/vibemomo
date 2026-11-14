// Appearance on the page (docs/ARCHITECTURE.md section 24): the choices in effect become custom properties on the
// root element, in the theme on screen, with no reload. A default writes nothing, so the stylesheet's own value
// stands; a token no choice sets is taken off again. What to write is components/appearance-model.js's answer.
import { ALL_TOKENS, cssVars, cleanAppearance, isCustom, THEMES } from './appearance-model.js';

/** A copy of what was last applied, per theme, for the first frame of the next load only (client/index.html reads it
 *  before the first paint, as it does the theme). The registry's answer replaces it as soon as the state arrives. */
export const FIRST_FRAME_KEY = 'atelier.appearance';

/** Set the look on the root element: the tokens of every choice that is off its default, and the motion switch. */
export function applyAppearance(appearance, theme = 'dark', root = document.documentElement) {
  const vars = cssVars(appearance, theme);
  for (const name of ALL_TOKENS) {
    if (Object.hasOwn(vars, name)) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  if (cleanAppearance(appearance).motion === 'reduced') root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
  return vars;
}

/** Keep (or drop) the first-frame copy. Storage that is full or switched off costs only the first frame. */
export function rememberAppearance(appearance, storage = globalThis.localStorage) {
  try {
    if (!isCustom(appearance)) return storage.removeItem(FIRST_FRAME_KEY);
    const copy = { motion: cleanAppearance(appearance).motion === 'reduced' };
    for (const theme of THEMES) copy[theme] = cssVars(appearance, theme);
    storage.setItem(FIRST_FRAME_KEY, JSON.stringify(copy));
  } catch { /* the look still applies when the state arrives */ }
}
