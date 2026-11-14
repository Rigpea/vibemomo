// The words for a task's or a budget's state (client/components/status-words.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskState, pauseWords, resultVersions, resultOptions, producedWords, madeBeforeCancel, eventWords, splitEvents, sessionChipState, globalTaskState, runningWords, taskCountWords, statusSentence, chipWords } from '../client/components/status-words.js';

test('the chip\'s visible words name the project, cut at 20, and the whole sentence stays for title and name', () => {
  const label = (id) => ({ 'claude-code': 'Claude Code' }[id]);
  assert.deepEqual(chipWords('review', 1, undefined, 'Room Three'), { visible: 'Room Three: ready to try', said: 'Status in Room Three: 1 task ready to try' });
  assert.deepEqual(chipWords('working', 1, undefined, 'Room Three'), { visible: 'Room Three: working', said: 'Status in Room Three: 1 task working' });
  assert.deepEqual(chipWords('needs-input', 2, undefined, 'Room Three'), { visible: 'Room Three: 2 need input', said: 'Status in Room Three: 2 tasks needing your input' });
  assert.equal(chipWords('needs-input', 1, undefined, 'Room Three').visible, 'Room Three: 1 needs input');
  assert.deepEqual(chipWords('working', 0, [{ backend: 'claude-code' }], 'Room Three', label), { visible: 'Room Three: working', said: 'Status in Room Three: 1 Claude Code session running' });
  assert.equal(chipWords('interrupted', 1, [], 'Room Three').visible, 'Room Three: interrupted', 'no session running: the task state');
  assert.equal(chipWords('record-result', 1, undefined, 'Room Three').visible, 'Room Three: record the result');
  assert.equal(chipWords('ready', 3, undefined, 'Room Three').visible, 'Room Three: ready for Claude Code');
  const long = chipWords('review', 1, undefined, 'A project with a name far too long');
  assert.equal(long.visible, 'A project with a…: ready to try');
  assert.equal(long.said, 'Status in A project with a name far too long: 1 task ready to try', 'the sentence keeps the whole name');
});

test('events stay oldest first and none is lost; only more than 12 makes an earlier part', () => {
  const events = (n) => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(splitEvents([]), { earlier: [], recent: [] });
  assert.deepEqual(splitEvents(events(12)), { earlier: [], recent: events(12) });
  assert.deepEqual(splitEvents(events(13)), { earlier: [1], recent: events(13).slice(1) });
  const { earlier, recent } = splitEvents(events(15));
  assert.deepEqual(earlier, [1, 2, 3]);
  assert.deepEqual([...earlier, ...recent], events(15));
  assert.equal(recent.length, 12);
});

test('a task row names every version its result lists, and an older result still reads', () => {
  const named = { v_5: '#5 Option A', v_6: '#6 Option B', v_7: '#7 Option C' };
  const nameOf = (vid) => named[vid] || vid;
  const three = { versionId: 'v_7', versionIds: ['v_5', 'v_6', 'v_7'] };
  assert.equal(producedWords(three, nameOf), 'produced #5, #6, #7');
  assert.equal(producedWords({ versionId: 'v_7', versionIds: ['v_7'] }, nameOf), 'produced #7');
  assert.deepEqual(resultVersions({ versionId: 'v_7' }), ['v_7'], 'a result from before versionIds');
  assert.equal(producedWords({ versionId: 'v_7' }, nameOf), 'produced #7');
  assert.equal(producedWords({ versionId: 'v_gone' }, nameOf), 'produced a version');
  assert.equal(producedWords({ versionId: 'v_7', versionIds: ['v_gone', 'v_7'] }, nameOf), 'produced 2 versions', 'never a raw id');
  assert.equal(producedWords({ versionId: null, versionIds: [] }, nameOf), 'no version');
  assert.equal(producedWords(null, nameOf), null);
});

test('a row reads the server\'s numbers without any name, and falls back when one is missing', () => {
  const unknown = (vid) => vid;
  assert.equal(producedWords({ versionId: 'v_9', versionIds: ['v_8', 'v_9'], versionNumbers: [8, 9] }, unknown), 'produced #8, #9');
  assert.equal(producedWords({ versionId: 'v_6', versionNumbers: [6] }, unknown), 'produced #6', 'a result from before versionIds');
  assert.equal(producedWords({ versionId: 'v_9', versionIds: ['v_8', 'v_9'], versionNumbers: [null, 9] }, unknown), 'produced 2 versions', 'never a raw id');
});

test('a finish version beside an explore task\'s options is a leftover, named apart and never an option', () => {
  const unknown = (vid) => vid;
  const three = { versionId: 'v_11', versionIds: ['v_9', 'v_10', 'v_11'], versionNumbers: [9, 10, 11], versionRoles: ['option', 'option', 'finish'] };
  assert.equal(producedWords(three, unknown, 'review', 'explore'), 'produced #9, #10 · and a leftover #11');
  assert.deepEqual(resultOptions(three, 'explore'), { options: ['v_9', 'v_10'], leftovers: ['v_11'] });
  const untagged = { ...three, versionRoles: [null, null, 'finish'] };
  assert.deepEqual(resultOptions(untagged, 'explore').options, ['v_9', 'v_10'], 'an option before ingest has no role yet');
  const one = { versionId: 'v_11', versionIds: ['v_9', 'v_11'], versionNumbers: [9, 11], versionRoles: ['option', 'finish'] };
  assert.equal(producedWords(one, unknown, 'done', 'explore'), 'produced #9 · and a leftover #11');

  // nothing to set it apart from, or a task with no options: the finish is the result
  const alone = { versionId: 'v_11', versionIds: ['v_11'], versionNumbers: [11], versionRoles: ['finish'] };
  assert.equal(producedWords(alone, unknown, 'review', 'explore'), 'produced #11');
  assert.deepEqual(resultOptions(alone, 'explore'), { options: ['v_11'], leftovers: [] });
  assert.equal(producedWords({ ...one, versionRoles: [null, 'finish'] }, unknown, 'review', 'handle'), 'produced #9, #11');
  assert.deepEqual(resultOptions({ ...one, versionRoles: [null, 'finish'] }, 'handle').options, ['v_9', 'v_11']);

  // an older result has no roles; names still read when the numbers are missing
  assert.deepEqual(resultOptions({ versionId: 'v_7' }, 'explore'), { options: ['v_7'], leftovers: [] });
  const named = { versionId: 'v_2', versionIds: ['v_1', 'v_2'], versionRoles: ['option', 'finish'] };
  assert.equal(producedWords(named, (vid) => `#${vid.slice(2)} Label`, 'review', 'explore'), 'produced #1 · and a leftover #2');
  assert.equal(producedWords(named, unknown, 'review', 'explore'), 'produced 2 versions', 'never a raw id');
});

test('a cancelled record with no role stays silent, whatever its result recorded', () => {
  const result = { versionId: 'v_6', versionIds: ['v_6'], versionNumbers: [6] };
  assert.equal(producedWords(result, () => '#6 Label', 'cancelled'), null);
  assert.equal(producedWords({ versionId: null, versionIds: [] }, () => '', 'cancelled'), null);
  assert.equal(producedWords(result, () => '#6 Label', 'done'), 'produced #6');
  // The server fills the list on every read, so an old record has it too, all null.
  assert.equal(producedWords({ ...result, versionRoles: [null] }, () => '#6 Label', 'cancelled'), null);
  assert.equal(producedWords({ versionId: null, versionIds: [], versionRoles: [] }, () => '', 'cancelled'), null);
  assert.equal(madeBeforeCancel({ ...result, versionRoles: [null] }), false);
  assert.equal(madeBeforeCancel(null), false);
});

test('a task that finished and was cancelled after still names what it made, and says so', () => {
  const unknown = (vid) => vid;
  const two = { versionId: 'v_6', versionIds: ['v_5', 'v_6'], versionNumbers: [5, 6], versionRoles: ['finish', 'finish'] };
  assert.equal(producedWords(two, unknown, 'cancelled'), 'produced #5, #6 · cancelled after');
  assert.equal(madeBeforeCancel(two), true, 'and the row keeps Try it');
  const explore = { versionId: 'v_6', versionIds: ['v_4', 'v_5', 'v_6'], versionNumbers: [4, 5, 6], versionRoles: ['option', null, 'finish'] };
  assert.equal(producedWords(explore, unknown, 'cancelled', 'explore'), 'produced #4, #5 · and a leftover #6 · cancelled after', 'one role is enough; an option has none before ingest');
  const noNumbers = { versionId: 'v_6', versionIds: ['v_6'], versionRoles: ['finish'] };
  assert.equal(producedWords(noNumbers, unknown, 'cancelled'), 'produced a version · cancelled after');
  assert.equal(producedWords(two, unknown, 'done'), 'produced #5, #6', 'only a cancelled row says it');
});

test('two leftovers read as leftovers', () => {
  const result = { versionId: 'v_16', versionIds: ['v_9', 'v_13', 'v_16'], versionNumbers: [9, 13, 16], versionRoles: ['option', 'finish', 'finish'] };
  assert.equal(producedWords(result, (vid) => vid, 'review', 'explore'), 'produced #9 · and leftovers #13, #16');
});

test('an event reads Claude Code where the stored type says console; other types just lose their underscores', () => {
  assert.equal(eventWords('handed_to_console'), 'handed to Claude Code');
  assert.equal(eventWords('base_moved'), 'base moved');
  assert.equal(eventWords('started'), 'started');
});

test('the chip names the project its counts belong to, and what runs each session', () => {
  const label = (id) => ({ 'claude-code': 'Claude Code', api: 'API', command: 'Command' }[id]);
  assert.equal(statusSentence(taskCountWords('review', 1), 'Room Two'), 'Status in Room Two: 1 task ready to try');
  assert.equal(statusSentence(taskCountWords('review', 2), 'Room Two'), 'Status in Room Two: 2 tasks ready to try');
  assert.equal(statusSentence('API utilities are paused; everything else works', null), 'Status: API utilities are paused; everything else works', 'the pause is not a project\'s');
  assert.equal(taskCountWords('needs-input', 2), '2 tasks needing your input', 'never the raw state id');
  assert.equal(taskCountWords('ready', 1), '1 task waiting to be opened in Claude Code');
  const run = (...backends) => runningWords(backends.map((backend) => ({ backend })), label);
  assert.equal(run('claude-code'), '1 Claude Code session running');
  assert.equal(run('claude-code', 'claude-code'), '2 Claude Code sessions running');
  assert.equal(run('api'), '1 API session running', 'an API session is not called Claude Code');
  assert.equal(run('command', 'api', 'claude-code', 'api'), '1 Claude Code session and 1 Command session and 2 API sessions running');
});

test('the session header says Working while a turn runs, and otherwise what the task says', () => {
  assert.equal(sessionChipState(true, { status: 'ready' }), 'working');
  assert.equal(sessionChipState(true, { status: 'review', result: { versionId: 'v' } }), 'working');
  assert.equal(sessionChipState(true, null), 'working', 'a session with no task');
  assert.equal(sessionChipState(false, { status: 'ready' }), 'ready');
  assert.equal(sessionChipState(false, { status: 'review', result: { versionId: null } }), 'record-result');
  assert.equal(sessionChipState(false, null), null);
});

test('the app bar says Working while a session runs, over every task state but a question', () => {
  const tasks = (...states) => states.map((status) => ({ status, result: status === 'review' ? { versionId: 'v' } : null }));
  assert.deepEqual(globalTaskState(tasks('ready'), 1), { state: 'working', count: 0, sessions: 1 });
  assert.deepEqual(globalTaskState(tasks('review'), 2), { state: 'working', count: 0, sessions: 2 });
  assert.deepEqual(globalTaskState(tasks('needs-input', 'review'), 1), { state: 'needs-input', count: 1, sessions: 0 });
  assert.deepEqual(globalTaskState(tasks('review', 'ready', 'ready')), { state: 'review', count: 1, sessions: 0 });
  assert.deepEqual(globalTaskState(tasks('ready', 'ready')), { state: 'ready', count: 2, sessions: 0 });
  assert.equal(globalTaskState(tasks('done', 'cancelled')), null);
  assert.deepEqual(globalTaskState([], 1), { state: 'working', count: 0, sessions: 1 });
});

test('a review task reads Record the result only when its result has no version', () => {
  assert.equal(taskState({ status: 'review', result: { summary: 's', versionId: null } }), 'record-result');
  assert.equal(taskState({ status: 'review', result: { summary: 's', versionId: 'v_1' } }), 'review');
  assert.equal(taskState({ status: 'review', result: null }), 'review', 'no result yet says nothing about a version');
  assert.equal(taskState({ status: 'done', result: { versionId: null } }), 'done', 'other states keep their own words');
});

test('each pause reason has its own label, and only a pause by the person can be resumed', () => {
  const words = (pausedReason) => pauseWords({ paused: true, pausedReason });
  assert.equal(words('user').label, 'Paused by you');
  assert.equal(words('user').canResume, true);
  assert.equal(words(null).canResume, true, 'records from before reasons existed were paused by the person');
  assert.equal(words('ceiling_reached').label, 'Paused: live ceiling reached');
  assert.equal(words('observed_balance_exhausted').label, 'Paused: observed balance below the reserve');
  for (const reason of ['ceiling_reached', 'observed_balance_exhausted', 'some_new_reason']) {
    assert.equal(words(reason).canResume, false, reason);
    assert.ok(words(reason).howToLift, `${reason} says what would lift it`);
  }
  assert.equal(words('some_new_reason').label, 'Paused: some new reason', 'never a raw code');
});
