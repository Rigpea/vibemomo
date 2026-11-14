// Panel strip under the preview: one tab per workbench panel that applies to the project. Companion first on every
// project, Codex beside it, Page next on every kind but audio, Source (a read-only file viewer) and Terminal on every project, then its kind, "action" when the manifest has tuning, "audio" when it has cues and "phone" when the server
// inferred a device provider into manifest.devices. The last tab and the dock's height are the project's
// (project.ui.dockTab, project.ui.dockHeight); the grip on the tab row pulls the dock tall, a double-click on it
// gives the default back. The person arranges the tabs (project.ui.dockOrder) by dragging or Alt+Left/Right, and
// drags one panel onto the stage to sit beside the preview (project.ui.stageSide; Alt+Up / Alt+Down by keyboard):
// see ./dock-arrange.js. A move never remounts a panel: its container (or the phone's screen) changes parent.
import { el, clear, button, loading, toast } from './ui.js';
import { clampDockHeight, DOCK_MIN } from './companion-words.js';
import { orderKinds, moveTo, sameOrder, movedWords, createTabDrag } from './dock-arrange.js';

const LABELS = { companion: 'Claude Code', codex: 'Codex', page: 'Page', source: 'Source', terminal: 'Terminal', game: 'Play', 'web-app': 'Devices', action: 'Tuning', audio: 'Audio', phone: 'Phone' };
const label = (k) => LABELS[k] || k;
const SS = 'atelier.dock';
const readPrefs = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; } };
const writePrefs = (key, p) => sessionStorage.setItem(key, JSON.stringify({ ...readPrefs(key), ...p }));
const KEY_STEP = 24; // px per arrow key on the grip

/** phone: the Phone tab (the Android emulator in the Workbench) only when the studio setting ui.phonePanel asks for it;
 *  off since the reference pass (decision row 125): development happens in the Mobile frame, the emulator before a launch. */
export function panelKinds(manifest = {}, { phone = false } = {}) {
  const kinds = ['companion', 'codex']; // the two brains side by side: Claude Code, then Codex (workbenches/codex/panel.js)
  if (manifest.kind !== 'audio') kinds.push('page'); // every kind with a web entry to read
  kinds.push('source'); // every project: its files, read-only, right after Page
  kinds.push('terminal'); // every project: its own shells (after Page, or after Companion where there is no Page)
  if (LABELS[manifest.kind] && manifest.kind !== 'action' && manifest.kind !== 'audio') kinds.push(manifest.kind);
  if (manifest.tuning || manifest.kind === 'action') kinds.push('action');
  if (manifest.cues?.length || manifest.kind === 'audio') kinds.push('audio');
  if (phone && manifest.devices && typeof manifest.devices === 'object' && Object.keys(manifest.devices).length) kinds.push('phone');
  return [...new Set(kinds)];
}

const defaultLoad = (kind) => import(`/workbenches/${kind}/panel.js`);

/** stageHeight(): the height the preview and the dock's body share, which bounds how tall the dock may be pulled. */
/** stageSide: the side slot beside the preview (components/stage-side.js), handed to panels as ctx.stageSide; while it
 *  is wide the Phone panel is mounted (hidden) even when its tab was never opened, so its screen can sit there.
 *  loadPanel(kind): the panel module (tests hand in their own). */
/** kinds(manifest): which kinds this dock holds (the Workbench runs two: the band, and the left column's for the Page
 *  panel; the Learning view one, the Companion alone); bare: no tab row or grip, the one panel fills the body; key: the
 *  sessionStorage key of its collapsed state; onCount(kind, n): told whenever a panel's count changes (the left column
 *  shows "n pages"). The Learning view's dock (views/learning.js) also passes: heightKey, the project.ui key its height
 *  is kept under (default dockHeight, the Workbench's); saveTab false, so a click on its tab does not become the
 *  Workbench's last tab (project.ui.dockTab); arrange false, no dragging, Alt+arrows or Reset arrangement, because
 *  dockOrder and stageSide are the Workbench's; label, the dock's accessible name. */
export function createDock(app, { bus, frame, setPreviewWidth, stageHeight = () => window.innerHeight, stageSide = null, loadPanel = defaultLoad, kinds: kindsOf = panelKinds, bare = false, key = SS, onCount = null,
  heightKey = 'dockHeight', saveTab = true, arrange = true, label: dockLabel = 'Workbench panels' }) {
  const prefs = () => readPrefs(key);
  const savePrefs = (p) => writePrefs(key, p);
  const tabs = el('div.dock-tablist', { role: 'tablist', 'aria-label': dockLabel });
  const grip = el('div.dock-grip', {
    role: 'separator', tabIndex: 0, 'aria-orientation': 'horizontal', 'aria-label': 'Dock height',
    title: 'Drag to change the dock\'s height (Up and Down arrows too); double-click for the default',
  });
  const dropLine = el('span.dock-drop-line', { hidden: true, 'aria-hidden': 'true' });
  const live = el('span.sr-only.dock-live', { role: 'status', 'aria-live': 'polite' });
  const note = el('span.dock-note', { hidden: true }); // the active panel's words at the right of the tabs (the companion's session)
  const notes = new Map(); // kind → its note
  const head = el('div.dock-tabs', grip, tabs, dropLine, live);
  const away = el('p.meta.dock-away', { hidden: true }); // the active tab's panel is beside the preview
  // A bare dock (the left column's) has no tab row or grip in the DOM and its body is div.dock-panel, so a query for
  // .dock-body, .dock-grip or the tabs means the band.
  const body = el(bare ? 'div.dock-panel' : 'div.dock-body', { role: bare ? undefined : 'tabpanel' }, away);
  const node = el(`section.dock${bare ? '.bare' : ''}`, { 'aria-label': bare ? 'Pages' : dockLabel }, bare ? null : head, body);
  // The side slot's head: which panel is there, a handle to drag it back, and a button that does the same.
  const sideName = el('span.side-name');
  const sideHandle = el('span.side-handle', { title: 'Drag onto the dock\'s tabs to put it back' }, sideName);
  const sideHead = el('div.side-head', { hidden: true }, sideHandle,
    button('Back to the dock', { small: true, variant: 'quiet', onclick: () => { const k = stageSide?.heldKind(); if (k) toSide(k, false); } }));
  const targetLabel = el('div.side-drop', 'Beside the preview');
  let kinds = []; // the project's kinds in the default order
  let order = []; // the same kinds in the person's order: the tabs as drawn
  let active = null;
  const mounted = new Map(); // kind → { mod, ctx, container, inSide } for the current project
  const counts = new Map(); // kind → a number its panel reports, shown on its tab
  const watchers = new Map(); // kind → stop(): a count watched before the panel mounts (the module's watchCount)
  const sideSubs = new Set(); // panels that place something in the slot themselves (the phone): told on every change
  let projectId = null;
  let generation = 0; // bumped on project change / destroy so stale imports never mount

  const project = () => (app.state.bundle?.project?.id === projectId ? app.state.bundle.project : null);
  /** The kind the person put beside the preview, when this project has it; else null. */
  const sideKind = () => { const k = project()?.ui?.stageSide; return kinds.includes(k) ? k : null; };
  /** Merge into project.ui and save. The local copy changes first, so two quick saves do not undo each other. */
  async function saveUi(partial) {
    const p = project();
    if (!p) return null;
    p.ui = { ...(p.ui || {}), ...partial };
    if ('stageSide' in partial) placeSide(); // the switch on the Phone tab can take the slot too
    const saved = await app.api.patchProject(projectId, { ui: p.ui });
    if (project() === p) p.ui = { ...saved.ui, ...p.ui }; // a later local change wins over this answer
    return p.ui;
  }

  function ctxFor(kind) {
    return {
      projectId,
      get project() { return app.state.bundle?.project; },
      get manifest() { return app.state.bundle?.manifest || {}; },
      api: app.api,
      bus,
      previewFrame: frame,
      app,
      toast,
      setPreviewWidth,
      stageSide,
      /** The kind the person dragged beside the preview (null: none), and a call on every change of it. */
      sideKind,
      onSide(fn) { sideSubs.add(fn); return () => sideSubs.delete(fn); },
      post(msg) {
        frame?.contentWindow?.postMessage(msg, location.origin); // the Learning view's dock has no preview
        // Extra live frames (e.g. side by side): tuning only reaches working-tree (head) frames.
        for (const tgt of app.previewTargets || []) {
          if (msg?.type === 'atelier:tuning' && tgt.getRef() !== 'head') continue;
          tgt.frame.contentWindow?.postMessage(msg, location.origin);
        }
      },
      /** Merge into project.ui (project-scope prefs) and save. */
      saveUi,
      /** A number worth showing on the tab (null hides it). */
      setCount(n) { counts.set(kind, Number.isFinite(n) && n > 0 ? n : null); renderTabs(); onCount?.(kind, counts.get(kind)); },
      /** A kind's name as the tab shows it. */
      label,
      /** Words at the right of the tab row while this panel's tab is active ("Session / Harbor"); empty takes them away. */
      setNote(text) { notes.set(kind, text || ''); renderTabs(); },
    };
  }

  /** A tab's count before its panel mounts: a panel module may export watchCount(ctx), which calls ctx.setCount as the
   *  number changes and returns a stop function. Called for the kinds not mounted; the panel's own setCount takes
   *  over when it mounts (stopWatch), and a project switch stops every watcher. A module with no watchCount, or one
   *  that fails to import, shows its number once mounted, as before. */
  async function watchCounts() {
    const gen = generation;
    for (const kind of kinds) {
      if (mounted.has(kind) || watchers.has(kind)) continue;
      watchers.set(kind, () => {}); // taken while the import is on its way
      let mod = null;
      try { mod = await loadPanel(kind); } catch { /* the tab says so when selected */ }
      if (gen !== generation) return;
      if (!watchers.has(kind) || mounted.has(kind) || typeof mod?.watchCount !== 'function') { watchers.delete(kind); continue; }
      try { watchers.set(kind, mod.watchCount(ctxFor(kind)) || (() => {})); } catch (err) { console.error(err); watchers.delete(kind); }
    }
  }
  function stopWatch(kind) {
    const stop = watchers.get(kind);
    watchers.delete(kind);
    try { stop?.(); } catch (err) { console.error(err); }
  }

  // Show the active panel's container, hide the others (they stay mounted and subscribed); a panel beside the preview
  // stays shown there, and the dock body says where it went when its tab is the active one.
  function showActive() {
    for (const [k, entry] of mounted) entry.container.hidden = k !== active && !entry.inSide;
    const there = !!mounted.get(active)?.inSide;
    away.hidden = !there;
    away.textContent = there ? `${label(active)} is beside the preview.` : '';
    node.dataset.tab = active || '';
    tellShown();
  }
  /** A panel that sizes itself to the body (the terminal) refits when its tab is shown or the dock expands. */
  function tellShown() {
    if (node.classList.contains('collapsed')) return;
    tell(mounted.get(active));
  }
  function tell(entry) {
    try { entry?.mod?.shown?.(entry.ctx); } catch (err) { console.error(err); }
  }

  async function select(kind, { fromUser = true } = {}) {
    active = kind;
    savePrefs(fromUser ? { collapsed: false } : {});
    if (fromUser) {
      node.classList.remove('collapsed');
      if (saveTab && project()?.ui?.dockTab !== kind) saveUi({ dockTab: kind }).catch(() => {}); // remembered per project
    }
    renderTabs();
    if (mounted.has(kind)) return showActive();
    await mountKind(kind);
  }

  /** Mount the kind's panel (hidden unless it is the active tab or beside the preview). */
  async function mountKind(kind) {
    stopWatch(kind); // the panel reports its own number from here
    // Registered before the import so a repeat click while loading reuses this container.
    const container = el('div.wbp-host', loading(`Loading ${label(kind)}…`));
    const entry = { mod: null, ctx: null, container, ready: null, inSide: false };
    let settle;
    entry.ready = new Promise((r) => { settle = r; }); // show() waits on it when the panel is still loading
    mounted.set(kind, entry);
    body.append(container);
    showActive();
    const gen = generation;
    try {
      const mod = await loadPanel(kind);
      if (gen !== generation) return;
      clear(container);
      entry.ctx = ctxFor(kind);
      mod.mount(container, entry.ctx);
      entry.mod = mod;
    } catch (err) {
      if (gen !== generation) return;
      // Kept in the map with mod null: the message stays and the import is not retried per switch.
      clear(container, el('div.empty.compact', el('p.empty-title', `No ${label(kind)} panel available: ${err.message}`)));
    } finally {
      settle();
    }
    showActive();
    if (entry.inSide) tell(entry);
  }

  /** The phone's screen goes beside the preview on wide windows: its panel must be mounted for that, tab open or not.
   *  Nothing is mounted when the person switched it off (project.ui.phoneBeside false), when another panel holds the
   *  slot, or when the project has no phone. */
  function ensureBeside() {
    if (!stageSide?.wide() || !kinds.includes('phone') || mounted.has('phone')) return;
    if (project()?.ui?.phoneBeside === false) return;
    const side = sideKind();
    if (side !== null && side !== 'phone') return;
    mountKind('phone');
  }

  /** Put the slot in line with project.ui.stageSide and the window's width: a dock panel that should not be there
   *  goes back into the body, the phone panel places its own screen, then the wanted panel's container moves in. */
  function placeSide() {
    if (!stageSide || !projectId) return;
    const want = sideKind();
    const wide = stageSide.wide();
    for (const [k, entry] of mounted) {
      if (!entry.inSide || (k === want && wide)) continue;
      entry.inSide = false;
      body.append(entry.container);
      stageSide.release(entry.container);
    }
    for (const fn of [...sideSubs]) { try { fn(want); } catch (err) { console.error(err); } }
    ensureBeside();
    if (want && want !== 'phone' && wide) {
      if (!mounted.has(want)) mountKind(want); // registers its container at once; the panel mounts into it later
      const entry = mounted.get(want);
      if (!entry.inSide) {
        entry.inSide = true;
        stageSide.put(entry.container, want);
        tell(entry);
      }
    }
    showActive();
    renderTabs();
  }
  const offSide = stageSide?.on(() => { ensureBeside(); placeSide(); });
  const offHold = stageSide?.onHold(() => { renderSideHead(); renderTabs(); });
  if (stageSide) stageSide.node.insertBefore(sideHead, stageSide.node.firstChild || null);

  function renderSideHead() {
    const k = stageSide?.heldKind();
    sideHead.hidden = !k;
    sideName.textContent = k ? label(k) : '';
  }
  sideHandle.addEventListener('pointerdown', (e) => { const k = stageSide?.heldKind(); if (k) drag.start(e, k, 'side'); });

  // ---------- arranging ----------
  const say = (words) => { live.textContent = ''; live.textContent = words; };
  function setOrder(next, { kind, announce = true } = {}) {
    if (sameOrder(next, order)) return false;
    order = next;
    renderTabs();
    if (announce && kind) say(movedWords(order, kind, label));
    saveUi({ dockOrder: [...order] }).catch((err) => toast(`Tab order not saved: ${err.message}`, { tone: 'danger' }));
    return true;
  }
  /** Beside the preview (on) or back in the dock (off). The phone's switch follows its screen. */
  function toSide(kind, on) {
    if (!kinds.includes(kind) || !stageSide) return;
    const there = sideKind() === kind || stageSide.heldKind() === kind;
    if (on ? sideKind() === kind : !there) return;
    const partial = { stageSide: on ? kind : null };
    if (kind === 'phone') partial.phoneBeside = !!on; // the Phone tab's switch says the same as the drag
    saveUi(partial).catch((err) => toast(`Beside the preview not saved: ${err.message}`, { tone: 'danger' }));
    if (on && !stageSide?.wide()) {
      toast(`${label(kind)} goes beside the preview when the window is 1440 px or wider.`);
      say(`${label(kind)} kept for beside the preview`);
    } else say(on ? `${label(kind)} moved beside the preview` : `${label(kind)} back in the dock`);
  }
  function arranged() {
    if (!arrange) return false;
    const ui = project()?.ui || {};
    return (Array.isArray(ui.dockOrder) && !sameOrder(orderKinds(kinds, ui.dockOrder), kinds)) || sideKind() !== null;
  }
  function reset() {
    order = [...kinds];
    saveUi({ dockOrder: null, stageSide: null }).catch((err) => toast(`Arrangement not saved: ${err.message}`, { tone: 'danger' }));
    renderTabs();
    // The phone's switch is left as the person set it, so on a wide window its screen keeps the default place.
    const phoneStays = kinds.includes('phone') && !!stageSide?.wide() && project()?.ui?.phoneBeside !== false;
    const phone = phoneStays ? '; the phone\'s screen stays beside the preview (its switch is on)' : '; nothing beside the preview';
    toast(`Dock arrangement reset: the default tab order${phone}.`);
  }

  const tabRects = (except) => [...tabs.querySelectorAll('[role="tab"]')].filter((t) => t.dataset.kind !== except).map((t) => t.getBoundingClientRect());
  const drag = createTabDrag({
    stage: () => stageSide?.host?.getBoundingClientRect?.() || null,
    others: tabRects,
    // While a tab is lifted, frames take no pointer events: a move over the preview's iframe would go to its document.
    onLift: () => { node.classList.add('arranging'); document.documentElement?.classList.add('tab-arranging'); renderTabs(); },
    onOver: ({ kind, zone, line }) => {
      const headLeft = head.getBoundingClientRect().left || 0;
      dropLine.hidden = zone !== 'tabs' || line === null;
      if (!dropLine.hidden) dropLine.style.left = `${Math.round(line - headLeft)}px`;
      if (zone === 'stage') {
        targetLabel.textContent = stageSide?.wide() ? `Beside the preview: ${label(kind)}` : 'Beside the preview, on windows 1440 px or wider';
        stageSide?.target(targetLabel);
      } else stageSide?.target(null);
    },
    onEnd: () => { dropLine.hidden = true; stageSide?.target(null); node.classList.remove('arranging'); document.documentElement?.classList.remove('tab-arranging'); renderTabs(); },
    onDrop: ({ kind, from, zone, index }) => {
      if (zone === 'stage') { if (stageSide && (from !== 'side')) toSide(kind, true); return; }
      const moved = setOrder(moveTo(order, kind, index), { kind, announce: from !== 'side' });
      const besideNow = sideKind() === kind || stageSide?.heldKind() === kind;
      if (besideNow) toSide(kind, false);
      else if (!moved) say(`${label(kind)} stays where it was`);
    },
  });

  function onTabKey(e, k) {
    const i = order.indexOf(k);
    if (arrange && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault(); // Alt+Left is the browser's Back
      const to = i + (e.key === 'ArrowRight' ? 1 : -1);
      if (to < 0 || to >= order.length) { say(`${label(k)} is already ${to < 0 ? 'first' : 'last'}`); return; }
      setOrder(moveTo(order, k, to), { kind: k });
      return;
    }
    if (arrange && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      if (!stageSide) return;
      e.preventDefault();
      toSide(k, e.key === 'ArrowUp');
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
      select(next).then(() => tabs.querySelector('[aria-selected="true"]')?.focus());
    }
  }

  /** studio.show (client/components/studio-show.js): open the kind's tab as a click would, then hand the panel its
   *  command ({ point }) once mounted. False when the project has no such panel. */
  async function show(kind, command = {}) {
    if (!kinds.includes(kind)) return false;
    if (kind !== active || node.classList.contains('collapsed')) await select(kind);
    const entry = mounted.get(kind);
    await entry?.ready;
    if (entry?.mod && Object.keys(command).length) {
      try { entry.mod.command?.(command); } catch (err) { console.error(err); }
    }
    return true;
  }

  function unmountAll() {
    for (const entry of mounted.values()) {
      if (entry.inSide) stageSide?.release(entry.container);
      try { entry.mod?.unmount?.(); } catch (err) { console.error(err); }
    }
    mounted.clear();
    for (const k of [...watchers.keys()]) stopWatch(k);
    counts.clear();
    notes.clear();
    sideSubs.clear();
    clear(body, away);
  }

  function renderTabs() {
    const collapsed = node.classList.contains('collapsed');
    note.textContent = notes.get(active) || '';
    note.hidden = !notes.get(active);
    const focused = tabs.contains(document.activeElement) ? document.activeElement.dataset.kind : null;
    const lifted = drag.lifted();
    const held = stageSide?.heldKind() || null;
    clear(tabs,
      order.map((k) => el(`button${k === lifted ? '.lifted' : ''}`, {
        type: 'button', role: 'tab', dataset: { kind: k }, 'aria-selected': String(k === active && !collapsed), tabIndex: k === active ? 0 : -1,
        title: arrange ? 'Drag to arrange, or onto the preview to put it beside; Alt+arrow keys do the same' : undefined,
        // The active tab stays open on a second click; only the chevron hides the dock. A drop is not a click.
        onclick: () => { if (drag.takeClick()) return; if (k !== active || collapsed) select(k); },
        onpointerdown: arrange ? (e) => drag.start(e, k, 'tabs') : undefined,
        onkeydown: (e) => onTabKey(e, k),
      }, label(k),
      k === held ? el('span.tab-side', { title: 'Beside the preview', 'aria-label': ', beside the preview' }) : null,
      counts.get(k) ? el('span.tab-count', { 'aria-label': `, ${counts.get(k)}` }, String(counts.get(k))) : null)),
      el('span.spacer'),
      note,
      kinds.length && arranged() ? button('Reset arrangement', { small: true, variant: 'quiet', title: 'The default tab order, and nothing dragged beside the preview', onclick: reset }) : null,
      kinds.length ? button('', { icon: 'chevron', small: true, variant: 'quiet', title: collapsed ? 'Show panel' : 'Hide panel', 'aria-label': collapsed ? 'Show panel' : 'Hide panel', 'aria-expanded': String(!collapsed), onclick: toggle, style: { transform: collapsed ? 'rotate(180deg)' : '' } }) : null);
    if (focused) tabs.querySelector(`[data-kind="${focused}"]`)?.focus();
    grip.hidden = collapsed || !kinds.length;
  }

  function toggle() {
    const collapsed = !node.classList.contains('collapsed');
    node.classList.toggle('collapsed', collapsed);
    savePrefs({ collapsed });
    renderTabs();
    tellShown();
  }

  /** Collapse or expand without touching the saved preference (e.g. while Side by side is open).
   *  Returns the previous collapsed state so the caller can put it back. */
  function collapse(want) {
    const was = node.classList.contains('collapsed');
    node.classList.toggle('collapsed', !!want);
    renderTabs();
    if (was && !want) tellShown();
    return was;
  }

  // ---------- height ----------
  /** The project's height on the body (null: the CSS default for the tab). */
  function applyHeight(px) {
    const h = Number.isFinite(px) ? px : null;
    node.classList.toggle('sized', h !== null);
    if (h !== null) node.style.setProperty('--dock-h', `${h}px`); else node.style.removeProperty('--dock-h');
    grip.setAttribute('aria-valuenow', String(Math.round(h ?? body.getBoundingClientRect().height ?? DOCK_MIN)));
    grip.setAttribute('aria-valuemin', String(DOCK_MIN));
  }
  const stage = () => stageHeight() || window.innerHeight;
  const bodyHeight = () => body.getBoundingClientRect().height || DOCK_MIN;
  function resizeTo(want) {
    const h = clampDockHeight(want, stage());
    if (h !== null) applyHeight(h);
    return h;
  }
  let gripDrag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gripDrag = { y: e.clientY, h: bodyHeight(), last: null };
    try { grip.setPointerCapture(e.pointerId); } catch { /* the move still lands mostly */ }
    node.classList.add('dragging');
  });
  grip.addEventListener('pointermove', (e) => { if (gripDrag) gripDrag.last = resizeTo(gripDrag.h + (gripDrag.y - e.clientY)); });
  const endDrag = () => {
    if (!gripDrag) return;
    const h = gripDrag.last;
    gripDrag = null;
    node.classList.remove('dragging');
    if (h !== null) saveUi({ [heightKey]: h }).catch((err) => toast(`Dock height not saved: ${err.message}`, { tone: 'danger' }));
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', () => { applyHeight(null); saveUi({ [heightKey]: null }).catch(() => {}); });
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const h = resizeTo(bodyHeight() + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP));
    if (h !== null) saveUi({ [heightKey]: h }).catch(() => {});
  });

  return {
    node,
    collapse,
    show,
    /** Beside the preview (on) or back in the dock (off), as a drag would do it. */
    toSide,
    kinds: () => [...order],
    setProject(bundle) {
      generation++;
      drag.cancel();
      unmountAll();
      projectId = bundle.project.id;
      kinds = kindsOf(bundle.manifest);
      const ui = bundle.project.ui || {};
      order = orderKinds(kinds, ui.dockOrder);
      node.hidden = false;
      if (!bare) applyHeight(Number.isFinite(ui[heightKey]) ? clampDockHeight(ui[heightKey], stage()) : null);
      const p = prefs();
      // The project's last tab; before it remembered one, the tab this window had open.
      const want = kinds.includes(ui.dockTab) ? ui.dockTab : p[`tab:${projectId}`];
      node.classList.toggle('collapsed', !!p.collapsed);
      select(kinds.includes(want) ? want : order[0], { fromUser: false });
      placeSide();
      renderSideHead();
      watchCounts();
    },
    /** No project (the Learning view before one exists): every panel unmounts and the dock hides. */
    clearProject() {
      generation++;
      drag.cancel();
      unmountAll();
      projectId = null;
      kinds = [];
      order = [];
      active = null;
      node.hidden = true;
      renderTabs();
    },
    update() {
      for (const { mod, ctx } of mounted.values()) {
        try { mod?.update?.(ctx); } catch (err) { console.error(err); }
      }
    },
    destroy() {
      generation++;
      drag.cancel();
      offSide?.();
      offHold?.();
      unmountAll();
      sideHead.remove();
    },
  };
}
