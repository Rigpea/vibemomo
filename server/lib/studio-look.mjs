// The Studio look board (docs/ARCHITECTURE.md section 27): the person's own inspiration for how the studio itself
// looks, kept in the studio's data folder beside settings.appearance (~/.atelier/studio-look.json and its images in
// ~/.atelier/studio-look/), never in a project. It is the same board as a project's (server/lib/inspiration.mjs, the
// same cards, limits and guards), found at another place; no worker's brief reads it. Make a look turns it into a
// patch of settings.appearance (client/components/studio-look-model.js; Apply and Undo in server/lib/appearance.mjs).
import { DATA_DIR } from './paths.mjs';

export const LOOK_FILE = 'studio-look.json';
export const LOOK_DIR = 'studio-look';
/** Where the Studio look board lives, as inspiration.mjs takes a board's place. */
export const LOOK_BOARD = Object.freeze({ root: DATA_DIR, file: LOOK_FILE, dir: LOOK_DIR });
