// Appearance settings (t_8ijmo5ji11; docs/ARCHITECTURE.md section 24). Risks covered: the model's defaults drift from
// client/styles.css; an accent that cannot be read against the canvas is accepted, or the nearest shade offered does
// not pass itself; a patch stores something that is no option; a control whose token a fixed rule locks is changed
// through the route; a refusal writes something; the look does not survive a restart of the reader (the registry);
// the look lands in a project; the page keeps a token after its choice went back to the default.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CONTROLS, CONTROL_KEYS, CHOICE_KEYS, ALL_TOKENS, THEMES, CANVAS, INK, DEFAULT_ACCENT, ACCENT_PRESETS, AA_TEXT, AA_RING, normHex, contrast, luminance, mix, nearestPassing, ratioWords, accentCheck, accentPair, accentPatch, accentVars, cleanAppearance, checkAppearancePatch, patchSets, mergeAppearance, controlLocks, effectiveAppearance, lockSentence, cssVars, accentOf, optionOf, isCustom } from '../client/components/appearance-model.js';
import { applyAppearance, rememberAppearance, FIRST_FRAME_KEY } from '../client/components/appearance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fsp.readFile(path.join(ROOT, rel), 'utf8');
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// ---------- the model against the stylesheet ----------
test('the model holds what client/styles.css holds: the canvas, ink and accent per theme, and every default token', async () => {
  const css = await read('client/styles.css');
  const dark = css.slice(css.indexOf(':root, [data-theme="dark"] {'), css.indexOf('[data-theme="light"] {'));
  const light = css.slice(css.indexOf('[data-theme="light"] {'), css.indexOf('\n:root {'));
  const shared = css.slice(css.indexOf('\n:root {'), css.indexOf('@media (prefers-reduced-motion'));
  for (const [theme, block] of [['dark', dark], ['light', light]]) {
    assert.ok(block.includes(`--bg: ${CANVAS[theme]};`), `${theme} canvas`);
    assert.ok(block.includes(`--ink: ${INK[theme]};`), `${theme} ink`);
    assert.ok(block.includes(`--accent: ${DEFAULT_ACCENT[theme]};`), `${theme} accent`);
    for (const token of CONTROLS.accent.tokens) assert.ok(block.includes(`${token}: `), `${token} is a ${theme} token`);
  }
  for (const key of CHOICE_KEYS) {
    const c = CONTROLS[key];
    assert.ok(Object.hasOwn(c.options, c.def), `${key} has its default among its options`);
    for (const [token, value] of Object.entries(c.options[c.def].tokens)) assert.ok(shared.includes(`${token}: ${value};`), `${token} is ${value} in client/styles.css`);
    for (const o of Object.values(c.options)) assert.deepEqual(Object.keys(o.tokens), c.tokens, `every option of ${key} writes the same tokens`);
  }
  assert.equal(new Set(ALL_TOKENS).size, ALL_TOKENS.length);
  assert.deepEqual(CONTROL_KEYS, ['accent', 'density', 'textSize', 'radius', 'motion']);
  // Density leaves the spacing scale alone (the 8 px grid is a fixed rule in words), and motion stays within 160 ms.
  assert.equal(ALL_TOKENS.filter((t) => /^--s\d$/.test(t)).length, 0);
  for (const o of Object.values(CONTROLS.motion.options)) assert.ok(parseFloat(o.tokens['--t']) <= 160);
  // The switch has the stylesheet rule the system's wish has.
  assert.match(css, /\[data-motion="reduced"\] \*, \[data-motion="reduced"\] \*::before, \[data-motion="reduced"\] \*::after \{ animation: none !important; transition: none !important; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ :root \{ --t: 0ms; \}/, 'prefers-reduced-motion is still honoured');
});

// ---------- contrast ----------
test('contrast: the WCAG ratio; the built-in accents and every preset pass on their canvas, with a light shade that passes too', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
  assert.equal(normHex(' #ABC '), '#aabbcc');
  assert.equal(normHex('d6a455'), '#d6a455');
  for (const bad of ['#12', '#12345', 'amber', '', null, 12, '#d6a45580', 'rgb(1,2,3)']) assert.equal(normHex(bad), null, String(bad));
  assert.ok(contrast(DEFAULT_ACCENT.dark, CANVAS.dark) >= AA_TEXT, 'the built-in dark accent passes');
  // The built-in light accent is the stylesheet's and is not asserted here: it is 3.7:1, which the section says in words.
  assert.equal(accentPatch('#d6a455', 'dark'), null, 'the studio\'s own accent is nothing stored, in both themes');
  assert.deepEqual(Object.keys(accentPatch('#79b3dc', 'dark')), ['dark', 'light']);
  assert.equal(ACCENT_PRESETS[0].hex, DEFAULT_ACCENT.dark, 'the first preset is the studio\'s own');
  assert.equal(new Set(ACCENT_PRESETS.map((p) => p.hex)).size, ACCENT_PRESETS.length);
  for (const p of ACCENT_PRESETS) {
    assert.ok(accentCheck(p.hex, 'dark').ok, `${p.name} passes on the dark canvas`);
    const pair = accentPair(p.hex, 'dark');
    assert.equal(pair.dark, p.hex);
    assert.ok(accentCheck(pair.light, 'light').ok, `${p.name}'s light shade ${pair.light} passes on the light canvas`);
  }
  assert.equal(ratioWords(4.46), '4.4:1', 'a ratio is cut, never rounded up to a pass');
  assert.equal(ratioWords(4.5), '4.5:1');
  assert.equal(ratioWords(12), '12.0:1');
});

test('nearestPassing: a colour that passes stays; one that fails moves only in lightness until its own hex passes, on both canvases', () => {
  assert.equal(nearestPassing('#d6a455', CANVAS.dark), '#d6a455');
  const hues = ['#5a3d9a', '#7a1f1f', '#1f4d7a', '#2e5e2e', '#232221', '#000000', '#808080', '#ff0000', '#0000ff', '#3a3834', '#ece8e1', '#ffffff', '#f3f1ec', '#00ff00', '#ffff00'];
  for (const theme of THEMES) {
    for (const hex of hues) {
      const out = nearestPassing(hex, CANVAS[theme]);
      assert.match(out, /^#[0-9a-f]{6}$/);
      const r = contrast(out, CANVAS[theme]);
      assert.ok(r >= AA_TEXT, `${hex} on ${theme}: ${out} is ${r}`);
      if (contrast(hex, CANVAS[theme]) < AA_TEXT) assert.ok(r < AA_TEXT + 0.35, `${hex} on ${theme}: ${out} goes no further than it must (${r})`);
    }
  }
  // The hue is kept: a failing blue comes back blue, a failing red red.
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(nearestPassing('#1f4d7a', CANVAS.dark).slice(i, i + 2), 16));
  assert.ok(b > g && g > r);
  // The focus ring's colour is never closer to the canvas than the accent.
  for (const theme of THEMES) for (const p of ACCENT_PRESETS) { const hex = accentPair(p.hex, 'dark')[theme]; assert.ok(contrast(accentVars(hex, theme)['--focus'], CANVAS[theme]) >= contrast(hex, CANVAS[theme]) - 0.05); }
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

test('accentCheck: a passing colour with its ratio; a failing one refused in a sentence that names the ratio, the need it misses and the nearest shade', () => {
  const ok = accentCheck('#D6A455', 'dark');
  assert.deepEqual([ok.ok, ok.hex], [true, '#d6a455']);
  assert.match(ok.sentence, /^#d6a455 is \d+\.\d:1 against the dark canvas\.$/);
  const dim = accentCheck('#5a3d9a', 'dark'); // under 3:1
  assert.deepEqual([dim.ok, dim.reason], [false, 'low_contrast']);
  assert.ok(dim.ratio < AA_RING);
  assert.match(dim.sentence, /^#5a3d9a is \d\.\d:1 against the dark canvas \(#232221\): too close for the focus ring \(3:1\) and for text in the accent \(4\.5:1\)\. The nearest shade that passes is #[0-9a-f]{6}\.$/);
  assert.ok(dim.sentence.endsWith(`${dim.nearest}.`));
  assert.ok(accentCheck(dim.nearest, 'dark').ok, 'the shade offered passes itself');
  const mid = ['#8a6d3b', '#7d6a4a', '#806090', '#6f7f6f'].map((h) => accentCheck(h, 'dark')).find((c) => !c.ok && c.ratio >= AA_RING);
  assert.ok(mid, 'a colour between 3:1 and 4.5:1');
  assert.match(mid.sentence, /enough for the focus ring \(3:1\) but not for text in the accent \(4\.5:1\)/);
  // The same colour is judged per theme: the dark theme's amber fails on the light canvas.
  const onLight = accentCheck('#d6a455', 'light');
  assert.equal(onLight.ok, false);
  assert.match(onLight.sentence, /against the light canvas \(#f3f1ec\)/);
  const none = accentCheck('amber', 'dark');
  assert.deepEqual([none.ok, none.reason], [false, 'not_hex']);
  assert.equal(none.sentence, 'An accent is a hex color such as #d6a455; "amber" is not one.');
});

// ---------- the stored choices ----------
test('a patch: only the five choices, only their options, an accent only as a hex that passes per theme; a default is stored as nothing', () => {
  assert.deepEqual(checkAppearancePatch(null), { ok: true, reset: true, patch: {} });
  const good = checkAppearancePatch({ accent: { dark: '#79B3DC', light: '#1f5f8a' }, density: 'compact', textSize: 'large', radius: 'round', motion: 'reduced' });
  assert.deepEqual(good, { ok: true, reset: false, patch: { accent: { dark: '#79b3dc', light: '#1f5f8a' }, density: 'compact', textSize: 'large', radius: 'round', motion: 'reduced' } });
  assert.deepEqual(checkAppearancePatch({ density: 'comfortable', radius: null, accent: { dark: '#d6a455' } }).patch, { density: null, radius: null, accent: { dark: null } }, 'a default, in words or as null, clears the choice');
  assert.deepEqual(checkAppearancePatch({ accent: null }).patch, { accent: null });
  const refused = [
    [[], /appearance must be an object holding any of accent, density, textSize, radius, motion, or null to reset them all/],
    ['compact', /appearance must be an object/],
    [{ theme: 'light' }, /appearance\.theme is not a choice \(accent, density, textSize, radius, motion\)/],
    [{ density: 'cosy' }, /appearance\.density must be one of comfortable, compact, or null for the default \(comfortable\); "cosy" is none of them/],
    [{ textSize: 15 }, /appearance\.textSize must be one of small, default, large, larger/],
    [{ radius: 'toString' }, /appearance\.radius must be one of sharp, soft, round/],
    [{ motion: true }, /appearance\.motion must be one of normal, reduced/],
    [{ accent: '#79b3dc' }, /appearance\.accent is \{ dark, light \}/],
    [{ accent: { sepia: '#79b3dc' } }, /appearance\.accent\.sepia is not a theme \(dark, light\)/],
    [{ accent: { dark: 'blue' } }, /An accent is a hex color such as #d6a455; "blue" is not one\./],
    [{ accent: { dark: 'red; background: url(x)' } }, /An accent is a hex color/],
  ];
  for (const [body, words] of refused) {
    const out = checkAppearancePatch(body);
    assert.deepEqual([out.ok, out.code], [false, 'invalid_input'], JSON.stringify(body));
    assert.match(out.message, words);
  }
  const low = checkAppearancePatch({ density: 'compact', accent: { dark: '#232221' } });
  assert.deepEqual([low.ok, low.code, low.key], [false, 'low_contrast', 'accent']);
  assert.match(low.message, /The nearest shade that passes is #[0-9a-f]{6}\.$/);
  assert.equal(checkAppearancePatch({ accent: { light: '#d6a455' } }).code, 'low_contrast', 'each theme against its own canvas');

  assert.deepEqual(patchSets(good.patch), CONTROL_KEYS);
  assert.deepEqual(patchSets({ density: null, accent: { dark: null }, radius: 'sharp' }), ['radius'], 'going back to a default sets nothing');
  assert.deepEqual(patchSets({ accent: null }), []);

  let stored = mergeAppearance({}, good);
  assert.deepEqual(stored, good.patch);
  stored = mergeAppearance(stored, checkAppearancePatch({ density: 'comfortable', accent: { light: null } }));
  assert.deepEqual(stored, { accent: { dark: '#79b3dc' }, textSize: 'large', radius: 'round', motion: 'reduced' }, 'only what was sent changes');
  stored = mergeAppearance(stored, checkAppearancePatch({ accent: { dark: null } }));
  assert.equal(stored.accent, undefined, 'an accent with no theme left is gone');
  assert.deepEqual(mergeAppearance(stored, checkAppearancePatch(null)), {});
});

test('what is stored is read back only as far as it is valid: a hand-edited registry cannot put an unknown value or a dim accent on the page', () => {
  assert.deepEqual(cleanAppearance({ accent: { dark: '#232221', light: '#1F5F8A', sepia: '#fff' }, density: 'cosy', textSize: 'large', radius: 'soft', motion: 1, extra: true }), { accent: { light: '#1f5f8a' }, textSize: 'large' });
  for (const junk of [null, undefined, 'compact', [], 7, { accent: '#79b3dc' }, { accent: [] }]) assert.deepEqual(cleanAppearance(junk), {});
  assert.deepEqual(cleanAppearance({ accent: { dark: '#d6a455' }, density: 'comfortable' }), {}, 'the defaults are nothing stored');
  assert.equal(isCustom({ radius: 'soft' }), false);
  assert.equal(isCustom({ radius: 'sharp' }), true);
  assert.equal(accentOf({}, 'light'), '#a86f17');
  assert.equal(accentOf({ accent: { dark: '#79b3dc' } }, 'dark'), '#79b3dc');
  assert.equal(optionOf({ textSize: 'huge' }, 'textSize'), 'default');
});

// ---------- fixed rules ----------
test('a locked token takes its control away: which control, the rule named in a sentence, and the choice out of what is in effect', () => {
  const locked = [
    { name: '--bg', value: '#232221', ruleId: 'rule_bg01', text: 'The canvas is warm charcoal' },
    { name: '--accent', value: '#d6a455', ruleId: 'rule_ac01', text: 'Amber is the one accent: the primary action, links, focus and the selected item.' },
    { name: '--r2', value: '8px', ruleId: 'rule_r201', text: 'Cards keep an 8 px corner' },
    { name: '--t', value: '140ms', ruleId: 'rule_t001', text: 'Motion at 140 ms' },
  ];
  const locks = controlLocks(locked);
  assert.deepEqual(Object.keys(locks), ['accent', 'radius', 'motion'], 'a token no control writes (--bg) locks no control');
  assert.deepEqual(locks.accent, { token: '--accent', value: '#d6a455', ruleId: 'rule_ac01', text: locked[1].text });
  assert.equal(controlLocks([{ name: '--focus', value: '#e6bd73', text: 'x' }]).accent.token, '--focus', 'any token the control writes');
  assert.equal(controlLocks([{ name: '--fs-meta', value: '12.5px', text: 'x' }]).textSize.token, '--fs-meta');
  assert.equal(controlLocks([{ name: '--row-h', value: '40px', text: 'x' }]).density.token, '--row-h');
  assert.deepEqual(controlLocks([]), {});
  assert.deepEqual(controlLocks(null), {});
  const stored = { accent: { dark: '#79b3dc' }, density: 'compact', radius: 'round', motion: 'reduced', textSize: 'large' };
  assert.deepEqual(effectiveAppearance(stored, locks), { density: 'compact', textSize: 'large' }, 'the locked choices are not in effect, though stored');
  assert.deepEqual(effectiveAppearance(stored, {}), stored);
  assert.equal(lockSentence('accent', locks.accent, 'Atelier (studio)'), 'Accent is fixed by Atelier (studio)\'s rule "Amber is the one accent: the primary action, links, focus and the selected item.", which locks --accent at #d6a455.');
  assert.equal(lockSentence('radius', locks.radius), 'Corners is fixed by the rule "Cards keep an 8 px corner", which locks --r2 at 8px.');
  assert.ok(lockSentence('motion', { token: '--t', value: '140ms', text: 'w '.repeat(200) }).length < 190, 'a long rule is cut');
});

// ---------- the page ----------
function fakeRoot(start = {}) {
  const props = new Map(Object.entries(start));
  return { props, dataset: {}, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
}

test('the page: a default writes nothing, a choice writes its tokens, and a choice taken back takes its tokens off again', () => {
  assert.deepEqual(cssVars({}, 'dark'), {});
  assert.deepEqual(cssVars({ density: 'comfortable', radius: 'soft', accent: { dark: '#d6a455' } }, 'dark'), {});
  assert.deepEqual(cssVars({ density: 'compact' }, 'dark'), CONTROLS.density.options.compact.tokens);
  const blue = cssVars({ accent: { dark: '#79b3dc', light: '#1f5f8a' }, radius: 'round' }, 'dark');
  assert.deepEqual(Object.keys(blue), ['--accent', '--accent-soft', '--accent-ink', '--focus', '--r1', '--r2', '--r3']);
  assert.equal(blue['--accent'], '#79b3dc');
  assert.equal(blue['--accent-soft'], 'rgba(121, 179, 220, 0.16)');
  assert.ok(contrast(blue['--accent-ink'], '#79b3dc') >= AA_TEXT, 'the words on a filled button can be read');
  const onLight = cssVars({ accent: { dark: '#79b3dc', light: '#1f5f8a' } }, 'light');
  assert.equal(onLight['--accent'], '#1f5f8a', 'each theme shows its own shade');
  assert.equal(onLight['--accent-ink'], '#ffffff');
  assert.deepEqual(cssVars({ accent: { dark: '#79b3dc' } }, 'light'), {}, 'a theme with no accent of its own keeps the stylesheet\'s');
  for (const p of ACCENT_PRESETS) for (const theme of THEMES) { const hex = accentPair(p.hex, 'dark')[theme]; assert.ok(contrast(accentVars(hex, theme)['--accent-ink'], hex) >= AA_TEXT, `${p.name} ${theme}: button words`); }

  const root = fakeRoot({ '--collab-w': '360px' });
  applyAppearance({ density: 'compact', motion: 'reduced', accent: { dark: '#79b3dc' } }, 'dark', root);
  assert.equal(root.props.get('--ctl-h'), '28px');
  assert.equal(root.props.get('--t'), '0ms');
  assert.equal(root.props.get('--accent'), '#79b3dc');
  assert.equal(root.dataset.motion, 'reduced');
  applyAppearance({ radius: 'sharp' }, 'dark', root);
  assert.deepEqual([...root.props.keys()].sort(), ['--collab-w', '--r1', '--r2', '--r3'], 'what is no longer chosen is taken off; a property that is not the look\'s stays');
  assert.equal('motion' in root.dataset, false);
  applyAppearance({}, 'dark', root);
  assert.deepEqual([...root.props.keys()], ['--collab-w']);
});

test('the first-frame copy: both themes\' tokens under one key, dropped when nothing is chosen, and index.html reads that key before the first paint', async () => {
  const store = new Map();
  const storage = { setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  rememberAppearance({ accent: { dark: '#79b3dc', light: '#1f5f8a' }, motion: 'reduced' }, storage);
  const copy = JSON.parse(store.get(FIRST_FRAME_KEY));
  assert.deepEqual([copy.motion, copy.dark['--accent'], copy.light['--accent'], copy.dark['--t']], [true, '#79b3dc', '#1f5f8a', '0ms']);
  rememberAppearance({}, storage);
  assert.equal(store.has(FIRST_FRAME_KEY), false);
  rememberAppearance({ radius: 'round' }, { setItem() { throw new Error('full'); }, removeItem() {} }); // storage that refuses costs nothing
  const html = await read('client/index.html');
  assert.ok(html.includes(`localStorage.getItem('${FIRST_FRAME_KEY}')`));
  assert.ok(html.indexOf(`localStorage.getItem('${FIRST_FRAME_KEY}')`) < html.indexOf('<body>'), 'before the body is drawn');
  assert.match(html, /if \(\/\^--\[a-z0-9-\]\+\$\/\.test\(k\)\) r\.style\.setProperty\(k, String\(v\[k\]\)\)/, 'only custom properties are set from the copy');
});

// ---------- through a real server process ----------
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-appearance-'));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let child = null;
const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const registry = async () => JSON.parse(await fsp.readFile(path.join(tmp, 'data', 'registry.json'), 'utf8'));

before(async () => {
  await fsp.mkdir(path.join(tmp, 'projects'), { recursive: true });
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, ATELIER_PORT: String(PORT), ATELIER_DATA_DIR: path.join(tmp, 'data'), ATELIER_PROJECTS_DIR: path.join(tmp, 'projects'), ATELIER_PID_FILE: path.join(tmp, 'server.pid'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), STUDIO_ANTHROPIC_API_KEY: '', ATELIER_CLAUDE_BIN: path.join(ROOT, 'tests', 'fixtures', 'fake-claude.mjs') },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}: ${stderr.slice(-800)}`);
    if (i > 150) throw new Error(`the server did not answer within 30 s: ${stderr.slice(-800)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
});
after(async () => {
  child?.kill();
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

test('the route: nothing stored at first; a patch is checked, stored per person in the registry and read back; a refusal writes nothing', async () => {
  const first = (await api('GET', '/api/state')).data.appearance;
  assert.deepEqual(first, { stored: {}, effective: {}, locks: {}, rulesProject: null, rulesUnread: false });
  assert.deepEqual((await api('GET', '/api/settings/appearance')).data, first);

  const saved = await api('PATCH', '/api/settings', { appearance: { accent: { dark: '#79B3DC', light: '#1f5f8a' }, density: 'compact', textSize: 'large', radius: 'round', motion: 'reduced' } });
  assert.equal(saved.status, 200);
  const want = { accent: { dark: '#79b3dc', light: '#1f5f8a' }, density: 'compact', textSize: 'large', radius: 'round', motion: 'reduced' };
  assert.deepEqual(saved.data.appearance, want, 'the settings answer holds what was kept');
  assert.deepEqual((await registry()).settings.appearance, want, 'in ~/.atelier/registry.json, the person\'s own file');
  const facts = (await api('GET', '/api/state')).data.appearance;
  assert.deepEqual([facts.stored, facts.effective], [want, want], 'a fresh read (a reload) finds it');

  for (const [body, code, words] of [
    [{ appearance: { density: 'cosy' } }, 'invalid_input', /appearance\.density must be one of comfortable, compact/],
    [{ appearance: { spacing: 'tight' } }, 'invalid_input', /appearance\.spacing is not a choice/],
    [{ appearance: 'compact' }, 'invalid_input', /appearance must be an object/],
    [{ appearance: { accent: { dark: '#3a3834' } } }, 'low_contrast', /#3a3834 is 1\.\d:1 against the dark canvas \(#232221\): too close for the focus ring \(3:1\) and for text in the accent \(4\.5:1\)\. The nearest shade that passes is #[0-9a-f]{6}\./],
    [{ appearance: { radius: 'sharp', accent: { light: '#d6a455' } } }, 'low_contrast', /against the light canvas/],
  ]) {
    const out = await api('PATCH', '/api/settings', body);
    assert.deepEqual([out.status, out.data.error.code], [400, code], JSON.stringify(body));
    assert.match(out.data.error.message, words);
    assert.deepEqual((await registry()).settings.appearance, want, 'a refusal writes nothing, not even the valid half of the patch');
  }
  // The nearest shade the sentence offers is itself accepted.
  const offered = (await api('PATCH', '/api/settings', { appearance: { accent: { dark: '#3a3834' } } })).data.error.message.match(/passes is (#[0-9a-f]{6})\./)[1];
  assert.equal((await api('PATCH', '/api/settings', { appearance: { accent: { dark: offered } } })).status, 200);
  assert.equal((await registry()).settings.appearance.accent.dark, offered);

  // Another settings change leaves the look alone; a default takes its key out; null resets.
  await api('PATCH', '/api/settings', { ui: { layout: { theme: 'light' } } });
  assert.equal((await registry()).settings.appearance.density, 'compact');
  const partly = await api('PATCH', '/api/settings', { appearance: { density: 'comfortable', motion: null } });
  assert.deepEqual(Object.keys(partly.data.appearance).sort(), ['accent', 'radius', 'textSize']);
  const reset = await api('PATCH', '/api/settings', { appearance: null });
  assert.equal(reset.status, 200);
  assert.equal('appearance' in (await registry()).settings, false, 'nothing chosen is nothing stored');
  assert.deepEqual((await api('GET', '/api/settings/appearance')).data.stored, {});
});

test('the fixed rules win: a control whose token the studio project locks is refused by the route with the rule named, and is out of what is in effect', async () => {
  const other = (await api('POST', '/api/projects', { name: 'A Product', kind: 'web-app', template: 'web-app-notes' })).data.project;
  await api('POST', `/api/projects/${other.id}/rules`, { text: 'This product keeps its own corners', kind: 'layout', token: { name: '--r1', value: '6px' } });
  await api('PATCH', '/api/settings', { appearance: { radius: 'round', accent: { dark: '#79b3dc' }, density: 'compact' } });
  assert.deepEqual((await api('GET', '/api/settings/appearance')).data.locks, {}, 'a product\'s rules are about the product, not the studio\'s look');

  const studio = (await api('POST', '/api/projects', { name: 'Studio Itself', kind: 'studio' })).data.project;
  assert.equal(studio.kind, 'studio');
  const rule = (await api('POST', `/api/projects/${studio.id}/rules`, { text: 'Amber is the one accent', kind: 'color', token: { name: '--accent', value: '#d6a455' } })).data;
  let facts = (await api('GET', '/api/state')).data.appearance;
  assert.deepEqual(facts.rulesProject, { id: studio.id, name: 'Studio Itself' });
  assert.deepEqual(facts.locks, { accent: { token: '--accent', value: '#d6a455', ruleId: rule.id, text: 'Amber is the one accent' } });
  assert.deepEqual(facts.stored.accent, { dark: '#79b3dc' }, 'the choice made before the rule is still stored');
  assert.deepEqual(facts.effective, { density: 'compact', radius: 'round' }, 'but it is not in effect');

  const refused = await api('PATCH', '/api/settings', { appearance: { textSize: 'large', accent: { dark: '#5fbcab' } } });
  assert.deepEqual([refused.status, refused.data.error.code], [409, 'token_locked']);
  assert.equal(refused.data.error.message, 'Accent is fixed by Studio Itself\'s rule "Amber is the one accent", which locks --accent at #d6a455. Change or remove that rule first (Inspiration, Fixed rules).');
  assert.equal((await registry()).settings.appearance.textSize, undefined, 'nothing of the refused patch was written');
  assert.equal((await registry()).settings.appearance.accent.dark, '#79b3dc');
  // The other controls stay free, and a locked control can still go back to its default.
  assert.equal((await api('PATCH', '/api/settings', { appearance: { textSize: 'large' } })).status, 200);
  assert.equal((await api('PATCH', '/api/settings', { appearance: { accent: null } })).status, 200);
  assert.equal((await registry()).settings.appearance.accent, undefined);

  // A second lock, on one token of a scale: the whole control is taken.
  await api('POST', `/api/projects/${studio.id}/rules`, { text: 'Cards keep an 8 px corner', kind: 'layout', token: { name: '--r2', value: '8px' } });
  const corners = await api('PATCH', '/api/settings', { appearance: { radius: 'sharp' } });
  assert.deepEqual([corners.status, corners.data.error.code], [409, 'token_locked']);
  assert.match(corners.data.error.message, /^Corners is fixed by Studio Itself's rule "Cards keep an 8 px corner", which locks --r2 at 8px\./);
  facts = (await api('GET', '/api/settings/appearance')).data;
  assert.deepEqual([Object.keys(facts.locks), facts.effective], [['accent', 'radius'], { density: 'compact', textSize: 'large' }]);

  // Taking the lock off frees the control, and the stored choice is in effect again.
  await api('PATCH', `/api/projects/${studio.id}/rules/${rule.id}`, { token: null });
  assert.equal((await api('PATCH', '/api/settings', { appearance: { accent: { dark: '#5fbcab' } } })).status, 200);
  assert.deepEqual((await api('GET', '/api/settings/appearance')).data.effective.accent, { dark: '#5fbcab' });

  // Per person, never in a project: no project folder holds the look.
  for (const p of [other, studio]) {
    const record = JSON.parse(await fsp.readFile(path.join(tmp, 'projects', p.slug, '.studio', 'project.json'), 'utf8'));
    assert.equal(JSON.stringify(record).includes('appearance'), false, `${p.name}'s records do not hold the look`);
  }
  await api('PATCH', '/api/settings', { appearance: null });
});

// ---------- wiring and the design rules, as source checks ----------
test('the Settings section is wired: applied at boot and with the theme, saved through the settings route, read again when a rule changes', async () => {
  const app = await read('client/app.js');
  const settings = await read('client/views/settings.js');
  const panel = await read('client/components/appearance-panel.js');
  const server = await read('server/index.mjs');
  assert.match(app, /appearance: s\.appearance \|\| null,/);
  assert.match(app, /applyLook\(\); \/\/ the accent is a shade per theme, so the look follows the theme/);
  assert.match(app, /await api\.patchSettings\(\{ appearance: patch \}\);\n\s+await loadStudio\(\);/, 'what shows after a save is what the server kept');
  assert.match(app, /es\.addEventListener\('rules\.changed', scheduleStudio\);/, 'a new lock reaches an open window');
  assert.match(settings, /v\.look = mountAppearance\(lookBody, app\);/);
  assert.match(settings, /export function unmount\(\) \{ v\?\.look\?\.unmount\(\);/);
  assert.match(settings, /look: sec\('Appearance', 'appearance'\), layout: sec\('Layout', 'layout-settings'\)/, 'the layout preferences keep their own section');
  // The server takes appearance out of the body before the spread that stores the rest unchecked.
  assert.match(server, /\(\{ workerModel, appearance, \.\.\.body \} = body\);/);
  assert.match(server, /if \(appearance !== undefined\) await saveAppearance\(appearance\);/);
  assert.match(server, /route\('GET', '\/api\/settings\/appearance', async \(\) => appearanceFacts\(\)\);/);
  // The panel: every control, a locked one disabled with its rule, an older server said in words, Reset with Undo.
  for (const piece of ['type: \'color\'', 'ACCENT_PRESETS.map', 'boardColors(out.cards)', 'CHOICE_KEYS.map', '\'Reset to defaults\'', 'lockSentence(key, lock, project?.name', 'prefers-reduced-motion: reduce', 'action: { label: \'Undo\'']) assert.ok(panel.includes(piece), piece);
  // The picker's preview does not wait for an animation frame: a window that does not paint may never get one
  // (seen in the driver, where the preview once did not show).
  assert.doesNotMatch(panel, /requestAnimationFrame/);
  assert.match(panel, /node\.style\.setProperty\('--sw', color\);/, 'a swatch\'s colour is set as a custom property by name');
  assert.match(panel, /b\.disabled = frozen\(key\);/);
  assert.match(panel, /pick\.disabled = off; hex\.disabled = off;/);
  assert.match(panel, /const frozen = \(key\) => !facts\(\) \|\| !!facts\(\)\.rulesUnread \|\| !!lockOf\(key\);/);
  assert.ok(panel.split('\n').length <= 500 && settings.split('\n').length <= 500);
  assert.doesNotMatch(panel, /stateChip|chip\(|variant: 'primary'/, 'no chip for a choice, and no second primary button on the page');
});

test('the section keeps the design rules: tokens only, motion on the token, hover nowhere a finger is, sizes from the scales', async () => {
  const css = await read('client/views.css');
  const own = css.slice(css.indexOf('/* Settings, Appearance'), css.indexOf('/* ---------- Claude Code section'));
  assert.ok(own.length > 900);
  assert.equal(own.match(/#[0-9a-f]{3,8}\b/gi), null, 'colours come from the tokens (a swatch\'s colour is data, in --sw)');
  assert.deepEqual([...own.matchAll(/transition: ([^;]+);/g)].map((m) => m[1]), ['transform var(--t) ease-out']);
  assert.doesNotMatch(own, /@keyframes|animation:|transition: all/);
  assert.doesNotMatch(own.replace(/@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\n\}/g, ''), /:hover/, 'hover styles only where a pointer can hover');
  assert.match(own, /\.look-swatch\[aria-pressed="false"\]:hover:not\(:disabled\)/, 'a swatch answers the pointer');
  assert.match(own, /\.look-swatch \{[^}]*width: 24px; height: 24px;/, 'a swatch is a 24 px target');
  // The controls every view shares take their heights, sizes and corners from the tokens the choices write.
  const base = await read('client/styles.css');
  for (const rule of ['.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--ctl-h);', '.btn.sm { height: var(--ctl-h-sm);', '.input { width: 100%; min-height: var(--ctl-h); padding: var(--ctl-pad) 10px;', 'min-height: var(--row-h); padding: var(--cell-y) 12px;', '.dialog { border: 1px solid var(--line-strong); border-radius: var(--r3);', '.seg > button:disabled { opacity: 0.5; cursor: not-allowed; }']) assert.ok(base.includes(rule), rule);
  for (const file of ['client/styles.css', 'client/views.css', 'client/inspiration.css', 'client/learning.css', 'client/visualizer.css']) {
    const text = (await read(file)).replace(/^\.brand \.mark \{.*$/m, ''); // the mark is a drawing of a letter, not text
    assert.equal(text.match(/font-size: (13|12\.5|12|11)px/g), null, `${file}: the small sizes are tokens, so the text size steps reach them`);
  }
});
