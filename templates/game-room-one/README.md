# Room One

One character, one room, one crate. Push the crate onto the pressure plate,
the door opens, walk through it.

## Play

Open `src/index.html` in a browser (double-click works; no server needed).

| Keys | Action |
| --- | --- |
| Left / Right, A / D | Move |
| Space, Up, W | Jump (hold for higher, tap for a hop) |
| R | Restart |
| P, Esc | Pause |
| M | Mute (remembered next time) |
| ? | Show the controls again |

On a phone or tablet, on-screen Left / Right / Jump buttons appear.
If the crate gets wedged in the left corner, press R.

## Tune

All feel numbers are in `src/tuning.js` (speed, acceleration, jump height,
gravity, coyote time, jump buffer, squash and stretch, dust). Edit, save,
reload. Inside Atelier the sliders change them live while you play.

Sounds are generated in `src/audio.js`; change the numbers in `PARAMS`
(pitch, length, decay, volume, noise) to reshape a cue.

## Code map

- `src/game.js`: setup, input, studio link, physics, drawing, UI, in that order.
- `src/audio.js`: Web Audio cues, no sound files.
- `src/tuning.js`: the one object of tunable values.
- `atelier.json`: the project manifest Atelier reads.

## Export

Copy the `src/` folder (or use Atelier's Build/Export, which writes `dist/`)
and zip it. Whoever unzips it double-clicks `index.html`. Nothing is loaded
from the internet.

`node selfcheck.mjs` runs a quick sanity check of the files.

As an Atelier template: a template's title and slug are replaced by the project's name and slug at creation (text files only; `selfcheck.mjs` is not copied).
