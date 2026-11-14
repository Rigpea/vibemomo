// Release notes: the draft the export dialog offers, the size limit and the Export ready wording.
// Pure (no DOM): the server imports the limit from here, so client and server cannot disagree on it.

export const RELEASE_NOTES_FILE = 'RELEASE-NOTES.md';
export const MAX_NOTES_BYTES = 20 * 1024;

/** Size as the server measures it (UTF-8), not the number of characters. */
export const notesBytes = (text) => new TextEncoder().encode(String(text ?? '')).length;

const versionLines = (v) => {
  const note = String(v.note || '').trim();
  const line = `#${v.n} ${v.label}`;
  // A note that only repeats the label says nothing new (fullName in version-actions.js skips it too).
  return note && note !== v.label ? [line, ...note.split(/\r?\n/).map((l) => `  ${l}`)] : [line];
};

/** An instant as this machine's clock reads it, 2026-11-04 21:16: for dates people read, not for records to compare. */
export function localDateTime(iso) {
  const d = new Date(iso);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A release's date wherever a person reads it: what the server wrote at the build, else the same format of createdAt.
 *  An old record's createdAt can be a date alone: it has no time to show, and read as an instant it could shift a day. */
export const releaseDate = (release) => {
  if (release?.builtLocal) return release.builtLocal;
  const at = release?.createdAt;
  if (!at) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : localDateTime(at);
};

/** The file name of a path written on either Windows or POSIX. */
export const fileName = (p) => String(p).split(/[\\/]/).pop();

/** The version the newest release was built from whose record still exists, or null. */
export function lastReleased(releases, versions) {
  for (let i = releases.length - 1; i >= 0; i--) {
    const v = versions.find((x) => x.id === releases[i].versionId);
    if (v) return v;
  }
  return null;
}

/**
 * The draft from the answer of GET release-notes-draft, which reads the versions from git ancestry:
 * versions oldest first, since (the last release's version or null), earlierRelease (released, but
 * that version has no record now: not a first release), releasedAs ({zip, date} when the exported
 * version is the last released one), sibling (neither descends from the other: the list runs back to
 * their merge base). An empty list under since means the exported version is behind that release,
 * because the exported version itself is otherwise always in the list.
 */
export function releaseNotesDraft({ versions = [], since = null, earlierRelease = false, releasedAs = null, sibling = false } = {}) {
  if (releasedAs) return `This version was released as ${releasedAs.zip} on ${releasedAs.date}; no changes since.`;
  if (since && !versions.length) return `No changes since #${since.n} "${since.label}": this version is older than that release.`;
  const heading = since && sibling ? `Changes since #${since.n} (a sibling of this version; what this version has that #${since.n} does not)`
    : since ? `Changes since #${since.n} "${since.label}"`
    : earlierRelease ? 'Changes since an earlier release'
    : 'First release';
  return [heading, ...versions.flatMap(versionLines)].join('\n');
}

/** Lines of text as a person counts them: blank lines inside count, a trailing line break does not. */
export const notesLineCount = (text) => {
  const t = String(text ?? '').trimEnd();
  return t ? t.split(/\r?\n/).length : 0;
};

/**
 * The release notes a record really carries. A record without readinessSummary comes from a server
 * older than typed notes: its notes held the readiness count (or the text was stored but no file written).
 */
export const typedNotes = (release) => (release?.readinessSummary ? release.notes || '' : '');

/** The Export ready line for a release record. */
export function notesSummary(release) {
  const n = notesLineCount(typedNotes(release));
  return n ? `${n} line${n === 1 ? '' : 's'}, in ${RELEASE_NOTES_FILE}` : 'no release notes';
}
