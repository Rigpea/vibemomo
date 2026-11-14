// The draft the export dialog offers, and what Export ready says about the notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseNotesDraft, lastReleased, fileName, notesBytes, notesLineCount, notesSummary, MAX_NOTES_BYTES } from '../client/components/release-notes.js';
import { localDateTime } from '../server/lib/paths.mjs';

const v = (n, label, note = '') => ({ id: `v_${n}`, n, label, note });
const versions = [v(1, 'First', 'The start'), v(2, 'Second'), v(3, 'Third', 'Faster jump'), v(4, 'Fourth')];

test('no release: First release and the listed versions, in the order given', () => {
  assert.equal(releaseNotesDraft({ versions }), 'First release\n#1 First\n  The start\n#2 Second\n#3 Third\n  Faster jump\n#4 Fourth');
});

test('the first line quotes the label of the last release', () => {
  assert.equal(releaseNotesDraft({ versions: [versions[2], versions[3]], since: v(2, 'Blip a little higher') }),
    'Changes since #2 "Blip a little higher"\n#3 Third\n  Faster jump\n#4 Fourth');
});

test('the last released version drafts one line and nothing else', () => {
  assert.equal(releaseNotesDraft({ versions: [], since: versions[3], releasedAs: { zip: 'room-v4.zip', date: '2026-11-04 21:16' } }),
    'This version was released as room-v4.zip on 2026-11-04 21:16; no changes since.');
});

test('a version behind the last release says so instead of a heading with nothing under it', () => {
  assert.equal(releaseNotesDraft({ versions: [], since: v(5, 'Fifth') }), 'No changes since #5 "Fifth": this version is older than that release.');
});

test('versions without notes get one line; a note repeating the label adds none', () => {
  assert.equal(releaseNotesDraft({ versions: [v(1, 'Plain'), v(2, 'Same', 'Same'), v(3, 'Blank', '  ')] }), 'First release\n#1 Plain\n#2 Same\n#3 Blank');
});

test('every line of a longer note stays indented', () => {
  assert.equal(releaseNotesDraft({ versions: [v(1, 'Long', 'one\r\ntwo')] }), 'First release\n#1 Long\n  one\n  two');
});

test('a release whose version has no record is not called a first release', () => {
  assert.equal(releaseNotesDraft({ versions: [versions[0]], earlierRelease: true }), 'Changes since an earlier release\n#1 First\n  The start');
});

test('the newest release with a record decides which version the draft starts from', () => {
  assert.equal(lastReleased([{ versionId: 'v_1' }, { versionId: 'v_3' }], versions).id, 'v_3');
  assert.equal(lastReleased([{ versionId: 'v_2' }, { versionId: 'v_gone' }], versions).id, 'v_2');
  assert.equal(lastReleased([{ versionId: 'v_gone' }], versions), null);
  assert.equal(lastReleased([], versions), null);
});

test('no arguments give the first-release heading alone', () => {
  assert.equal(releaseNotesDraft(), 'First release');
});

test('a zip name comes out of a path from either system', () => {
  assert.equal(fileName('C:\\work\\dist\\room-v4.zip'), 'room-v4.zip');
  assert.equal(fileName('/work/dist/room-v4.zip'), 'room-v4.zip');
});

test('the date people read is local, not UTC: late evening west of Greenwich stays on its own day', () => {
  const zone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(localDateTime('2026-11-05T02:16:05.220Z'), '2026-11-04 21:16');
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(localDateTime('2026-11-05T02:16:05.220Z'), '2026-11-05 11:16');
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('lines are counted as a person counts them', () => {
  assert.equal(notesLineCount(''), 0);
  assert.equal(notesLineCount(' \n '), 0);
  assert.equal(notesLineCount('one'), 1);
  assert.equal(notesLineCount('one\n\nthree\n'), 3);
});

test('Export ready speaks from the record; a record from an older server claims no file', () => {
  const rec = (notes) => ({ notes, readinessSummary: 'No readiness checklist at export' });
  assert.equal(notesSummary(rec('one')), '1 line, in RELEASE-NOTES.md');
  assert.equal(notesSummary(rec('one\ntwo')), '2 lines, in RELEASE-NOTES.md');
  assert.equal(notesSummary(rec('')), 'no release notes');
  assert.equal(notesSummary(undefined), 'no release notes');
  assert.equal(notesSummary({ notes: 'typed, but no file was written' }), 'no release notes');
});

test('the limit is measured in bytes', () => {
  assert.equal(MAX_NOTES_BYTES, 20480);
  assert.equal(notesBytes('é'), 2);
  assert.equal(notesBytes(undefined), 0);
});
