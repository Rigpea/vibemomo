// The Companion tab's words, apart from the DOM: the state line, the trajectory's verbs, the pin cards, the chip and the
// block a selected pin adds to a message, the composer's placeholder and the dock height clamp. No imports, so the
// server (server/lib/companion.mjs, server/lib/console.mjs) and tests/companion-panel.test.mjs read it directly.

export const COMPANION_MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-fable-5-2', 'Fable 5.2'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']]; // ids as server/lib/console.mjs CONSOLE_MODELS
/** The CLI's effort levels; '' leaves Claude Code's default. */
export const COMPANION_EFFORTS = [['', 'Default effort'], ['low', 'Low effort'], ['medium', 'Medium effort'], ['high', 'High effort'], ['xhigh', 'Extra high effort'], ['max', 'Max effort']];
/** The permission modes the tab offers, in the person's words; ids as the CLI's --permission-mode. */
export const COMPANION_MODES = [['plan', 'Plan: edits nothing'], ['acceptEdits', 'Accept edits'], ['auto', 'Auto'], ['bypassPermissions', 'Runs anything']];
export const modeWords = (id) => COMPANION_MODES.find(([m]) => m === id)?.[1] || id || 'mode not set';
/** Whether the companion works in the person's own Chrome (claude --chrome; decision row 150). */
export const COMPANION_CHROME = [['on', 'Chrome on'], ['off', 'Chrome off']];
/** The person's companion choices kept per project (project.ui.companion): model, effort, permissionMode, chrome. */
export function companionChoices(ui) {
  const c = ui?.companion || {};
  return {
    model: COMPANION_MODELS.some(([m]) => m === c.model) ? c.model : COMPANION_MODELS[0][0],
    effort: COMPANION_EFFORTS.some(([e]) => e === c.effort) ? c.effort : '',
    permissionMode: COMPANION_MODES.some(([m]) => m === c.permissionMode) ? c.permissionMode : 'auto', // the person's default of 2026-11-07
    chrome: c.chrome !== false, // on unless the person switched it off (2026-11-13)
  };
}

/** The block a message carries for the files attached to it: their paths inside the project, for the Read tool. */
export function attachmentBlock(files) {
  if (!files?.length) return '';
  const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  return ['', '', '---', `Attached file${files.length > 1 ? 's' : ''} (from the studio, inside this project):`,
    ...files.map((f) => `- ${f.path}${f.type || f.bytes ? ` (${[f.type, f.bytes ? kb(f.bytes) : null].filter(Boolean).join(', ')})` : ''}`),
    'Read them with the Read tool before answering.'].join('\n');
}
export const messageWithAttachments = (text, files) => `${text}${attachmentBlock(files)}`;
export const modelWords = (id) => COMPANION_MODELS.find(([m]) => m === id)?.[1] || id || 'model not set';

/** The header line: who answers, in words, as the concept's "Interface agent / run ui-03". */
export const brainLine = (model) => `Claude Code · ${modelWords(model)} · your login`;
/** Who runs a session, from its record: a Codex session (a Codex worker, the Codex tab) names Codex, its model, effort
 *  and sandbox; every other session reads as brainLine. No record yet: Claude Code's line with no model. */
export const sessionBrainLine = (session) => (session?.backend === 'codex'
  ? `Codex · ${session.model || 'Codex\'s default model'} · ${session.effort ? `${session.effort} effort` : 'default effort'} · sandbox ${session.sandbox || 'read-only'}`
  : brainLine(session?.model));

export const MAKE_TASK_MESSAGE = 'Turn this thread into a studio task with atelier_create_task: a title, the request with the pins\' files named, the numbers of the pins it is about as pins, three acceptance lines, mode handle; then tell me the task id.';

export const PIN_HINT = 'the companion can call atelier_phone_screenshot for the picture';

// ---------- the trajectory ----------

const VERBS = {
  Read: 'Read', Edit: 'Edit', MultiEdit: 'Edit', Write: 'Write', NotebookEdit: 'Edit', Bash: 'Run', PowerShell: 'Run',
  Shell: 'Run', Delete: 'Delete', // a Codex session's command and file removal (server/lib/codex.mjs)
  Grep: 'Search', Glob: 'Find files', WebFetch: 'Fetch', WebSearch: 'Web search', ToolSearch: 'Tool search', TodoWrite: 'Plan', Task: 'Agent',
  atelier_read_briefing: 'Briefing', atelier_read_memory: 'Memory', atelier_read_file: 'Read', atelier_list_files: 'List',
  atelier_list_versions: 'Versions', atelier_read_diff: 'Diff', atelier_phone_status: 'Phone status',
  atelier_phone_screenshot: 'Phone screenshot', atelier_phone_inspect: 'Inspect', atelier_page_files: 'Page files',
  atelier_studio_show: 'Show', atelier_create_task: 'Task created', atelier_add_unresolved: 'Unresolved added',
  atelier_add_memory: 'Memory added', atelier_keep_version: 'Version kept',
};

/** A tool's name as a verb: Edit, Phone screenshot, Task created; an unknown MCP tool loses its server prefix. */
export function toolVerb(name) {
  const n = String(name || 'tool');
  const bare = n.replace(/^mcp__.+?__/, '');
  if (VERBS[n]) return VERBS[n];
  if (VERBS[bare]) return VERBS[bare];
  const words = bare.replace(/^atelier_/, '').replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Tool';
}

const PATTERN_TOOLS = new Set(['Grep', 'Glob', 'WebSearch']); // their summary is a pattern or a query, never a file

/** The file or argument after the verb: a path's last part, a JSON input as k: v pairs, else the summary as it is.
 *  With the tool's name, a Grep, Glob or WebSearch summary is quoted (“spacing”), so a pattern does not read as a file. */
export function toolObject(summary, name = null) {
  const s = String(summary ?? '').trim();
  if (!s) return '';
  if (PATTERN_TOOLS.has(String(name || '').replace(/^mcp__.+?__/, ''))) return `“${s}”`;
  if (s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      return Object.entries(o).map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
    } catch { return s.replace(/[{}"]/g, ''); }
  }
  if (/^[^\s]+[\\/][^\s]+$/.test(s) && !/^https?:/i.test(s)) return s.split(/[\\/]/).filter(Boolean).pop();
  return s;
}

/** Elapsed time as mm:ss (h:mm:ss from an hour). */
export function clock(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** One trajectory line's label: "00:19 · Edit · welcome.mjs" (the time only when the call carries one). */
export function trajectoryLabel(e) {
  const obj = toolObject(e?.summary, e?.name);
  return [typeof e?.ms === 'number' ? clock(e.ms) : null, toolVerb(e?.name), obj || null].filter(Boolean).join(' · ');
}

// ---------- a task's intent ----------

/** The first sentence of a request: up to the first . ! or ? that ends a word, or the first line. */
export function firstSentenceOf(text) {
  const line = String(text || '').trim().split(/\r?\n/)[0].trim();
  const m = line.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : line).trim();
}

/** The intent line under the title: the request's first sentence when it says more than the title; null when it would
 *  only repeat the title (listTasks gives a task its request's first sentence as its title when none was typed), or
 *  when the task carries no request. A title cut at 120 characters differs from its sentence, so the sentence shows. */
export function intentLine(t) {
  const first = firstSentenceOf(t?.request);
  if (!first) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…:;,]+$/g, '').trim();
  return norm(first) === norm(t?.title) ? null : first;
}

// ---------- the state line ----------

/** Does an answer end on a question to the person? The last paragraph that says something ends with "?". */
export function asksQuestion(text) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.replace(/[\s*_`>)\]]+$/g, '').trim()).filter(Boolean);
  return !!paras.length && /\?$/.test(paras[paras.length - 1]);
}

/** The question's first words, for a state reason: the last paragraph's last sentence, cut at about 60 characters. */
export function questionWords(text, max = 60) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.replace(/[\s*_`>)\]]+$/g, '').trim()).filter(Boolean);
  const last = paras[paras.length - 1] || '';
  const sentence = (last.match(/[^.!?\n]*\?$/)?.[0] || last).replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

const ago = (iso, now) => {
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return 'earlier';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/**
 * The tab's state in one word and its reason: { word, reason, tone }.
 * session: the console record (or null); running: a run is under way; startedAt: when it began (ms);
 * lastTool: the newest tool call of the live run ({ name, summary }), if any.
 */
export function companionState({ session = null, running = false, startedAt = null, lastTool = null, now = Date.now() } = {}) {
  if (!session) return { word: 'Idle', reason: 'no session yet', tone: 'neutral' };
  if (running) {
    const doing = lastTool ? [toolVerb(lastTool.name), toolObject(lastTool.summary, lastTool.name)].filter(Boolean).join(' ') : 'thinking';
    return { word: 'Working', reason: [startedAt ? clock(now - startedAt) : null, doing].filter(Boolean).join(' · '), tone: 'busy' };
  }
  const last = [...(session.turns || [])].reverse().find((t) => t.role !== 'user');
  const lastUser = [...(session.turns || [])].reverse().find((t) => t.role === 'user');
  if (!last) return { word: 'Idle', reason: lastUser ? 'the message got no answer' : 'no message yet', tone: 'neutral' };
  if (lastUser && Date.parse(lastUser.at) > Date.parse(last.at)) return { word: 'Idle', reason: 'the last message got no answer', tone: 'neutral' };
  if (last.cancelled) return { word: 'Stopped', reason: `you stopped the run · ${ago(last.at, now)}`, tone: 'neutral' };
  if (last.signedOut) return { word: 'Signed out', reason: 'Claude Code has no working sign-in on this machine · Settings', tone: 'danger' };
  if (last.isError && !last.text) return { word: 'Failed', reason: String(last.error || 'the run ended with an error').split('\n')[0].slice(0, 120), tone: 'danger' };
  if (asksQuestion(last.text)) return { word: 'Needs you', reason: 'a question is waiting', tone: 'warn' };
  return { word: 'Done', reason: ago(last.at, now), tone: 'ok' };
}

/** A session list entry (server listSessions) that waits on the person: its last answer asks a question. */
export const sessionAsks = (s) => !!s && s.status !== 'running' && s.asks === true;

// ---------- pins ----------

const short = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** "Pin 1 · span.mini-case-label · index.html:73" (n is 1-based, the order in the list). */
export const pinTitle = (pin, n) => ['Pin ' + n, pin?.element || 'no element', pin?.files?.[0] || null].filter(Boolean).join(' · ');

const SOURCE_WORDS = { phone: 'Phone', preview: 'Preview' };

/** The chip above the composer: "Harbor / Phone / span.mini-case-label" (one pin), "Harbor / Phone / 2 pins" (more). */
export function pinChip(projectName, pins) {
  if (!pins?.length) return null;
  const what = pins.length === 1 ? pins[0].element || 'a point' : `${pins.length} pins`;
  const source = [...new Set(pins.map((p) => SOURCE_WORDS[p.source] || p.source || 'Pin'))].join(', ');
  return `${projectName} / ${source} / ${what}`;
}

/** The block a message carries for its selected pins: point, element, text, the first three files and the hint. */
export function pinBlock(pins, numberOf = (p, i) => i + 1) {
  if (!pins?.length) return '';
  const lines = ['', '---', `Selected pin${pins.length > 1 ? 's' : ''} (from the studio):`];
  pins.forEach((p, i) => {
    const pt = p.point?.device ? `device (${p.point.device.x}, ${p.point.device.y})${p.point.css ? `, page CSS (${p.point.css.x}, ${p.point.css.y})` : ''}` : p.source === 'preview' ? 'a click on the studio preview (no device)' : 'not recorded';
    lines.push(`Pin ${numberOf(p, i)} · ${p.source || 'phone'}${p.pageName ? ` · ${p.pageName}` : ''}${p.page ? ` · ${p.page}` : ''}`);
    lines.push(`- Point: ${pt}`);
    lines.push(`- Element: ${p.element || '(none)'}${p.selector ? ` (selector ${p.selector})` : ''}`);
    lines.push(`- Text: ${p.text ? `"${short(p.text, 200)}"` : '(none)'}`);
    const files = (p.files || []).slice(0, 3);
    lines.push(`- Files: ${files.length ? files.join(', ') : 'none found'}`);
    if (p.note) lines.push(`- Note: ${short(p.note, 300)}`);
  });
  lines.push(`(${PIN_HINT}.)`);
  return lines.join('\n');
}

/** The message as sent: the person's words, then the pins' block when any is selected. */
export const messageWithPins = (text, pins, numberOf) => (pins?.length ? `${String(text).trimEnd()}\n${pinBlock(pins, numberOf)}` : String(text));

export const composerPlaceholder = (pinsSelected) => (pinsSelected ? 'Refine the selected part…' : 'Ask about this page…');

/** A Point readout (POST /phone/inspect's answer) as the pin the server stores. */
export function pinFromReadout(answer) {
  const e = answer?.element || {};
  const name = `${e.tag || e.nodeName?.toLowerCase() || '?'}${e.id ? `#${e.id}` : ''}${(e.classes || []).map((c) => `.${c}`).join('')}`;
  const point = answer?.point ? { device: answer.point.device || null, css: answer.point.css || null } : null;
  return {
    source: 'phone',
    element: name,
    text: e.text || '',
    selector: e.selector || '',
    point,
    files: (answer?.candidates || []).slice(0, 10).map((c) => `${c.file}:${c.line}`),
    page: answer?.page?.url || e.url || '',
  };
}

// ---------- the dock's height ----------

export const DOCK_MIN = 180;
export const STAGE_KEEP = 120; // what the preview keeps when the dock is pulled tall

/** The dock's height for a wish, between 180 px and the stage's height (preview + dock) less 120 px. */
export function clampDockHeight(want, stageHeight) {
  const max = Math.max(DOCK_MIN, Math.floor((Number(stageHeight) || 0) - STAGE_KEEP));
  const n = Math.round(Number(want));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(DOCK_MIN, n));
}

/** A panel narrower than this stacks the trajectory under the thread, collapsed to its state line. */
export const SPLIT_MIN_PX = 760;
export const isStacked = (width) => Number(width) > 0 && Number(width) < SPLIT_MIN_PX;
