// The Processes tab's model (client/components/process-words.js): which runs become nodes, and each edge's line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processModel, allProjectsModel, projectChoices, resolveChoice, countWords, nodeDetail, pruneReports, edgeOf, addReport, MAX_NODES, MAX_PER_PROJECT, OPEN, ALL, NO_PROJECT } from '../client/components/process-words.js';

const now = Date.parse('2026-11-07T19:00:00Z');
const at = (min) => new Date(now - min * 60000).toISOString();
const run = (id, state, extra = {}) => ({ id, kind: 'session', projectId: 'p1', name: id, state, startedAt: at(10), endedAt: null, latest: null, ...extra });

test('each state has its own line; a working run that waits on something reads as waiting', () => {
  assert.equal(edgeOf(run('a', 'Working')), 'working');
  assert.equal(edgeOf(run('a', 'Working', { waitsFor: 'the phone' })), 'waiting');
  assert.equal(edgeOf(run('a', 'Queued')), 'queued');
  assert.equal(edgeOf(run('a', 'Waiting for you', { endedAt: at(1) })), 'waiting');
  assert.equal(edgeOf(run('a', 'Done', { endedAt: at(1) })), 'done');
  assert.equal(edgeOf(run('a', 'Failed', { endedAt: at(1) })), 'failed');
  assert.equal(edgeOf(run('a', 'Stopped', { endedAt: at(1) })), 'stopped');
});

test('the open project only, working runs first, ended ones within the hour, at most MAX_NODES', () => {
  const runs = [
    run('old-done', 'Done', { startedAt: at(90), endedAt: at(70) }),
    run('done', 'Done', { startedAt: at(20), endedAt: at(5) }),
    run('work', 'Working', { startedAt: at(30) }),
    run('other', 'Working', { projectId: 'p2' }),
  ];
  const m = processModel(runs, { projectId: 'p1', now });
  assert.deepEqual(m.nodes.map((n) => n.id), ['work', 'done']);
  assert.equal(m.live, 1);
  assert.equal(m.ended, 1);
  const many = Array.from({ length: MAX_NODES + 3 }, (_, i) => run(`r${i}`, 'Working'));
  const capped = processModel(many, { projectId: 'p1', now });
  assert.equal(capped.nodes.length, MAX_NODES);
  assert.equal(capped.hidden, 3);
});

test('a report is kept when the latest action changes, not when it repeats, and the log is capped', () => {
  const log = new Map();
  assert.equal(addReport(log, run('a', 'Working')), false, 'no latest yet');
  assert.equal(addReport(log, run('a', 'Working', { latest: 'Read copy.mjs' }), 1), true);
  assert.equal(addReport(log, run('a', 'Working', { latest: 'Read copy.mjs' }), 2), false);
  for (let i = 0; i < 10; i++) addReport(log, run('a', 'Working', { latest: `step ${i}` }), 3 + i, 4);
  assert.deepEqual(log.get('a').map((r) => r.text), ['step 6', 'step 7', 'step 8', 'step 9']);
});

const projects = [{ id: 'p1', name: 'Harbor' }, { id: 'p2', name: 'Atelier (studio)' }, { id: 'p3', name: 'Room One' }];

test('one project: only its runs, whichever project is chosen; a run with no project is its own hub', () => {
  const runs = [run('a', 'Working'), run('b', 'Working', { projectId: 'p2' }), run('c', 'Done', { projectId: 'p2', endedAt: at(2) }), run('u', 'Done', { projectId: null, kind: 'utility', endedAt: at(3) })];
  assert.deepEqual(processModel(runs, { projectId: 'p2', now }).nodes.map((n) => n.id), ['b', 'c']);
  assert.deepEqual(processModel(runs, { projectId: 'p1', now }).nodes.map((n) => n.id), ['a']);
  assert.deepEqual(processModel(runs, { projectId: null, now }).nodes.map((n) => n.id), ['u']);
  assert.equal(processModel(runs, { projectId: 'p3', now }).nodes.length, 0);
});

test('all projects: a group per project with runs this hour, open first then the list order, each capped with its counts', () => {
  const many = Array.from({ length: MAX_PER_PROJECT + 2 }, (_, i) => run(`s${i}`, 'Working', { projectId: 'p2', startedAt: at(20 - i) }));
  const runs = [
    run('a', 'Done', { endedAt: at(5) }),
    ...many,
    run('old', 'Done', { projectId: 'p3', startedAt: at(120), endedAt: at(90) }),
    run('gone', 'Working', { projectId: 'p9' }),
    run('u', 'Done', { projectId: null, kind: 'utility', endedAt: at(3) }),
  ];
  const m = allProjectsModel(runs, projects, { activeId: 'p2', now });
  assert.deepEqual(m.groups.map((g) => g.name), ['Atelier (studio)', 'Harbor', 'p9', NO_PROJECT], 'open first, then list order; Room One ran over an hour ago');
  const studio = m.groups[0];
  assert.equal(studio.open, true);
  assert.equal(studio.nodes.length, MAX_PER_PROJECT);
  assert.equal(studio.hidden, 2);
  assert.equal(studio.live, MAX_PER_PROJECT + 2, 'the working count includes the runs past the cap');
  assert.ok(studio.nodes.every((n) => n.projectId === 'p2'));
  assert.equal(m.groups[1].ended, 1);
  assert.equal(m.live, MAX_PER_PROJECT + 3);
  assert.equal(m.ended, 2);
  assert.deepEqual(allProjectsModel([], projects, { activeId: 'p1', now }).groups, []);
});

test('queued workers sit under their own project with the dotted line, among the running ones', () => {
  const runs = [
    run('w1', 'Working', { projectId: 'p2', startedAt: at(4) }),
    run('q1', 'Queued', { projectId: 'p2', startedAt: at(2), latest: 'waits for t_1' }),
    run('d1', 'Done', { projectId: 'p2', startedAt: at(1), endedAt: at(1) }),
    run('a', 'Working'),
  ];
  const m = allProjectsModel(runs, projects, { activeId: 'p1', now });
  const studio = m.groups.find((g) => g.projectId === 'p2');
  assert.deepEqual(studio.nodes.map((n) => [n.id, n.edge, n.live]), [['q1', 'queued', true], ['w1', 'working', true], ['d1', 'done', false]]);
  assert.equal(studio.live, 2);
  assert.ok(!m.groups.find((g) => g.projectId === 'p1').nodes.some((n) => n.id === 'q1'));
});

test('the picker: the open project, other projects with runs and their counts, then All projects', () => {
  const runs = [run('b', 'Working', { projectId: 'p2' }), run('c', 'Done', { projectId: 'p3', endedAt: at(2) }), run('d', 'Done', { projectId: 'p3', endedAt: at(30), startedAt: at(40) })];
  const choices = projectChoices(runs, projects, { activeId: 'p1', now });
  assert.deepEqual(choices.map((c) => [c.value, c.label]), [
    [OPEN, 'Harbor (open)'],
    ['p2', 'Atelier (studio) · 1 working'],
    ['p3', 'Room One · 2 ended'],
    [ALL, 'All projects · 1 working · 2 ended'],
  ]);
  const own = projectChoices(runs, projects, { activeId: 'p2', now });
  assert.deepEqual(own.map((c) => c.value), [OPEN, 'p3', ALL], 'the open project is listed once, as the open one');
  assert.equal(own[0].label, 'Atelier (studio) (open) · 1 working');
  assert.equal(countWords({ live: 0, ended: 0 }), '');
});

test('a kept choice: all stays all, the open id reads as open, a project with nothing this hour falls back to the open one', () => {
  const runs = [run('b', 'Working', { projectId: 'p2' })];
  const choices = projectChoices(runs, projects, { activeId: 'p1', now });
  assert.deepEqual(resolveChoice(ALL, choices, 'p1'), { value: ALL, projectId: null, all: true, fellBack: false });
  assert.deepEqual(resolveChoice('p2', choices, 'p1'), { value: 'p2', projectId: 'p2', all: false, fellBack: false });
  assert.deepEqual(resolveChoice('p1', choices, 'p1'), { value: OPEN, projectId: 'p1', all: false, fellBack: false });
  assert.deepEqual(resolveChoice('p3', choices, 'p1'), { value: OPEN, projectId: 'p1', all: false, fellBack: true });
  assert.deepEqual(resolveChoice(null, choices, 'p1'), { value: OPEN, projectId: 'p1', all: false, fellBack: false });
  // After a switch to p2, the kept p2 is now the open project.
  assert.equal(resolveChoice('p2', projectChoices(runs, projects, { activeId: 'p2', now }), 'p2').value, OPEN);
});

test('reports are keyed by run: a switch of view keeps every project\'s log, and only runs the server dropped are forgotten', () => {
  const log = new Map();
  addReport(log, run('a', 'Working', { latest: 'Read a.js' }), 1);
  addReport(log, run('b', 'Working', { projectId: 'p2', latest: 'Read b.js' }), 2);
  addReport(log, run('c', 'Working', { projectId: 'p3', latest: 'Read c.js' }), 3);
  assert.equal(pruneReports(log, [run('a', 'Working'), run('b', 'Done', { projectId: 'p2', endedAt: at(1) })]), 1);
  assert.deepEqual([...log.keys()], ['a', 'b']);
  assert.deepEqual(log.get('b').map((r) => r.text), ['Read b.js']);
});

test('a worker node carries its task\'s department; its detail line names it, and the project among all of them', () => {
  const runs = [run('w', 'Working', { name: 'Tidy the labels', department: 'Docs and writing' }), run('q', 'Queued', { name: 'Grid air', department: 'Design' }), run('s', 'Working', { kind: 'terminal', name: 'pwsh' })];
  const m = processModel(runs, { projectId: 'p1', now });
  assert.deepEqual(m.nodes.map((n) => [n.id, n.department]), [['w', 'Docs and writing'], ['q', 'Design'], ['s', null]]);
  assert.equal(nodeDetail(m.nodes[0]), 'Claude Code · Docs and writing department');
  assert.equal(nodeDetail(m.nodes[1], 'Harbor'), 'Claude Code · Design department · Harbor');
  assert.equal(nodeDetail(m.nodes[2]), 'Shell', 'no department, no words for one');
  const all = allProjectsModel(runs, [{ id: 'p1', name: 'Harbor' }], { activeId: 'p1', now });
  assert.equal(all.groups[0].nodes[0].department, 'Docs and writing');
});
