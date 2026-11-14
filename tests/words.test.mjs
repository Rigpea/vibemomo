// The sentences the version dialogs build: no ellipsis followed by a full stop, and the right panel for the kind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endSentence, readinessSentence, rendersBeforeBuild, rendersAfterBuild, previewedElsewhere, previewExportSentence } from '../client/components/words.js';

test('the export dialog speaks up only when the preview shows something other than the files on disk', () => {
  const nine = { id: 'v9', n: 9, sha: 'aaa' };
  const eight = { id: 'v8', n: 8, sha: 'bbb' };
  const twin = { id: 'v8b', n: 10, sha: 'bbb' };
  const b = { versions: [eight, nine, twin], changes: { headSha: 'bbb', dirty: false } };
  assert.equal(previewedElsewhere(b, 'v9'), nine);
  assert.equal(previewedElsewhere(b, 'head'), null);
  assert.equal(previewedElsewhere(b, undefined), null);
  assert.equal(previewedElsewhere(b, 'v8'), null, 'its commit is HEAD');
  assert.equal(previewedElsewhere(b, 'v8b'), null, 'a second record of the same commit is what is on disk too');
  assert.equal(previewedElsewhere(b, 'gone'), null);
  assert.equal(previewedElsewhere({ ...b, changes: { headSha: 'bbb', dirty: true } }, 'v8'), eight, 'edits on disk: the preview differs');
});

test('the export dialog names both versions, with no full stop after a cut label', () => {
  assert.equal(previewExportSentence('#9 Jump higher', '#8 Lower gravity'), 'You are previewing #9 Jump higher. Export builds the files on disk, which are #8 Lower gravity.');
  assert.equal(previewExportSentence('#9 Jump…', '#8 Lower…'), 'You are previewing #9 Jump… Export builds the files on disk, which are #8 Lower…');
});

test('a cut label gets no full stop; a whole label gets one, once', () => {
  assert.equal(endSentence('#3 Make the swell down by about…'), '#3 Make the swell down by about…');
  assert.equal(endSentence('#3 Lower gravity'), '#3 Lower gravity.');
  assert.equal(endSentence('#3 Lower gravity.'), '#3 Lower gravity.');
});

test('the export dialog names the panel that holds the checklist', () => {
  assert.match(readinessSentence('audio'), /the Audio panel/);
  assert.match(readinessSentence('game'), /the Play panel/);
  assert.match(readinessSentence('web-app'), /the Devices panel/);
  for (const kind of ['audio', 'game', 'web-app']) assert.doesNotMatch(readinessSentence(kind), /Play or Devices/);
  assert.match(readinessSentence('other'), /no panel to tick them in/);
});

test('only an audio project speaks of renders: where they are before the build, how many after', () => {
  assert.match(rendersBeforeBuild('audio'), /dist\/audio will travel/);
  assert.equal(rendersBeforeBuild('game'), null);
  assert.equal(rendersAfterBuild('audio', { rendered: 4 }), '4 rendered files travel with this export, in audio/.');
  assert.equal(rendersAfterBuild('audio', { rendered: 1 }), '1 rendered file travels with this export, in audio/.');
  assert.match(rendersAfterBuild('audio', { rendered: 0 }), /No rendered files/);
  assert.equal(rendersAfterBuild('audio', { note: 'no count' }), null);
  assert.equal(rendersAfterBuild('game', { rendered: 4 }), null);
});
