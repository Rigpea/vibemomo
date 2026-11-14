// One card of the inspiration board (views/inspiration.js; docs/DESIGN.md section 10): an image, a link with its
// fetched title and preview image, a color swatch or a note, each with its why and its tags. An image is shown only
// through an <img>, where a browser runs no script of an SVG. The eyedropper reads a pixel of the image from a canvas
// of the same picture: pointer or arrow keys choose the point, a click or Enter picks it, Esc stops.
import { el, button, toast, copyText } from './ui.js';
import { cardName, imageAlt, linkMeta, fileUrl, rgbToHex, httpUrl } from './inspiration-words.js';

const imageOf = (card) => (card.kind === 'image' ? card : card.kind === 'link' ? card.image : null);

/**
 * The card's node. ctx: { projectId, onEdit(card), onRemove(card), onMove(card, delta), onPick(card, hex),
 * onPicking(on) }. The list item takes the focus itself: Enter edits, Delete removes, Alt with an arrow moves it.
 */
export function cardNode(card, ctx) {
  const image = imageOf(card);
  const li = el(`li.inspo-card.inspo-${card.kind}`, { tabindex: '0', draggable: true, dataset: { card: card.id }, 'aria-label': cardName(card), 'aria-keyshortcuts': 'Enter Delete Alt+ArrowLeft Alt+ArrowRight' });
  let media = null;
  if (image?.file) {
    const img = el('img.inspo-img', { alt: imageAlt(card), loading: 'lazy', decoding: 'async', draggable: false, src: fileUrl(ctx.projectId, image.file, card.updatedAt) });
    media = el('div.inspo-media', img);
    if (image.width && image.height) { img.width = image.width; img.height = image.height; media.style.aspectRatio = `${image.width} / ${image.height}`; }
    li.append(media);
  }
  if (card.kind === 'color') li.append(el('div.inspo-swatch', { style: { background: card.hex }, role: 'img', 'aria-label': `Swatch of ${card.hex}` }));

  const body = el('div.inspo-body');
  if (card.kind === 'link') {
    const meta = linkMeta(card);
    // Only an http(s) address becomes a link. The server leaves any other link card out of its answer; this is the
    // view's own check, for a card that reaches it some other way (a studio server from before that rule, say).
    const href = httpUrl(card.url);
    const words = String(card.title || card.url || '');
    body.append(href ? el('a.inspo-title', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, words)
      : el('span.inspo-title', { title: 'Not an http or https address, so it is not opened as a link' }, words), meta ? el('p.inspo-site', meta) : null);
  }
  if (card.kind === 'note') body.append(el('p.inspo-note', card.text));
  if (card.kind === 'color') {
    const copy = el('button.inspo-copy', { type: 'button', title: `Copy ${card.hex}`, onclick: async () => { if (await copyText(card.hex)) toast(`Copied ${card.hex}`, { timeout: 2000 }); } }, card.hex);
    copy.setAttribute('translate', 'no'); // a code, not words (the property is a boolean, so the attribute is set)
    body.append(el('p.inspo-hex', copy, card.name ? el('span.inspo-name', card.name) : null));
  }
  if (card.why) body.append(el('p.inspo-why', card.why));
  if (card.tags?.length) body.append(el('p.inspo-tags', card.tags.join(' · ')));
  if (body.childNodes.length) li.append(body);

  let picker = null;
  const pickBtn = media ? button('Pick color', { small: true, variant: 'quiet', 'aria-pressed': 'false', title: 'Pick a color from this image; each pick becomes a swatch beside it', onclick: () => togglePick() }) : null;
  const stopPick = () => {
    if (!picker) return;
    picker.stop();
    picker = null;
    li.classList.remove('picking');
    pickBtn.setAttribute('aria-pressed', 'false');
    pickBtn.querySelector('span').textContent = 'Pick color';
    ctx.onPicking?.(false);
  };
  const togglePick = () => {
    if (picker) return stopPick();
    picker = startPicker(media, { onPick: (hex) => ctx.onPick(card, hex), onStop: stopPick });
    if (!picker) return;
    li.classList.add('picking');
    pickBtn.setAttribute('aria-pressed', 'true');
    pickBtn.querySelector('span').textContent = 'Done';
    ctx.onPicking?.(true);
  };
  li.stopPick = stopPick;

  li.append(el('div.inspo-actions', pickBtn,
    button('', { icon: 'edit', small: true, variant: 'quiet', title: 'Edit: tags, why you like it and its words (Enter)', onclick: () => ctx.onEdit(card) }),
    button('', { icon: 'trash', small: true, variant: 'quiet', title: 'Remove from the board (Delete)', onclick: () => ctx.onRemove(card) })));

  li.addEventListener('keydown', (e) => {
    if (e.target !== li || e.ctrlKey || e.metaKey) return; // a key inside a control of the card is that control's
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) { e.preventDefault(); ctx.onMove(card, -1); }
    else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) { e.preventDefault(); ctx.onMove(card, 1); }
    else if (e.altKey) return;
    else if (e.key === 'Enter') { e.preventDefault(); ctx.onEdit(card); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); ctx.onRemove(card); }
  });
  li.addEventListener('dblclick', (e) => { if (!picker && !e.target.closest('a, button')) ctx.onEdit(card); });
  return li;
}

const MAX_SIDE = 1600; // the canvas the eyedropper reads: the picture, at most this long on its longer side

/**
 * The eyedropper on a card's image. Answers { stop() }, or null (with a toast) when the picture cannot be read.
 * The mark and the readout follow the pointer with no transition: they track a hand.
 */
export function startPicker(media, { onPick, onStop }) {
  const img = media.querySelector('img');
  if (!img?.complete || !(img.naturalWidth || img.clientWidth)) { toast('The image has not loaded yet; try again in a moment', { tone: 'warn' }); return null; }
  const w0 = img.naturalWidth || img.clientWidth;
  const h0 = img.naturalHeight || img.clientHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const read = (x, y) => {
    const d = g.getImageData(Math.min(canvas.width - 1, Math.max(0, Math.floor(x * canvas.width))), Math.min(canvas.height - 1, Math.max(0, Math.floor(y * canvas.height))), 1, 1).data;
    // A see-through pixel is read over the card's own surface, as the eye sees it.
    const a = d[3] / 255;
    const bg = getComputedStyle(media).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) || [42, 41, 39];
    return rgbToHex(d[0] * a + bg[0] * (1 - a), d[1] * a + bg[1] * (1 - a), d[2] * a + bg[2] * (1 - a));
  };
  try { g.drawImage(img, 0, 0, canvas.width, canvas.height); read(0.5, 0.5); } catch { toast('This image cannot be read for its colors', { tone: 'warn' }); return null; }

  const chip = el('span.inspo-pick-chip');
  const words = el('span');
  const readout = el('div.inspo-pick-read', { 'aria-live': 'polite' }, chip, words);
  const mark = el('div.inspo-pick-mark', { 'aria-hidden': 'true' });
  media.append(mark, readout);
  media.tabIndex = 0;
  media.setAttribute('role', 'application');
  media.setAttribute('aria-label', 'Pick a color: arrow keys move the point, Enter picks, Escape stops');
  const at = { x: 0.5, y: 0.5 };
  let hex = '';
  const show = () => {
    hex = read(at.x, at.y);
    mark.style.left = readout.style.left = `${at.x * 100}%`;
    mark.style.top = readout.style.top = `${at.y * 100}%`;
    readout.classList.toggle('flip-x', at.x > 0.6);
    readout.classList.toggle('flip-y', at.y > 0.7);
    chip.style.background = hex;
    words.textContent = hex;
  };
  const toPoint = (e) => {
    const r = img.getBoundingClientRect();
    at.x = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
    at.y = Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)));
    show();
  };
  const onMove = (e) => toPoint(e);
  const onClick = (e) => { e.preventDefault(); e.stopPropagation(); toPoint(e); onPick(hex); };
  const onKey = (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d && !e.altKey) { e.preventDefault(); e.stopPropagation(); at.x = Math.min(1, Math.max(0, at.x + d[0])); at.y = Math.min(1, Math.max(0, at.y + d[1])); show(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPick(hex); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onStop(); media.closest('.inspo-card')?.focus(); }
  };
  // A press anywhere else ends it: the mode belongs to this one image.
  const onOutside = (e) => { if (!media.closest('.inspo-card')?.contains(e.target)) onStop(); };
  media.addEventListener('pointermove', onMove);
  media.addEventListener('click', onClick);
  media.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside, true);
  show();
  media.focus({ preventScroll: true });
  return {
    stop() {
      media.removeEventListener('pointermove', onMove);
      media.removeEventListener('click', onClick);
      media.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onOutside, true);
      mark.remove(); readout.remove();
      media.removeAttribute('tabindex'); media.removeAttribute('role'); media.removeAttribute('aria-label');
    },
  };
}
