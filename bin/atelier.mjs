#!/usr/bin/env node
// Atelier CLI — the half of the handoff that Claude Code (or you) runs.
// It works on files only; the studio server need not be running.
//
//   atelier task show <id>            print the brief
//   atelier task handover <id>        set the base to HEAD now; an explore task's HEAD with no version gets one
//   atelier task start <id>           mark working (writes a started event)
//   atelier task note <id> "text"     progress note
//   atelier task question <id> "text" ask the user; status needs-input
//   atelier task finish <id> --summary "..." [--verification "..."]... [--unresolved "..."]... [--decision "text | reason"]...
//   atelier task list [--project <id|path>]
//   atelier memory add --scope user|project --kind <kind> [--tags a,b] [--status explicit|inferred|verified] "text"
//   atelier memory list [--scope user|project|all] [--q "..."] [--project <id|path>]
//   atelier memory retract <id> | delete <id>
//   atelier checkpoint --label "..." [--note "..."] [--task <id>] [--project <id|path>]
//   atelier restore <versionId> [--project <id|path>]
//   atelier projects                  every registered project with its worker model
//   atelier project get worker-model [--project <id|path>]
//   atelier project set worker-model <model|default> [--project <id|path>]
//   atelier briefing [--project <id|path>]
//
// The project is resolved from --project, else from the current folder (walking up to a .studio/).
import path from 'node:path';
import fsp from 'node:fs/promises';
import process from 'node:process';
import { loadRegistry } from '../server/lib/registry.mjs';
import { readJson, exists } from '../server/lib/fsutil.mjs';
import { isPlainName, folderKey } from '../server/lib/paths.mjs';
import * as projects from '../server/lib/projects.mjs';
import * as versions from '../server/lib/versions.mjs';
import * as memory from '../server/lib/memory.mjs';
import * as tasks from '../server/lib/tasks.mjs';
import * as briefing from '../server/lib/briefing.mjs';
import { CONSOLE_MODELS, workerModelWords } from '../server/lib/models.mjs';
import { studioWorkerModelOf } from '../server/lib/worker-model.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        if (flags[key] === undefined) flags[key] = next;
        else flags[key] = [].concat(flags[key], next);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}
const arr = (v) => (v === undefined ? [] : [].concat(v));

async function resolveProject(flag) {
  const reg = await loadRegistry();
  if (flag) {
    const byId = reg.projects.find((p) => p.id === flag || p.slug === flag || p.name === flag);
    if (byId) return byId.id;
    const key = folderKey(String(flag));
    const byPath = reg.projects.find((p) => folderKey(p.path) === key);
    if (byPath) return byPath.id;
    throw new Error(`No registered project matches ${flag}`);
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const found = reg.projects.find((p) => folderKey(p.path) === folderKey(dir));
    if (found) return found.id;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Not inside a registered project; pass --project <id|path>');
}

/** Find which project owns a task id (tasks are per project). */
async function findTask(tid, projectFlag) {
  const reg = await loadRegistry();
  const candidates = projectFlag ? [await resolveProject(projectFlag)] : reg.projects.map((p) => p.id);
  for (const id of candidates) {
    const entry = reg.projects.find((p) => p.id === id);
    if (!entry) continue;
    if (await exists(path.join(entry.path, '.studio', 'tasks', tid, 'task.json'))) return projects.loadProject(id);
  }
  throw new Error(`Task ${tid} not found in any registered project`);
}

const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [group, cmd, ...rest] = positional;
  if (!group || flags.help || group === '--help') {
    console.log(await fsp.readFile(new URL(import.meta.url), 'utf8').then((t) => t.split('\n').filter((l) => l.startsWith('//')).slice(1, 21).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')));
    return;
  }
  if (group === 'projects') {
    const reg = await loadRegistry();
    const studioDefault = studioWorkerModelOf(reg.settings).model; // the stored studio default, else the built-in one
    for (const p of reg.projects) {
      const record = await readJson(path.join(p.path, '.studio', 'project.json'), null).catch(() => null);
      const worker = record ? `  worker ${workerModelWords(record, studioDefault)}` : '';
      console.log(`${p.id}  ${p.kind.padEnd(8)}  ${p.name}  ${p.path}${reg.activeProjectId === p.id ? '  (active)' : ''}${worker}`);
    }
    return;
  }
  if (group === 'task') {
    if (cmd === 'list') {
      const id = await resolveProject(flags.project);
      const ctx = await projects.loadProject(id);
      for (const t of await tasks.listTasks(ctx.path)) console.log(`${t.id}  ${(tasks.STATUS_LABELS[t.status] || t.status).padEnd(22)}  ${t.mode.padEnd(7)}  ${t.title}`);
      return;
    }
    const tid = rest[0] ?? cmd;
    if (!tid) throw new Error('task id required');
    const ctx = await findTask(tid, flags.project);
    const regen = () => briefing.regenerate(ctx.project.id);
    switch (cmd) {
      case 'show': {
        const { brief, task, events } = await tasks.getTask(ctx.path, tid);
        console.log(brief);
        console.log(`\n--- status: ${tasks.STATUS_LABELS[task.status] || task.status} · events: ${events.length}`);
        return;
      }
      case 'handover': {
        const { task, moved, reason } = await tasks.handOverTask(ctx, tid);
        if (reason === 'closed') return out(`task ${tid} is ${tasks.STATUS_LABELS[task.status] || task.status}; nothing to hand over`);
        if (moved) await regen();
        const named = task.context?.baseVersionId;
        if (reason === 'kept' && !named && task.mode === 'explore') return out(`task ${tid}: ${tasks.keptBareBase(task.context?.baseSha)}`);
        const base = (await versions.listVersions(ctx.path)).find((v) => v.id === named);
        return out(`task ${tid}: the base is ${base ? `#${base.n} ${base.label} (${base.id})` : `commit ${String(task.context?.baseSha).slice(0, 8)}`}${moved ? ', and the brief says so now' : named && !base ? '; its base version record is gone' : ''}`);
      }
      case 'start': {
        const t = await tasks.startTask(ctx.path, tid);
        await regen();
        return out(`task ${tid} → working (started ${t.startedAt}). Brief: ${path.join(ctx.path, '.studio', 'tasks', tid, 'brief.md')}`);
      }
      case 'note': {
        await tasks.noteTask(ctx.path, tid, rest.slice(1).join(' '));
        return out(`note recorded on ${tid}`);
      }
      case 'heartbeat': {
        await tasks.heartbeat(ctx.path, tid);
        return out('ok');
      }
      case 'question': {
        await tasks.questionTask(ctx.path, tid, rest.slice(1).join(' '));
        await regen();
        return out(`task ${tid} → needs your input`);
      }
      case 'finish': {
        const summary = flags.summary;
        if (!summary || summary === true) throw new Error('--summary "..." is required');
        const { version, result } = await tasks.finishTask(ctx, tid, {
          summary,
          verification: arr(flags.verification),
          unresolved: arr(flags.unresolved),
          decisions: arr(flags.decision),
        });
        await regen();
        if (!version) return out({ task: tid, status: 'review (nothing to try: record the result to close it)', version: null, note: result.note, result });
        return out({ task: tid, status: 'review (Ready to try)', version: { id: version.id, n: version.n, sha: version.sha, label: version.label }, versionIds: result.versionIds, result });
      }
      default:
        throw new Error(`Unknown task command ${cmd}`);
    }
  }
  if (group === 'memory') {
    const projectId = cmd === 'add' && flags.scope !== 'project' && !flags.project ? null : await resolveProject(flags.project).catch(() => null);
    const ctx = projectId ? await projects.loadProject(projectId) : null;
    switch (cmd) {
      case 'add': {
        const text = rest.join(' ');
        const scope = flags.scope || 'project';
        if (scope === 'project' && !ctx) throw new Error('project scope needs a project (run inside one or pass --project)');
        const rec = await memory.addMemory(
          { text, scope, kind: flags.kind || 'observation', status: flags.status || 'inferred', tags: flags.tags ? String(flags.tags).split(',') : [], provenance: { source: 'claude-code', ref: flags.ref || '', evidence: flags.evidence || '' } },
          { projectPath: ctx?.path || null, projectId: ctx?.project.id || null }
        );
        if (ctx) await briefing.regenerate(ctx.project.id);
        return out({ added: rec.id, scope: rec.scope, status: rec.status });
      }
      case 'list': {
        const list = await memory.listMemory({ scope: flags.scope || 'all', projectPath: ctx?.path || null, projectId: ctx?.project.id || null, q: flags.q || '', limit: Number(flags.limit || 50) });
        for (const m of list) console.log(`${m.id}  ${m.scope.padEnd(7)} ${m.kind.padEnd(11)} ${m.status.padEnd(9)} ${m.text}`);
        return;
      }
      case 'retract': {
        const r = await memory.retractMemory(rest[0], { projectPath: ctx?.path || null });
        return out({ retracted: rest[0], now: r.record.status });
      }
      case 'delete': {
        return out(await memory.deleteMemory(rest[0], { projectPath: ctx?.path || null }));
      }
      default:
        throw new Error(`Unknown memory command ${cmd}`);
    }
  }
  if (group === 'project') {
    // atelier project get worker-model | project set worker-model <model|default>: the model this project's workers
    // start on (server/lib/models.mjs). Written to .studio/project.json through patchProject, which refuses a bad id.
    const id = await resolveProject(flags.project);
    const studioDefault = studioWorkerModelOf((await loadRegistry()).settings).model;
    const setting = rest[0];
    if (setting !== 'worker-model') throw new Error(`project ${cmd || '(no command)'} needs a setting: worker-model`);
    if (cmd === 'get') {
      const ctx = await projects.loadProject(id);
      return out(`${ctx.project.name} (${id}) worker model: ${workerModelWords(ctx.project, studioDefault)}`);
    }
    if (cmd === 'set') {
      const value = rest[1];
      if (!value) throw new Error(`project set worker-model needs a model (${CONSOLE_MODELS.join(', ')}) or default`);
      await projects.patchProject(id, { workerModel: value === 'default' ? null : value });
      await briefing.regenerate(id);
      const ctx = await projects.loadProject(id); // read back from the record, not from what was sent
      return out(`${ctx.project.name} (${id}) worker model: ${workerModelWords(ctx.project, studioDefault)}. It applies to the next worker started; a running worker keeps its model.`);
    }
    throw new Error(`Unknown project command ${cmd}; use get or set`);
  }
  if (group === 'checkpoint') {
    const id = await resolveProject(flags.project);
    const ctx = await projects.loadProject(id);
    // A mistyped id would tag a version with a task that does not exist, and the task would never find it.
    // A plain name only: "../../x/.studio/tasks/t_y" would find another project's task.json.
    if (flags.task !== undefined && (!isPlainName(flags.task) || !(await exists(path.join(ctx.path, '.studio', 'tasks', flags.task, 'task.json'))))) {
      throw new Error(`--task needs a task of this project (got ${flags.task === true ? 'no id' : flags.task})`);
    }
    const task = flags.task ? (await tasks.getTask(ctx.path, flags.task)).task : null;
    if (task && ['done', 'cancelled'].includes(task.status)) throw new Error(`--task needs an open task: ${flags.task} is ${task.status}`);
    const v = await versions.checkpoint(ctx, { label: flags.label, note: flags.note || '', origin: 'claude-code', state: flags.state || 'experiment', taskId: flags.task || null, role: task?.mode === 'explore' ? 'option' : null, baseSha: task?.context?.baseSha || null });
    await briefing.regenerate(id);
    out(`#${v.n} ${String(v.label).replace(/\s+/g, ' ')} (${v.id})`); // the number first: it is what a session should repeat
    return out({ version: v.id, n: v.n, sha: v.sha, label: v.label, ...(v.taskId ? { taskId: v.taskId } : {}) });
  }
  if (group === 'restore') {
    const id = await resolveProject(flags.project);
    const ctx = await projects.loadProject(id);
    if (!cmd) throw new Error('restore needs a version id');
    // Checked here so a wrong id says which project it was looked for in, before anything on disk moves.
    if (!(await versions.listVersions(ctx.path)).some((v) => v.id === cmd)) throw new Error(`${cmd} is not a version of ${ctx.project.name}`);
    const { restoredTo: v, safetyVersionId } = await versions.restore(ctx, cmd);
    await briefing.regenerate(id);
    return out({ restoredTo: { version: v.id, n: v.n, sha: v.sha, label: v.label }, safetyVersionId });
  }
  if (group === 'briefing') {
    const id = await resolveProject(flags.project);
    const { markdown } = await briefing.composeBriefing(id);
    console.log(markdown);
    return;
  }
  throw new Error(`Unknown command ${group}`);
}

main().catch((err) => {
  console.error(`atelier: ${err.message}`);
  if (err.existing) console.error(`existing version: ${err.existing.id}`);
  process.exit(1);
});
