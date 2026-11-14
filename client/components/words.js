// Sentences the version dialogs build from data. No DOM, so tests read them directly.

/** A full stop, unless the text already ends a sentence: a label cut by shortLabel ends with an ellipsis. */
export const endSentence = (text) => (/[….]$/.test(text) ? text : `${text}.`);

// Where the Readiness checklist is, by project kind; these are the dock's tab names (client/components/dock.js).
const CHECKLIST_PANEL = { game: 'Play', 'web-app': 'Devices', audio: 'Audio' };

/** The export dialog's sentence on open readiness items. */
export function readinessSentence(kind) {
  const panel = CHECKLIST_PANEL[kind];
  const record = 'You can still export; the release records the count.';
  return panel
    ? `Ticks are your own judgement after trying it, made in the ${panel} panel in the dock. ${record}`
    : `This kind of project has no panel to tick them in, so they stay open. ${record}`;
}

/** The version the preview shows when it is not what is on disk; null for the files on disk or the same commit. */
export function previewedElsewhere(bundle, ref) {
  if (!ref || ref === 'head') return null;
  const v = bundle?.versions?.find((x) => x.id === ref);
  if (!v) return null;
  const ch = bundle.changes;
  return v.sha && ch && v.sha === ch.headSha && !ch.dirty ? null : v;
}

/** At the top of the export dialog while another version is previewed: an export builds the files on disk. */
export const previewExportSentence = (previewed, onDisk) =>
  `${endSentence(`You are previewing ${previewed}`)} ${endSentence(`Export builds the files on disk, which are ${onDisk}`)}`;

/** Before the build, for an audio project: the count only exists once the build has copied the files. */
export const rendersBeforeBuild = (kind) => (kind === 'audio' ? 'Renders under dist/audio will travel with the export, into audio/.' : null);

/** After the build: the count from the audio build hook's answer (workbenches/audio/server.mjs). */
export function rendersAfterBuild(kind, built) {
  if (kind !== 'audio' || !Number.isInteger(built?.rendered)) return null;
  const n = built.rendered;
  if (!n) return 'No rendered files travel with this export: dist/audio has none yet.';
  return `${n} rendered file${n === 1 ? ' travels' : 's travel'} with this export, in audio/.`;
}
