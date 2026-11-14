// Small UI toolkit: element builder, icons, chips, toasts, dialogs, formatting.

/** el('button.btn.primary', {onclick, title}, 'Text', child...) */
export function el(spec, props, ...children) {
  if (props !== null && props !== undefined && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className += ' ' + v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k in node && !k.startsWith('aria') && k !== 'list' && k !== 'role') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function icon(name, label) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVGNS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** Button with optional icon. variant: primary (once per view) | '' (secondary) | quiet | danger (quiet, red). */
export function button(text, { icon: ic, variant = '', onclick, title, disabled, small, type = 'button', ...rest } = {}) {
  const cls = ['btn', variant, small ? 'sm' : '', text ? '' : 'icon-only'].filter(Boolean).join('.');
  return el(`button.${cls}`, { type, onclick, title: title || undefined, 'aria-label': text ? undefined : title, disabled, ...rest }, ic ? icon(ic) : null, text ? el('span', text) : null);
}

// ---------- status chips (task status labels from server/lib/tasks.mjs STATUS_LABELS) ----------
export const STATUS = {
  draft: { label: 'Draft', tone: 'neutral' },
  ready: { label: 'Ready for Claude Code', tone: 'accent' },
  working: { label: 'Working', tone: 'busy' },
  review: { label: 'Ready to try', tone: 'ok' },
  'record-result': { label: 'Record the result', tone: 'ok' }, // a review task with no version (taskState in status-words.js)
  done: { label: 'Done', tone: 'neutral' },
  'needs-input': { label: 'Needs your input', tone: 'warn' },
  'needs-you': { label: 'Needs you', tone: 'warn' }, // a companion's finished answer asks a question (status-words.js)
  'run-ended': { label: 'A run ended', tone: 'neutral' }, // a run the server reported ended (run-words.js); the words say which
  interrupted: { label: 'Interrupted', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  saving: { label: 'Saving', tone: 'busy' },
  retrieving: { label: 'Retrieving resources', tone: 'busy' },
  paused: { label: 'API paused', tone: 'warn' },
  idle: { label: 'No open tasks', tone: 'neutral' },
  offline: { label: 'Server offline', tone: 'danger' },
};
export function chip(status, extra, words) {
  const s = STATUS[status] || { label: status, tone: 'neutral' };
  return el(`span.chip.tone-${s.tone}`, { title: extra || s.label }, words || s.label);
}
/** A chip for a state that changes over time (DESIGN.md: chips are for states only). */
export const stateChip = (text, tone = 'neutral', title) => el(`span.chip.tone-${tone}`, { title }, text);
/** A plain muted word (kinds, backends, modes): not a badge. */
export const tag = (text, _tone, title) => el('span.tag', { title }, text);

/** Segmented control for 2–4 exclusive modes. options: [[value, label]]; returns {node, set(value), value}. */
export function segmented(options, value, onChange, { label } = {}) {
  const node = el('div.seg', { role: 'group', 'aria-label': label });
  let cur = value;
  const draw = () => {
    const focused = node.contains(document.activeElement) ? document.activeElement.dataset.v : null;
    clear(node, options.map(([v, text]) => el('button', { type: 'button', 'aria-pressed': String(v === cur), dataset: { v }, onclick: () => { if (v !== cur) { cur = v; draw(); onChange(v); } } }, text)));
    if (focused) node.querySelector(`[data-v="${focused}"]`)?.focus();
  };
  draw();
  return { node, set(v) { cur = v; draw(); }, get value() { return cur; } };
}

// ---------- toasts ----------
let toastHost;
/** clears: the prefix of an action's earlier errors, which stay until dismissed but stop being true once it succeeds. */
export function toast(message, { tone = 'neutral', action, timeout = 4000, clears } = {}) {
  toastHost ||= document.getElementById('toasts');
  if (clears) for (const old of [...toastHost.children]) if (old.dataset.prefix === clears) old.remove();
  const t = el(`div.toast.tone-${tone}`, { role: tone === 'danger' ? 'alert' : 'status' }, message instanceof Node ? message : el('span', message));
  if (action) t.append(button(action.label, { small: true, variant: 'quiet', onclick: () => { action.run(); t.remove(); } }));
  t.append(button('', { icon: 'x', small: true, variant: 'quiet', title: 'Dismiss', onclick: () => t.remove() }));
  toastHost.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  return t;
}
export function toastError(err, prefix = '') { // errors stay until dismissed, or until the same action succeeds
  const t = toast(`${prefix}${prefix ? ': ' : ''}${err.message || err}`, { tone: 'danger', timeout: 0 });
  if (prefix) t.dataset.prefix = prefix;
  return t;
}

// ---------- dialogs ----------
const closers = new WeakMap();

/** Close the open dialogs inside a node that is going away, and run their onClose before returning.
 *  A native d.close() only queues its close event, so what onClose undoes would outlive the caller.
 *  The focus stays where it is: the person is leaving, not going back to the opener. */
export function closeDialogsIn(root) {
  root.querySelectorAll('dialog[open]').forEach((d) => closers.get(d)?.());
}

/**
 * Open a modal dialog. body: Node | (close) => Node. Returns {close, node, done: Promise}.
 * Esc closes (native <dialog>), focus returns to the opener. modal: false shows it
 * in place inside `parent` (d.show()) so the rest of the page stays usable.
 */
export function dialog({ title, body, actions = [], wide = false, onClose, modal = true, parent = document.body } = {}) {
  const opener = document.activeElement;
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const titleId = 'dlg_' + Math.random().toString(36).slice(2, 8);
  const d = el(`dialog.dialog${wide ? '.wide' : ''}`, { 'aria-labelledby': titleId });
  let closed = false;
  const finish = (value, returnFocus) => { // runs once however the dialog closes (button, Esc, d.close() from outside)
    if (closed) return;
    closed = true;
    if (d.open) d.close();
    d.remove();
    onClose?.(value);
    resolve(value);
    if (returnFocus && opener?.isConnected) opener.focus();
  };
  const close = (value) => finish(value, true);
  closers.set(d, () => finish(undefined, false));
  const content = typeof body === 'function' ? body(close) : body;
  const foot = el('div.dialog-actions', actions.map((a) => button(a.label, { variant: a.variant || (a.value === false || /^(cancel|close)$/i.test(a.label) ? 'quiet' : ''), onclick: () => a.run ? a.run(close) : close(a.value) })));
  d.append(
    el('header.dialog-head', el('h2', { id: titleId }, title), button('', { icon: 'x', variant: 'quiet', title: 'Close (Esc)', onclick: () => close(undefined) })),
    el('div.dialog-body', content),
  );
  if (actions.length) d.append(foot);
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
  d.addEventListener('close', () => close(undefined));
  if (modal) {
    document.body.append(d);
    d.showModal();
  } else {
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(undefined); } });
    parent.append(d);
    d.show();
  }
  const first = d.querySelector('.dialog-body input, .dialog-body textarea, .dialog-body select') || d.querySelector('.dialog-actions .btn.primary');
  first?.focus();
  return { close, node: d, done };
}

export function confirmDialog({ title, message, confirm = 'Confirm', variant = 'primary', cancel = 'Cancel' }) {
  return dialog({
    title,
    body: el('div.prose', typeof message === 'string' ? el('p', message) : message),
    actions: [{ label: cancel, value: false }, { label: confirm, variant, value: true }],
  }).done;
}

// ---------- form helpers ----------
export function field(label, control, hint) {
  const id = control.id || 'f_' + Math.random().toString(36).slice(2, 8);
  control.id = id;
  return el('div.field', el('label', { htmlFor: id }, label), control, hint ? el('div.hint', hint) : null);
}
export const input = (props = {}) => el('input.input', { type: 'text', ...props });
export const textarea = (props = {}) => el('textarea.input', { rows: 3, ...props });
export function select(options, value, props = {}) {
  const s = el('select.input', props);
  for (const o of options) {
    const [v, label] = Array.isArray(o) ? o : [o, o];
    s.append(el('option', { value: v, selected: v === value }, label));
  }
  return s;
}

/** Empty state: one sentence and at most one action. A second string shows as a muted line; use it sparingly. */
export function empty(sentence, more, action) {
  return el('div.empty', el('p.empty-title', sentence), more ? el('p', more) : null, action || null);
}
export function errorBox(err, retry) {
  return el('div.empty.error', { role: 'alert' }, el('p.empty-title', `Could not load this: ${err.message || String(err)}`), retry ? button('Retry', { onclick: retry }) : null);
}
export const loading = (text = 'Loading…') => el('div.loading', { role: 'status' }, el('span.spinner', { 'aria-hidden': 'true' }), text);

// ---------- formatting ----------
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
export const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const usd = (n, d = 2) => (typeof n === 'number' ? `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : d)}` : '—');
export function bytes(n) {
  if (typeof n !== 'number') return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Shorten text to at most `max` characters, cutting at a word boundary and ending with "…". */
export function shortLabel(text, max = 60) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  const head = at > max * 0.4 ? cut.slice(0, at) : cut; // one very long word: cut it rather than leave nothing
  return `${head.replace(/[\s,;:.·–-]+$/, '')}…`;
}
