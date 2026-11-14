// Terminal dock tab (docs/ARCHITECTURE.md section 14): this project's real shells under the stage, the same shells the
// Claude Code view's Terminal mode lists, seen from the Workbench. The pane is client/components/terminal.js's
// createTerminalPane with its scope fixed to the project: the studio's own shells stay in the Claude Code view.
// The tab's count is the number of this project's shells still running (none when zero). The pane refits when the
// grip moves (its ResizeObserver) and when the tab is shown (shown(), called by the dock).
import { createTerminalPane } from '/components/terminal.js';

let st = null;

/** Shells still running among the listed ones (an exited or ended tab is not an open terminal). */
export const openCount = (list) => (list || []).filter((t) => !t.exited).length;

/** The running shells on the tab before the panel mounts (the dock calls this at setProject): the list now and on
 *  every terminal event, this project's shells that have not exited; the stop function ends it. */
export function watchCount(ctx) {
  let on = true;
  const read = async () => {
    try {
      const out = await ctx.api.terminals();
      if (on) ctx.setCount?.(openCount((Array.isArray(out) ? out : []).filter((t) => t.projectId === ctx.projectId)));
    } catch { /* the pane says so when it is opened */ }
  };
  const off = typeof ctx.app?.on === 'function' ? ctx.app.on('terminal', () => read()) : null;
  read();
  return () => { on = false; off?.(); };
}

export function mount(container, ctx) {
  unmount();
  container.classList?.add('terminal-host');
  const pane = createTerminalPane(container, ctx.app, {
    scope: 'project', fixedScope: true, projectId: ctx.projectId, place: 'dock',
    onTerms: (list) => ctx.setCount?.(openCount(list)),
  });
  st = { container, ctx, pane };
}

export function unmount() {
  const me = st;
  if (!me) return;
  st = null;
  me.pane.destroy();
  me.container.classList?.remove('terminal-host');
}

/** The dock showed this tab (or expanded with it): fit the pane to the dock body and take the shell's size. */
export function shown() { st?.pane.refresh(); }

/** Tests only. */
export const _state = () => st;
