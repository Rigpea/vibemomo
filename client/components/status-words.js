// The words for a task's or a budget's state, apart from what is stored. No DOM, so tests can import it
// (ui.js touches the DOM only when its functions are called, and shortLabel does not).
import { shortLabel } from './ui.js';

/** A review task with a result but no version has nothing to try: only the words
 *  differ, its stored status stays `review`. Keys into STATUS in ui.js and GROUPS in views/tasks.js. */
export const taskState = (t) => (t?.status === 'review' && t.result && !t.result.versionId ? 'record-result' : t?.status);

/** Every version a result names, oldest first. A result from before versionIds has only versionId. */
export const resultVersions = (result) => (result?.versionIds?.length ? result.versionIds : result?.versionId ? [result.versionId] : []);

/** An explore task's result split by the server's versionRoles: what the finish kept beside options is a
 *  leftover, never one of them. Every other task's finish version is simply its result, and so is a finish
 *  with no options beside it. {options, leftovers}, ids oldest first. */
export function resultOptions(result, mode) {
  const vids = resultVersions(result);
  const roles = result?.versionRoles;
  const leftover = (_, i) => mode === 'explore' && roles?.length === vids.length && roles[i] === 'finish';
  const options = vids.filter((vid, i) => !leftover(vid, i));
  return options.length ? { options, leftovers: vids.filter(leftover) } : { options: vids, leftovers: [] };
}

/** Did a cancelled task really make what its result names? The server fills versionRoles on every result it reads,
 *  with null for a version with no role, so a real role is what marks a record from #68 on, not the list being there. */
export const madeBeforeCancel = (result) => !!result?.versionRoles?.some(Boolean);

/** What a task row says it made. A cancelled task says it only when madeBeforeCancel; an older cancelled record
 *  stays silent, whatever its result recorded before the cancel.
 *  The server's versionNumbers name every version on any row; nameOf gives "#n label", or the id itself while
 *  the name is unknown, for a result without them. */
export function producedWords(result, nameOf, status, mode) {
  const cancelled = status === 'cancelled';
  if (cancelled && !madeBeforeCancel(result)) return null;
  const after = cancelled ? ' · cancelled after' : '';
  const vids = resultVersions(result);
  if (!vids.length) return result ? 'no version' : null;
  const numbers = result.versionNumbers;
  const known = numbers?.length === vids.length && numbers.every(Number.isInteger);
  const names = vids.map(nameOf);
  if (!known && names.some((name, i) => name === vids[i])) return `${vids.length > 1 ? `produced ${vids.length} versions` : 'produced a version'}${after}`;
  const short = new Map(vids.map((vid, i) => [vid, known ? `#${numbers[i]}` : names[i].split(' ')[0]]));
  const list = (ids) => ids.map((vid) => short.get(vid)).join(', ');
  const { options, leftovers } = resultOptions(result, mode);
  const left = leftovers.length ? ` · and ${leftovers.length > 1 ? 'leftovers' : 'a leftover'} ${list(leftovers)}` : '';
  return `produced ${list(options)}${left}${after}`;
}

const EVENT_WORDS = { handed_to_console: 'handed to Claude Code', worker_interrupted: 'worker interrupted by a studio restart' }; // the stored type keeps the old name

/** A task event's type as a row reads it. */
export const eventWords = (type) => EVENT_WORDS[type] || String(type).replace(/_/g, ' ');

/** The state the Claude Code view's session header shows: a turn running is Working whatever the task's
 *  record says; otherwise the task the session is bound to, and nothing when it has none. */
export const sessionChipState = (busy, task) => (busy ? 'working' : task ? taskState(task) : null);

/** The app bar's task state: the first of these any task is in. A Chat session running in the project counts
 *  as working, because a session can run before its task starts, or for no task at all; a companion session whose
 *  finished answer asks a question (askingSessions) reads needs-you, after a task that needs input.
 *  {state, count, sessions} or null. */
export function globalTaskState(tasks, runningSessions = 0, askingSessions = 0) {
  for (const state of ['needs-input', 'working', 'interrupted', 'review', 'record-result', 'ready']) {
    const count = tasks.filter((t) => taskState(t) === state).length;
    if (count) return { state, count, sessions: 0 };
    if (state === 'needs-input' && askingSessions) return { state: 'needs-you', count: askingSessions, sessions: 0 };
    if (state === 'needs-input' && runningSessions) return { state: 'working', count: 0, sessions: runningSessions };
  }
  return null;
}

/** Running sessions by what runs them, Claude Code first: "1 Claude Code session and 2 API sessions running".
 *  labelOf is backendLabel in the client; it stays out of here because transcript.js builds DOM. */
export function runningWords(sessions, labelOf = (id) => id) {
  const counts = new Map();
  for (const s of sessions) counts.set(s.backend, (counts.get(s.backend) || 0) + 1);
  const backends = [...counts.keys()].sort((a, b) => (b === 'claude-code') - (a === 'claude-code'));
  return `${backends.map((b) => `${counts.get(b)} ${labelOf(b)} session${counts.get(b) > 1 ? 's' : ''}`).join(' and ')} running`;
}

/** "2 tasks ready to try": the app bar's count of one state, never a raw state id. */
export function taskCountWords(state, n) {
  if (state === 'needs-you') return n > 1 ? `${n} companion sessions ask you a question` : 'the companion asks you a question';
  const what = { review: 'ready to try', 'record-result': 'with nothing to try, only a result to record', 'needs-input': 'needing your input', ready: 'waiting to be opened in Claude Code' }[state] || state;
  return `${n} task${n > 1 ? 's' : ''} ${what}`;
}

/** The chip's sentence. It counts the active project only, while Tasks can show all of them, so it says which. */
export const statusSentence = (why, projectName) => (projectName ? `Status in ${projectName}: ${why}` : `Status: ${why}`);

const CHIP_STATES = { review: 'ready to try', working: 'working', interrupted: 'interrupted', 'record-result': 'record the result', ready: 'ready for Claude Code', 'needs-you': 'needs you' };

/** A project's chip: visible names the project and its state in short words; said is the whole sentence, for the
 *  title and the accessible name. sessions are the running ones, which are what a chip with any reads from.
 *  status 'run-ended' with run (a row of GET /api/runs the server reported ended) reads "<project>: <name> <state>". */
export function chipWords(status, count, sessions, projectName, labelOf, run = null) {
  if (status === 'run-ended' && run) {
    const what = `${shortLabel(run.name, 32)} ${run.state}`;
    return { visible: `${shortLabel(projectName, 20)}: ${what}`, said: statusSentence(`${run.name} ${run.state}${run.reason ? ` · ${run.reason}` : ''}`, projectName) };
  }
  const running = sessions?.length ? sessions : null;
  const state = running ? 'working' : status;
  const words = state === 'needs-input' ? `${count} need${count === 1 ? 's' : ''} input` : CHIP_STATES[state] || state;
  return {
    visible: `${shortLabel(projectName, 20)}: ${words}`,
    said: statusSentence(running ? runningWords(running, labelOf) : taskCountWords(state, count), projectName),
  };
}

/** A task's events as stored (oldest first), split so the last `shown` stay open under a disclosure for the rest. */
export function splitEvents(events, shown = 12) {
  const cut = Math.max(0, events.length - shown);
  return { earlier: events.slice(0, cut), recent: events.slice(cut) };
}

// Reasons come from server/api-utility/budget.mjs. Only the person can undo their own pause; the
// studio lifts its own when the cause is gone (budget.patch rechecks), so those explain what to change.
const AUTO_PAUSES = {
  ceiling_reached: {
    label: 'Paused: live ceiling reached',
    title: 'Spending this cycle reached the live ceiling. API utility runs are refused; Claude Code, versions, tasks and memory keep working',
    howToLift: 'To run utilities again, raise the live ceiling or set a new cycle below. The pause lifts when you save, if that leaves room.',
  },
  observed_balance_exhausted: {
    label: 'Paused: observed balance below the reserve',
    title: 'The observed balance, less what was spent since, is at or below the reserve. API utility runs are refused; Claude Code, versions, tasks and memory keep working',
    howToLift: 'To run utilities again, enter a newer observed balance below. The pause lifts when you save, if it is above the reserve.',
  },
};

/** {label, title, canResume, howToLift} for a paused budget (or the status object, which has the same fields). */
export function pauseWords(b) {
  const reason = b?.pausedReason;
  if (!reason || reason === 'user') {
    return { label: 'Paused by you', title: 'API utility runs are refused; Claude Code, versions, tasks and memory keep working', canResume: true, howToLift: null };
  }
  const auto = AUTO_PAUSES[reason];
  if (auto) return { ...auto, canResume: false };
  return {
    label: `Paused: ${String(reason).replace(/_/g, ' ')}`,
    title: 'The studio paused API utility runs; Claude Code, versions, tasks and memory keep working',
    canResume: false,
    howToLift: 'Saving the cycle or the balance below checks this pause again.',
  };
}
