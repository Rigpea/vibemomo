// The Focus panel's list of releases: one line per record of .studio/releases.json, newest first.
// Pure (no DOM) so the wording and the order are testable.
import { typedNotes, fileName, releaseDate } from './release-notes.js';

/** [{ id, text: '#n label · zip file name · date', title: release notes and zip path }], newest first (the store appends). */
export function releaseRows(releases = [], versions = []) {
  return [...releases].reverse().map((r) => {
    const v = versions.find((x) => x.id === r.versionId);
    const zip = r.artifact?.path || '';
    return {
      id: r.id,
      text: [v ? `#${v.n} ${v.label}` : `version ${r.versionId}`, zip ? fileName(zip) : null, releaseDate(r)].filter(Boolean).join(' · '),
      title: [typedNotes(r), zip].filter(Boolean).join('\n\n') || undefined,
    };
  });
}
