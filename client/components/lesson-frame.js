// The Learning view's lesson document (docs/ARCHITECTURE.md section 19, docs/DESIGN.md section 9): the lesson's html
// wrapped in a page the studio controls, rendered in an iframe with sandbox="allow-scripts" (no allow-same-origin, so
// it runs in an opaque origin and cannot reach the studio's API, storage or DOM) under a CSP that blocks the network.
// Pure: no DOM at import, so tests and the server can read it.
//
// The studio base stylesheet comes first, so a lesson that is plain headings, paragraphs and SVG looks like the studio
// (its colour tokens are read from the open window, so the theme follows). Built-in classes a lesson can use:
//   <ol class="steps"><li class="step">…</li>…</ol>   steps paged one at a time; the display shows Back, Next and a
//                                                      progress row (any element with class "step" counts)
//   <figure class="diagram"><svg>…</svg><figcaption>…</figcaption></figure>   a diagram with its caption
//   <aside class="callout">…</aside>                    a note set apart; add "warn" or "ok" for its tone
//   <dl class="terms"><dt>term</dt><dd>meaning</dd></dl>   term and definition pairs
//   <div class="flow"><div class="box">A</div><span class="arrow" data-label="asks"></span><div class="box">B</div></div>
//                                                      boxes and arrows in HTML and CSS; "flow down" stacks them,
//                                                      "box accent" marks one, <small> in a box is its second line
// The bridge script (lessonBridge) pages the steps and offers "Ask about this" on a selection or a figure; it talks to
// the parent only by postMessage with { type: 'atelier:lesson', what: 'steps' | 'ask', … } (client/components/lesson-words.js).

export const LESSON_MESSAGE = 'atelier:lesson';

/** default-src 'none' blocks every fetch, image, style, font and frame load; inline style and script run, images and
 *  fonts only from data: URLs; no <base>, no form posts. A navigation of the frame itself is not a CSP matter: the
 *  bridge stops link clicks, and the sandbox (no allow-top-navigation, allow-popups or allow-forms) does the rest. */
export const LESSON_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";

/** The tokens copied from the studio window into the lesson, with the dark theme's values when none can be read. */
export const LESSON_TOKENS = {
  bg: '#232221', panel: '#2a2927', 'panel-2': '#33312e', 'panel-3': '#3d3a36', field: '#1e1d1b',
  line: '#3a3834', 'line-strong': '#4b4843', ink: '#ece8e1', 'ink-2': '#c8c2b8', muted: '#9a948a',
  accent: '#d6a455', 'accent-ink': '#231c0e', 'accent-soft': 'rgba(214, 164, 85, 0.16)',
  ok: '#93be7c', warn: '#d6a455', danger: '#e07a72', busy: '#9fb3c8',
  'ok-soft': 'rgba(147, 190, 124, 0.14)', 'warn-soft': 'rgba(214, 164, 85, 0.14)', 'danger-soft': 'rgba(224, 122, 114, 0.14)', 'busy-soft': 'rgba(159, 179, 200, 0.14)',
  focus: '#e6bd73', 'code-bg': '#1d1c1a',
  s1: '4px', s2: '8px', s3: '12px', s4: '16px', s5: '24px', s6: '32px', r1: '6px', r2: '8px',
  font: '"Inter", "Segoe UI", system-ui, sans-serif',
  serif: '"Source Serif 4", "Source Serif Pro", "Iowan Old Style", "Charter", "Cambria", "Georgia", serif',
  mono: '"Cascadia Code", "Consolas", ui-monospace, monospace',
};

/** The studio window's current token values (getComputedStyle of the root); a value that could break out of a
 *  declaration is dropped, so the default stays. scheme: 'dark' | 'light' from the root's data-theme. */
export function readTokens(style, scheme = 'dark') {
  const out = { ...LESSON_TOKENS };
  for (const name of Object.keys(LESSON_TOKENS)) {
    const v = String(style?.getPropertyValue?.(`--${name}`) || '').trim();
    if (v && v.length < 200 && !/[;{}<>\\]/.test(v)) out[name] = v;
  }
  out.scheme = scheme === 'light' ? 'light' : 'dark';
  return out;
}

/** The base stylesheet: the tokens, plain type on the studio's canvas, and the built-in lesson classes. */
export function baseCss(tokens = LESSON_TOKENS) {
  const t = { ...LESSON_TOKENS, ...tokens };
  const vars = Object.keys(LESSON_TOKENS).map((k) => `--${k}: ${t[k]};`).join(' ');
  return `:root { ${vars} color-scheme: ${t.scheme === 'light' ? 'light' : 'dark'}; }
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; color: var(--ink); font: 15px/1.6 var(--font); -webkit-font-smoothing: antialiased; }
main.lesson { max-width: 76ch; margin: 0 auto; padding: var(--s6) var(--s5) 72px; }
h1, h2, h3, h4 { line-height: 1.3; letter-spacing: -0.005em; margin: 0; }
h1 { font: 600 26px/1.25 var(--serif); margin-bottom: var(--s3); }
h2 { font-size: 18px; font-weight: 600; margin: var(--s6) 0 var(--s2); }
h3 { font-size: 15px; font-weight: 600; margin: var(--s5) 0 var(--s2); }
h4 { font-size: 13px; font-weight: 600; color: var(--ink-2); margin: var(--s4) 0 var(--s1); }
p, ul, ol, pre, table { margin: 0 0 var(--s3); }
p, li, dd, td { color: var(--ink-2); }
strong, b, dt, th { color: var(--ink); }
ul, ol { padding-left: 1.4em; }
li + li { margin-top: var(--s1); }
a { color: var(--accent); }
hr { border: 0; border-top: 1px solid var(--line); margin: var(--s5) 0; }
code, pre, kbd { font-family: var(--mono); font-size: 0.86em; }
code, kbd { background: var(--code-bg); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: var(--r2); padding: var(--s3); overflow: auto; }
pre code { background: none; border: 0; padding: 0; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: var(--s2) var(--s3); border-bottom: 1px solid var(--line); vertical-align: top; }
img, svg { max-width: 100%; height: auto; }
svg text:not([fill]) { fill: currentColor; }
svg text { font-family: var(--font); }
::selection { background: var(--accent-soft); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
figure { margin: var(--s5) 0; }
figure.diagram { padding: var(--s4); background: var(--panel); border: 1px solid var(--line); border-radius: var(--r2); color: var(--ink-2); }
figure.diagram svg { display: block; margin: 0 auto; }
figcaption { margin-top: var(--s2); color: var(--muted); font-size: 13px; }
figure[data-asking] { outline: 1px solid var(--accent); outline-offset: 2px; }
.callout { margin: var(--s4) 0; padding: var(--s3) var(--s4); border-left: 3px solid var(--accent); background: var(--accent-soft); border-radius: 0 var(--r2) var(--r2) 0; color: var(--ink); }
.callout.warn { border-left-color: var(--danger); background: var(--danger-soft); }
.callout.ok { border-left-color: var(--ok); background: var(--ok-soft); }
.callout > :last-child { margin-bottom: 0; }
dl.terms { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--s2) var(--s4); margin: var(--s4) 0; }
dl.terms dt { font-weight: 600; }
dl.terms dd { margin: 0; }
.flow { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); margin: var(--s4) 0; }
.flow .box { padding: var(--s2) var(--s3); background: var(--panel-2); border: 1px solid var(--line-strong); border-radius: var(--r2); color: var(--ink); font-size: 14px; line-height: 1.35; }
.flow .box small { display: block; color: var(--muted); font-size: 12px; }
.flow .box.accent { border-color: var(--accent); background: var(--accent-soft); }
.flow .arrow { position: relative; flex: none; width: 36px; height: 2px; background: var(--muted); }
.flow .arrow::after { content: ""; position: absolute; right: -1px; top: -4px; border: 5px solid transparent; border-left: 7px solid var(--muted); border-right: 0; }
/* A labelled arrow is as wide as its label: the words sit on the line, the line is drawn under them. */
.flow .arrow[data-label] { width: auto; height: auto; min-width: 36px; padding: 0 12px 6px 4px; background: linear-gradient(var(--muted), var(--muted)) left bottom / calc(100% - 2px) 2px no-repeat; }
.flow .arrow[data-label]::before { content: attr(data-label); display: block; white-space: nowrap; text-align: center; font-size: 11px; line-height: 1.3; color: var(--muted); }
.flow .arrow[data-label]::after { top: auto; bottom: -4px; }
.flow.down { flex-direction: column; align-items: flex-start; }
.flow.down .arrow, .flow.down .arrow[data-label] { width: 2px; min-width: 0; height: 26px; padding: 0; margin: 0 0 0 var(--s5); background: var(--muted); }
.flow.down .arrow::after, .flow.down .arrow[data-label]::after { right: auto; left: -4px; top: auto; bottom: -1px; border: 5px solid transparent; border-top: 7px solid var(--muted); border-bottom: 0; }
.flow.down .arrow[data-label]::before { position: absolute; top: 50%; left: 12px; transform: translateY(-50%); }
ol.steps, ul.steps { list-style: none; padding: 0; margin: var(--s4) 0; counter-reset: step; }
.step { counter-increment: step; padding: var(--s4) var(--s5); background: var(--panel); border: 1px solid var(--line); border-radius: var(--r2); margin: 0 0 var(--s3); }
.step::before { content: "Step " counter(step); display: block; margin-bottom: var(--s2); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.step > :last-child { margin-bottom: 0; }
html.paged .step:not(.is-current) { display: none; }
html.paged .step::before { content: "Step " attr(data-step) " of " attr(data-steps); } /* a counter skips the hidden steps */
.ask-btn { position: absolute; z-index: 10; padding: 4px 10px; font: 600 12.5px/1.4 var(--font); color: var(--accent-ink); background: var(--accent); border: 0; border-radius: var(--r1); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35); cursor: pointer; }
.ask-btn[hidden] { display: none; }
@media (prefers-reduced-motion: no-preference) { .step.is-current { animation: lesson-in 140ms ease-out; } }
@keyframes lesson-in { from { opacity: 0.4; transform: translateY(4px); } to { opacity: 1; transform: none; } }
`;
}

/** The part of the lesson's html that goes in the page body: a body fragment as it is, or a whole document's body
 *  with the <style> blocks of its head kept in front. A <meta http-equiv> or <base> anywhere is dropped. */
export function lessonBody(html) {
  let s = String(html || '').replace(/<!doctype[^>]*>/gi, '');
  const body = s.match(/<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i);
  if (body) {
    const head = s.slice(0, body.index);
    const styles = [...head.matchAll(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi)].map((m) => m[0]).join('\n');
    s = `${styles}${styles ? '\n' : ''}${body[1]}`;
  }
  return s.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '');
}

const escapeText = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Runs inside the lesson frame (stringified into its head; it must not use anything from this module).
 * Steps: every .step, one shown at a time once the page has any; the frame reports { what: 'steps', count, index }
 * and the parent asks for one with { what: 'step', index }. ArrowLeft/ArrowRight page inside the frame too.
 * Ask about this: a text selection, or a press on a figure (or an svg outside one, or Enter on a focused figure),
 * shows a small button; pressing it sends { what: 'ask', kind: 'selection' | 'figure', text }.
 */
export function lessonBridge() {
  const TYPE = 'atelier:lesson';
  const post = (msg) => { try { parent.postMessage(Object.assign({ type: TYPE }, msg), '*'); } catch (e) { /* no parent */ } };
  const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const start = () => {
    const root = document.documentElement;
    const steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
    let index = 0;
    const show = (i) => {
      if (!steps.length) return;
      index = Math.max(0, Math.min(steps.length - 1, i));
      steps.forEach((s, n) => s.classList.toggle('is-current', n === index));
      post({ what: 'steps', count: steps.length, index });
    };
    steps.forEach((s, n) => { s.setAttribute('data-step', String(n + 1)); s.setAttribute('data-steps', String(steps.length)); });
    if (steps.length) { root.classList.add('paged'); show(0); } else post({ what: 'steps', count: 0, index: 0 });
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (e.source !== parent || !d || d.type !== TYPE || d.what !== 'step' || typeof d.index !== 'number') return;
      show(Math.floor(d.index));
    });

    // Links never leave the lesson: there is nothing to load, and a navigation would replace it.
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (a && (a.getAttribute('href') || '').charAt(0) !== '#') e.preventDefault();
    }, true);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ask-btn';
    btn.textContent = 'Ask about this';
    btn.title = 'Quote this into the Companion box beside the lesson';
    btn.hidden = true;
    document.body.appendChild(btn);
    let pending = null;
    let marked = null;
    const unmark = () => { if (marked) marked.removeAttribute('data-asking'); marked = null; };
    const hide = () => { btn.hidden = true; pending = null; unmark(); };
    const place = (rect, corner) => {
      btn.hidden = false;
      const w = btn.offsetWidth || 110;
      const top = corner ? rect.top + 8 : rect.bottom + 6;
      const left = corner ? rect.right - w - 8 : rect.left;
      btn.style.top = `${Math.max(4, top + window.scrollY)}px`;
      btn.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8)) + window.scrollX}px`;
    };
    const figureOf = (node) => {
      if (!node || !node.closest) return null;
      const fig = node.closest('figure');
      if (fig) return fig;
      let svg = node.closest('svg');
      while (svg && svg.parentElement && svg.parentElement.closest('svg')) svg = svg.parentElement.closest('svg');
      return svg;
    };
    const figureText = (fig) => {
      const cap = fig.querySelector && fig.querySelector('figcaption');
      const title = fig.querySelector && fig.querySelector('title');
      return clip((cap && cap.textContent) || fig.getAttribute('aria-label') || (title && title.textContent) || '') || 'the figure';
    };
    const askFigure = (fig) => {
      unmark();
      pending = { kind: 'figure', text: figureText(fig) };
      marked = fig.tagName.toLowerCase() === 'figure' ? fig : null;
      if (marked) marked.setAttribute('data-asking', '');
      place(fig.getBoundingClientRect(), true);
    };
    const fromSelection = () => {
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? clip(sel.toString()) : '';
      if (!text || btn.contains(sel.anchorNode)) return false;
      unmark();
      pending = { kind: 'selection', text };
      place(sel.getRangeAt(0).getBoundingClientRect(), false);
      return true;
    };
    for (const fig of document.querySelectorAll('figure')) if (!fig.hasAttribute('tabindex')) fig.setAttribute('tabindex', '0');
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection while pressing
    btn.addEventListener('click', () => {
      if (!pending) return hide();
      post({ what: 'ask', kind: pending.kind, text: pending.text });
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      hide();
    });
    document.addEventListener('mouseup', (e) => {
      if (btn.contains(e.target)) return;
      setTimeout(() => {
        if (fromSelection()) return;
        const fig = figureOf(e.target);
        if (fig) askFigure(fig); else hide();
      }, 0);
    });
    document.addEventListener('keyup', (e) => { if (e.shiftKey) fromSelection(); });
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape' && !btn.hidden) { hide(); return; }
      const t = e.target;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
      if ((e.key === 'Enter' || e.key === ' ') && t && t.tagName && t.tagName.toLowerCase() === 'figure') { e.preventDefault(); askFigure(t); btn.focus(); return; }
      if (!steps.length || t === btn) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(index + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(index - 1); }
    });
    window.addEventListener('scroll', () => { if (!btn.hidden && pending && pending.kind === 'selection') fromSelection(); }, { passive: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}

/** The whole srcdoc: CSP first, then the base stylesheet, the bridge, and the lesson's body. */
export function lessonDocument({ html, title = 'Lesson', tokens = LESSON_TOKENS } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${LESSON_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<style id="studio-base">${baseCss(tokens)}</style>
<script>(${lessonBridge.toString()})();</script>
</head><body><main class="lesson">
${lessonBody(html)}
</main></body></html>`;
}
