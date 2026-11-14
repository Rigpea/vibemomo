// Room One — audio.js
//
// Procedural sound: every cue is synthesized with the Web Audio API, so the
// game ships with no audio files. Read it in this order:
//
//   1. PARAMS   one plain object per cue. Change a number, hear the difference.
//               type        oscillator wave: "sine" | "square" | "triangle" | "sawtooth"
//               frequency   start pitch in Hz; endFrequency is where it glides to
//               duration    seconds until the voice is stopped
//               decay       seconds; how quickly the volume fades (time constant)
//               volume      0..1 loudness of the tone
//               noise       0..1 loudness of a filtered noise layer (scrapes, thuds)
//               filterFrequency  center of the noise band-pass filter (Hz)
//               variation   random pitch spread per play (0.05 = +/-5%)
//               notes       (jingle only) list of pitches played in sequence
//   2. init()   creates the AudioContext. Browsers keep audio suspended until
//               the player presses a key or taps, so the game calls init()
//               from its first input event; calling it again just resumes.
//   3. play(id) builds a tiny graph (oscillator/noise -> gain -> master) for
//               one cue and lets it stop itself. Nothing is kept around.
//   4. setMuted(bool) mutes the master gain and remembers it in localStorage.
//
// The only global is window.RoomAudio.
(function () {
  "use strict";

  var STORAGE_KEY = "atelier.room-one.muted";

  var PARAMS = {
    jump:    { type: "square",   frequency: 300, endFrequency: 620, duration: 0.14, decay: 0.05, volume: 0.12, noise: 0,    filterFrequency: 2000, variation: 0.04 },
    land:    { type: "triangle", frequency: 150, endFrequency: 55,  duration: 0.14, decay: 0.04, volume: 0.35, noise: 0.25, filterFrequency: 700,  variation: 0.06 },
    push:    { type: "sine",     frequency: 70,  endFrequency: 60,  duration: 0.16, decay: 0.06, volume: 0.04, noise: 0.22, filterFrequency: 900,  variation: 0.15, minIntervalMs: 140 },
    plate:   { type: "square",   frequency: 1200, endFrequency: 600, duration: 0.07, decay: 0.015, volume: 0.16, noise: 0.2, filterFrequency: 3000, variation: 0 },
    door:    { type: "sawtooth", frequency: 70,  endFrequency: 140, duration: 0.7,  decay: 0.3,  volume: 0.08, noise: 0.08, filterFrequency: 500,  variation: 0 },
    cleared: { type: "triangle", frequency: 523.25, endFrequency: 523.25, duration: 0.22, decay: 0.12, volume: 0.18, noise: 0, filterFrequency: 2000, variation: 0,
               notes: [523.25, 659.25, 783.99, 1046.5], noteGap: 0.1 }
  };

  var ctx = null;        // AudioContext, created on first user gesture
  var master = null;     // master gain node (mute lives here)
  var noiseBuffer = null;
  var muted = readMuted();
  var lastPlayed = {};   // cueId -> ms timestamp, for minIntervalMs rate limits

  function readMuted() {
    try { return window.localStorage.getItem(STORAGE_KEY) === "1"; }
    catch (e) { return false; } // storage can be blocked (privacy modes, some file:// setups)
  }

  function init() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.8;
      master.connect(ctx.destination);
      noiseBuffer = makeNoise(ctx);
    }
    if (ctx.state === "suspended") ctx.resume();
    return true;
  }

  function makeNoise(c) {
    var length = Math.floor(c.sampleRate * 1);
    var buffer = c.createBuffer(1, length, c.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  // One voice: a pitched oscillator plus an optional band-passed noise layer.
  function voice(p, when, pitch, gainScale) {
    var stopAt = when + p.duration;
    var spread = p.variation ? 1 + (Math.random() * 2 - 1) * p.variation : 1;
    var f0 = pitch * spread;
    var f1 = Math.max(1, (p.endFrequency / p.frequency) * f0);

    if (p.volume > 0) {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = p.type;
      osc.frequency.setValueAtTime(f0, when);
      osc.frequency.exponentialRampToValueAtTime(f1, stopAt);
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(p.volume * gainScale, when + 0.005);
      g.gain.setTargetAtTime(0, when + 0.005, p.decay);
      osc.connect(g); g.connect(master);
      osc.start(when); osc.stop(stopAt + 0.02);
    }
    if (p.noise > 0) {
      var src = ctx.createBufferSource();
      var bp = ctx.createBiquadFilter();
      var ng = ctx.createGain();
      src.buffer = noiseBuffer;
      bp.type = "bandpass";
      bp.frequency.value = p.filterFrequency * spread;
      bp.Q.value = 1.2;
      ng.gain.setValueAtTime(0, when);
      ng.gain.linearRampToValueAtTime(p.noise * gainScale, when + 0.005);
      ng.gain.setTargetAtTime(0, when + 0.005, p.decay);
      src.connect(bp); bp.connect(ng); ng.connect(master);
      src.start(when, Math.random() * 0.5); src.stop(stopAt + 0.02);
    }
  }

  // play("jump") or play("land", { intensity: 0.5 }). Unknown ids are ignored.
  function play(cueId, opts) {
    var p = PARAMS[cueId];
    if (!p || !ctx || muted) return;
    if (ctx.state === "suspended") { ctx.resume(); return; }
    var now = Date.now();
    if (p.minIntervalMs && lastPlayed[cueId] && now - lastPlayed[cueId] < p.minIntervalMs) return;
    lastPlayed[cueId] = now;
    var intensity = opts && typeof opts.intensity === "number" ? Math.max(0.1, Math.min(1, opts.intensity)) : 1;
    var t = ctx.currentTime + 0.005;
    if (p.notes && p.notes.length) {
      for (var i = 0; i < p.notes.length; i++) voice(p, t + i * p.noteGap, p.notes[i], intensity);
    } else {
      voice(p, t, p.frequency, intensity);
    }
  }

  function setMuted(value) {
    muted = !!value;
    try { window.localStorage.setItem(STORAGE_KEY, muted ? "1" : "0"); } catch (e) { /* ignore */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.8, ctx.currentTime, 0.02);
  }

  window.RoomAudio = {
    PARAMS: PARAMS,
    init: init,
    play: play,
    setMuted: setMuted,
    isMuted: function () { return muted; }
  };
})();
