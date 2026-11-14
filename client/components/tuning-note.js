// What Keep version says about an unsaved tuning draft (project.ui.tuningDraft, see
// workbenches/action/panel.js). A draft is not always live: it survives a reload and is never applied
// by itself, so "applied live" is said only from the product's acknowledgement (`applied`).

/** The sentence for this bundle, or null when no draft would show in the Tuning panel. */
export function unsavedTuningNote(bundle, { applied = false } = {}) {
  const draft = bundle?.project?.ui?.tuningDraft;
  if (!draft?.values || !Object.keys(draft.values).length) return null;
  if (draft.file !== bundle.manifest?.tuning) return null; // the panel ignores a draft of another file
  const state = applied ? `is applied live but not saved to ${draft.file}` : `is not saved to ${draft.file}`;
  return `Your tuning change ${state}. Save it first (Tuning › Save to file), then keep.`;
}
