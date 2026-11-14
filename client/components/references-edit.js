// The dialog that adds or edits a reference (components/references-panel.js; docs/DESIGN.md section 13). A new
// entry first says what it is (a link, a snippet, a prompt, a note), and the fields follow the kind: a link its
// address and a title that may stay empty (the page's own is fetched), a snippet its title, language and code, a
// prompt and a note their words. Then, for every kind, what to use it for, its tags and where it came from. An edit
// sends only what changed; a refusal stays in the dialog as the server's sentence, with the focus on the field it names.
import { el, clear, dialog, field, input, textarea, segmented } from './ui.js';
import { KIND_ONE, LANGUAGES, formPatch, parseTags, USE_HINT } from './references-words.js';

const TEXT_LABEL = { snippet: 'Code', prompt: 'Prompt', note: 'Note' };
const TEXT_HOLDER = { snippet: 'Paste the code to reuse…', prompt: 'The words that worked…', note: 'An API note, an example to follow, a thing to remember…' };
const TITLE_HOLDER = { link: 'Leave empty to use the page\'s own title…', snippet: 'What it is, in a few words…', prompt: 'What it is for, in a few words…', note: 'Optional…' };

/**
 * Open the dialog. entry: the reference to edit, or null for a new one. opts: { kinds, limits, tags (in use),
 * save(patch) → Promise }. Resolves the saved entry, or undefined when the dialog closed without a save.
 */
export function refDialog(entry, { kinds = Object.keys(KIND_ONE), limits = {}, tags: inUse = [], save }) {
  let kind = entry?.kind || kinds[0] || 'link';
  const maxTags = limits.tags || 6;
  const title = input({ name: 'reference-title', value: entry?.title || '', maxLength: limits.title || 120, autocomplete: 'off' });
  const url = input({ type: 'url', name: 'reference-url', value: entry?.url || '', maxLength: 2000, placeholder: 'https://…', spellcheck: false, autocomplete: 'off', autocapitalize: 'off', inputMode: 'url' });
  const language = input({ name: 'reference-language', value: entry?.language || '', maxLength: limits.language || 24, placeholder: 'js…', class: 'mono', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' });
  language.setAttribute('list', 'refs-languages');
  const text = textarea({ name: 'reference-text', value: entry?.text || '', rows: 6, autocomplete: 'off' });
  const useFor = input({ name: 'reference-use', value: entry?.useFor || '', maxLength: limits.useFor || 200, placeholder: 'When to reach for it…', autocomplete: 'off' });
  const source = input({ name: 'reference-source', value: entry?.source || '', maxLength: limits.source || 200, placeholder: 'A doc, a file, a task, a person…', autocomplete: 'off' });
  const tags = input({ name: 'reference-tags', value: (entry?.tags || []).join(', '), placeholder: 'mcp, records…', autocomplete: 'off', autocapitalize: 'off', spellcheck: false });

  // The tags the project already uses, as buttons that put a tag in the field or take it out: one spelling per tag.
  const tagRow = el('div.inspo-tagpick', { role: 'group', 'aria-label': 'Tags in use' });
  const tagHint = el('span.hint');
  const drawTags = () => {
    const chosen = parseTags(tags.value);
    clear(tagRow, inUse.map((t) => el('button.inspo-tagbtn', {
      type: 'button', 'aria-pressed': String(chosen.includes(t)), disabled: !chosen.includes(t) && chosen.length >= maxTags, dataset: { tag: t },
      onclick: () => {
        const now = parseTags(tags.value);
        tags.value = (now.includes(t) ? now.filter((x) => x !== t) : [...now, t]).join(', ');
        drawTags();
        tagRow.querySelector(`[data-tag="${CSS.escape(t)}"]`)?.focus();
      },
    }, t)));
    tagRow.hidden = !inUse.length;
    clear(tagHint, chosen.length > maxTags ? `${chosen.length} tags: a reference takes up to ${maxTags}` : `A few words to find it by, separated by commas; up to ${maxTags}. A task whose request names a tag gets this reference first.`);
  };
  tags.addEventListener('input', drawTags);
  drawTags();

  const reason = el('p.note.danger.refs-reason', { role: 'alert', hidden: true });
  const say = (words) => { reason.hidden = !words; clear(reason, words || ''); };
  const form = () => ({ kind, title: title.value, url: url.value, text: text.value, language: language.value, useFor: useFor.value, source: source.value, tags: tags.value });
  /** The field a refusal is about, from its sentence. */
  const fieldOf = (message) => (/\btags?\b/i.test(message) ? tags : /language/i.test(message) ? language : /use-it-for/i.test(message) ? useFor : /came from/i.test(message) ? source : /title/i.test(message) ? title : kind === 'link' ? url : text);

  // The fields of the kind in hand. Switching the kind of a new entry keeps what was typed in the fields both have.
  const own = el('div.refs-own');
  const titleField = field('Title', title);
  const textField = field('Text', text);
  const drawKind = () => {
    const code = kind === 'snippet';
    title.placeholder = TITLE_HOLDER[kind];
    title.required = code || kind === 'prompt';
    titleField.querySelector('label').textContent = kind === 'link' || kind === 'note' ? 'Title (optional)' : 'Title';
    if (kind !== 'link') {
      textField.querySelector('label').textContent = TEXT_LABEL[kind];
      Object.assign(text, { placeholder: TEXT_HOLDER[kind], rows: code ? 10 : kind === 'prompt' ? 8 : 5, maxLength: limits.text?.[kind] || 20000, spellcheck: !code, required: true });
      text.classList.toggle('mono', code);
      text.classList.toggle('refs-code-input', code);
      text.wrap = code ? 'off' : 'soft';
      if (code) text.setAttribute('translate', 'no'); else text.removeAttribute('translate');
    }
    url.required = kind === 'link';
    clear(own,
      kind === 'link' ? field('Address', url) : null,
      code ? el('div.refs-title-lang', titleField, field('Language (optional)', language)) : titleField,
      kind === 'link' ? null : textField);
  };
  drawKind();

  let d;
  const saveBtn = () => d.node.querySelector('.dialog-actions .btn.primary');
  const send = async () => {
    const patch = formPatch(entry, form());
    if (entry && !Object.keys(patch).length) return d.close(undefined);
    // A link's title emptied on an edit asks for the page's own again, as the field's placeholder says.
    if (entry && kind === 'link' && patch.title === '' && !patch.url) patch.refetch = true;
    const btn = saveBtn();
    const words = btn.querySelector('span');
    const was = words.textContent;
    btn.disabled = true; words.textContent = kind === 'link' && (!entry || patch.url || patch.refetch) ? 'Fetching the title…' : 'Saving…'; say('');
    try { d.close(await save(patch)); } catch (err) {
      const message = err.message || String(err);
      say(message);
      btn.disabled = false; words.textContent = was;
      fieldOf(message).focus();
    }
  };

  const kindPick = entry ? null : segmented(kinds.map((k) => [k, KIND_ONE[k] || k]), kind, (k) => {
    kind = k;
    drawKind();
    d.node.classList.toggle('wide', kind === 'snippet');
    words(saveBtn(), `Add ${kind}`);
    say('');
  }, { label: 'What the reference is' });
  const words = (btn, w) => { btn.querySelector('span').textContent = w; };

  // noValidate: a field left empty is answered by the server's sentence in the dialog, whichever way the form is sent.
  const body = el('form.refs-edit', { noValidate: true, onsubmit: (e) => { e.preventDefault(); send(); } },
    kindPick ? el('div.field', kindPick.node) : null,
    own,
    field('Use it for (optional)', useFor, USE_HINT),
    el('div.field', el('label', { htmlFor: 'refs-tags' }, 'Tags'), Object.assign(tags, { id: 'refs-tags' }), tagRow, tagHint),
    field('Where it came from (optional)', source),
    el('datalist', { id: 'refs-languages' }, LANGUAGES.map((l) => el('option', { value: l }))),
    el('button', { type: 'submit', hidden: true, tabIndex: -1, 'aria-hidden': 'true' })); // Enter in a one-line field submits
  d = dialog({
    title: entry ? `Edit ${entry.kind}` : 'Add reference',
    wide: kind === 'snippet',
    body,
    actions: [{ label: 'Cancel', value: undefined }, { label: entry ? 'Save' : `Add ${kind}`, variant: 'primary', run: () => send() }],
  });
  // The refusal stands over the buttons, outside the part that scrolls: it is in sight whichever field it sends the focus to.
  d.node.querySelector('.dialog-actions').before(reason);
  // The first thing to fill in holds the focus, not the kind switch.
  (kind === 'link' ? url : title).focus();
  return d.done;
}
