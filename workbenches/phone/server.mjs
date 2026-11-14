// Phone workbench (server side): the routes under /api/projects/:id/phone over the device providers
// (server/lib/devices; docs/ARCHITECTURE.md section 10). Each route takes ?provider=android|ios, android
// by default. A provider's ok:false answer is a 200 the panel reads, except invalid_input (400),
// build_running (409), no provider for the project (404) and a failed screenshot (503, no image to send).
import { providersFor, PROVIDER_IDS } from '../../server/lib/devices/index.mjs';

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' };

export function routes(route, { loadProject, loadRegistry, HttpError, emit = () => {} }) {
  const settings = async () => (await loadRegistry()).settings || {};

  async function all(id) {
    const ctx = await loadProject(id);
    const list = await providersFor(ctx.path, ctx.manifest, await settings(), { projectId: id });
    if (!list.length) throw new HttpError(404, 'no_device_provider', 'No device provider applies: the project has no android/ or ios/ folder, no capacitor.config.json and no devices in atelier.json');
    return { ctx, list };
  }
  async function one(id, query) {
    const want = query.get('provider') || 'android';
    if (!PROVIDER_IDS.includes(want)) throw new HttpError(400, 'invalid_input', `provider must be ${PROVIDER_IDS.join(' or ')}`);
    const { ctx, list } = await all(id);
    const provider = list.find((p) => p.id === want);
    if (!provider) throw new HttpError(404, 'no_device_provider', `The ${want} provider does not apply to this project (it applies: ${list.map((p) => p.id).join(', ')})`);
    return { ctx, provider };
  }
  /** A provider answer as the route's answer: refusals of the request become HTTP errors, the rest is read by the panel. */
  function answer(out) {
    if (!out.ok && out.code === 'invalid_input') throw new HttpError(400, out.code, out.message);
    if (!out.ok && out.code === 'build_running') throw new HttpError(409, out.code, out.message);
    return out;
  }
  const changed = (projectId, what) => { try { emit('phone.changed', { projectId, ...what }); } catch { /* events never break a route */ } };

  route('GET', '/api/projects/:id/phone', async ({ params }) => {
    const { list } = await all(params.id);
    return { providers: await Promise.all(list.map((p) => p.status())) };
  });

  for (const action of ['boot', 'launch', 'stop']) {
    route('POST', `/api/projects/:id/phone/${action}`, async ({ params, query }) => {
      const { provider } = await one(params.id, query);
      const out = answer(await provider[action]());
      changed(params.id, { provider: provider.id, action, ok: out.ok });
      return out;
    });
  }

  route('POST', '/api/projects/:id/phone/input', async ({ params, query, body }) => {
    const { provider } = await one(params.id, query);
    return answer(await provider.input(body));
  });

  route('POST', '/api/projects/:id/phone/inspect', async ({ params, query, body }) => {
    const { provider } = await one(params.id, query);
    return answer(await provider.inspect({ x: body?.x, y: body?.y }));
  });

  route('GET', '/api/projects/:id/phone/screenshot', async ({ params, query, res }) => {
    const { provider } = await one(params.id, query);
    const shot = await provider.screenshot();
    if (!shot.ok) throw new HttpError(shot.code === 'invalid_input' ? 400 : 503, shot.code, shot.message);
    // Every request has its own ?t=, so nothing stale is served; a short private cache lets the panel's visible
    // image take the bytes its offscreen Image just loaded instead of asking the device for another screencap.
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': shot.png.length, 'Cache-Control': 'private, max-age=60', 'X-Device-Serial': shot.serial || '' });
    res.end(shot.png);
  });

  // Starts the build and answers at once; GET /build/log follows it.
  route('POST', '/api/projects/:id/phone/build', async ({ params, query }) => {
    const { provider } = await one(params.id, query);
    if (!provider.buildState) return answer(await provider.build({})); // the iOS stub answers needs_mac
    if (provider.buildState().state === 'running') return answer({ ok: false, code: 'build_running', message: 'A build is already running for this project' });
    const done = provider.build({}); // the record exists once build() returns
    done.then((out) => changed(params.id, { provider: provider.id, action: 'build', ok: out.ok })).catch(() => {});
    changed(params.id, { provider: provider.id, action: 'build', started: true });
    return { ok: true, started: true, log: `/api/projects/${params.id}/phone/build/log?provider=${provider.id}` };
  });

  route('GET', '/api/projects/:id/phone/build', async ({ params, query }) => {
    const { provider } = await one(params.id, query);
    return provider.buildState ? { ok: true, ...provider.buildState() } : { ok: true, state: 'none' };
  });

  // SSE like the terminal's: the kept lines first (replay: true, at most 400), then each new line;
  // `event: end` with the build's state when it finishes, or at once when no build is running.
  route('GET', '/api/projects/:id/phone/build/log', async ({ params, query, res }) => {
    const { provider } = await one(params.id, query);
    const write = (text) => { try { res.write(text); } catch { /* reader gone */ } };
    const data = (obj) => write(`data: ${JSON.stringify(obj)}\n\n`);
    const finish = (state) => { write(`event: end\ndata: ${JSON.stringify(state)}\n\n`); try { res.end(); } catch { /* gone */ } };
    res.writeHead(200, SSE_HEADERS);
    let ping = null;
    const followed = provider.followBuild?.({
      line: (line) => data({ line }),
      end: (state) => { clearInterval(ping); finish(state); },
    });
    if (!followed) return finish({ state: 'none' });
    for (const line of followed.lines) data({ line, replay: true });
    const { lines, unsubscribe, ...state } = followed;
    if (state.state !== 'running') { unsubscribe(); return finish(state); }
    ping = setInterval(() => write(': ping\n\n'), 25000);
    ping.unref?.();
    res.on('close', () => { clearInterval(ping); unsubscribe(); });
  });
}

export default { kind: 'phone', routes };
