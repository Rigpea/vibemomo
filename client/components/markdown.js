// Markdown-lite: headings, paragraphs, lists (- * 1.), fenced code (also indented inside a list
// item), simple pipe tables, inline code, **bold**, _italic_ / *italic*, and http(s) links.
// Everything is escaped first; only the tags generated here reach innerHTML.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  const codes = [];
  // Code spans first (`` `a` `` or ``` ``a ` b`` ```), so nothing inside them is formatted.
  let s = esc(text).replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, c) => `\u0000${codes.push(c.trim()) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

/** Cells of a pipe-table row: "| a | b |" → ["a", "b"] (a backslash-escaped \| stays in the cell). */
const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isRow = (line) => /^\s*\|.*\|\s*$/.test(line || '');
const isSep = (line) => isRow(line) && cells(line).every((c) => /^:?-{3,}:?$/.test(c));

export function markdownToHtml(md = '') {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let item = false; // an <li> is open (a fenced block can still join it)
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeItem = () => { if (item) { out.push('</li>'); item = false; } };
  const closeList = () => { closeItem(); if (list) { out.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(```+|~~~+)/);
    if (fence) {
      flushPara();
      const indented = fence[1].length > 0;
      if (!(indented && item)) closeList(); // an indented fence right after a list item belongs to it
      const close = new RegExp(`^\\s*${fence[2][0] === '`' ? '`' : '~'}{${fence[2].length},}\\s*$`);
      const buf = [];
      while (++i < lines.length && !close.test(lines[i])) buf.push(indented ? lines[i].replace(new RegExp(`^ {0,${fence[1].length}}`), '') : lines[i]);
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (isRow(line) && isSep(lines[i + 1])) {
      flushPara(); closeList();
      const head = cells(line);
      const rows = [];
      i += 1;
      while (i + 1 < lines.length && isRow(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); closeList(); const n = Math.min(h[1].length + 2, 6); out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    const li = line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.*)$/);
    if (li) {
      flushPara();
      const kind = li[2] ? 'ol' : 'ul';
      if (list !== kind) { closeList(); out.push(kind === 'ol' && li[2] !== '1' ? `<ol start="${Number(li[2])}">` : `<${kind}>`); list = kind; }
      closeItem();
      out.push(`<li>${inline(li[3])}`);
      item = true;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      // A blank line between two items of the same list keeps the list (and its numbering) going.
      const next = lines.slice(i + 1).find((l) => l.trim());
      const nextLi = next && next.match(/^\s*(?:([-*])|(\d+)\.)\s+/);
      if (!(list && nextLi && (nextLi[2] ? 'ol' : 'ul') === list)) closeList();
      continue;
    }
    if (/^>\s?/.test(line)) { flushPara(); closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    // A source line wrapped inside a list item continues that item.
    if (item && !isRow(line)) { out[out.length - 1] += ` ${inline(line.trim())}`; continue; }
    closeList();
    para.push(line.trim());
  }
  flushPara(); closeList();
  return out.join('\n');
}

export function markdown(md, className = 'prose md') {
  const div = document.createElement('div');
  div.className = className;
  div.innerHTML = markdownToHtml(md);
  return div;
}
