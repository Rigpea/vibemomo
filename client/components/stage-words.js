// The stage's words (DESIGN.md section 8; the reference's "Home / iPhone · Draft 08" above the frame and "Preview draft /
// not yet verified · Event grid selected" under it), apart from the DOM so tests read them. Every word comes from the
// bundle: the page in view (project.ui.pageInView, written by the Page panel), the width the preview is set to, the
// current version and the changed files; nothing is a claim.

/** The device the preview is set to: desktop (full width), mobile (390 px), phone (the device's own screen), else custom. */
export function deviceOf(width, phoneShown = false) {
  if (phoneShown) return 'phone';
  if (width === null || width === undefined) return 'desktop';
  return width === 390 ? 'mobile' : 'custom';
}

export function deviceWords(device, width) {
  if (device === 'desktop') return 'Desktop';
  if (device === 'mobile') return 'Mobile · 390';
  if (device === 'phone') return 'Phone';
  return width ? `${width} px` : 'Custom';
}

/**
 * The line above the frame. left: "<page> / <device>"; right: the version the files on disk stand at, or the one
 * being viewed. current: the version at HEAD (null when HEAD is past every version or there is none); viewing: the
 * version shown instead of the files on disk (null for the files on disk); changed: files changed since the current.
 */
export function capWords({ pageName = null, entry = null, device = 'desktop', width = null, current = null, viewing = null, changed = 0, versionCount = 0 } = {}) {
  const page = pageName || (entry ? String(entry).split('/').pop() : 'Entry');
  const left = `${page} / ${deviceWords(device, width)}`;
  let right;
  if (viewing) right = `Viewing #${viewing.n}`;
  else if (current) right = changed ? `#${current.n} · ${changed} file${changed === 1 ? '' : 's'} changed` : `#${current.n}`;
  else right = versionCount ? 'Not at a kept version' : 'No version yet';
  return { left, right };
}

/** The line under the frame. left: what the preview shows and whether it is verified; right: the selected part. */
export function footWords({ current = null, viewing = null, changed = 0, selection = null } = {}) {
  const verified = (v) => (v?.verified ? 'verified' : 'not yet verified');
  let left;
  if (viewing) left = `Preview of #${viewing.n} / ${verified(viewing)}`;
  else if (current && !changed) left = `Preview of the files on disk, at #${current.n} / ${verified(current)}`;
  else if (current) left = `Preview of the files on disk, ${changed} file${changed === 1 ? '' : 's'} past #${current.n} / not yet verified`;
  else left = 'Preview of the files on disk / not a kept version';
  return { left, right: selection ? `${selection} selected` : 'Nothing selected' };
}

/**
 * The line under the frame with Live in mind: no line while the frame shows the project's own server (the switch has
 * its chip and its Log, and the person wanted the height for the preview); Live's reason when it failed or is not
 * valid; otherwise footWords. live: liveWords() of the switch, or null.
 */
export function stageFoot({ liveShown = false, live = null, ...model } = {}) {
  if (liveShown) return { hidden: true, left: '', right: '' };
  const w = footWords(model);
  if (live && ['failed', 'invalid'].includes(live.state)) return { hidden: false, left: `Live ${live.state === 'failed' ? 'failed' : 'is not valid'}: ${live.reason}. The preview shows the files on disk.`, right: w.right };
  return { hidden: false, ...w };
}

/** The More menu's toggle for the Working now strip (layout key runsShown, hidden by default). */
export const RUNS_TOGGLE = 'Show runs under the preview';
/**
 * What a press on the toggle writes, from the key's resolved { value, scope }: the studio default, unless a session
 * or project value wins over it, which is then the one changed, so a press always shows or hides the strip.
 */
export function runsToggle(entry) {
  const shown = entry?.value === true;
  const scope = entry?.scope === 'session' || entry?.scope === 'project' ? entry.scope : 'studio';
  return { shown, scope, next: !shown };
}

/** The status line at the foot of the Workbench. */
export function statusWords({ working = [], shells = 0, version = null } = {}) {
  const names = working.map((r) => r.name).filter(Boolean);
  const left = names.length ? `${names.length} working now: ${names.join(', ')}` : shells ? `${shells} shell${shells === 1 ? '' : 's'} open, nothing working` : 'Nothing runs now';
  return { left, right: version ? `vibeMomo ${version}` : 'vibeMomo' };
}
