// A release was recorded but invisible in Focus: the rows it now shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseRows } from '../client/components/release-rows.js';
import { releaseDate, localDateTime } from '../client/components/release-notes.js';

const versions = [{ id: 'v_1', n: 1, label: 'First' }, { id: 'v_2', n: 2, label: 'Second' }];
const release = (id, versionId, path) => ({ id, versionId, createdAt: '2026-11-04T12:00:00.000Z', artifact: path ? { path } : undefined });
const date = localDateTime('2026-11-04T12:00:00.000Z');

test('a release date reads one way: the server\'s builtLocal, else the same format of createdAt', () => {
  assert.equal(releaseDate({ builtLocal: '2026-11-04 23:08', createdAt: '2026-11-05T04:08:00.000Z' }), '2026-11-04 23:08');
  assert.match(releaseDate({ createdAt: '2026-11-05T04:08:00.000Z' }), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(releaseDate({}), null);
  assert.equal(releaseDate(undefined), null);
  const [row] = releaseRows([{ ...release('r1', 'v_1', '/work/room-v1.zip'), builtLocal: '2026-11-04 23:08' }], versions);
  assert.equal(row.text, '#1 First · room-v1.zip · 2026-11-04 23:08');
});

test('an old record with a date alone shows that date, with no made-up time and no shift', () => {
  assert.equal(releaseDate({ createdAt: '2026-11-04' }), '2026-11-04');
  const [row] = releaseRows([{ id: 'r1', versionId: 'v_1', createdAt: '2026-11-04', artifact: { path: '/work/room-v1.zip' } }], versions);
  assert.equal(row.text, '#1 First · room-v1.zip · 2026-11-04');
});

test('rows are newest first and name the version, the zip file and the date', () => {
  const rows = releaseRows([release('r1', 'v_1', 'C:\\work\\dist\\room-v1.zip'), release('r2', 'v_2', '/work/dist/room-v2.zip')], versions);
  assert.deepEqual(rows.map((r) => r.id), ['r2', 'r1']);
  assert.equal(rows[0].text, `#2 Second · room-v2.zip · ${date}`);
  assert.equal(rows[1].text, `#1 First · room-v1.zip · ${date}`);
  assert.equal(rows[1].title, 'C:\\work\\dist\\room-v1.zip');
});

test('the hover shows the typed notes above the zip path; an older record\'s readiness count is not notes', () => {
  const typed = { ...release('r1', 'v_1', '/work/room-v1.zip'), notes: 'First release\n#1 First', readinessSummary: 'No readiness checklist at export' };
  const [row] = releaseRows([typed], versions);
  assert.equal(row.title, 'First release\n#1 First\n\n/work/room-v1.zip');
  assert.equal(row.text, `#1 First · room-v1.zip · ${date}`, 'the row itself does not change');
  const empty = { ...typed, notes: '' };
  assert.equal(releaseRows([empty], versions)[0].title, '/work/room-v1.zip');
  const old = { ...release('r2', 'v_2', '/work/room-v2.zip'), notes: 'Readiness at export: 1 of 2 items met' };
  assert.equal(releaseRows([old], versions)[0].title, '/work/room-v2.zip');
});

test('no releases give no rows, and a missing version or zip is not invented', () => {
  assert.deepEqual(releaseRows(undefined, versions), []);
  const [row] = releaseRows([release('r1', 'v_gone')], versions);
  assert.equal(row.text, `version v_gone · ${date}`);
  assert.equal(row.title, undefined);
});
