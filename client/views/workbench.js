// Workbench (DESIGN.md section 8, composed after the reference concept): the stage in the middle with the preview in
// a frame on a dotted canvas, a line above it (page / device · version) and one under it (what the preview shows,
// what is selected); the pages and their parts in the left column (the Page panel, mounted there by its own dock)
// with the last version under them; the task inspector on the right (components/collab.js); the runs as a timeline
// under the stage (components/working-now.js), hidden unless the More menu's toggle shows it; the band at the bottom
// (the dock: Claude Code, Terminal, Source and the kind's panels); the version strip and a status line under it;
// the Versions drawer over it all.
import { el, clear, button, icon, empty, errorBox, toast, shortLabel, closeDialogsIn, segmented, ago } from '../components/ui.js';
import { previewUrl } from '../api.js';
import { keepDialog, compareDialog, sideBySideCompare, restoreDialog, buildFlow, currentVersion, vname, fullName, stateLabel, stateMeaning, PREFERRED_MEANING } from '../components/version-actions.js';
import { renderVersions } from '../components/versions-drawer.js';
import { createVersionStrip } from '../components/version-strip.js';
import { createWorkingNow } from '../components/working-now.js';
import { createBus } from '../components/bus.js';
import { createDock, panelKinds } from '../components/dock.js';
import { createPreviewFocus } from '../components/preview-focus.js';
import { createGhost } from '../components/ghost.js';
import { createStageSide } from '../components/stage-side.js';
import { endSentence, previewedElsewhere } from '../components/words.js';
import { deviceOf, capWords, stageFoot, statusWords, RUNS_TOGGLE, runsToggle } from '../components/stage-words.js';
import { createSplitter } from '../components/splitter.js';
import { createLiveSwitch } from '../components/live-switch.js';
import { liveFrameUrl, LIVE_SELECT_TITLE } from '../components/live-words.js';

let ui = null;

export function mount(host, app) {
  const bus = createBus();
  const frame = el('iframe', { title: 'Preview of the product', allow: 'autoplay; fullscreen; gamepad', referrerpolicy: 'same-origin' });
  const overlay = el('div.preview-overlay', { hidden: true });
  // The preview swallows Tab presses (the game takes focus): a link before it skips to the band.
  const skip = el('a.sr-only.focusable', { href: '#', onclick: (e) => { e.preventDefault(); focusDock(); } }, 'Skip past the preview');
  // The side slot: on wide windows the phone's screen sits here, to the right of the preview (components/stage-side.js);
  // with the device set to Phone it fills the stage instead.
  const sideNode = el('aside.stage-side', { hidden: true, 'aria-label': 'Beside the preview' });
  const previewWrap = el('div.preview-wrap', skip, frame, overlay, sideNode);
  const stageSide = createStageSide({ node: sideNode, host: previewWrap });
  const head = el('div.stage-head', { role: 'toolbar', 'aria-label': 'Preview controls' });
  const cap = el('div.stage-cap', el('span.stage-cap-left'), el('span.stage-cap-right'));
  const foot = el('div.stage-foot', el('span.stage-foot-left'), el('span.stage-foot-right'));
  const banner = el('div.banner', { hidden: true, role: 'status' });
  const stage = el('section.wb-stage', { 'aria-label': 'Preview' }, head, banner, cap, previewWrap, foot);
  // The left column: the Page panel (its own dock, no tabs) under "Project · n pages", the last version under it.
  const leftCount = el('span.left-count');
  const leftFoot = el('div.left-foot');
  // The column collapses whole into a tag at the stage head's left (Project · n pages); the tag opens it again (p).
  const leftHide = button('', { icon: 'sidebar', small: true, variant: 'quiet', class: 'left-hide', title: 'Collapse the pages column to a tag (p)', 'aria-expanded': 'true', onclick: () => toggleLeft(true) });
  const left = el('aside.wb-left', { id: 'wb-left', 'aria-label': 'Pages and parts' }, el('div.left-head', el('span.overline', 'Project'), leftCount, leftHide), leftFoot);
  const leftTagCount = el('span.left-tag-count');
  const leftTag = el('button.btn.quiet.sm.left-tag', { type: 'button', title: 'Open the pages column (p)', 'aria-expanded': 'false', 'aria-controls': 'wb-left', onclick: () => toggleLeft(false) }, icon('sidebar'), el('span.left-tag-name', 'Project'), leftTagCount);
  const main = el('div.wb-main', left, stage);
  const drawer = el('section.drawer', { hidden: true, 'aria-label': 'Versions' });
  const drawerBody = el('div.drawer-body');
  const versionsBtnSlot = el('div.versions-btn');
  const strip = createVersionStrip(app);
  const versionsBar = el('div.versions-bar', versionsBtnSlot, strip.node);
  const workingNow = createWorkingNow();
  const status = el('div.wb-status', el('span.wb-status-left'), el('span.wb-status-right'));
  const root = el('div.wb');
  ui = { app, bus, frame, overlay, previewWrap, stageSide, head, cap, foot, banner, left, leftCount, leftFoot, leftHide, leftTag, leftTagCount, drawer, drawerBody, versionsBar, versionsBtnSlot, strip, workingNow, status, root, ref: 'head', projectId: null, offs: [], doneTasks: null, device: 'desktop', focus: false, selection: null, leftOpen: false };
  // The stage is what the preview and the band's body share: the band may take it all but 120 px.
  const stageHeight = () => previewWrap.getBoundingClientRect().height + (ui?.dock.node.querySelector('.dock-body')?.getBoundingClientRect().height || 0);
  // The Phone tab (the emulator) only when the studio setting asks for it: development happens in the Mobile frame.
  ui.dock = createDock(app, { bus, frame, setPreviewWidth, stageHeight, stageSide, kinds: (m) => panelKinds(m, { phone: app.state.settings?.ui?.phonePanel === true }).filter((k) => k !== 'page') });
  ui.leftDock = createDock(app, { bus, frame, setPreviewWidth, stageHeight: () => 0, stageSide: null, kinds: (m) => panelKinds(m).filter((k) => k === 'page'), bare: true, key: 'atelier.dock.left', onCount: (kind, n) => renderLeftCount(n) });
  left.insertBefore(ui.leftDock.node, leftFoot);
  // Live: the project's own server in the frame when atelier.json declares one and the person switched it on.
  ui.live = createLiveSwitch(app, { onChange: (running, flipped) => { if (flipped && ui?.projectId && ui.ref === 'head') setSrc('head'); renderHead(); renderFoot(); } });
  ui.offs.push(() => ui.live.destroy());
  ui.previewFocus = createPreviewFocus({ frame, fallback: () => head.querySelector('button') });
  // Who is working where: a label in the preview's corner, outside the frame (the frame reloads); Reload is the person's.
  ui.ghost = createGhost(app, { frame, reload: () => tryHead(), h: { el, button }, accent: cssAccent });
  previewWrap.append(ui.ghost.node);
  ui.offs.push(() => ui.ghost.destroy());
  previewWrap.addEventListener('pointerdown', () => ui?.previewFocus.press(), true);
  // The pages column's width and the timeline's height are the person's, dragged on their edges and kept as layout prefs.
  left.append(createSplitter({ axis: 'x', sign: 1, min: 180, max: 480, label: 'Width of the pages column',
    read: () => left.getBoundingClientRect().width || 236, apply: (px) => root.style.setProperty('--left-w', `${px}px`),
    save: (px) => app.setLayoutPref('studio', 'leftWidth', px).catch((err) => toast(`Width not saved: ${err.message}`, { tone: 'danger' })) }));
  workingNow.node.append(createSplitter({ axis: 'y', sign: -1, min: 96, max: 420, label: 'Height of the timeline',
    read: () => workingNow.node.getBoundingClientRect().height || 156, apply: (px) => { workingNow.node.style.height = `${px}px`; },
    save: (px) => app.setLayoutPref('studio', 'timelineHeight', px).catch((err) => toast(`Height not saved: ${err.message}`, { tone: 'danger' })) }));
  root.append(main, workingNow.node, ui.dock.node, versionsBar, status, drawer);
  clear(host, root);
  applySizes();

  // Narrow windows: the Task | Focus overlay starts where the stage head ends (styles.css).
  const appRoot = document.getElementById('app');
  const measureTop = () => {
    const edge = head.getBoundingClientRect().bottom;
    appRoot.style.setProperty('--wb-top', `${Math.ceil(edge - root.getBoundingClientRect().top)}px`);
  };
  const topObserver = new ResizeObserver(measureTop);
  topObserver.observe(head);
  ui.offs.push(() => { topObserver.disconnect(); appRoot.style.removeProperty('--wb-top'); });
  // The Workbench resizes with the window: the side slot reads the window's width again (1440 px, 24 px hysteresis).
  const sideObserver = new ResizeObserver(() => stageSide.measure());
  sideObserver.observe(root);
  ui.offs.push(() => { sideObserver.disconnect(); stageSide.empty(); });

  const onMessage = (e) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
    bus.receive(e.data);
  };
  window.addEventListener('message', onMessage);
  frame.addEventListener('load', () => {
    // A press inside the frame fires in its own document and never reaches previewWrap.
    frame.contentDocument?.addEventListener('pointerdown', () => ui?.previewFocus.press(), true);
    ui.previewFocus.loaded();
    checkPreview();
  });
  ui.offs.push(() => window.removeEventListener('message', onMessage));
  ui.offs.push(app.on('bundle', () => render()));
  ui.offs.push(app.on('project-switch', () => render()));
  ui.offs.push(app.on('runs', () => { renderWorkingNow(); renderStatus(); }));
  ui.offs.push(app.on('terminal', () => renderStatus()));
  // The selected part (the Page panel's Point, the Phone's) is named under the frame.
  ui.offs.push(app.on('ghost-readout', (r) => { if (!ui || r?.projectId !== ui.projectId) return; ui.selection = r.element || null; renderFoot(); }));
  ui.offs.push(() => workingNow.destroy());
  // Esc closes the Versions drawer (a dialog or the side-by-side overlay handles its own Esc first).
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !app.layout().versionsOpen.value) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    app.toggleVersions(false);
  };
  document.addEventListener('keydown', onKey);
  ui.offs.push(() => document.removeEventListener('keydown', onKey));
  ui.offs.push(app.on('layout', () => { applySizes(); if (ui?.projectId && app.state.bundle) renderHead(); renderDrawer(); }));
  app.workbench = { bus, tryHead, viewVersion, keep: () => keepDialog(app), compare: () => compareDialog(app), sideBySide: (opts) => sideBySideCompare(app, opts), host: () => ui.previewWrap, collapseDock: (c) => ui?.dock.collapse(c), restore: () => restoreDialog(app), build: () => buildFlow(app), previewRef: () => ui?.ref,
    focus: () => setFocus(!ui?.focus), togglePages: () => toggleLeft(), device: (d) => setDevice(d),
    // studio.show: the panels belong to the project on screen, so a panel is shown only once it is that project.
    projectOnScreen: () => ui?.projectId || null, ghost: () => (ui?.projectId ? { projectId: ui.projectId, model: ui.ghost.model() } : null),
    showPanel: (kind, command) => (ui?.projectId ? (kind === 'page' ? ui.leftDock : ui.dock).show(kind, command) : Promise.resolve(false)) };
  render();
}

export function unmount() {
  if (!ui) return;
  // The side-by-side overlay lives in the preview area: leaving the view closes it, so its listeners and live targets go with it.
  closeDialogsIn(ui.previewWrap);
  ui.offs.forEach((off) => off());
  ui.dock.destroy();
  ui.leftDock.destroy();
  const note = document.getElementById('view-note');
  if (note) clear(note);
  ui.app.workbench = null;
  ui = null;
}

// ---------- preview ----------
function setSrc(ref) {
  const { frame, bus, projectId } = ui;
  ui.previewWrap.classList.remove('switching');
  ui.ref = ref;
  ui.previewFocus.loading();
  bus.reset();
  ui.overlay.hidden = true;
  // A query string busts any cached document so "Try" always shows the files on disk now. With Live on, the head is
  // the project's own server: /live/<id> answers with a 302 to its address, so the token never passes through here.
  frame.src = ref === 'head' && ui.live.running() ? liveFrameUrl(projectId) : `${previewUrl(projectId, ref, ui.app.state.bundle?.manifest?.entry)}?t=${Date.now()}`;
  renderBanner();
  renderCap();
  renderFoot();
  renderDrawer();
}
/** The project on screen is no longer the active one: its overlays and preview go, so a game stops playing behind the
 *  loading state and an error box has nothing of the old project under it. Does nothing once left. */
function leaveProject() {
  if (!ui.projectId) return;
  closeDialogsIn(ui.previewWrap); // e.g. the side-by-side overlay
  ui.projectId = null;
  ui.ref = 'head';
  ui.selection = null;
  ui.overlay.hidden = true;
  ui.ghost.leave(); // the marker is per project: another project's sessions draw nothing here
  ui.stageSide.empty(); // another project's phone screen never sits beside this preview
  ui.live.setProject(null); // the server stops another project's live server when the switch activates the new one
  ui.previewWrap.classList.add('switching');
  ui.frame.src = 'about:blank';
  renderBanner();
  renderDrawer();
}
function tryHead() {
  if (!ui?.projectId) return;
  setSrc('head');
  toast('Preview reloaded from the files on disk', { timeout: 1600 });
}
function viewVersion(vid) {
  if (!ui?.projectId) return;
  setSrc(vid);
  // Trying a version from its row hands the keyboard to it, so its load does not take it back.
  ui.previewFocus.press();
  ui.frame.focus();
}
function focusDock() {
  const tabs = ui?.dock.node.querySelectorAll('[role="tab"]') || [];
  ([...tabs].find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0] || ui?.dock.node.querySelector('button'))?.focus();
}
function cssAccent() {
  try { return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || undefined; } catch { return undefined; }
}
/** The preview's width: null for the full stage, a number of px for a device (the Devices panel and the stage's own
 *  picker both call this; the picker reads back what was set). */
function setPreviewWidth(px) {
  ui.frame.style.width = px ? `${px}px` : '100%';
  ui.previewWrap.classList.toggle('device', !!px);
  if (ui.device !== 'phone' || px) ui.device = deviceOf(px || null, false);
  renderHead();
  renderCap();
}
/** Desktop: the preview at the stage's width; mobile: 390 px in a frame; phone: the device's own screen in the middle
 *  (the Phone panel's screen moves into the slot, which fills the stage: components/stage-side.js force). */
function setDevice(d) {
  if (!ui) return;
  const want = ['desktop', 'mobile', 'phone'].includes(d) ? d : 'desktop';
  ui.device = want;
  ui.previewWrap.classList.toggle('stage-phone', want === 'phone');
  if (want === 'phone') {
    ui.frame.style.width = '100%';
    ui.previewWrap.classList.remove('device');
    ui.stageSide.force(true);
    ui.dock.toSide('phone', true);
  } else {
    ui.stageSide.force(false);
    setPreviewWidth(want === 'mobile' ? 390 : null);
  }
  renderHead();
  renderCap();
}
/** Expand (f): only the preview; the columns, the timeline and the band step aside. */
function setFocus(on) {
  if (!ui) return;
  ui.focus = !!on;
  ui.root.classList.toggle('focus', ui.focus);
  renderHead();
}
function checkPreview() {
  // Same-origin preview: if the server answered with a JSON error instead of a page, say so plainly.
  try {
    const doc = ui.frame.contentDocument;
    if (doc && doc.contentType === 'application/json') {
      let msg = 'The preview could not be served.';
      try { msg = JSON.parse(doc.body.innerText).error.message; } catch { /* keep default */ }
      clear(ui.overlay, el('div.empty.error', el('div.empty-title', 'Nothing to preview'), el('p', msg),
        el('p.small', 'The manifest entry (atelier.json → entry) must point at an HTML file.')));
      ui.overlay.hidden = false;
    }
  } catch { /* cross-origin content: nothing to check */ }
}

// ---------- render ----------
function render() {
  const { app } = ui;
  const s = app.state;
  if (!s.activeProjectId) {
    ui.projectId = null;
    ui.ghost.leave();
    clear(ui.head);
    clear(ui.overlay, empty('Create a project from a template, or import a folder.', null, button('New project', { variant: 'primary', onclick: () => app.newProject() })));
    ui.overlay.hidden = false;
    renderViewNote(null);
    return;
  }
  const b = s.bundle;
  if (!b || b.project.id !== s.activeProjectId) {
    leaveProject();
    clear(ui.head, s.bundleError && !b ? el('span.muted', 'Project unavailable') : el('span.muted', 'Loading…'));
    if (s.bundleError && !b) {
      clear(ui.overlay, errorBox(s.bundleError, () => app.loadBundle()));
      ui.overlay.hidden = false;
    }
    renderViewNote(null, { loading: !(s.bundleError && !b) });
    return;
  }
  // A task that just became Done (Record the result) closes the "what is on disk now" banner for its version.
  const done = new Set((b.tasks || []).filter((t) => t.status === 'done').map((t) => t.id));
  const justDone = ui.doneTasks && ui.projectId === b.project.id ? (b.tasks || []).filter((t) => done.has(t.id) && !ui.doneTasks.has(t.id)) : [];
  ui.doneTasks = done;
  if (ui.projectId !== b.project.id) {
    leaveProject();
    ui.projectId = b.project.id;
    ui.device = 'desktop';
    ui.previewWrap.classList.remove('stage-phone');
    ui.stageSide.force(false);
    setPreviewWidth(null);
    ui.previewFocus.chosen();
    setSrc('head');
    ui.dock.setProject(b);
    ui.leftDock.setProject(b);
    ui.ghost.setProject(b);
    ui.live.setProject(b);
  } else {
    ui.live.update(b);
    ui.dock.update(b);
    ui.leftDock.update(b);
    if (ui.ref !== 'head' && !b.versions.some((v) => v.id === ui.ref)) setSrc('head');
    else if (ui.ref !== 'head' && ui.banner.classList.contains('same') && justDone.some((t) => t.result?.versionId === ui.ref)) setSrc('head');
  }
  renderHead();
  renderCap();
  renderFoot();
  renderLeftFoot(b);
  renderViewNote(b);
  renderBanner();
  renderDrawer();
  renderStatus();
}

/** The sizes from the layout prefs: the pages column's width and the timeline's height (none: the stylesheet's);
 *  the timeline itself only when runsShown asks for it, so by default the preview takes its height. */
function applySizes() {
  if (!ui) return;
  const l = ui.app.layout();
  ui.root.classList.toggle('left-collapsed', !!l.leftCollapsed?.value);
  const lw = Number(l.leftWidth?.value);
  if (Number.isFinite(lw) && lw > 0) ui.root.style.setProperty('--left-w', `${lw}px`); else ui.root.style.removeProperty('--left-w');
  const th = Number(l.timelineHeight?.value);
  ui.workingNow.node.style.height = Number.isFinite(th) && th > 0 ? `${th}px` : '';
  ui.workingNow.node.hidden = !runsToggle(l.runsShown).shown;
}

/** The More menu's toggle: shows or hides the timeline, kept as the studio's layout pref (Settings shows it too). */
function toggleRuns() {
  if (!ui) return;
  const t = runsToggle(ui.app.layout().runsShown);
  ui.app.setLayoutPref(t.scope, 'runsShown', t.next)
    .then(() => ui?.head.querySelector('.wb-actions > summary')?.focus()) // the layout event has redrawn the menu, closed
    .catch((err) => toast(`Not saved: ${err.message}`, { tone: 'danger' }));
}

/** The stage head: the device, Select (Point on the page) and Expand at the left; Try and More at the right. */
function renderHead() {
  if (!ui?.projectId || !ui.app.state.bundle) return;
  const { app } = ui;
  const hasPhone = ui.dock.kinds().includes('phone');
  const options = [['desktop', 'Desktop'], ['mobile', 'Mobile']];
  if (hasPhone) options.push(['phone', 'Phone']);
  const seg = segmented(options, ui.device, (v) => setDevice(v), { label: 'Device' });
  const collabCollapsed = app.layout().collabCollapsed.value;
  const narrow = app.isNarrow?.();
  const focusedLabel = ui.head.contains(document.activeElement) && document.activeElement !== ui.leftTag ? document.activeElement.textContent : null;
  const liveFocus = ui.live.node.contains(document.activeElement) ? document.activeElement : null; // the switch keeps the keyboard across a redraw
  const quiet = (label, onclick, title, more = {}) => button(label, { small: true, variant: 'quiet', onclick, title, ...more });
  const leftCollapsed = !narrow && !!app.layout().leftCollapsed?.value;
  clear(ui.head,
    leftCollapsed ? ui.leftTag : null,
    seg.node,
    quiet('Select', () => ui.leftDock.show('page', { point: true }), liveShown() ? LIVE_SELECT_TITLE : 'Point at a part of the page: a click on the preview reads the element under it (Esc leaves)', { disabled: liveShown() }),
    quiet('Expand', () => setFocus(!ui.focus), 'Only the preview: the columns, the timeline and the band step aside (f)', { 'aria-pressed': String(ui.focus) }),
    ui.live.node,
    el('span.spacer'),
    narrow ? quiet('Pages', () => { ui.leftOpen = !ui.leftOpen; ui.root.classList.toggle('left-open', ui.leftOpen); }, 'Show or hide the pages column', { 'aria-pressed': String(ui.leftOpen) }) : null,
    quiet('Try', tryHead, 'Reload the preview from the files on disk (t)'),
    quiet('Side by side', () => sideBySideCompare(app), 'Two live previews with mirrored keys (s)', { 'aria-label': 'Side by side compare' }),
    el('details.wb-more.wb-actions', { ontoggle: (e) => { if (!e.target.open) return; const close = (ev) => { if (!e.target.contains(ev.target)) { e.target.open = false; document.removeEventListener('pointerdown', close); } }; document.addEventListener('pointerdown', close); } },
      el('summary.btn.quiet.sm', { title: 'Keep, compare, restore, build' }, 'More', icon('chevron')),
      el('div.wb-more-menu', { role: 'menu' },
        quiet('Keep version', () => keepDialog(app), 'Keep the files on disk as a new version (k)'),
        quiet('Compare', () => compareDialog(app), 'Compare two versions (c)'),
        quiet('Restore', () => restoreDialog(app), 'Restore an earlier version'),
        quiet('Build/Export', () => buildFlow(app), 'Build a zip from the current version', { 'aria-label': 'Build or export' }),
        el('div.wb-more-sep', { role: 'separator' }),
        runsItem())),
    narrow
      ? button('Panel', { small: true, variant: 'quiet', class: 'wb-panel-btn', 'aria-expanded': String(!collabCollapsed), title: 'Open or close the Task inspector over the preview (])', onclick: () => app.toggleLayout('collabCollapsed') })
      : collabCollapsed ? button('', { icon: 'sidebar', small: true, variant: 'quiet', class: 'wb-panel-btn', title: 'Show the Task inspector (])', onclick: () => app.toggleLayout('collabCollapsed', false) }) : null);
  if (liveFocus) liveFocus.focus();
  else if (focusedLabel) [...ui.head.querySelectorAll('button, summary')].find((x) => x.textContent === focusedLabel)?.focus(); // More's summary too
}

/** The More menu's Show runs item: a checkbox item, ticked while the timeline is on screen. */
function runsItem() {
  const shown = runsToggle(ui.app.layout().runsShown).shown;
  return el('button.btn.quiet.sm', { type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(shown), title: shown ? 'Hide the runs under the preview; the Processes panel still lists them' : 'Show this project\'s runs of the last hour under the preview', onclick: toggleRuns },
    el('span.wb-more-tick', { 'aria-hidden': 'true' }, shown ? icon('check') : null), el('span', RUNS_TOGGLE));
}

/** The version pill in the view row (the reference's branch chip): #n label, the star when preferred. */
function renderViewNote(b, { loading = false } = {}) {
  const note = document.getElementById('view-note');
  if (!note) return;
  if (!b) return clear(note, loading ? el('span.version-pill.loading', 'Loading…') : null);
  const { app } = ui;
  const cur = currentVersion(b);
  const files = b.changes?.files || [];
  const pill = cur
    ? el('button.version-pill', { type: 'button', title: `Current version: ${fullName(cur)}\n${stateLabel(cur.state)} (${stateMeaning(cur.state)})${cur.userPreferred ? ` · ${PREFERRED_MEANING.toLowerCase()}` : ''} — open Versions (v)`, onclick: () => app.toggleVersions(true) },
      el('span.ellipsis', `#${cur.n} ${shortLabel(cur.label, 40)}`), cur.userPreferred ? icon('star', 'preferred') : null)
    : el('span.version-pill', b.versions.length ? 'Not at a kept version' : 'No versions yet');
  pill.querySelector?.('svg')?.classList.add('star-on');
  const pref = b.versions.filter((v) => v.userPreferred && v.id !== cur?.id).sort((x, y) => y.n - x.n)[0];
  const prefStar = pref
    ? el('button.pref-elsewhere', { type: 'button', title: `Preferred: ${vname(pref)}`, 'aria-label': `Preferred: ${vname(pref)}`, onclick: () => app.toggleVersions(true) }, icon('star'))
    : null;
  const changes = el(`span.changes${files.length ? '.dirty' : ''}`, { title: files.map((f) => `${f.status} ${f.path}`).join('\n') || 'The files on disk match the current version' },
    files.length ? `${files.length} file${files.length > 1 ? 's' : ''} changed` : '');
  clear(note, changes, pill, prefStar);
}

function renderLeftCount(n) {
  if (!ui) return;
  ui.leftCount.textContent = Number.isFinite(n) && n > 0 ? `${n} page${n === 1 ? '' : 's'}` : '';
  ui.leftTagCount.textContent = ui.leftCount.textContent;
}

/** Collapse the pages column to its tag, or open it again (a session layout pref; Settings can make it durable).
 *  Focus follows: to the tag when the column goes, to the column's collapse button when it comes back. */
function toggleLeft(value) {
  if (!ui) return Promise.resolve();
  return ui.app.toggleLayout('leftCollapsed', value).then(() => requestAnimationFrame(() => {
    if (!ui) return;
    (ui.app.layout().leftCollapsed?.value ? ui.leftTag : ui.leftHide).focus();
  }));
}

/** Under the pages: the last version kept, and Compare (the reference's "Last checkpoint · Compare with draft"). */
function renderLeftFoot(b) {
  const { app } = ui;
  const last = [...(b.versions || [])].sort((x, y) => y.n - x.n)[0] || null;
  clear(ui.leftFoot,
    el('span.overline', 'Last version'),
    last
      ? el('button.left-version', { type: 'button', title: `${fullName(last)} — open Versions (v)`, onclick: () => app.toggleVersions(true, { versionId: last.id }) }, icon('check'), el('span.ellipsis', `#${last.n} ${shortLabel(last.label, 44)}`))
      : el('p.meta', 'No version yet'),
    button('Compare with the files on disk', { small: true, variant: 'quiet', class: 'left-compare', title: 'Compare two versions (c)', onclick: () => compareDialog(app) }));
}

/** The frame shows the project's live server (Live on and the head, not a version, in view). */
const liveShown = () => !!ui?.live.running() && ui.ref === 'head';
function capModel() {
  const b = ui.app.state.bundle;
  const cur = currentVersion(b);
  const viewing = ui.ref !== 'head' ? b.versions.find((v) => v.id === ui.ref) || null : null;
  return { current: cur, viewing, changed: (b.changes?.files || []).length, versionCount: b.versions.length };
}
function renderCap() {
  if (!ui?.projectId || !ui.app.state.bundle) return;
  const b = ui.app.state.bundle;
  const width = ui.device === 'mobile' ? 390 : parseInt(ui.frame.style.width, 10) || null;
  const w = capWords({ pageName: b.project?.ui?.pageInView?.name || null, entry: b.manifest?.entry || null, device: ui.device, width, ...capModel() });
  ui.cap.firstChild.textContent = liveShown() ? `Live · ${ui.live.label()}` : w.left;
  ui.cap.lastChild.textContent = liveShown() ? ui.live.host() || '' : w.right;
}
function renderFoot() {
  if (!ui?.projectId || !ui.app.state.bundle) return;
  // No line while the frame shows the live server; a failed or invalid Live says why here, the toolbar has no room.
  const w = stageFoot({ ...capModel(), selection: ui.selection, liveShown: liveShown(), live: ui.ref === 'head' ? ui.live.words() : null });
  ui.foot.hidden = w.hidden;
  ui.foot.firstChild.textContent = w.left;
  ui.foot.lastChild.textContent = w.right;
}
function renderStatus() {
  if (!ui) return;
  const { app } = ui;
  const runs = (app.state.runs || []).filter((r) => r.projectId === ui.projectId);
  const working = runs.filter((r) => !r.endedAt);
  const w = statusWords({ working, shells: 0, version: app.state.studio?.version ? `v${app.state.studio.version}` : null });
  ui.status.classList.toggle('working', working.length > 0);
  ui.status.firstChild.textContent = w.left;
  ui.status.lastChild.textContent = w.right;
}

function renderBanner() {
  const { app, banner } = ui;
  if (!ui.projectId || ui.ref === 'head') { banner.hidden = true; return; }
  const v = app.state.bundle?.versions?.find((x) => x.id === ui.ref);
  banner.hidden = false;
  // The version is exactly what is on disk (its commit is HEAD and nothing changed since): nothing to restore.
  const onDisk = v && !previewedElsewhere(app.state.bundle, ui.ref);
  banner.classList.toggle('same', !!onDisk);
  if (onDisk) {
    clear(banner, el('span.ellipsis', { style: { flex: 1 }, title: fullName(v) }, `This version is what is on disk now: #${v.n} ${shortLabel(v.label, 40)}`),
      button('Back to the live preview', { small: true, variant: 'quiet', title: 'Show the files on disk with live tuning again', onclick: () => setSrc('head') }));
    return;
  }
  clear(banner, icon('alert'), el('span.ellipsis', { style: { flex: 1 }, title: fullName(v) }, `${endSentence(`Previewing ${vname(v)}`)} Tuning and edits still apply to the files on disk.`),
    button('Back to the files on disk', { small: true, onclick: () => setSrc('head') }),
    button('Restore this version', { small: true, variant: 'quiet', onclick: () => restoreDialog(app, { versionId: ui.ref }) }));
}

/** The timeline draws the project on screen only (null during a switch); the Versions drawer lies over it when open. */
function renderWorkingNow() {
  if (!ui) return;
  if (ui.workingNow.node.hidden) return ui.workingNow.update([], null); // hidden: no rows, so no clock ticks under it
  const b = ui.app.state.bundle;
  ui.workingNow.update(ui.app.state.runs, ui.projectId, { name: ui.projectId && b?.project?.id === ui.projectId ? b.project.name : '', note: String(ui.app.state.runsNote || '').replace(/ at (\d{4}-\S+)$/, (m, iso) => ` ${ago(iso)}`) });
}

function renderDrawer() {
  if (!ui) return;
  const { app, drawer, drawerBody, versionsBar, versionsBtnSlot, strip } = ui;
  const open = !!app.layout().versionsOpen.value && !!app.state.bundle;
  const n = app.state.bundle?.versions?.length || 0;
  const btnFocused = versionsBtnSlot.contains(document.activeElement); // a live refresh replaces the button: it keeps the focus
  clear(versionsBtnSlot,
    button(`Versions${n ? ` · ${n}` : ''}`, { small: true, variant: 'quiet', 'aria-expanded': String(open), title: 'Open the version history (v)', onclick: () => app.toggleVersions() }));
  // The strip draws the project on screen only: during a switch the old project's marks go with its preview.
  const b = app.state.bundle;
  strip.update(ui.projectId && b?.project?.id === ui.projectId ? b : null, { viewingId: ui.ref !== 'head' ? ui.ref : null });
  renderWorkingNow();
  versionsBar.hidden = open;
  drawer.hidden = !open;
  if (btnFocused && !open) versionsBtnSlot.querySelector('button').focus();
  if (!open) return;
  clear(drawer,
    el('div.drawer-head', el('h2', { style: { flex: 1 } }, `Versions · ${n}`),
      button('', { icon: 'x', small: true, variant: 'quiet', title: 'Close versions (v)', onclick: () => app.toggleVersions(false) })),
    drawerBody);
  renderVersions(drawerBody, app, { viewing: ui.ref !== 'head' ? ui.ref : null });
}
