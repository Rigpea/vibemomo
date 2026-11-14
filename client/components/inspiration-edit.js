// The Edit dialog of an inspiration card (views/inspiration.js): why the person likes it, its tags (the default set,
// the board's own, and new ones typed), and the card's own words: a note's text, a color's hex and name, a link's
// title with Fetch the preview again. Save sends only what changed; a refusal stays in the dialog as the server's sentence.
import { el, clear, button, dialog, field, input, textarea } from './ui.js';
import { parseTags, normalizeHex, tagChoices } from './inspiration-words.js';

const TITLES = { image: 'Edit image', link: 'Edit link', color: 'Edit color', note: 'Edit note' };

/**
 * Open the dialog. opts: { defaultTags, cards, limits, save(patch) → Promise }. Resolves the saved card, or
 * undefined when the dialog closed without a save.
 */
export function editCardDialog(card, { defaultTags = [], cards = [], limits = {}, save }) {
  const max = limits.tags || 6;
  const chosen = new Set(card.tags || []);
  const choices = tagChoices(defaultTags, cards, card.tags || []);
  const tagRow = el('div.inspo-tagpick', { role: 'group', 'aria-label': 'Tags' });
  const tagCount = el('span.hint');
  const drawTags = () => {
    clear(tagRow, choices.map((t) => el('button.inspo-tagbtn', {
      type: 'button', 'aria-pressed': String(chosen.has(t)), disabled: !chosen.has(t) && chosen.size >= max,
      onclick: () => { const had = chosen.has(t); if (had) chosen.delete(t); else chosen.add(t); drawTags(); tagRow.querySelector(`[data-tag="${CSS.escape(t)}"]`)?.focus(); }, dataset: { tag: t },
    }, t)));
    clear(tagCount, chosen.size >= max ? `${max} of ${max} tags: take one off to add another` : `A few words to find it by; up to ${max}.`);
  };
  const own = input({ name: 'tag', placeholder: 'Your own tag…', maxLength: limits.tag || 24, 'aria-label': 'Add your own tag', autocomplete: 'off' });
  const addOwn = () => {
    for (const t of parseTags(own.value)) {
      if (!choices.includes(t)) choices.push(t);
      if (chosen.size < max) chosen.add(t);
    }
    own.value = '';
    drawTags();
  };
  own.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addOwn(); } });
  drawTags();

  const why = input({ name: 'why', value: card.why || '', maxLength: limits.why || 200, placeholder: 'One line, for you and for Claude…', autocomplete: 'off' });
  const fields = [];
  const own_ = {};
  if (card.kind === 'note') { own_.text = textarea({ name: 'text', value: card.text || '', rows: 6, maxLength: limits.note || 2000 }); fields.push(field('Note', own_.text)); }
  if (card.kind === 'color') {
    own_.hex = input({ name: 'hex', value: card.hex || '', maxLength: 7, spellcheck: false, autocomplete: 'off', class: 'mono' });
    own_.name = input({ name: 'name', value: card.name || '', maxLength: limits.name || 60, autocomplete: 'off' });
    fields.push(el('div.fields-2', field('Hex', own_.hex), field('Name (optional)', own_.name)));
  }
  const reason = el('p.note.danger', { role: 'alert', hidden: true });
  const say = (text) => { reason.hidden = !text; clear(reason, text || ''); };
  let d;
  const run = async (patch, btn, busyWords) => {
    const words = btn.querySelector('span');
    const was = words.textContent;
    btn.disabled = true; words.textContent = busyWords; say('');
    try { d.close(await save(patch)); } catch (err) { say(err.message || String(err)); btn.disabled = false; words.textContent = was; }
  };
  if (card.kind === 'link') {
    own_.title = input({ name: 'title', value: card.title || '', maxLength: limits.title || 200, autocomplete: 'off' });
    const again = button('Fetch the preview again', { small: true, variant: 'quiet', title: 'Ask the page for its title and preview image again', onclick: () => run({ ...changes(), refetch: true }, again, 'Fetching…') });
    fields.push(field('Title', own_.title, el('span', el('span.inspo-edit-url', card.url), ' · ', again)));
  }

  const changes = () => {
    const patch = {};
    const tags = choices.filter((t) => chosen.has(t));
    if (JSON.stringify(tags) !== JSON.stringify(card.tags || [])) patch.tags = tags;
    if (why.value.trim() !== (card.why || '')) patch.why = why.value.trim();
    if (own_.text && own_.text.value.trim() !== (card.text || '')) patch.text = own_.text.value;
    if (own_.hex && (normalizeHex(own_.hex.value) || own_.hex.value.trim()) !== card.hex) patch.hex = own_.hex.value.trim();
    if (own_.name && own_.name.value.trim() !== (card.name || '')) patch.name = own_.name.value.trim();
    if (own_.title && own_.title.value.trim() !== (card.title || '')) patch.title = own_.title.value.trim();
    return patch;
  };

  const body = el('form.inspo-edit', { onsubmit: (e) => { e.preventDefault(); saveBtn()?.click(); } },
    ...fields,
    field('Why I like it', why),
    el('div.field', el('label', { htmlFor: 'inspo-own-tag' }, 'Tags'), tagRow, el('div.inspo-tagadd', Object.assign(own, { id: 'inspo-own-tag' }), button('Add tag', { small: true, onclick: addOwn })), tagCount),
    reason);
  const saveBtn = () => d.node.querySelector('.dialog-actions .btn.primary');
  d = dialog({
    title: TITLES[card.kind] || 'Edit card',
    body,
    actions: [
      { label: 'Cancel', value: undefined },
      { label: 'Save', variant: 'primary', run: (close) => { addOwn(); const patch = changes(); if (!Object.keys(patch).length) return close(undefined); return run(patch, saveBtn(), 'Saving…'); } },
    ],
  });
  return d.done;
}
