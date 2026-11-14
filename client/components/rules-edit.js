// The dialog that adds or edits a fixed rule (components/rules-panel.js; docs/DESIGN.md section 11): the rule's one
// sentence, its kind, why, and optionally the design token it locks (a CSS custom property and its value). An edit
// sends only what changed; a refusal stays in the dialog as the server's sentence, with the focus on the field it names.
import { el, clear, dialog, field, input, textarea, select } from './ui.js';
import { kindWord, formPatch, swatchOf, TOKEN_HINT } from './rules-words.js';

/**
 * Open the dialog. rule: the rule to edit, or null for a new one. opts: { kinds, limits, save(patch) → Promise }.
 * Resolves the saved rule, or undefined when the dialog closed without a save.
 */
export function ruleDialog(rule, { kinds = [], limits = {}, save }) {
  const text = textarea({ name: 'rule-text', value: rule?.text || '', rows: 2, maxLength: limits.text || 200, required: true, placeholder: 'What must stay the same, in one sentence…', autocomplete: 'off' });
  const kind = select([...(rule ? [] : [['', 'Choose a kind…']]), ...kinds.map((k) => [k, kindWord(k)])], rule?.kind || '', { name: 'rule-kind', required: true });
  const why = input({ name: 'rule-why', value: rule?.why || '', maxLength: limits.why || 300, placeholder: 'Where it comes from, or what breaks without it…', autocomplete: 'off' });
  const tokenName = input({ name: 'rule-token-name', value: rule?.token?.name || '', maxLength: limits.tokenName || 64, placeholder: '--accent…', class: 'mono', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' });
  const tokenValue = input({ name: 'rule-token-value', value: rule?.token?.value || '', maxLength: limits.tokenValue || 200, placeholder: '#d6a455…', class: 'mono', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' });
  for (const code of [tokenName, tokenValue]) code.setAttribute('translate', 'no'); // code, not words
  // The value as a color beside its field, when it is one: what is typed is what will be locked.
  const swatch = el('span.rules-swatch', { 'aria-hidden': 'true', hidden: true });
  const drawSwatch = () => { const c = swatchOf(tokenValue.value); swatch.hidden = !c; swatch.style.background = c || ''; };
  tokenValue.addEventListener('input', drawSwatch);
  drawSwatch();

  const reason = el('p.note.danger', { role: 'alert', hidden: true });
  const say = (words) => { reason.hidden = !words; clear(reason, words || ''); };
  const form = () => ({ text: text.value, kind: kind.value, why: why.value, tokenName: tokenName.value, tokenValue: tokenValue.value });
  /** The field a refusal is about, from its sentence: the token's, the kind's, why's, else the rule's own words. */
  const fieldOf = (message) => (/value|parenthes|quote/i.test(message) && /token/i.test(message) ? tokenValue : /token|locked|custom property/i.test(message) ? tokenName : /kind/i.test(message) ? kind : /^why/i.test(message) ? why : text);

  let d;
  const saveBtn = () => d.node.querySelector('.dialog-actions .btn.primary');
  const send = async () => {
    const patch = formPatch(rule, form());
    if (rule && !Object.keys(patch).length) return d.close(undefined);
    const btn = saveBtn();
    const words = btn.querySelector('span');
    const was = words.textContent;
    btn.disabled = true; words.textContent = 'Saving…'; say('');
    try { d.close(await save(patch)); } catch (err) {
      const message = err.message || String(err);
      say(message);
      btn.disabled = false; words.textContent = was;
      fieldOf(message).focus();
    }
  };
  // Enter in the sentence saves, as in a one-line field; Shift+Enter is not needed in one sentence.
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

  const body = el('form.rules-edit', { onsubmit: (e) => { e.preventDefault(); send(); } },
    field('Rule', text),
    field('Kind', kind),
    field('Why (optional)', why),
    el('div.rules-token', el('div.fields-2', field('Locked token', tokenName), el('div.field', el('label', { htmlFor: 'rules-token-value' }, 'Its value'), el('span.rules-value', Object.assign(tokenValue, { id: 'rules-token-value' }), swatch))), el('p.hint', TOKEN_HINT)),
    reason,
    el('button', { type: 'submit', hidden: true, tabIndex: -1, 'aria-hidden': 'true' })); // Enter in a one-line field submits
  d = dialog({
    title: rule ? 'Edit rule' : 'Add rule',
    body,
    actions: [{ label: 'Cancel', value: undefined }, { label: rule ? 'Save' : 'Add rule', variant: 'primary', run: () => send() }],
  });
  return d.done;
}
