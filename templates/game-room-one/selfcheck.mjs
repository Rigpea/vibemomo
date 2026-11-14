// Room One — selfcheck.mjs
// Headless sanity check (Node only, no browser). Run: node selfcheck.mjs
// (a) tuning.js parses the way the studio parses it: the text between the
//     first "{" and the last "}" must be valid JSON.
// (b) atelier.json has the required manifest fields.
// (c) index.html loads classic scripts only and references nothing remote.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

// (b) manifest
let manifest = {};
try { manifest = JSON.parse(read("atelier.json")); check(true, "atelier.json is valid JSON"); }
catch (e) { check(false, `atelier.json is valid JSON (${e.message})`); }
check(["game", "web-app", "audio"].includes(manifest.kind), `kind is a known kind (${manifest.kind})`);
check(manifest.kind === "game", "kind is \"game\"");
check(typeof manifest.name === "string" && manifest.name.length > 0, "name is set");
check(typeof manifest.entry === "string" && existsSync(join(root, manifest.entry)), `entry exists (${manifest.entry})`);
const b = manifest.build || {};
check(b.type === "static" && typeof b.dir === "string" && typeof b.out === "string", "build has type/dir/out");
check(typeof b.dir === "string" && existsSync(join(root, b.dir)), `build.dir exists (${b.dir})`);
check(typeof manifest.tuning === "string" && existsSync(join(root, manifest.tuning)), `tuning file exists (${manifest.tuning})`);
check(Array.isArray(manifest.cues) && manifest.cues.length > 0 &&
  manifest.cues.every((c) => c && typeof c.id === "string" && typeof c.label === "string" && typeof c.trigger === "string"),
  "cues is a non-empty list of {id,label,trigger}");
check(Array.isArray(manifest.readiness) && manifest.readiness.length > 0 &&
  manifest.readiness.every((r) => typeof r === "string"), "readiness is a non-empty list of strings");

// (a) tuning, parsed exactly like the studio does
const tuningText = read(manifest.tuning || "src/tuning.js");
check(/^window\.ATELIER_TUNING\s*=\s*\{/m.test(tuningText), "tuning.js assigns window.ATELIER_TUNING");
let tuning = null;
try {
  const body = tuningText.slice(tuningText.indexOf("{"), tuningText.lastIndexOf("}") + 1);
  tuning = JSON.parse(body);
  check(true, `tuning parses as JSON (${Object.keys(tuning).length} keys)`);
} catch (e) { check(false, `tuning parses as JSON (${e.message})`); }
check(tuningText.indexOf("{") > tuningText.indexOf("window.ATELIER_TUNING"), "no \"{\" in comments above the assignment");
if (tuning) {
  const required = ["accel", "decel", "maxSpeed", "jumpVelocity", "gravity", "fallGravityMultiplier",
    "jumpCutMultiplier", "coyoteTimeMs", "jumpBufferMs", "terminalVelocity", "squashStretch", "dustParticles"];
  for (const k of required) check(k in tuning, `tuning has ${k}`);
  // every tuning key must be known to game.js (so live updates are type-checked)
  const game = read("src/game.js");
  for (const k of Object.keys(tuning)) check(new RegExp(String.raw`\b${k}\s*:`).test(game), `game.js DEFAULTS knows ${k}`);
}

// (c) index.html runs from file://
const html = read(manifest.entry || "src/index.html");
check(!/type\s*=\s*["']?module/i.test(html), "index.html has no type=\"module\"");
check(!/https?:\/\//i.test(html), "index.html has no http(s) references");
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
check(scripts.join(",") === "tuning.js,audio.js,game.js", `script order is tuning, audio, game (${scripts.join(", ")})`);
for (const s of scripts) check(existsSync(join(root, "src", s)), `script ${s} exists`);
for (const f of ["src/game.js", "src/audio.js", "src/tuning.js", "src/style.css"]) {
  const text = read(f);
  check(!/https?:\/\//i.test(text.replace(/^\s*\/\/.*$/gm, "")), `${f} has no http(s) references`);
  if (f.endsWith(".js")) check(!/\bfetch\s*\(|\bimport\s*\(|^\s*(import|export)\s/m.test(text), `${f} uses no fetch/import/export`);
}

// (d) studio audio cues: game.js answers atelier:cue with an atelier:event "cue",
//     and every cue the manifest lists is a sound audio.js can play.
{
  const game = read("src/game.js");
  check(/msg\.type\s*!==\s*"atelier:cue"/.test(game), "game.js handles atelier:cue messages");
  check(/emit\("cue",\s*\{\s*id:\s*msg\.id,\s*played:\s*true\s*\}\)/.test(game) &&
    /emit\("cue",\s*\{\s*id:\s*msg\.id,\s*played:\s*false,\s*reason:/.test(game), "game.js acknowledges cues with played true/false");
  const audio = read("src/audio.js");
  for (const c of manifest.cues || []) check(new RegExp(String.raw`^\s*${c.id}:\s*\{`, "m").test(audio), `audio.js PARAMS has cue ${c.id}`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
