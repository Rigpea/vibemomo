// Room One — tuning.js
//
// Every number that shapes how the game FEELS lives here, in one object.
// The Atelier studio reads the object below (from its first opening brace
// to its last closing brace) as JSON and rewrites it when you move a slider,
// so keep it strict JSON: double-quoted keys, no comments, no trailing commas.
// Never type a brace character in these comments.
// Units: pixels, seconds, pixels per second (px/s) and px/s^2 for forces.
//
//   accel / decel           how fast you reach / lose speed on the ground
//   airControl              0..1, share of accel/decel available in the air
//   maxSpeed                top walking speed (px/s)
//   jumpVelocity            upward launch speed (px/s); height = v^2 / (2 * gravity)
//   gravity                 downward pull while rising (px/s^2)
//   fallGravityMultiplier   extra pull while falling (>1 feels snappier)
//   jumpCutMultiplier       0..1, upward speed kept when jump is released early
//   coyoteTimeMs            grace period to still jump after walking off a ledge
//   jumpBufferMs            a jump pressed this long before landing still counts
//   terminalVelocity        maximum fall speed (px/s)
//   pushSpeedFactor         0..1, share of maxSpeed while pushing the crate
//   doorOpenSeconds         length of the door opening animation
//   squashStretch           0..1, how much the character squashes and stretches
//   dustParticles           true/false, puffs of dust on jump and landing
//   playerColor             character color (CSS color string)
window.ATELIER_TUNING = {
  "accel": 2600,
  "decel": 3000,
  "airControl": 0.65,
  "maxSpeed": 300,
  "jumpVelocity": 760,
  "gravity": 2200,
  "fallGravityMultiplier": 1.6,
  "jumpCutMultiplier": 0.45,
  "coyoteTimeMs": 100,
  "jumpBufferMs": 120,
  "terminalVelocity": 1100,
  "pushSpeedFactor": 0.55,
  "doorOpenSeconds": 0.7,
  "squashStretch": 0.6,
  "dustParticles": true,
  "playerColor": "#ff7a59"
};
