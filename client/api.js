// Atelier client API: one fetch wrapper + named calls for every route the UI uses.
// Errors from the server look like {error:{code,message}}; they are rethrown as
// Error objects with .code, .status, (for 409 checkpoints) .existing and (for an already registered folder) .project.

let inflightWrites = 0;
const writeListeners = new Set();
const notifyWrites = () => writeListeners.forEach((fn) => fn(inflightWrites));

/** Subscribe to the number of write requests in flight (drives the "Saving" chip). */
export function onWrites(fn) {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

export async function request(method, url, body) {
  const isWrite = method !== 'GET';
  if (isWrite) { inflightWrites++; notifyWrites(); }
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw Object.assign(new Error('The studio server is not reachable. Is it running on port 4747?'), { code: 'offline', status: 0, cause: err });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const e = data?.error || {};
      throw Object.assign(new Error(e.message || `${method} ${url} failed (${res.status})`), {
        code: e.code || 'http_' + res.status, status: res.status, existing: data?.existing || null,
        project: data?.projectId ? { id: data.projectId, name: data.name } : null, // not .name: that is the Error's own
      });
    }
    return data;
  } finally {
    if (isWrite) { inflightWrites--; notifyWrites(); }
  }
}

const get = (u) => request('GET', u);
const post = (u, b = {}) => request('POST', u, b);
const patch = (u, b = {}) => request('PATCH', u, b);
const put = (u, b = {}) => request('PUT', u, b);
const del = (u) => request('DELETE', u);
const enc = encodeURIComponent;
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${enc(v)}`).join('&');
const P = (id) => `/api/projects/${enc(id)}`;

export const api = {
  state: () => get('/api/state'),
  projects: () => get('/api/projects'),
  runs: (projectId = 'all') => get(`/api/runs?${qs({ projectId })}`), // server/lib/runs.mjs
  createProject: (b) => post('/api/projects', b),
  importProject: (b) => post('/api/projects/import', b),
  project: (id) => get(P(id)),
  patchProject: (id, b) => patch(P(id), b),
  removeProject: (id) => del(P(id)),
  activate: (id) => post(`${P(id)}/activate`),
  changes: (id) => get(`${P(id)}/changes`),
  versions: (id) => get(`${P(id)}/versions`),
  keepVersion: (id, b) => post(`${P(id)}/versions`, b),
  patchVersion: (id, vid, b) => patch(`${P(id)}/versions/${enc(vid)}`, b),
  restore: (id, versionId) => post(`${P(id)}/restore`, { versionId }),
  compare: (id, a, b) => get(`${P(id)}/compare?${qs({ a, b })}`),
  readFile: (id, path, max) => get(`${P(id)}/files?${qs({ path, max })}`),
  writeFile: (id, path, content) => put(`${P(id)}/files`, { path, content }),
  build: (id, b = {}) => post(`${P(id)}/build`, b),
  releaseNotesDraft: (id, version) => get(`${P(id)}/release-notes-draft?${qs({ version })}`),
  templateDrift: (id) => get(`${P(id)}/template-drift`),
  templateDriftDiff: (id, path) => get(`${P(id)}/template-drift/diff?path=${encodeURIComponent(path)}`),
  audioRender: (id, b) => post(`${P(id)}/audio/render`, b),
  audioRenders: (id) => get(`${P(id)}/audio/renders`),
  async audioRenderBytes(id, cue) {
    const res = await fetch(`${P(id)}/audio/renders/${enc(cue)}`);
    if (!res.ok) throw new Error(`the file could not be read (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
  releases: (id) => get(`${P(id)}/releases`),
  decisions: (id) => get(`${P(id)}/decisions`),
  addDecision: (id, b) => post(`${P(id)}/decisions`, b),
  patchDecision: (id, did, b) => patch(`${P(id)}/decisions/${enc(did)}`, b),
  projectResources: (id) => get(`${P(id)}/resources`),
  addProjectResource: (id, b) => post(`${P(id)}/resources`, b),
  patchProjectResource: (id, rid, b) => patch(`${P(id)}/resources/${enc(rid)}`, b),
  tasks: (id) => get(`${P(id)}/tasks`),
  allTasks: () => get('/api/tasks'),
  createTask: (id, b) => post(`${P(id)}/tasks`, b),
  task: (id, tid) => get(`${P(id)}/tasks/${enc(tid)}`),
  openTask: (id, tid) => post(`${P(id)}/tasks/${enc(tid)}/open`),
  taskConsole: (id, tid, b = {}) => post(`${P(id)}/tasks/${enc(tid)}/console`, b),
  ingestTask: (id, tid) => post(`${P(id)}/tasks/${enc(tid)}/ingest`),
  taskAction: (id, tid, action, text) => patch(`${P(id)}/tasks/${enc(tid)}`, { action, text }),
  memory: (o) => get(`/api/memory?${qs(o)}`),
  addMemory: (b) => post('/api/memory', b),
  patchMemory: (mid, b, projectId) => patch(`/api/memory/${enc(mid)}?${qs({ projectId })}`, b),
  deleteMemory: (mid, projectId) => del(`/api/memory/${enc(mid)}?${qs({ projectId })}`),
  briefing: (projectId) => get(`/api/briefing?${qs({ projectId })}`),
  resources: () => get('/api/resources'),
  addResource: (b) => post('/api/resources', b),
  patchResource: (rid, b) => patch(`/api/resources/${enc(rid)}`, b),
  budget: () => get('/api/budget'),
  patchBudget: (b) => patch('/api/budget', b),
  usage: (projectId) => get(`/api/usage?${qs({ projectId })}`),
  utility: () => get('/api/utility'),
  runUtility: (task, b) => post(`/api/utility/${enc(task)}`, b),
  cancelUtility: (runId) => post('/api/utility/cancel', { runId }),
  setApiKey: (key) => post('/api/secrets/api-key', { key }),
  removeLegacyClaudeToken: () => post('/api/secrets/claude-token', { token: '' }),
  accountSignIn: () => get('/api/accounts/sign-in'),
  consoleAuth: (fresh = false) => get(`/api/console/auth${fresh ? '?fresh=1' : ''}`),
  evidence: () => get('/api/evidence/models'),
  settings: () => get('/api/settings'),
  patchSettings: (b) => patch('/api/settings', b),
  // console (docs/ARCHITECTURE.md section 7)
  consoleBackends: () => get('/api/console/backends'),
  /** Codex for the Codex tab: the CLI, the login, the models and config.toml's defaults (section 21). */
  codexStatus: (fresh = false) => get(`/api/console/codex${fresh ? '?fresh=1' : ''}`),
  consoleSessions: (projectId) => get(`/api/console/sessions${projectId ? `?${qs({ projectId })}` : ''}`),
  consoleCreate: (b) => post('/api/console/sessions', b),
  consoleGet: (id) => get(`/api/console/sessions/${enc(id)}`),
  /** The model, permission mode or effort of a session, for its next turn. */
  consolePatch: (id, b) => patch(`/api/console/sessions/${enc(id)}`, b),
  consoleDelete: (id) => del(`/api/console/sessions/${enc(id)}`),
  consoleSend: (id, { text, context } = {}) => post(`/api/console/sessions/${enc(id)}/send`, { text, context }),
  consoleCancel: (id) => post(`/api/console/sessions/${enc(id)}/cancel`),
  // companion pins (section 12)
  companionPins: (id) => get(`${P(id)}/companion/pins`),
  /** A file for the next companion message: { name, type, data (base64) } → { path, name, bytes, type }. */
  companionAttach: (id, b) => post(`${P(id)}/companion/attachments`, b),
  addCompanionPin: (id, pin) => post(`${P(id)}/companion/pins`, pin),
  removeCompanionPin: (id, pinId) => del(`${P(id)}/companion/pins/${enc(pinId)}`),
  // the Learning view's lessons (section 19): the shelf, one lesson with its html, delete
  lessons: (id) => get(`${P(id)}/lessons`),
  lesson: (id, lessonId) => get(`${P(id)}/lessons/${enc(lessonId)}`),
  deleteLesson: (id, lessonId) => del(`${P(id)}/lessons/${enc(lessonId)}`),
  // the inspiration board (section 22): the cards, add one (an image rides as base64; a link waits for its preview),
  // change one, move one before another (before: null is the end), remove one
  inspiration: (id) => get(`${P(id)}/inspiration`),
  addInspiration: (id, card) => post(`${P(id)}/inspiration`, card),
  patchInspiration: (id, cardId, b) => patch(`${P(id)}/inspiration/${enc(cardId)}`, b),
  moveInspiration: (id, b) => post(`${P(id)}/inspiration/move`, b),
  removeInspiration: (id, cardId) => del(`${P(id)}/inspiration/${enc(cardId)}`),
  // the Studio look (section 27): the person's own board in the data folder, the same calls without a project; Apply,
  // Reset and Undo of the look it makes (settings.appearance)
  lookBoard: () => get('/api/studio-look/board'),
  addLookCard: (card) => post('/api/studio-look/board', card),
  patchLookCard: (cardId, b) => patch(`/api/studio-look/board/${enc(cardId)}`, b),
  moveLookCard: (b) => post('/api/studio-look/board/move', b),
  removeLookCard: (cardId) => del(`/api/studio-look/board/${enc(cardId)}`),
  applyLook: (look) => post('/api/studio-look/apply', { look }),
  resetLook: () => post('/api/studio-look/reset'),
  undoLook: () => post('/api/studio-look/undo'),
  // fixed rules (section 23): what must stay the same in the project's design; a rule may lock one design token
  rules: (id) => get(`${P(id)}/rules`),
  addRule: (id, rule) => post(`${P(id)}/rules`, rule),
  patchRule: (id, ruleId, b) => patch(`${P(id)}/rules/${enc(ruleId)}`, b),
  removeRule: (id, ruleId) => del(`${P(id)}/rules/${enc(ruleId)}`),
  // references (section 25): what the project keeps to build from; a link waits for its page's title
  references: (id) => get(`${P(id)}/references`),
  addReference: (id, entry) => post(`${P(id)}/references`, entry),
  patchReference: (id, refId, b) => patch(`${P(id)}/references/${enc(refId)}`, b),
  removeReference: (id, refId) => del(`${P(id)}/references/${enc(refId)}`),
  // the Visualizer (section 26): the design the web entry's stylesheets hold, with the rules and the board's colours
  visualizer: (id) => get(`${P(id)}/visualizer`),
  // the Page tab's pages (section 13): the entry and the sibling HTML files
  pageFiles: (id) => get(`${P(id)}/page/files`),
  // live (section 20): the masked status, the person's allowance, start and stop; the frame opens /live/<id> itself
  live: (id) => get(`${P(id)}/live`),
  liveAllow: (id, b) => post(`${P(id)}/live/consent`, b),
  liveForget: (id) => del(`${P(id)}/live/consent`),
  liveStart: (id, b) => post(`${P(id)}/live/start`, b),
  liveStop: (id) => post(`${P(id)}/live/stop`),
  // terminal (section 8); input and resize are sent by components/terminal.js directly
  terminals: () => get('/api/terminal'),
  terminalOpen: (b) => post('/api/terminal', b),
  terminalClose: (id) => del(`/api/terminal/${enc(id)}`),
  // the Skills tab (server/lib/skills.mjs): list, one SKILL.md, and add a picked folder or .zip (dryRun checks only)
  skills: (projectId) => get(`/api/skills?${qs({ projectId })}`),
  skillFile: (projectId, path) => get(`/api/skills/file?${qs({ projectId, path })}`),
  installSkill: (b) => post('/api/skills/install', b),
  revealSkillFolder: (projectId, path) => post('/api/skills/reveal', { projectId, path }), // opens it in the file manager
  // skill departments, studio-wide: { action: add|rename|remove|place, … } answers { departments }
  skillDepartments: (op) => post('/api/skills/departments', op),
};

/** Preview URL of a file of a ref (e.g. "src/index.html"). With no file it is the ref's bare root, which the server
 *  redirects to that ref's entry: for a version the one its own atelier.json names, else the current one. */
export const previewUrl = (projectId, ref = 'head', entry = '') =>
  `/preview/${enc(projectId)}/${enc(ref)}/${String(entry || '').replace(/^\/+/, '').split('/').map(enc).join('/')}`;
/** What a preview frame opens for a ref: the files on disk at the current manifest's entry, a version at its bare
 *  root, because only the server can read which page that version opened on (its entry may differ from today's). */
export const previewStart = (projectId, ref, currentEntry) => previewUrl(projectId, ref, ref === 'head' ? currentEntry : '');
