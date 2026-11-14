// Who holds the keyboard when the preview loads: a product that focuses itself on load does not
// take it from the studio. Only a press on the preview (or an explicit hand-over) leaves it there.
export function createPreviewFocus({ frame, fallback, doc = document }) {
  let returnTo = null;
  let pressed = false;
  return {
    // Another project was chosen: an earlier press no longer counts.
    chosen() { pressed = false; },
    // A new page is about to load. A frame that already holds the keyboard keeps its state, so a
    // reload nobody asked for does not blur a preview the person clicked.
    loading() {
      const active = doc.activeElement;
      if (active === frame) return;
      returnTo = active;
      pressed = false;
    },
    press() { pressed = true; },
    loaded() {
      if (pressed || doc.activeElement !== frame) return;
      if (returnTo?.isConnected && returnTo !== doc.body) returnTo.focus();
      // Gone, hidden or disabled by now: focus() did nothing, so the toolbar takes it.
      if (doc.activeElement === frame) fallback()?.focus();
    },
  };
}
