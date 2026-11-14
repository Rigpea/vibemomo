// What a change under .studio sends to the live stream (server/lib/watch-events.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watchEvent, createWatchListener } from '../server/lib/watch-events.mjs';
import { writeJson, appendJsonl } from '../server/lib/fsutil.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('watchEvent: temp files and the folders around a write stand for nothing', () => {
  for (const f of ['tasks/t_a/task.json.12.34.tmp', 'tasks\\t_a\\task.json.12.34.tmp', 'memory/m_a.json.1.2.tmp', 'versions.json.1.2.tmp', 'tasks', 'tasks/t_a', 'tasks\\t_a', 'memory', 'BRIEFING.md']) {
    assert.equal(watchEvent(f), null, f);
  }
  // fs.watch may not name the file: something changed, so the project still hears of it
  assert.deepEqual(watchEvent(null), { type: 'project.changed', data: { file: '' } });
});

test('watchEvent: a real file names its kind, and a task file its task', () => {
  assert.deepEqual(watchEvent('tasks\\t_a\\task.json'), { type: 'task.changed', data: { taskId: 't_a', file: 'tasks\\t_a\\task.json' } });
  assert.deepEqual(watchEvent('tasks/t_a/events.jsonl'), { type: 'task.changed', data: { taskId: 't_a', file: 'tasks/t_a/events.jsonl' } });
  assert.deepEqual(watchEvent('memory/m_a.json'), { type: 'memory.changed', data: { file: 'memory/m_a.json' } });
  assert.deepEqual(watchEvent('versions.json'), { type: 'project.changed', data: { file: 'versions.json' } });
});

test('listener: repeated reports for one path send once; different paths send one each', async () => {
  const sent = [];
  const listen = createWatchListener((type, data) => sent.push([type, data.file]), { quietMs: 20 });
  for (const f of ['tasks/t_a/task.json.1.2.tmp', 'tasks/t_a', 'tasks/t_a/task.json', 'tasks/t_a/task.json', 'tasks/t_a/result.json', 'tasks']) listen('rename', f);
  assert.deepEqual(sent, [], 'nothing before the path goes quiet');
  await wait(80);
  assert.deepEqual(sent.sort(), [['task.changed', 'tasks/t_a/result.json'], ['task.changed', 'tasks/t_a/task.json']]);
});

test('a real atomic task write through fs.watch sends one task.changed; so does the next one', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atelier-watch-'));
  const file = path.join(dir, 'tasks', 't_a', 'task.json');
  await writeJson(file, { n: 0 });
  const sent = [];
  const watcher = fs.watch(dir, { recursive: true }, createWatchListener((type, data) => sent.push({ type, ...data }), { quietMs: 40 }));
  try {
    await wait(150);
    sent.length = 0; // anything the setup write still reported
    await writeJson(file, { n: 1 });
    await wait(250);
    assert.equal(sent.length, 1, JSON.stringify(sent));
    assert.equal(sent[0].type, 'task.changed');
    assert.equal(sent[0].taskId, 't_a');
    await writeJson(file, { n: 2 });
    await wait(250);
    assert.equal(sent.length, 2, JSON.stringify(sent));
    await appendJsonl(path.join(dir, 'tasks', 't_a', 'events.jsonl'), { n: 3 });
    await wait(250);
    assert.equal(sent.length, 3, JSON.stringify(sent));
  } finally {
    watcher.close();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
