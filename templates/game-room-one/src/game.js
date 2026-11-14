// Room One — game.js
//
// A single-screen platformer: walk, jump, push the crate onto the pressure
// plate, and leave through the door it opens. No libraries, no build step.
//
// How the file is organized (read top to bottom):
//
//   1. SETUP        constants, the live tuning object, the room layout
//   2. INPUT        keyboard + on-screen touch buttons -> one `input` record
//   3. STUDIO LINK  postMessage to/from the Atelier studio (safe without it)
//   4. SIMULATION   step(dt): runs at a FIXED 120 Hz so the physics behaves
//                   the same on every screen; collision is axis-separated
//                   AABB (move X, resolve; then move Y, resolve)
//   5. RENDERING    draw(alpha): runs once per animation frame and draws the
//                   world interpolated between the last two physics steps
//   6. UI + LOOP    overlays (help, pause, cleared), the requestAnimationFrame
//                   loop, and the window.RoomGame handle
//
// Coordinates are logical pixels in a 960x540 room; y grows downward.
// Speeds are px/s, accelerations px/s^2, times in seconds unless named *Ms.
(function () {
  "use strict";

  // ---------------------------------------------------------------- 1. SETUP
  var W = 960, H = 540;
  var STEP = 1 / 120;                 // fixed physics timestep (seconds)
  var MAX_FRAME = 0.25;               // never simulate more than this per frame

  // Fallbacks in case tuning.js is missing a key. tuning.js always wins.
  var DEFAULTS = {
    accel: 2600, decel: 3000, airControl: 0.65, maxSpeed: 300,
    jumpVelocity: 760, gravity: 2200, fallGravityMultiplier: 1.6,
    jumpCutMultiplier: 0.45, coyoteTimeMs: 100, jumpBufferMs: 120,
    terminalVelocity: 1100, pushSpeedFactor: 0.55, doorOpenSeconds: 0.7,
    squashStretch: 0.6, dustParticles: true, playerColor: "#ff7a59"
  };
  var T = {};                         // the ACTIVE tuning; read every step
  applyTuning(DEFAULTS);
  applyTuning(window.ATELIER_TUNING || {});

  // Merge new values into the active tuning. Known keys must keep their type
  // (a number stays a number) and unknown keys are skipped, so a bad message
  // can never break the physics.
  // Returns { applied: [keys set], ignored: [keys skipped by a check] }.
  function applyTuning(next) {
    var result = { applied: [], ignored: [] };
    if (!next || typeof next !== "object") return result;
    Object.keys(next).forEach(function (key) {
      if (!(key in DEFAULTS)) { result.ignored.push(key); return; }
      var v = next[key];
      var t = typeof v;
      if ((t !== "number" && t !== "boolean" && t !== "string") ||
          (t === "number" && !isFinite(v)) ||
          (key in DEFAULTS && typeof DEFAULTS[key] !== t)) {
        result.ignored.push(key);
        return;
      }
      T[key] = v;
      result.applied.push(key);
    });
    return result;
  }

  var reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  function motionOk() { return !reducedMotion.matches; }

  // The room. Solids are plain rectangles; everything collides with them.
  var SOLIDS = [
    { x: 0,   y: 480, w: 960, h: 60 },   // floor
    { x: -40, y: 0,   w: 60,  h: 540 },  // left wall  (visible 0..20)
    { x: 940, y: 0,   w: 60,  h: 540 },  // right wall (visible 940..960)
    { x: 0,   y: -40, w: 960, h: 60 },   // ceiling    (visible 0..20)
    { x: 800, y: 400, w: 140, h: 80 },   // raised ledge holding the exit
    { x: 400, y: 350, w: 130, h: 16 }    // floating shelf, just for fun
  ];
  var PLATE = { x: 620, y: 472, w: 72, h: 8 };
  var DOOR = { x: 858, y: 324, w: 52, h: 76 };
  var LEFT_INNER = 20;                // inner face of the left wall

  var S;                              // all mutable game state; see reset()

  function reset() {
    S = {
      time: 0,                        // ms of simulated play since level start
      jumps: 0,
      phase: "play",                  // "play" | "cleared"
      player: {
        x: 90, y: 440, w: 28, h: 40, px: 90, py: 440,
        vx: 0, vy: 0, facing: 1, grounded: false, pushing: false,
        lastGroundedAt: -1e9, jumpPressedAt: -1e9, canCut: false,
        sx: 1, sy: 1                  // squash/stretch scale, eases back to 1
      },
      crate: { x: 300, y: 432, w: 48, h: 48, px: 300, py: 432, vy: 0, shake: 0 },
      plate: { latched: false, latchedAt: 0, press: 0 },
      door: { open: 0, opening: false },
      particles: [],
      lastPushSound: -1e9,
      clearedAt: 0
    };
  }

  // ---------------------------------------------------------------- 2. INPUT
  // `input` holds what is pressed right now. Jump presses are also stamped
  // with a time so a jump pressed slightly early still happens (buffering).
  var input = { left: false, right: false, jump: false };
  var KEYS = {
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right",
    Space: "jump", ArrowUp: "jump", KeyW: "jump"
  };

  function setInput(action, down) {
    if (action === "jump" && down && !input.jump) S.player.jumpPressedAt = S.time;
    input[action] = down;
  }

  window.addEventListener("keydown", function (e) {
    unlockAudio();
    var action = KEYS[e.code];
    if (action) {
      e.preventDefault();
      if (helpOpen) { closeHelp(); return; }
      if (!e.repeat) setInput(action, true);
      return;
    }
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "?") { if (helpOpen) closeHelp(); else openHelp(); }
    else if (e.code === "KeyR") restart();
    else if (e.code === "KeyM") toggleMute();
    else if (e.code === "KeyP" || e.code === "Escape") {
      if (helpOpen) closeHelp(); else if (S.phase === "play") setPaused(!paused);
    }
    else if (e.code === "Enter") {
      if (helpOpen) closeHelp(); else if (S.phase === "cleared") restart();
    }
  });
  window.addEventListener("keyup", function (e) {
    var action = KEYS[e.code];
    if (action) setInput(action, false);
  });
  // Losing focus must not leave a key "stuck" down.
  window.addEventListener("blur", function () { input.left = input.right = input.jump = false; });

  // Browsers only start audio after a user gesture; the first one unlocks it.
  // audioReady: started after a real user gesture (userActivation where the
  // browser reports it), so RoomAudio.play() is heard rather than dropped.
  var audioReady = false;
  function unlockAudio() {
    if (!window.RoomAudio || !window.RoomAudio.init()) return;
    var ua = window.navigator && window.navigator.userActivation;
    if (!ua || ua.hasBeenActive) audioReady = true;
  }
  window.addEventListener("pointerdown", unlockAudio);

  function sound(id, opts) { if (window.RoomAudio) window.RoomAudio.play(id, opts); }

  // ---------------------------------------------------------- 3. STUDIO LINK
  // Inside the Atelier studio the game runs in an iframe. Opened directly
  // (file:// double-click) window.parent === window and all of this is a no-op.
  var embedded = !!window.parent && window.parent !== window;

  function post(message) {
    if (!embedded) return;
    try { window.parent.postMessage(message, "*"); } catch (e) { /* ignore */ }
  }

  // Telemetry: what happened and when (ms of play since the level started).
  function emit(name, data) {
    post({ type: "atelier:event", name: name, t: Math.round(S.time), data: data || {} });
  }

  // Hot tuning: the studio sends new values; merge them without restarting,
  // then acknowledge which keys were applied and which were ignored.
  window.addEventListener("message", function (e) {
    if (!embedded || e.source !== window.parent) return;
    var msg = e.data;
    if (!msg || msg.type !== "atelier:tuning" || !msg.tuning) return;
    emit("tuning", applyTuning(msg.tuning));
  });

  // Audio cues: the studio's Audio panel asks for one sound by id. Play it
  // through RoomAudio and answer with what really happened:
  // { id, played: true } or { id, played: false, reason }.
  function cueBlocker(id) {
    var A = window.RoomAudio;
    if (!A) return "audio unavailable";
    if (!A.PARAMS || !Object.prototype.hasOwnProperty.call(A.PARAMS, id)) return "unknown cue";
    if (A.isMuted()) return "muted";
    // Browsers keep audio locked until a click or key press. An audio context
    // started just now is still "suspended" and would drop this one sound, so
    // the first cue only unlocks (played false); the next one plays.
    var wasReady = audioReady;
    unlockAudio();
    return wasReady && audioReady ? "" : "audio locked";
  }

  window.addEventListener("message", function (e) {
    if (!embedded || e.source !== window.parent) return;
    var msg = e.data;
    if (!msg || msg.type !== "atelier:cue" || typeof msg.id !== "string") return;
    var reason = cueBlocker(msg.id);
    if (reason) { emit("cue", { id: msg.id, played: false, reason: reason }); return; }
    sound(msg.id);
    emit("cue", { id: msg.id, played: true });
  });

  // ------------------------------------------------------------ 4. SIMULATION
  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function approach(value, target, amount) {
    return value < target ? Math.min(value + amount, target) : Math.max(value - amount, target);
  }

  // Move a body horizontally by dx and push it back out of any solid it hit.
  // Returns true if it hit something.
  function moveX(body, dx, solids) {
    var hit = false;
    body.x += dx;
    for (var i = 0; i < solids.length; i++) {
      var s = solids[i];
      if (!overlaps(body, s)) continue;
      body.x = dx > 0 ? s.x - body.w : s.x + s.w;
      hit = true;
    }
    return hit;
  }

  // Same for vertical movement. Returns +1 landed, -1 bumped head, 0 free.
  function moveY(body, dy, solids) {
    body.y += dy;
    var hit = 0;
    for (var i = 0; i < solids.length; i++) {
      var s = solids[i];
      if (!overlaps(body, s)) continue;
      if (dy > 0) { body.y = s.y - body.h; hit = 1; }
      else { body.y = s.y + s.h; hit = -1; }
    }
    return hit;
  }

  function step(dt) {
    var p = S.player, c = S.crate;
    p.px = p.x; p.py = p.y; c.px = c.x; c.py = c.y;
    S.time += dt * 1000;

    if (S.phase === "play") updatePlayer(dt);
    updateCrate(dt);
    updatePlateAndDoor(dt);
    updateEffects(dt);
  }

  function updatePlayer(dt) {
    var p = S.player, c = S.crate;
    var dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    var control = p.grounded ? 1 : T.airControl;
    var top = T.maxSpeed * (p.pushing ? T.pushSpeedFactor : 1);

    // Horizontal: accelerate toward the target speed, brake with decel.
    // Reversing direction gets accel + decel so turns feel snappy.
    if (dir !== 0) {
      var turning = p.vx !== 0 && (p.vx > 0 ? 1 : -1) !== dir;
      var a = (turning ? T.accel + T.decel : T.accel) * control;
      p.vx = approach(p.vx, dir * top, a * dt);
      p.facing = dir;
    } else {
      p.vx = approach(p.vx, 0, T.decel * control * dt);
    }

    // Jump: allowed if jump was pressed within jumpBufferMs AND we touched
    // the ground within coyoteTimeMs. Both windows are consumed on use.
    if (p.grounded) p.lastGroundedAt = S.time;
    var buffered = S.time - p.jumpPressedAt <= T.jumpBufferMs;
    var coyote = S.time - p.lastGroundedAt <= T.coyoteTimeMs;
    if (buffered && coyote) {
      p.vy = -T.jumpVelocity;
      p.grounded = false;
      p.canCut = true;
      p.lastGroundedAt = -1e9;
      p.jumpPressedAt = -1e9;
      S.jumps++;
      stretch(0.78, 1.25);
      dust(p.x + p.w / 2, p.y + p.h, 5);
      sound("jump");
      emit("jump", { x: Math.round(p.x), jumps: S.jumps });
    }

    // Variable height: letting go while still rising cuts the upward speed.
    if (p.canCut && !input.jump && p.vy < 0) {
      p.vy *= T.jumpCutMultiplier;
      p.canCut = false;
    }
    if (p.vy >= 0) p.canCut = false;

    // Gravity, heavier on the way down, capped at terminal velocity.
    var g = T.gravity * (p.vy > 0 ? T.fallGravityMultiplier : 1);
    p.vy = Math.min(p.vy + g * dt, T.terminalVelocity);

    // Horizontal move, including pushing the crate.
    var dx = p.vx * dt;
    if (moveX(p, dx, SOLIDS)) p.vx = 0;     // walked into a wall
    p.pushing = false;
    if (overlaps(p, c)) {
      if (!S.plate.latched && dx !== 0) {
        var depth = dx > 0 ? p.x + p.w - c.x : p.x - (c.x + c.w);
        var crateFrom = c.x;
        moveX(c, depth, SOLIDS);
        if (Math.abs(c.x - crateFrom) > 1e-6) {
          p.pushing = true;
          if (S.time - S.lastPushSound > 140) {
            S.lastPushSound = S.time;
            sound("push");
            emit("push", { crateX: Math.round(c.x) });
            if (Math.random() < 0.5) dust(dx > 0 ? c.x : c.x + c.w, c.y + c.h, 1);
          }
        }
      }
      if (overlaps(p, c)) {        // crate didn't (fully) move: stop at it
        p.x = dx > 0 ? c.x - p.w : c.x + c.w;
        if (!p.pushing) p.vx = 0;
      }
    }

    // Vertical move. The crate is a solid you can stand on.
    var impact = p.vy;
    var wasGrounded = p.grounded;
    var hit = moveY(p, p.vy * dt, SOLIDS.concat([c]));
    p.grounded = hit === 1;
    if (hit !== 0) p.vy = 0;
    if (p.grounded && !wasGrounded) land(impact);
  }

  function land(impact) {
    var p = S.player;
    if (impact < 150) return;               // just stepping down, not a landing
    var k = Math.min(1, impact / T.terminalVelocity);
    stretch(1 + 0.45 * k, 1 - 0.4 * k);
    dust(p.x + p.w / 2, p.y + p.h, Math.round(4 + 8 * k));
    sound("land", { intensity: 0.3 + k });
    emit("land", { speed: Math.round(impact) });
  }

  function updateCrate(dt) {
    var c = S.crate;
    // Once latched, the crate glides to the plate's center and stays there.
    if (S.plate.latched) {
      var target = PLATE.x + PLATE.w / 2 - c.w / 2;
      c.x = approach(c.x, target, 160 * dt);
    }
    c.vy = Math.min(c.vy + T.gravity * dt, T.terminalVelocity);
    if (moveY(c, c.vy * dt, SOLIDS) !== 0) c.vy = 0;
  }

  function updatePlateAndDoor(dt) {
    var c = S.crate, pl = S.plate, d = S.door, p = S.player;
    var center = c.x + c.w / 2, plateCenter = PLATE.x + PLATE.w / 2;
    var onFloor = c.y + c.h >= PLATE.y + PLATE.h - 0.5;
    if (!pl.latched && onFloor && Math.abs(center - plateCenter) <= PLATE.w / 2 - 12) {
      pl.latched = true;
      pl.latchedAt = S.time;
      c.shake = 1;
      dust(center, c.y + c.h, 8);
      sound("plate");
      emit("plate", { crateX: Math.round(c.x) });
    }
    pl.press = approach(pl.press, pl.latched ? 1 : 0, dt * 8);

    // The door starts opening a beat after the click, so you hear both.
    if (pl.latched && !d.opening && S.time - pl.latchedAt > 280) {
      d.opening = true;
      sound("door");
      emit("door", {});
    }
    if (d.opening) {
      var dur = motionOk() ? Math.max(0.05, T.doorOpenSeconds) : 0.001;
      d.open = Math.min(1, d.open + dt / dur);
    }

    // Leaving: stand inside the open doorway.
    var mid = p.x + p.w / 2;
    if (S.phase === "play" && d.open >= 1 && p.grounded &&
        mid > DOOR.x + 8 && mid < DOOR.x + DOOR.w - 8 &&
        p.y + p.h <= DOOR.y + DOOR.h + 1 && p.y + p.h > DOOR.y) {
      S.phase = "cleared";
      S.clearedAt = S.time;
      p.vx = 0;
      sound("cleared");
      emit("cleared", { timeMs: Math.round(S.time), jumps: S.jumps });
      showCleared();
    }
  }

  // Squash & stretch: snap to a shape; updateEffects springs it back to 1.
  function stretch(sx, sy) {
    var k = motionOk() ? T.squashStretch : 0;
    S.player.sx = 1 + (sx - 1) * k;
    S.player.sy = 1 + (sy - 1) * k;
  }

  function dust(x, y, count) {
    if (!T.dustParticles || !motionOk()) return;
    for (var i = 0; i < count; i++) {
      var side = Math.random() < 0.5 ? -1 : 1;
      S.particles.push({
        x: x + side * Math.random() * 10, y: y - 2,
        vx: side * (40 + Math.random() * 110), vy: -30 - Math.random() * 70,
        life: 0, maxLife: 0.35 + Math.random() * 0.3, r: 2.5 + Math.random() * 3.5
      });
    }
  }

  function updateEffects(dt) {
    var p = S.player;
    var ease = Math.min(1, dt * 14);
    p.sx += (1 - p.sx) * ease;
    p.sy += (1 - p.sy) * ease;
    S.crate.shake = Math.max(0, S.crate.shake - dt * 4);
    for (var i = S.particles.length - 1; i >= 0; i--) {
      var q = S.particles[i];
      q.life += dt;
      if (q.life >= q.maxLife) { S.particles.splice(i, 1); continue; }
      q.vx *= 1 - 4 * dt;
      q.vy += 220 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
    }
  }

  // ------------------------------------------------------------- 5. RENDERING
  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var COLORS = {
    wallTop: "#f6f1e7", wallBottom: "#e8dfcf", stripe: "rgba(120, 100, 70, 0.05)",
    solid: "#2f3142", solidEdge: "#4b4f6b", shadow: "rgba(30, 25, 40, 0.18)",
    crate: "#c98b4f", crateDark: "#9a6533", crateLight: "#e0a768",
    plate: "#8b90a8", plateOn: "#3fbf86", door: "#5b4fc4", doorFrame: "#23243a",
    exitGlow: "#ffe7a3", dust: "rgba(170, 155, 130, 0.9)", eye: "#23243a"
  };

  // Crisp scaling: the canvas backing store matches its on-screen size times
  // devicePixelRatio; the transform maps 960x540 logical units onto it.
  function resize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var bw = Math.max(1, Math.round(rect.width * dpr));
    var bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    ctx.setTransform(bw / W, 0, 0, bh / H, 0, 0);
  }
  window.addEventListener("resize", resize);

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  // Top of the first surface below a span, for soft contact shadows.
  function groundBelow(x, y, w, self) {
    var best = H;
    var list = self === S.crate ? SOLIDS : SOLIDS.concat([S.crate]);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (x + w > s.x && x < s.x + s.w && s.y >= y - 1 && s.y < best) best = s.y;
    }
    return best;
  }

  function drawShadow(cx, bottom, w, self) {
    var gy = groundBelow(cx - w / 2, bottom, w, self);
    var k = Math.max(0.25, 1 - (gy - bottom) / 220);
    ctx.fillStyle = COLORS.shadow;
    ctx.beginPath();
    ctx.ellipse(cx, gy, (w / 2 + 4) * k, 5 * k, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function draw(alpha) {
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, COLORS.wallTop);
    bg.addColorStop(1, COLORS.wallBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLORS.stripe;
    for (var sx = 40; sx < W; sx += 80) ctx.fillRect(sx, 0, 40, 480);

    drawDoor();
    for (var i = 0; i < SOLIDS.length; i++) {
      var s = SOLIDS[i];
      ctx.fillStyle = COLORS.solid;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      ctx.fillStyle = COLORS.solidEdge;     // lighter top edge
      ctx.fillRect(s.x, s.y, s.w, Math.min(4, s.h));
    }
    drawPlate();
    drawCrate(alpha);
    drawPlayer(alpha);
    drawParticles();
  }

  function drawCrate(alpha) {
    var c = S.crate;
    var cx = lerp(c.px, c.x, alpha), cy = lerp(c.py, c.y, alpha);
    drawShadow(cx + c.w / 2, cy + c.h, c.w, c);
    var wobble = motionOk() ? Math.sin(S.time / 25) * c.shake * 0.04 : 0;
    ctx.save();
    ctx.translate(cx + c.w / 2, cy + c.h);
    ctx.rotate(wobble);
    var hw = c.w / 2;
    ctx.fillStyle = COLORS.crateDark;
    roundRect(-hw, -c.h, c.w, c.h, 5); ctx.fill();
    ctx.fillStyle = COLORS.crate;
    roundRect(-hw + 4, -c.h + 4, c.w - 8, c.h - 8, 3); ctx.fill();
    ctx.strokeStyle = COLORS.crateDark;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-hw + 6, -c.h + 6); ctx.lineTo(hw - 6, -6);
    ctx.moveTo(hw - 6, -c.h + 6); ctx.lineTo(-hw + 6, -6);
    ctx.stroke();
    ctx.fillStyle = COLORS.crateLight;
    ctx.fillRect(-hw + 4, -c.h + 4, c.w - 8, 3);
    ctx.restore();
  }

  // The player is a soft rounded block, scaled around its feet so that
  // squash/stretch keeps it planted on the ground.
  function drawPlayer(alpha) {
    var p = S.player;
    var x = lerp(p.px, p.x, alpha), y = lerp(p.py, p.y, alpha);
    var fade = S.phase === "cleared" ? 1 - (S.time - S.clearedAt) / 400 : 1;
    if (fade <= 0) return;
    drawShadow(x + p.w / 2, y + p.h, p.w, p);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(x + p.w / 2, y + p.h);
    ctx.scale(p.sx, p.sy);
    ctx.fillStyle = T.playerColor;
    roundRect(-p.w / 2, -p.h, p.w, p.h, 9); ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
    roundRect(-p.w / 2 + 4, -p.h + 4, p.w - 8, 8, 4); ctx.fill();
    // Eyes look where you are going and squint while pushing.
    ctx.fillStyle = COLORS.eye;
    var ex = p.facing * 5, eh = p.pushing ? 2.5 : 7;
    ctx.fillRect(ex - 6, -p.h + 12, 3.5, eh);
    ctx.fillRect(ex + 3, -p.h + 12, 3.5, eh);
    ctx.restore();
  }

  function drawParticles() {
    ctx.fillStyle = COLORS.dust;
    for (var j = 0; j < S.particles.length; j++) {
      var q = S.particles[j];
      var life = 1 - q.life / q.maxLife;
      ctx.globalAlpha = life;
      ctx.beginPath();
      ctx.arc(q.x, q.y, q.r * (0.5 + 0.5 * life), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPlate() {
    var h = PLATE.h * (1 - 0.6 * S.plate.press);
    ctx.fillStyle = COLORS.solidEdge;
    ctx.fillRect(PLATE.x - 4, PLATE.y + PLATE.h - 2, PLATE.w + 8, 2);
    ctx.fillStyle = S.plate.latched ? COLORS.plateOn : COLORS.plate;
    roundRect(PLATE.x, PLATE.y + PLATE.h - h, PLATE.w, h, 2); ctx.fill();
  }

  // The door: a dark frame, a warm glowing doorway, and a panel that slides
  // up (eased) once the plate is latched.
  function drawDoor() {
    var ease = 1 - Math.pow(1 - S.door.open, 3);
    ctx.fillStyle = COLORS.doorFrame;
    roundRect(DOOR.x - 6, DOOR.y - 6, DOOR.w + 12, DOOR.h + 6, 6); ctx.fill();
    ctx.fillStyle = COLORS.exitGlow;
    ctx.fillRect(DOOR.x, DOOR.y, DOOR.w, DOOR.h);
    if (ease > 0) {
      ctx.fillStyle = "rgba(255, 231, 163, " + (0.45 * ease) + ")";
      ctx.beginPath();
      ctx.ellipse(DOOR.x + DOOR.w / 2, DOOR.y + DOOR.h, 80 * ease, 12 * ease, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    var panelH = DOOR.h * (1 - ease);
    if (panelH > 0.5) {
      ctx.save();
      ctx.beginPath(); ctx.rect(DOOR.x, DOOR.y, DOOR.w, DOOR.h); ctx.clip();
      ctx.fillStyle = COLORS.door;
      ctx.fillRect(DOOR.x, DOOR.y, DOOR.w, panelH);
      ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
      for (var k = 1; k < 4; k++) ctx.fillRect(DOOR.x, DOOR.y + panelH - k * 19, DOOR.w, 2);
      ctx.fillStyle = S.plate.latched ? COLORS.plateOn : "#f2c14e";   // lock light
      ctx.beginPath();
      ctx.arc(DOOR.x + DOOR.w - 10, DOOR.y + panelH - 30, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ------------------------------------------------------------ 6. UI + LOOP
  function $(id) { return document.getElementById(id); }
  var ui = {
    objective: $("objective"), stats: $("stats"),
    help: $("help"), paused: $("paused"), cleared: $("cleared"),
    clearedTime: $("cleared-time"), clearedJumps: $("cleared-jumps"),
    mute: $("btn-mute")
  };
  var paused = false;
  var helpOpen = true;      // the controls card is shown on first load

  function formatTime(ms) {
    var s = ms / 1000;
    var m = Math.floor(s / 60);
    var rest = s - m * 60;
    return m > 0 ? m + ":" + (rest < 10 ? "0" : "") + rest.toFixed(2) : rest.toFixed(2) + "s";
  }

  function objectiveText() {
    if (S.phase === "cleared") return "Room cleared.";
    if (S.door.open >= 1) return "The door is open. Step into the doorway.";
    if (S.plate.latched) return "Click. Something is opening...";
    if (S.crate.x <= LEFT_INNER + 0.5) return "The crate is stuck in the corner. Press R to reset the room.";
    return "Push the crate onto the pressure plate to open the door.";
  }

  var lastObjective = "", lastStats = "";
  function updateHud() {
    var text = objectiveText();
    if (text !== lastObjective) { ui.objective.textContent = text; lastObjective = text; }
    var shown = S.phase === "cleared" ? S.clearedAt : S.time;
    var stats = (Math.floor(shown / 100) / 10).toFixed(1) + "s · " +
                S.jumps + (S.jumps === 1 ? " jump" : " jumps");
    if (stats !== lastStats) { ui.stats.textContent = stats; lastStats = stats; }
  }

  function openHelp() { helpOpen = true; ui.help.hidden = false; }
  function closeHelp() { helpOpen = false; ui.help.hidden = true; canvas.focus(); }

  function setPaused(value) {
    paused = value;
    ui.paused.hidden = !paused;
  }

  function showCleared() {
    ui.clearedTime.textContent = formatTime(S.clearedAt);
    ui.clearedJumps.textContent = String(S.jumps);
    setTimeout(function () { if (S.phase === "cleared") ui.cleared.hidden = false; }, 450);
  }

  function restart() {
    // Report first, so t says how long the abandoned attempt lasted.
    if (S && S.time > 0) emit("restart", { phase: S.phase, jumps: S.jumps });
    reset();
    input.jump = false;
    acc = 0;
    ui.cleared.hidden = true;
    setPaused(false);
  }

  function refreshMute() {
    var m = window.RoomAudio ? window.RoomAudio.isMuted() : true;
    ui.mute.textContent = m ? "Sound off" : "Sound on";
    ui.mute.setAttribute("aria-pressed", m ? "true" : "false");
  }
  function toggleMute() {
    if (!window.RoomAudio) return;
    window.RoomAudio.setMuted(!window.RoomAudio.isMuted());
    refreshMute();
  }

  // Buttons hand focus back to the canvas so Space never "clicks" them again.
  function button(id, fn) {
    $(id).addEventListener("click", function (e) {
      unlockAudio();
      fn();
      e.currentTarget.blur();
      canvas.focus();
    });
  }
  button("btn-restart", restart);
  button("btn-help", function () { if (helpOpen) closeHelp(); else openHelp(); });
  button("btn-mute", toggleMute);
  button("btn-start", closeHelp);
  button("btn-resume", function () { setPaused(false); });
  button("btn-again", restart);
  canvas.addEventListener("pointerdown", function () { canvas.focus(); });

  // Touch buttons: hold to move, tap to jump.
  Array.prototype.forEach.call(document.querySelectorAll("[data-touch]"), function (el) {
    var action = el.getAttribute("data-touch");
    function down(e) {
      e.preventDefault();
      unlockAudio();
      if (helpOpen) closeHelp();
      el.classList.add("active");
      setInput(action, true);
    }
    function up() { el.classList.remove("active"); setInput(action, false); }
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  });

  // Hidden tab: pause rather than letting the clock run.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && S.phase === "play" && !helpOpen) setPaused(true);
  });

  // The loop: accumulate real time, spend it in fixed STEP-sized chunks,
  // then draw with the leftover fraction for smooth motion on any refresh rate.
  var acc = 0, last = performance.now();
  function frame(now) {
    var dt = Math.min(MAX_FRAME, Math.max(0, (now - last) / 1000));
    last = now;
    var running = !paused && !helpOpen;
    if (running) {
      acc += dt;
      while (acc >= STEP) { step(STEP); acc -= STEP; }
    }
    draw(running ? acc / STEP : 1);
    updateHud();
    requestAnimationFrame(frame);
  }

  reset();
  resize();
  refreshMute();
  ui.help.hidden = false;
  requestAnimationFrame(frame);
  post({ type: "atelier:ready", tuning: Object.assign({}, T) });

  // A small handle for the studio, tests, and curious learners in DevTools.
  window.RoomGame = {
    restart: restart,
    pause: function (value) { setPaused(value === undefined ? true : !!value); },
    applyTuning: applyTuning,
    getTuning: function () { return Object.assign({}, T); },
    getState: function () {
      return {
        phase: S.phase, timeMs: Math.round(S.time), jumps: S.jumps,
        plateLatched: S.plate.latched, doorOpen: S.door.open, paused: paused, helpOpen: helpOpen,
        player: { x: S.player.x, y: S.player.y, vx: S.player.vx, vy: S.player.vy, grounded: S.player.grounded },
        crate: { x: S.crate.x, y: S.crate.y }
      };
    }
  };
})();
