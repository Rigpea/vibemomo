// The phone's screen beside the preview (docs/ARCHITECTURE.md section 10). The screen is one DOM node, div.phone-screen
// with the image, the no-screen note, the live line and the ghost words, and it lives in one of two places: the Phone
// tab, or the stage's side slot (client/components/stage-side.js, ctx.stageSide). It sits in the slot while the window
// is wide (1440 px, 24 px hysteresis), the project's switch "Beside the preview" is on (project.ui.phoneBeside, on by
// default) and the panel belongs to the project on screen; else it is in the tab. Moving a node keeps its listeners,
// its image and its src, so the stream, Point mode and the readout carry on and nothing reloads. Never two screens.

export const BESIDE_LINE = 'The screen is beside the preview.';
/** The tab's line while the switch is on but another panel holds the slot: the screen stays, and the line says why. */
export const heldLine = (name) => `${name} is beside the preview; the screen stays here until it comes back.`;
const capital = (k) => (k ? k[0].toUpperCase() + k.slice(1) : '');

/**
 * ctx: the dock's panel context (stageSide, saveUi, project, projectId); screen: the node that moves; phone: div.phone,
 * its home; line: the tab's "The screen is beside the preview" line, which marks the screen's place in the tab;
 * box: the switch's checkbox; host: the panel's container (.beside while the screen is away); onMove(beside).
 */
export function createBeside({ ctx, screen, phone, line, box, host, onMove, onError }) {
  const slot = ctx.stageSide || null;
  // The switch is the person's; the slot is also the dock's (project.ui.stageSide, ctx.sideKind()): while another
  // panel was dragged there the screen stays in the tab, one thing beside the preview at a time.
  const switchOn = () => ctx.project?.ui?.phoneBeside !== false;
  const slotFree = () => { const k = ctx.sideKind?.() ?? null; return k === null || k === 'phone'; };
  const chosen = () => switchOn() && slotFree();
  const mine = () => !ctx.project || !ctx.projectId || ctx.project.id === ctx.projectId;
  let beside = false;

  function place() {
    box.checked = switchOn(); // the person's choice as kept, whatever holds the slot: a dragged panel does not unset it
    const want = !!slot && slot.wide() && chosen() && mine();
    const holder = !want && !!slot && slot.wide() && switchOn() && !slotFree() && mine() ? (ctx.sideKind?.() ?? null) : null;
    if (want) {
      if (!slot.holds(screen)) slot.put(screen, 'phone');
    } else if (beside) { // back to its place in the tab, before the line (the slot may already have let it go)
      phone.insertBefore(screen, line);
      slot?.release(screen);
    }
    line.hidden = !want && !holder;
    if (want) line.textContent = BESIDE_LINE;
    else if (holder) line.textContent = heldLine(ctx.label?.(holder) || capital(holder));
    host.classList?.toggle('beside', want);
    if (want !== beside) { beside = want; onMove?.(want); }
    return want;
  }

  /** The switch: kept per project through saveUi (it reads project.ui, merges and sends the whole map). */
  async function choose(on) {
    const partial = { phoneBeside: !!on };
    // On takes the slot back from a panel dragged there; off lets go of a slot the phone was dragged into.
    const side = ctx.sideKind?.() ?? null;
    if (on && side !== null && side !== 'phone') partial.stageSide = 'phone';
    if (!on && side === 'phone') partial.stageSide = null;
    const save = ctx.saveUi?.(partial); // the local copy changes before the request goes out
    place();
    try { await save; } catch (err) { onError?.(err); }
  }

  box.addEventListener('change', () => choose(box.checked));
  const off = slot?.on(() => place());
  const offDock = ctx.onSide?.(() => place()); // the dock changed what the slot holds
  place();

  return {
    place,
    beside: () => beside,
    /** Unmount: the screen leaves the slot (the tab's container goes with the panel). */
    destroy() {
      off?.();
      offDock?.();
      slot?.release(screen);
      beside = false;
    },
  };
}
