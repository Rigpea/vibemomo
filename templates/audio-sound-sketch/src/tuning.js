// Sound Sketch — tuning.js
//
// Every number that shapes how the cues SOUND lives here, in one object.
// The Atelier studio reads the object below (from its first opening brace
// to its last closing brace) as JSON and rewrites it when you change a value,
// so keep it strict JSON: double-quoted keys, no comments, no trailing commas.
// Never type a brace character in these comments.
//
//   masterVolume     0..1, scales every cue
//   <cue>Volume      0..1, loudness of that cue
//   <cue>Pitch       Hz, 40..12000: tap and blip start here, tick is the center
//                    of its noise filter, swell is the note of its pad
//   <cue>DecayMs     ms until the sound is gone: 5..380 for tap, blip and tick;
//                    5..200 for swell, which first rises for a fixed 180 ms
//
// These limits keep every cue under 400 ms. A value outside its limit is
// ignored and the cue keeps the value it had; the Tuning panel names it.
window.ATELIER_TUNING = {
  "masterVolume": 0.8,
  "tapVolume": 0.35,
  "tapPitch": 420,
  "tapDecayMs": 30,
  "blipVolume": 0.25,
  "blipPitch": 880,
  "blipDecayMs": 110,
  "tickVolume": 0.3,
  "tickPitch": 4200,
  "tickDecayMs": 30,
  "swellVolume": 0.2,
  "swellPitch": 220,
  "swellDecayMs": 60
};
