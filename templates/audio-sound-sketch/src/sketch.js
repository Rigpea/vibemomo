// Sound Sketch — sketch.js
//
// Four sound cues made with the Web Audio API; there are no audio files.
//
//   1. TUNING       the live numbers, their limits, and how new values are checked
//   2. SYNTHESIS    one small function per cue. The same functions play in the
//                   page and render to a file, so a render is what you hear.
//   3. PLAYING      the AudioContext, mute, and what happens when a cue is asked for
//   4. RENDERING    OfflineAudioContext -> 16-bit PCM WAV -> base64
//   5. STUDIO LINK  postMessage to/from the Atelier studio (safe without it)
//   6. PAGE         buttons and keyboard
//
// The only global is window.Sketch, a small handle for tests and DevTools.
(function () {
  "use strict";

  // -------------------------------------------------------------- 1. TUNING
  // Fallbacks in case tuning.js is missing a key. tuning.js always wins.
  var DEFAULTS = {
    masterVolume: 0.8,
    tapVolume: 0.35, tapPitch: 420, tapDecayMs: 30,
    blipVolume: 0.25, blipPitch: 880, blipDecayMs: 110,
    tickVolume: 0.3, tickPitch: 4200, tickDecayMs: 30,
    swellVolume: 0.2, swellPitch: 220, swellDecayMs: 60
  };
  var SWELL_RISE_MS = 180;
  var ATTACK_MS = 2;
  // The limits that keep every cue under 400 ms and at or below full level.
  function limits(key) {
    if (/Volume$/.test(key)) return [0, 1];
    if (/Pitch$/.test(key)) return [40, 12000];
    return key === "swellDecayMs" ? [5, 200] : [5, 380];
  }

  var T = {};                         // the ACTIVE tuning; read on every play
  var measured = {};                  // cue id -> Promise of its peak at the active tuning
  applyTuning(DEFAULTS);
  applyTuning(window.ATELIER_TUNING || {});

  // Merge new values. Unknown keys, wrong types and values outside the limits
  // are skipped, so a bad message can never make a cue long or loud.
  // Returns { applied: [keys set], ignored: [keys skipped by a check] }.
  function applyTuning(next) {
    var result = { applied: [], ignored: [] };
    if (!next || typeof next !== "object") return result;
    Object.keys(next).forEach(function (key) {
      var v = next[key];
      var ok = Object.prototype.hasOwnProperty.call(DEFAULTS, key) && typeof v === "number" && isFinite(v);
      if (ok) { var r = limits(key); ok = v >= r[0] && v <= r[1]; }
      if (!ok) { result.ignored.push(key); return; }
      if (T[key] !== v) measured = {}; // a measurement still running answers its own play, and is not kept
      T[key] = v;
      result.applied.push(key);
    });
    return result;
  }

  // ----------------------------------------------------------- 2. SYNTHESIS
  // A fixed noise pattern: the same tuning always renders the same file.
  var noiseCache = new WeakMap();     // per context, and a finished render can be dropped
  function noiseBuffer(ac) {
    if (noiseCache.has(ac)) return noiseCache.get(ac);
    var buffer = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.5), ac.sampleRate);
    var data = buffer.getChannelData(0);
    var x = 22222;                    // 16-bit-style linear congruential noise
    for (var i = 0; i < data.length; i++) {
      x = (x * 25173 + 13849) % 65536;
      data[i] = x / 32768 - 1;
    }
    noiseCache.set(ac, buffer);
    return buffer;
  }

  // Volume shape: up to `peak` in riseMs, then down to silence in decayMs.
  function envelope(ac, at, peak, riseMs, decayMs) {
    var g = ac.createGain();
    var top = at + riseMs / 1000;
    var floor = Math.max(peak * 0.001, 1e-5);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(Math.max(peak, floor), top);
    g.gain.exponentialRampToValueAtTime(floor, top + decayMs / 1000);
    return g;
  }

  function filter(ac, type, frequency, q) {
    var f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(frequency, ac.sampleRate / 2 - 1);
    f.Q.value = q;
    return f;
  }

  // Each entry: id -> { ms() its length, build(ac, out, at, peak) its nodes }.
  var CUES = {
    tap: { // a soft click: a low triangle, muffled, gone almost at once
      ms: function () { return ATTACK_MS + T.tapDecayMs; },
      build: function (ac, out, at, peak) {
        var end = at + this.ms() / 1000;
        var osc = ac.createOscillator();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(T.tapPitch, at);
        osc.frequency.exponentialRampToValueAtTime(T.tapPitch * 0.7, end);
        osc.connect(filter(ac, "lowpass", T.tapPitch * 4, 0.7))
          .connect(envelope(ac, at, peak, ATTACK_MS, T.tapDecayMs)).connect(out);
        osc.start(at); osc.stop(end);
      }
    },
    blip: { // a short sine with a quick pitch drop
      ms: function () { return ATTACK_MS + T.blipDecayMs; },
      build: function (ac, out, at, peak) {
        var end = at + this.ms() / 1000;
        var osc = ac.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(T.blipPitch, at);
        osc.frequency.exponentialRampToValueAtTime(T.blipPitch * 0.55, at + (end - at) * 0.6);
        osc.connect(envelope(ac, at, peak, ATTACK_MS, T.blipDecayMs)).connect(out);
        osc.start(at); osc.stop(end);
      }
    },
    tick: { // a filtered noise burst
      ms: function () { return ATTACK_MS + T.tickDecayMs; },
      build: function (ac, out, at, peak) {
        var end = at + this.ms() / 1000;
        var src = ac.createBufferSource();
        src.buffer = noiseBuffer(ac);
        src.connect(filter(ac, "bandpass", T.tickPitch, 1.5))
          .connect(envelope(ac, at, peak, ATTACK_MS, T.tickDecayMs)).connect(out);
        src.start(at); src.stop(end);
      }
    },
    swell: { // a short pad: two close saws, the filter opens as it rises, then it stops
      ms: function () { return SWELL_RISE_MS + T.swellDecayMs; },
      build: function (ac, out, at, peak) {
        var top = at + SWELL_RISE_MS / 1000;
        var end = at + this.ms() / 1000;
        var lp = filter(ac, "lowpass", T.swellPitch, 0.7);
        lp.frequency.setValueAtTime(lp.frequency.value, at);
        lp.frequency.exponentialRampToValueAtTime(Math.min(T.swellPitch * 6, ac.sampleRate / 2 - 1), top);
        lp.connect(envelope(ac, at, peak * 0.5, SWELL_RISE_MS, T.swellDecayMs)).connect(out);
        [1, 1.006].forEach(function (ratio) {
          var osc = ac.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.value = T.swellPitch * ratio;
          osc.connect(lp);
          osc.start(at); osc.stop(end);
        });
      }
    }
  };
  function knownCue(id) { return Object.prototype.hasOwnProperty.call(CUES, id); }
  // The level a cue is made at. Mute is not part of it: mute is about the room
  // you are in, and a render is a file.
  function peakOf(id) { return T[id + "Volume"] * T.masterVolume; }

  // ------------------------------------------------------------- 3. PLAYING
  var STORAGE_KEY = "atelier." + (document.documentElement.dataset.storageKey || "sound-sketch") + ".muted";
  var ctx = null;                     // AudioContext, made the first time a cue is asked for
  var master = null;                  // mute lives here, so it also silences a cue in flight
  var muted = readMuted();

  function readMuted() {
    try { return window.localStorage.getItem(STORAGE_KEY) === "1"; }
    catch (e) { return false; }       // storage can be blocked (privacy modes, some file:// setups)
  }

  function setMuted(value) {
    muted = !!value;
    try { window.localStorage.setItem(STORAGE_KEY, muted ? "1" : "0"); } catch (e) { /* ignore */ }
    if (master) master.gain.value = muted ? 0 : 1;
    refreshMute();
  }

  // Browsers keep an AudioContext suspended until a click or key press. One made
  // right after a press also starts suspended and runs a moment later, so wait
  // briefly before calling it locked. `done` always runs, with the running context
  // or null.
  function whenRunning(done) {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { done(null); return; }
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === "running") { done(ctx); return; }
    var settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      done(ctx.state === "running" ? ctx : null);
    }
    var resumed = ctx.resume();
    if (resumed && resumed.then) resumed.then(settle, settle);
    setTimeout(settle, 200);
  }

  // Answers with what really happened: callback({ played: true }) only after the
  // nodes are scheduled on a running context, otherwise { played: false, reason }.
  function playCue(id, callback) {
    if (!knownCue(id)) { callback({ played: false, reason: "unknown cue" }); return; }
    if (muted) { callback({ played: false, reason: "muted" }); return; }
    var peak = peakOf(id);
    if (!(peak > 0)) { callback({ played: false, reason: "volume is 0" }); return; }
    whenRunning(function (ac) {
      if (!ac) {
        var AC = window.AudioContext || window.webkitAudioContext;
        callback({ played: false, reason: AC ? "suspended: click in the page first" : "audio unavailable" });
        return;
      }
      if (muted) { callback({ played: false, reason: "muted" }); return; } // pressed M while waiting
      try {
        CUES[id].build(ac, master, ac.currentTime + 0.005, peakOf(id));
        callback({ played: true });
      } catch (e) {
        callback({ played: false, reason: "audio error: " + e.message });
      }
    });
  }

  // ----------------------------------------------------------- 4. RENDERING
  var SAMPLE_RATE = 44100;
  var TAIL_MS = 50;

  // A complete mono 16-bit PCM RIFF/WAVE file. Samples are limited to -1..1.
  function encodeWav(samples, sampleRate) {
    var bytes = new Uint8Array(44 + samples.length * 2);
    var view = new DataView(bytes.buffer);
    function text(at, s) { for (var i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); }
    text(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);              // size of this chunk
    view.setUint16(20, 1, true);               // 1 = PCM
    view.setUint16(22, 1, true);               // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);  // bytes per second
    view.setUint16(32, 2, true);               // bytes per frame
    view.setUint16(34, 16, true);              // bits per sample
    text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    }
    return bytes;
  }

  function toBase64(bytes) {
    var out = "";
    var CHUNK = 0x6000;               // a multiple of 3, so only the last piece is padded
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += window.btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return out;
  }

  // Resolves to the cue's rendered buffer at the tuning active right now.
  function renderBuffer(id) {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return Promise.reject(new Error("offline audio unavailable"));
    return new Promise(function (resolve) {
      var frames = Math.ceil(SAMPLE_RATE * (CUES[id].ms() + TAIL_MS) / 1000);
      var off = new OAC(1, frames, SAMPLE_RATE);
      CUES[id].build(off, off.destination, 0, peakOf(id));
      resolve(off.startRendering());
    });
  }

  // The largest absolute sample, limited to full scale as the file is.
  function samplePeak(samples) {
    var peak = 0;
    for (var i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
    return Math.min(1, peak);
  }

  // Resolves to { id, wav, seconds, peak, sampleRate, tuning }; rejects with a reason.
  // tuning is read in the same turn the nodes are built, so it describes this file
  // even if new values arrive while the render runs.
  function renderCue(id) {
    if (!knownCue(id)) return Promise.reject(new Error("unknown cue"));
    var tuning = Object.assign({}, T);
    return renderBuffer(id).then(function (buffer) {
      var samples = buffer.getChannelData(0);
      return {
        id: id,
        wav: toBase64(encodeWav(samples, SAMPLE_RATE)),
        seconds: buffer.length / SAMPLE_RATE,
        peak: samplePeak(samples),
        sampleRate: SAMPLE_RATE,
        tuning: tuning
      };
    });
  }

  // A known cue's peak at the active tuning: rendered the first time it is asked
  // for, then kept until the tuning changes. A failure is not kept.
  function measurePeak(id) {
    if (measured[id]) return measured[id];
    var kept = measured;
    kept[id] = renderBuffer(id).then(function (buffer) {
      return samplePeak(buffer.getChannelData(0));
    });
    kept[id].catch(function () { delete kept[id]; });
    return kept[id];
  }

  // --------------------------------------------------------- 5. STUDIO LINK
  // Inside the Atelier studio this page runs in an iframe. Opened directly
  // (file:// double-click) window.parent === window and all of this is a no-op.
  var embedded = !!window.parent && window.parent !== window;

  function post(message) {
    if (!embedded) return;
    try { window.parent.postMessage(message, "*"); } catch (e) { /* ignore */ }
  }

  // Telemetry: what happened and when (ms since the page loaded).
  function emit(name, data) {
    post({ type: "atelier:event", name: name, t: Math.round(window.performance.now()), data: data || {} });
  }

  // Adds what was played to a report and sends it. Read in the same turn as the
  // play, so both numbers describe the sound just scheduled. If the render fails
  // the report has no peak: never a guess.
  function reportPlayed(id, name, report) {
    report.seconds = CUES[id].ms() / 1000;
    measurePeak(id).then(function (peak) { report.peak = peak; }, function () {})
      .then(function () { emit(name, report); });
  }

  window.addEventListener("message", function (e) {
    if (!embedded || e.source !== window.parent) return;
    var msg = e.data;
    if (!msg) return;
    if (msg.type === "atelier:tuning" && msg.tuning) {
      emit("tuning", applyTuning(msg.tuning));
    } else if (msg.type === "atelier:cue" && typeof msg.id === "string") {
      playCue(msg.id, function (r) {
        var answer = { id: msg.id, played: r.played };
        if (r.reason) answer.reason = r.reason;
        showResult(msg.id, r);
        if (r.played) reportPlayed(msg.id, "cue", answer);
        else emit("cue", answer);
      });
    } else if (msg.type === "atelier:render" && typeof msg.id === "string") {
      renderCue(msg.id).then(function (r) { emit("render", r); }, function (err) {
        emit("render", { id: msg.id, reason: err.message });
      });
    }
  });

  // ---------------------------------------------------------------- 6. PAGE
  var statusLine = document.getElementById("status");
  var muteButton = document.getElementById("btn-mute");

  function showResult(id, r) {
    statusLine.textContent = r.played ? id + " · " + Math.round(CUES[id].ms()) + " ms" : id + " not played: " + r.reason;
  }

  function refreshMute() {
    muteButton.textContent = muted ? "Sound off" : "Sound on";
    muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
  }

  // Played by hand: tell the studio under the cue's own name, like any product
  // event, with the same numbers as a Trigger's answer and how it was played, so
  // the Audio panel shows it like a Trigger and counts it with them.
  function playByHand(id, how) {
    playCue(id, function (r) {
      showResult(id, r);
      if (r.played) reportPlayed(id, id, { how: how });
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("[data-cue]"), function (b) {
    b.addEventListener("click", function () { playByHand(b.getAttribute("data-cue"), "button"); });
  });
  muteButton.addEventListener("click", function () { setMuted(!muted); });

  var KEYS = { Digit1: "tap", Digit2: "blip", Digit3: "tick", Digit4: "swell" };
  window.addEventListener("keydown", function (e) {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "KeyM") setMuted(!muted);
    else if (KEYS[e.code]) playByHand(KEYS[e.code], "key");
  });

  refreshMute();
  post({ type: "atelier:ready", tuning: Object.assign({}, T) });

  window.Sketch = {
    applyTuning: applyTuning,
    getTuning: function () { return Object.assign({}, T); },
    cueLengthMs: function (id) { return knownCue(id) ? CUES[id].ms() : null; },
    encodeWav: encodeWav,
    renderCue: renderCue,
    isMuted: function () { return muted; },
    setMuted: setMuted
  };
})();
