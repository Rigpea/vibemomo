// What a change under <project>/.studio means for the live event stream.
// One atomic write reaches fs.watch as several reports: the temp file, the folders around it, and on
// Windows the target twice (removed, then added). A person's screen needs one event per written file.

/** The task id in a path relative to .studio (tasks/<id>/..., either separator); null otherwise. */
export function taskIdFromPath(file) {
  const parts = String(file || '').split(/[\\/]/);
  return parts[0] === 'tasks' && parts.length > 2 && parts[1] ? parts[1] : null;
}

/** The {type, data} a changed path stands for, or null when it stands for nothing of its own:
 *  a temp file, the briefing, or a folder that changed because a file inside it did. */
export function watchEvent(file) {
  const f = String(file || '');
  if (f.endsWith('.tmp')) return null;
  const parts = f.split(/[\\/]/);
  if ((parts[0] === 'tasks' && parts.length <= 2) || f === 'memory') return null;
  // A lesson file (the Learning view's shelf), not the project record; the folder itself stands for nothing.
  if (parts[0] === 'lessons') return parts.length === 2 && /^les_[a-z0-9]+\.json$/.test(parts[1]) ? { type: 'lessons.changed', data: { lessonId: parts[1].slice(0, -5), file: f } } : null;
  // The inspiration board (server/lib/inspiration.mjs): its record says a card changed; an image file beside it says
  // nothing of its own, since the record is written after it.
  if (f === 'inspiration.json') return { type: 'inspiration.changed', data: { file: f } };
  if (parts[0] === 'inspiration' || f.startsWith('inspiration.json.')) return null;
  // The fixed rules (server/lib/rules.mjs): a hand edit or another window's change reaches the open view.
  if (f === 'rules.json') return { type: 'rules.changed', data: { file: f } };
  if (f.startsWith('rules.json.')) return null;
  // The references (server/lib/references.mjs), the same way.
  if (f === 'references.json') return { type: 'references.changed', data: { file: f } };
  if (f.startsWith('references.json.')) return null;
  if (f.includes('tasks')) {
    const taskId = taskIdFromPath(f);
    return { type: 'task.changed', data: taskId ? { taskId, file: f } : { file: f } };
  }
  if (f.includes('memory')) return { type: 'memory.changed', data: { file: f } };
  if (f === 'pins.json') return { type: 'pins.changed', data: { file: f } }; // the Companion tab's pins, not the project record
  return f.startsWith('BRIEFING') ? null : { type: 'project.changed', data: { file: f } };
}

/** An fs.watch listener: reports for one path merge until it has been quiet for quietMs, then send() runs once. */
export function createWatchListener(send, { quietMs = 60 } = {}) {
  const waiting = new Map(); // path -> timer
  return (_evt, filename) => {
    const f = String(filename || '');
    const event = watchEvent(f);
    if (!event) return;
    clearTimeout(waiting.get(f));
    const timer = setTimeout(() => { waiting.delete(f); send(event.type, event.data); }, quietMs);
    timer.unref?.();
    waiting.set(f, timer);
  };
}
