import test from 'node:test';
import assert from 'node:assert/strict';
import { groupUnresolved, firstItems, groupLine, itemCount, resolveLabel, resolveAllLabel, focusAfterResolve, focusAfterResolveAll } from '../client/components/unresolved-groups.js';

test('after a Resolve the focus keys hold no button: a repeated Enter must not resolve a second item', () => {
  const view = groupUnresolved([{ id: 'm', text: 'm' }, { id: 'a1', text: 'a1', taskId: 't_a', taskTitle: 'A' }, { id: 'a2', text: 'a2', taskId: 't_a', taskTitle: 'A' }]);
  const keys = [...focusAfterResolve(view, view.typed[0]), ...view.groups[0].items.flatMap((u) => focusAfterResolve(view, u)), ...focusAfterResolveAll(view, view.groups[0])];
  assert.ok(keys.length);
  for (const key of keys) assert.match(key, /^(item:|group:|unresolved-add$)/);
});

test('each Resolve names its item, and each Resolve all its group', () => {
  assert.equal(resolveLabel({ text: 'one two three four five six seven eight nine ten' }), 'Resolve: one two three four five six seven eight…');
  assert.equal(resolveLabel({ text: 'Is  the jump\ntoo floaty?' }), 'Resolve: Is the jump too floaty?', 'nothing cut, so no …');
  assert.equal(resolveLabel({ text: 'one two three four five six seven eight' }), 'Resolve: one two three four five six seven eight');
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolveAllLabel({ items, title: 'An explore task shows every option it made' }), 'Resolve all 3 from An explore task shows every option');
  assert.equal(resolveAllLabel({ items, title: '', earlier: true }), 'Resolve all 3 from earlier tasks');
});

const typed = (text) => ({ id: `u_${text}`, text });
const carried = (text, taskId, taskTitle) => ({ id: `u_${text}`, text, taskId, ...(taskTitle ? { taskTitle } : {}) });
const texts = (list) => list.map((u) => u.text);

test('typed items come first, whatever the order of the list', () => {
  const view = groupUnresolved([carried('a', 't_1', 'One'), typed('mine'), carried('b', 't_1', 'One'), typed('also mine')]);
  assert.deepEqual(texts(view.typed), ['mine', 'also mine']);
  assert.deepEqual(view.groups.map((g) => g.title), ['One']);
  assert.equal(view.total, 4);
});

test('items group by task, also when another task left items between them', () => {
  const view = groupUnresolved([carried('a', 't_1', 'One'), carried('b', 't_2', 'Two'), carried('c', 't_1', 'One')]);
  assert.deepEqual(view.groups.map((g) => [g.taskId, texts(g.items)]), [['t_1', ['a', 'c']], ['t_2', ['b']]]);
});

test('an item from before the title stamp finds its title in the tasks, or goes to the earlier group, last', () => {
  const view = groupUnresolved(
    [carried('gone', 't_gone'), carried('old', 't_old'), carried('new', 't_new', 'New'), carried('gone too', 't_gone2'), typed('mine')],
    { t_old: 'Old task' });
  assert.deepEqual(texts(view.typed), ['mine']);
  assert.deepEqual(view.groups.map((g) => [g.earlier ? 'earlier' : g.title, texts(g.items)]), [
    ['Old task', ['old']], ['New', ['new']], ['earlier', ['gone', 'gone too']],
  ]);
  assert.equal(groupLine(view.groups[2]), 'From earlier tasks · 2 items');
});

test('an entry without taskId is typed, not "earlier": carrying has always stamped taskId', () => {
  const view = groupUnresolved([{ id: 'u_1', text: 'Typed before the stamp', createdAt: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(view.typed.length, 1);
  assert.deepEqual(view.groups, []);
});

test('one stamped item names the group for an unstamped item of the same task', () => {
  const view = groupUnresolved([carried('old', 't_1'), carried('new', 't_1', 'Reopened')]);
  assert.deepEqual(view.groups.map((g) => [g.title, g.earlier]), [['Reopened', false]]);
});

test('the group line counts its items', () => {
  const [one, two] = groupUnresolved([carried('a', 't_1', 'One'), carried('b', 't_2', 'Two'), carried('c', 't_2', 'Two')]).groups;
  assert.equal(groupLine(one), 'From task: One · 1 item');
  assert.equal(groupLine(two), 'From task: Two · 2 items');
  assert.equal(itemCount(0), '0 items');
});

test('empty, missing and blank lists read as nothing', () => {
  for (const list of [[], undefined, null, [null]]) assert.deepEqual(groupUnresolved(list), { typed: [], groups: [], total: 0 });
});

test('firstItems shows five across typed and groups; a cut group still holds all it would resolve', () => {
  const view = groupUnresolved([
    typed('m1'), typed('m2'),
    carried('a1', 't_a', 'A'), carried('a2', 't_a', 'A'), carried('a3', 't_a', 'A'), carried('a4', 't_a', 'A'),
    carried('b1', 't_b', 'B'),
  ]);
  assert.equal(view.total, 7);
  const first = firstItems(view, 5);
  assert.deepEqual(texts(first.typed), ['m1', 'm2']);
  assert.deepEqual(first.groups.map((g) => g.title), ['A']);
  assert.deepEqual(texts(first.groups[0].shown), ['a1', 'a2', 'a3']);
  assert.equal(first.groups[0].items.length, 4);
  assert.equal(groupLine(first.groups[0]), 'From task: A · 4 items');
});

test('firstItems without a limit shows everything; a limit inside the typed items shows no group', () => {
  const view = groupUnresolved([typed('m1'), typed('m2'), carried('a', 't_a', 'A')]);
  const all = firstItems(view);
  assert.deepEqual(all.groups[0].shown, all.groups[0].items);
  assert.equal(all.typed.length, 2);
  assert.deepEqual(firstItems(view, 1), { typed: [view.typed[0]], groups: [] });
});
