// Sound Sketch — selfcheck.mjs
// Headless sanity check (Node only, no browser). Run: node selfcheck.mjs
// (a) atelier.json has the required manifest fields.
// (b) tuning.js parses the way the studio parses it: the text between the
//     first "{" and the last "}" must be valid JSON.
// (c) index.html loads classic scripts only and references nothing remote.
// (d) sketch.js knows every cue and answers every studio message.
// (e) the project holds no audio files (renders under dist/ do not count).
// (f) sketch.js, loaded with stand-ins for the browser: tuning rejects what it
//     should, every cue stays under 400 ms, the WAV encoder writes a whole file.
//     Real sound needs a browser; this does not check that.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

// (a) manifest
let manifest = {};
try { manifest = JSON.parse(read("atelier.json")); check(true, "atelier.json is valid JSON"); }
catch (e) { check(false, `atelier.json is valid JSON (${e.message})`); }
check(manifest.kind === "audio", "kind is \"audio\"");
check(typeof manifest.name === "string" && manifest.name.length > 0, "name is set");
check(typeof manifest.entry === "string" && existsSync(join(root, manifest.entry)), `entry exists (${manifest.entry})`);
const b = manifest.build || {};
check(b.type === "static" && typeof b.dir === "string" && typeof b.out === "string", "build has type/dir/out");
check(typeof manifest.tuning === "string" && existsSync(join(root, manifest.tuning)), `tuning file exists (${manifest.tuning})`);
check(Array.isArray(manifest.cues) && manifest.cues.length === 4 &&
  manifest.cues.every((c) => c && typeof c.id === "string" && typeof c.label === "string" && typeof c.trigger === "string"),
  "cues is a list of four {id,label,trigger}");
check(Array.isArray(manifest.readiness) && manifest.readiness.length > 0 &&
  manifest.readiness.every((r) => typeof r === "string"), "readiness is a non-empty list of strings");

// (b) tuning, parsed exactly like the studio does
const tuningText = read(manifest.tuning || "src/tuning.js");
check(/^window\.ATELIER_TUNING\s*=\s*\{/m.test(tuningText), "tuning.js assigns window.ATELIER_TUNING");
check(tuningText.indexOf("{") > tuningText.indexOf("window.ATELIER_TUNING"), "no \"{\" in comments above the assignment");
let tuning = null;
try {
  tuning = JSON.parse(tuningText.slice(tuningText.indexOf("{"), tuningText.lastIndexOf("}") + 1));
  check(true, `tuning parses as JSON (${Object.keys(tuning).length} keys)`);
} catch (e) { check(false, `tuning parses as JSON (${e.message})`); }

// (c) index.html runs from file://
const html = read(manifest.entry || "src/index.html");
check(!/type\s*=\s*["']?module/i.test(html), "index.html has no type=\"module\"");
check(!/https?:\/\//i.test(html), "index.html has no http(s) references");
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
check(scripts.join(",") === "tuning.js,sketch.js", `script order is tuning, sketch (${scripts.join(", ")})`);
for (const s of scripts) check(existsSync(join(root, "src", s)), `script ${s} exists`);
check(/<html[^>]*\sdata-storage-key="[^"]+"/.test(html), "html carries data-storage-key");
check(/id="btn-mute"/.test(html), "index.html has the mute toggle");

// (d) cues and studio messages
const sketch = read("src/sketch.js");
check(!/https?:\/\//i.test(sketch.replace(/^\s*\/\/.*$/gm, "")), "sketch.js has no http(s) references");
check(!/\bfetch\s*\(|\bimport\s*\(|^\s*(import|export)\s/m.test(sketch), "sketch.js uses no fetch/import/export");
for (const c of manifest.cues || []) {
  check(new RegExp(String.raw`^\s*${c.id}:\s*\{`, "m").test(sketch), `sketch.js has cue ${c.id}`);
  check(html.includes(`data-cue="${c.id}"`), `index.html has a button for ${c.id}`);
}
for (const t of ["atelier:ready", "atelier:event", "atelier:tuning", "atelier:cue", "atelier:render"]) check(sketch.includes(`"${t}"`), `sketch.js handles ${t}`);
if (tuning) for (const k of Object.keys(tuning)) check(new RegExp(String.raw`\b${k}\s*:`).test(sketch), `sketch.js DEFAULTS knows ${k}`);

// (e) no audio files
const AUDIO = new Set([".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a", ".opus", ".aiff", ".webm"]);
const SKIP = new Set([".git", ".studio", "node_modules", "dist"]);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (SKIP.has(e.name)) return [];
  return e.isDirectory() ? walk(join(dir, e.name)) : [e.name];
});
const audioFiles = walk(root).filter((f) => AUDIO.has(extname(f).toLowerCase()));
check(audioFiles.length === 0, `no audio files (${audioFiles.join(", ") || "none"})`);

// (f) sketch.js with stand-ins for the browser
{
  const stub = () => ({ textContent: "", setAttribute() {}, addEventListener() {} });
  const window = {
    ATELIER_TUNING: tuning || {},
    addEventListener() {},
    performance: { now: () => 0 },
    localStorage: { getItem: () => null, setItem() {} },
    btoa: (s) => Buffer.from(s, "latin1").toString("base64"),
  };
  window.parent = window;
  const document = {
    documentElement: { dataset: {} },
    getElementById: stub,
    querySelectorAll: () => [],
  };
  vm.runInNewContext(sketch, { window, document, setTimeout });
  const S = window.Sketch;
  check(!!S, "sketch.js loads and sets window.Sketch");
  if (S) {
    const r = S.applyTuning({ tapVolume: 0.5, nope: 1, blipVolume: 2, tickDecayMs: 9999, swellPitch: "high" });
    check(r.applied.join() === "tapVolume", `tuning applies a good value (${r.applied.join(", ")})`);
    check(r.ignored.join() === "nope,blipVolume,tickDecayMs,swellPitch", `tuning ignores unknown, out of range and wrong type (${r.ignored.join(", ")})`);
    for (const c of manifest.cues || []) {
      const ms = S.cueLengthMs(c.id);
      check(ms > 0 && ms < 400, `${c.id} is under 400 ms as tuned (${ms} ms)`);
    }
    S.applyTuning({ tapDecayMs: 380, blipDecayMs: 380, tickDecayMs: 380, swellDecayMs: 200 });
    for (const c of manifest.cues || []) {
      const ms = S.cueLengthMs(c.id);
      check(ms < 400, `${c.id} is under 400 ms at its longest (${ms} ms)`);
    }
    const bytes = S.encodeWav([0, 1, -1, 2], 44100);
    const view = new DataView(bytes.buffer);
    const str = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
    check(str(0, 4) === "RIFF" && str(8, 4) === "WAVE" && str(12, 4) === "fmt " && str(36, 4) === "data", "WAV has its RIFF, WAVE, fmt and data markers");
    check(view.getUint32(4, true) === bytes.length - 8 && view.getUint32(40, true) === 8 && bytes.length === 52, "WAV sizes add up");
    check(view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint32(24, true) === 44100 && view.getUint16(34, true) === 16, "WAV is PCM, mono, 44100 Hz, 16-bit");
    check(view.getInt16(46, true) === 32767 && view.getInt16(48, true) === -32768 && view.getInt16(50, true) === 32767, "WAV samples are limited to full scale");
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
