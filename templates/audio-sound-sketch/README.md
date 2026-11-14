# Sound Sketch

Four sound cues to shape by ear: short, dry and quiet. Each one is made in the
browser with Web Audio, so there are no audio files, and each lasts under 400 ms.

| Cue | Sound |
| --- | --- |
| Tap | A soft click |
| Blip | A short sine with a quick pitch drop |
| Tick | A filtered noise burst |
| Swell | A short filtered pad that rises and stops |

## Play

Open `src/index.html` in a browser (double-click works; no server needed).

| Keys | Action |
| --- | --- |
| 1, 2, 3, 4 | Tap, Blip, Tick, Swell (or press the buttons) |
| M | Mute (remembered next time) |

Browsers keep sound off until you click or press a key in the page.

## Tune

All the numbers are in `src/tuning.js`: a master volume and, per cue, a volume,
a pitch in Hz and a decay in ms. Edit, save, reload. Inside Atelier the Tuning
panel changes them live. A value outside its limit (listed in that file) is
ignored, which is what keeps every cue under 400 ms.

## How the studio talks to it

Inside Atelier the page runs in an iframe and uses `postMessage`:

| The studio sends | The page answers with `atelier:event` |
| --- | --- |
| (on load, the page sends `atelier:ready`) | |
| `atelier:cue {id}` | `cue {id, played, seconds, peak}` when a sound was really scheduled: `seconds` is the cue's scheduled length (rise plus decay) and `peak` the largest absolute sample (0..1) of the same cue in an offline render, made the first time the cue is played at a tuning and kept until the tuning changes; if that render fails there is no `peak`. Otherwise `cue {id, played: false, reason}`, where `reason` says why (for example `suspended: click in the page first`, `muted`) |
| `atelier:tuning {tuning}` | `tuning {applied, ignored}`; unknown keys, wrong types and values outside the limits are ignored |
| `atelier:render {id}` | `render {id, wav, seconds, peak, sampleRate, tuning}`; `wav` is the base64 of a complete 16-bit PCM WAV file (44100 Hz, mono, the cue's length plus 50 ms), `peak` is the largest absolute sample (0..1), `tuning` the values it was rendered with; a failed render answers `{id, reason}` |

A render needs no click, uses the current tuning, and ignores mute. The same
tuning always renders the same file.

Playing a cue by hand also sends an event named after the cue, `<cue> {how, seconds,
peak}`, where `how` is `key` or `button` and the numbers mean the same as in a `cue`
answer (no `peak` if the render fails). The Audio panel shows it like a Trigger and
counts both together.

## Renders

Rendered files belong in `dist/audio/<cue>.wav`, for example `dist/audio/tap.wav`.
The Audio panel's **Render to file** writes them there; the product only answers
`atelier:render`. The values a render was made with are kept beside it as
`dist/audio/<cue>.tuning.json`. `dist/` stays out of versions, but renders travel with
an export: Build/Export copies the rendered `dist/audio/<cue>.wav` files into `audio/`
in the zip, without those value files, and says how many it carried. A `.wav` whose
name could not be a cue's id stays behind and the note counts it. It takes the files
as they are, whichever tuning made them, so render again before exporting if the
tuning changed.

The panel lists the files in `dist/audio/` when it opens and draws a waveform under
each cue that has one. It is drawn from the rendered file, not from the live playback,
so it shows the cue at the tuning that was rendered; change the tuning and it stays as
it was until the next render, with a sentence under the cue when the values it was
rendered at differ from the tuning file's (saving the same values changes nothing). A
file with no record of its values says `tuning at render unknown`. It is drawn to the cue's own peak, so these quiet cues fill their
height, and the label gives the real level: `0.29 s · drawn to its peak, -19 dB`. A
silent file keeps the centre line and says `silent`. A render is 50 ms longer than the
play, because the file carries a tail.

## Code map

- `src/sketch.js`: tuning checks, synthesis, playing, rendering, studio link, page, in that order.
- `src/tuning.js`: the one object of tunable values.
- `atelier.json`: the project manifest Atelier reads.

As an Atelier template: a template's title and slug are replaced by the project's name and slug at creation (text files only; `selfcheck.mjs` is not copied).
