// The Inspiration view (docs/DESIGN.md section 10, docs/ARCHITECTURE.md section 22), driven in a real window: the tab
// and its key, the empty state, a note, a color and a refused link typed into the one field, an image by file pick, by
// drop and by paste, a refused file, the tag filter, Edit, a move by Alt+arrow and by drag, the eyedropper (a pick
// becomes a swatch beside its image), Remove after one question, and a reload that finds the board as it was.
// Offscreen. It adds and removes cards, so it runs only on a named project whose board is empty (a throwaway one) and
// refuses any other; with the word look it changes nothing and only measures and captures the board that is there
// (the laptop and the wide width). A link's preview needs the network: link=<host/path> (https is assumed) adds one and
// reports what came back.
// Run: node_modules/electron/dist/electron.exe scripts/ui-check/verify-inspiration.cjs <project name or id> [look] [link=<host/path>] [baseUrl]
// Writes .local/shot-live/inspiration-*.jpg and prints the facts as JSON.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(path.resolve(__dirname, '..', '..'), '.local', 'shot-live');
// Options are plain words (look, link=<host/path>) and the base address comes last. Both for Electron's sake, shown
// by a probe on 2026-11-13 (Electron 45 on Windows): it takes arguments starting with -- for its own switches, and it
// exits at once (code -1, no output) when any argument follows one that holds a URL, its guard against a protocol
// handler passing switches in.
const args = process.argv.slice(2);
const LOOK = args.includes('look');
const linkArg = args.find((a) => a.startsWith('link='))?.slice(5) || null; // without its scheme (link=linear.app/method): see above
const LINK = linkArg ? (/^https?:\/\//.test(linkArg) ? linkArg : `https://${linkArg}`) : null;
const plain = args.filter((a) => a !== 'look' && !a.startsWith('link='));
const projectName = plain[0] || '';
const BASE = plain[1] || process.env.ATELIER_LIVE || 'http://127.0.0.1:4747';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();
setTimeout(() => { console.log(JSON.stringify({ error: 'timed out' })); app.exit(2); }, 150000);

// A 96 x 64 PNG in two flat colours (left amber #d6a455, right charcoal #232221), made here so the eyedropper has a known answer.
function twoColourPng() {
  const zlib = require('node:zlib');
  const w = 96; const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = x < w / 2 ? [0xd6, 0xa4, 0x55] : [0x23, 0x22, 0x21]; raw.set(c, y * (w * 3 + 1) + 1 + x * 3); }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

app.whenReady().then(async () => {
  const facts = {};
  try {
    const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { backgroundThrottling: false } });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const shot = async (name) => { win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toJPEG(88)); };
    const key = async (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await sleep(350); };
    await win.loadURL(`${BASE}/#/workbench`);
    await sleep(2500);
    if (projectName) {
      facts.picked = await js(`(() => { const s = document.querySelector('#project-pick select'); const o = [...(s?.options || [])].find((x) => x.value === ${JSON.stringify(projectName)} || x.textContent.replace('● ', '') === ${JSON.stringify(projectName)}); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change')); return true; })()`);
      await sleep(2500);
    }
    // The tab beside Learning, and its number key.
    facts.tabs = await js(`[...document.querySelectorAll('#view-tabs a')].map((a) => a.textContent)`);
    await js(`document.getElementById('main').focus()`);
    await key('3');
    await sleep(1500);
    facts.viewByKey = await js(`location.hash + ' · ' + document.getElementById('app').dataset.view + ' · current tab ' + document.querySelector('#view-tabs a[aria-current="page"]')?.textContent`);
    const state = `(() => { const r = document.querySelector('.inspo'); if (!r) return null; const cards = [...r.querySelectorAll('.inspo-card')];
      return { head: r.querySelector('.inspo-count').textContent, add: r.querySelector('.inspo-add .btn.primary').textContent, primaries: r.querySelectorAll('.btn.primary').length,
        filter: r.querySelector('.inspo-filter').hidden ? null : [...r.querySelectorAll('.inspo-filter-tag')].map((b) => (b.getAttribute('aria-pressed') === 'true' ? '[' + b.textContent + ']' : b.textContent)),
        status: r.querySelector('.inspo-status').hidden ? '' : r.querySelector('.inspo-status').textContent, fill: r.querySelector('.inspo-fill')?.textContent || null,
        cards: cards.map((c) => c.className.match(/inspo-(image|link|color|note)/)[1] + ' ' + c.getAttribute('aria-label')), focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName }; })()`;
    const geometry = `(() => { const b = document.querySelector('.inspo-board'); const cards = [...b.querySelectorAll('.inspo-card')].map((c) => c.getBoundingClientRect());
      const cols = [...new Set(cards.map((r) => Math.round(r.left)))].sort((x, y) => x - y); let overlaps = 0;
      for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) { const p = cards[i], q = cards[j]; if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) overlaps++; }
      const gaps = []; for (const x of cols) { const col = cards.filter((r) => Math.round(r.left) === x).sort((p, q) => p.top - q.top); for (let i = 1; i < col.length; i++) gaps.push(Math.round(col[i].top - col[i - 1].bottom)); }
      const s = document.querySelector('.inspo-scroll');
      return { window: innerWidth + 'x' + innerHeight, columns: cols.length, cardWidth: Math.round(cards[0]?.width || 0), overlaps, gapsUnder: gaps.length ? [Math.min(...gaps), Math.max(...gaps)] : 'no column holds two cards', sideways: s.scrollWidth - s.clientWidth, headFits: document.querySelector('.inspo-head').scrollWidth <= document.querySelector('.inspo-head').clientWidth }; })()`;
    facts.start = await js(state);

    // The pictures in view, loaded (they load lazily) or 6 s gone: what a capture should wait for.
    const pictures = `new Promise((done) => { const t0 = Date.now(); const tick = () => { const seen = [...document.querySelectorAll('.inspo-img')].filter((i) => { const r = i.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
      if (seen.every((i) => i.complete && i.naturalWidth) || Date.now() - t0 > 6000) Promise.all(seen.map((i) => i.decode().catch(() => {}))).then(() => requestAnimationFrame(() => setTimeout(() => done(seen.map((i) => i.naturalWidth + 'x' + i.naturalHeight)), 400))); else setTimeout(tick, 150); }; tick(); })`;
    if (LOOK) {
      facts.picturesAtLaptop = await js(pictures);
      facts.laptop = await js(geometry);
      await shot('inspiration-look-1280.jpg');
      win.setSize(1920, 1080); await sleep(1200);
      facts.picturesAtWide = await js(pictures);
      facts.wide = await js(geometry);
      await shot('inspiration-look-1920.jpg');
      // DESIGN.md's checklist: 1000x700 too, and the light theme (a session toggle: nothing is stored).
      win.setSize(1000, 700); await sleep(1200);
      await js(pictures);
      facts.small = await js(geometry);
      await shot('inspiration-look-1000.jpg');
      win.setSize(1280, 720); await sleep(800);
      await js(`document.getElementById('theme-toggle').click()`); await sleep(600);
      facts.light = await js(`({ theme: document.documentElement.dataset.theme, card: getComputedStyle(document.querySelector('.inspo-card')).backgroundColor, ink: getComputedStyle(document.querySelector('.inspo-card')).color })`);
      await js(pictures);
      await shot('inspiration-look-light.jpg');
      console.log(JSON.stringify(facts, null, 1));
      return app.exit(0);
    }
    // The rest writes. Only an empty board is written to: a board that holds cards is someone's, and look is for those.
    if (!facts.picked || facts.start?.cards?.length) {
      facts.refused = facts.picked ? `The board of ${projectName} already holds ${facts.start.cards.length} cards, so nothing was added or removed: run this on an empty throwaway project, or with look.` : `No project ${projectName || '(none named)'} in the picker: name a throwaway project.`;
      console.log(JSON.stringify(facts, null, 1));
      return app.exit(1);
    }

    const type = async (text) => { await js(`(() => { const f = document.querySelector('.inspo-add .input'); f.focus(); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input')); })()`); return js(`document.querySelector('.inspo-add .btn.primary').textContent`); };
    const submit = async (ms = 1500) => { await js(`document.querySelector('.inspo-add').requestSubmit()`); await sleep(ms); };
    const toasts = `[...document.querySelectorAll('.toast')].map((t) => t.textContent)`;
    const clearToasts = `document.querySelectorAll('.toast').forEach((t) => t.remove())`;

    // The one field: a note, a color, and a link the server refuses with a sentence (back in the field).
    facts.labels = [await type(''), await type('Warm charcoal, one amber accent.'), await type('#D6A455'), await type('https://linear.app/method')];
    await type('Warm charcoal, one amber accent.'); await submit();
    await type('#D6A455'); await submit();
    await type('http://127.0.0.1:4747/api/state'); await submit();
    facts.refusedLink = { toast: (await js(toasts)).slice(-1)[0], backInField: await js(`document.querySelector('.inspo-add .input').value`) };
    await js(clearToasts); await type('');
    facts.afterTyping = await js(state);

    // An image three ways: the file pick, a drop on the view, the clipboard. Then a file that is no image.
    const png = twoColourPng().toString('base64');
    const fileFrom = (b64, name, mime) => `(() => { const bin = atob(${JSON.stringify(b64)}); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([u8], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} })); return dt; })()`;
    await js(`(() => { const inp = document.querySelector('.inspo-add input[type=file]'); inp.files = ${fileFrom(png, 'picked.png', 'image/png')}.files; inp.dispatchEvent(new Event('change')); })()`);
    await sleep(1500);
    facts.dropState = await js(`(() => { const r = document.querySelector('.inspo'); const dt = ${fileFrom(png, 'dropped.png', 'image/png')}; r.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const during = { dropping: r.classList.contains('dropping'), status: r.querySelector('.inspo-status').textContent }; r.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return { ...during, after: r.classList.contains('dropping') }; })()`);
    await sleep(1500);
    // A paste event carrying the file, as the clipboard hands a copied picture over (the real clipboard is left alone).
    facts.pasteTaken = await js(`(() => { document.getElementById('main').focus(); const e = new ClipboardEvent('paste', { clipboardData: ${fileFrom(png, 'image.png', 'image/png')}, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; })()`);
    await sleep(1800);
    // A pasted link or color is added at once; pasted words wait in the field.
    facts.pasteWords = await js(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'Numbers as muted counters'); document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); const f = document.querySelector('.inspo-add .input'); const out = { field: f.value, button: document.querySelector('.inspo-add .btn.primary').textContent, focused: document.activeElement === f }; f.value = ''; f.dispatchEvent(new Event('input')); return out; })()`);
    await js(`(() => { const r = document.querySelector('.inspo'); const dt = ${fileFrom(Buffer.from('MZ this is a program, whatever its name says').toString('base64'), 'photo.png', 'image/png')}; r.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
    await sleep(1200);
    facts.refusedFile = (await js(toasts)).slice(-1)[0];
    await js(clearToasts);
    facts.afterImages = await js(state);
    if (LINK) { await type(LINK); await submit(14000); facts.link = await js(`(() => { const c = document.querySelector('.inspo-card.inspo-link'); return c && { title: c.querySelector('.inspo-title').textContent, meta: c.querySelector('.inspo-site')?.textContent, image: !!c.querySelector('img') && c.querySelector('img').naturalWidth }; })()`); }

    // Edit the note: a default tag, an own tag and a why. The dialog's refusal stays in it.
    await js(`[...document.querySelectorAll('.inspo-card.inspo-note .inspo-actions button')].find((b) => b.title.startsWith('Edit')).click()`);
    await sleep(400);
    facts.editDialog = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return { title: d.querySelector('h2').textContent, labels: [...d.querySelectorAll('.field > label')].map((l) => l.textContent), tags: [...d.querySelectorAll('.inspo-tagbtn')].map((b) => b.textContent), focus: document.activeElement?.tagName }; })()`);
    await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); [...d.querySelectorAll('.inspo-tagbtn')].find((b) => b.textContent === 'mood').click(); const own = d.querySelector('#inspo-own-tag'); own.value = 'Warm'; [...d.querySelectorAll('.inspo-tagadd button')][0].click();
      const why = d.querySelector('input[name=why]'); why.value = 'calm, like a page'; [...d.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === 'Save').click(); })()`);
    await sleep(1200);
    facts.afterEdit = await js(`(() => { const c = document.querySelector('.inspo-card.inspo-note'); return { tags: c.querySelector('.inspo-tags')?.textContent, why: c.querySelector('.inspo-why')?.textContent, dialogs: document.querySelectorAll('dialog[open]').length, focusOnCard: document.activeElement === c }; })()`);
    await js(`[...document.querySelectorAll('.inspo-card.inspo-color .inspo-actions button')].find((b) => b.title.startsWith('Edit')).click()`);
    await sleep(400);
    await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); d.querySelector('input[name=hex]').value = 'amber'; [...d.querySelectorAll('.dialog-actions button')].find((b) => b.textContent === 'Save').click(); })()`);
    await sleep(900);
    facts.editRefusal = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d ? d.querySelector('.note.danger')?.textContent : 'the dialog closed'; })()`);
    await js(`document.querySelector('dialog.dialog[open] .dialog-head button')?.click()`);
    await sleep(300);

    // The filter by tag, and back to all.
    await js(`[...document.querySelectorAll('.inspo-filter-tag')].find((b) => b.textContent.startsWith('mood')).click()`);
    await sleep(400);
    facts.filtered = await js(state);
    await js(`[...document.querySelectorAll('.inspo-filter-tag')].find((b) => b.textContent.startsWith('All')).click()`);
    await sleep(400);

    // Reorder: Alt+Right on the focused first card, then a drag of the last card onto the first.
    const order = `[...document.querySelectorAll('.inspo-card')].map((c) => c.getAttribute('aria-label'))`;
    facts.orderBefore = await js(order);
    await js(`document.querySelector('.inspo-card').focus()`);
    await key('Right', ['alt']);
    await sleep(600);
    facts.orderAfterKey = { order: await js(order), live: await js(`document.querySelector('.inspo .sr-only').textContent`), focusKept: await js(`document.activeElement?.classList.contains('inspo-card') && document.activeElement.getAttribute('aria-label')`) };
    facts.drag = await js(`(() => { const cards = [...document.querySelectorAll('.inspo-card')]; const from = cards.at(-1), to = cards[0]; const dt = new DataTransfer(); const r = to.getBoundingClientRect();
      from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
      to.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 10 }));
      const mark = { dragging: from.classList.contains('dragging'), line: to.className.match(/drop-(before|after)/)?.[0] || null, lineBox: getComputedStyle(to, '::before').width };
      to.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 10 })); from.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true })); return mark; })()`);
    await sleep(900);
    facts.orderAfterDrag = await js(order);

    // The eyedropper on the first image: a click left of the middle, then Enter after moving right by keys.
    await js(`(() => { const c = document.querySelector('.inspo-card.inspo-image'); c.scrollIntoView({ block: 'center' }); [...c.querySelectorAll('.inspo-actions button')].find((b) => b.textContent === 'Pick color').click(); })()`);
    await sleep(500);
    facts.picking = await js(`(() => { const c = document.querySelector('.inspo-card.picking'); return c && { button: c.querySelector('.inspo-actions button').textContent, status: document.querySelector('.inspo-status').textContent, readout: c.querySelector('.inspo-pick-read').textContent, focusOnImage: document.activeElement === c.querySelector('.inspo-media') }; })()`);
    await js(`(() => { const m = document.querySelector('.inspo-card.picking .inspo-media'); const r = m.getBoundingClientRect(); const at = { clientX: r.left + r.width * 0.2, clientY: r.top + r.height * 0.5, bubbles: true, cancelable: true }; m.dispatchEvent(new PointerEvent('pointermove', at)); m.dispatchEvent(new MouseEvent('click', at)); })()`);
    await sleep(1500);
    facts.pickedByClick = await js(`(() => { const c = document.querySelector('.inspo-card.picking'); const next = c?.nextElementSibling; return { stillPicking: !!c, next: next?.getAttribute('aria-label'), readout: c?.querySelector('.inspo-pick-read')?.textContent }; })()`);
    await shot('inspiration-eyedropper.jpg');
    for (let i = 0; i < 4; i++) await key('Right', ['shift']);
    await key('Enter');
    await sleep(1500);
    facts.pickedByKey = await js(`document.querySelector('.inspo-card.picking')?.nextElementSibling?.getAttribute('aria-label')`);
    await key('Escape');
    facts.afterEsc = await js(`({ picking: !!document.querySelector('.inspo-card.picking'), status: document.querySelector('.inspo-status').hidden, focus: document.activeElement?.getAttribute('aria-label') })`);

    facts.laptop = await js(geometry);
    await shot('inspiration-1280.jpg');
    win.setSize(1920, 1080); await sleep(1200);
    facts.wide = await js(geometry);
    await shot('inspiration-1920.jpg');
    win.setSize(1280, 720); await sleep(800);

    // Remove asks once: Keep it leaves the card, Remove takes it and its file.
    const countNow = `document.querySelectorAll('.inspo-card').length`;
    const before = await js(countNow);
    await js(`document.querySelector('.inspo-card.inspo-image').focus()`);
    await key('Delete');
    facts.removeQuestion = await js(`(() => { const d = document.querySelector('dialog.dialog[open]'); return d && { title: d.querySelector('h2').textContent, words: d.querySelector('.dialog-body').textContent, buttons: [...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent) }; })()`);
    await js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => b.textContent === 'Keep it').click()`);
    await sleep(400);
    const kept = await js(countNow);
    await js(`document.querySelector('.inspo-card.inspo-image').focus()`);
    await key('Delete');
    await js(`[...document.querySelectorAll('dialog.dialog[open] .dialog-actions button')].find((b) => b.textContent === 'Remove').click()`);
    await sleep(1200);
    facts.removed = { before, afterKeepIt: kept, afterRemove: await js(countNow), toast: (await js(toasts)).slice(-1)[0], focus: await js(`document.activeElement?.getAttribute('aria-label')`) };

    // A reload finds the board as it was left.
    const left = await js(order);
    win.webContents.reloadIgnoringCache(); // a real reload: loading the same address again would only be a hash change
    await sleep(3500);
    facts.afterReload = { same: JSON.stringify(await js(order)) === JSON.stringify(left), state: await js(state) };
    facts.images = await js(`[...document.querySelectorAll('.inspo-img')].map((i) => i.complete && i.naturalWidth + 'x' + i.naturalHeight)`);
  } catch (err) { facts.error = err.message; }
  console.log(JSON.stringify(facts, null, 1));
  app.exit(0);
});
