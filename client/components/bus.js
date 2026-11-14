// Preview message bus shared by the workbench and its panels.
// Receives the game's postMessages ({type:"atelier:ready"|"atelier:event", ...}) and keeps
// a short log since the preview last loaded, so a panel mounted later still sees history.
export function createBus() {
  const target = new EventTarget();
  const bus = {
    events: [],      // atelier:event messages since the preview loaded: {name, t, data, at}
    // The same from the side-by-side frames, with frame 'A' or 'B'. A log of its own: telemetry and
    // acknowledgements in `events` describe the main preview, and only a panel that names the frame reads this.
    frameEvents: [],
    ready: null,     // last atelier:ready message ({tuning}) or null
    loadedAt: Date.now(),
    on(name, fn) {
      const h = (e) => fn(e.detail);
      target.addEventListener(name, h);
      return () => target.removeEventListener(name, h);
    },
    emit(name, detail) { target.dispatchEvent(new CustomEvent(name, { detail })); },
    receive(msg) {
      if (msg.type === 'atelier:event' && typeof msg.name === 'string') {
        const ev = { name: msg.name, t: msg.t, data: msg.data || {}, at: Date.now() };
        // A rendered file can be megabytes of base64: listeners get it once, the log keeps the facts only.
        const { wav, ...facts } = ev.data;
        bus.events.push(wav === undefined ? ev : { ...ev, data: facts });
        if (bus.events.length > 500) bus.events.splice(0, bus.events.length - 500);
        bus.emit('event', ev);
      } else if (msg.type === 'atelier:ready') {
        bus.ready = { ...msg, at: Date.now() };
        bus.emit('ready', bus.ready);
      }
      bus.emit('message', msg);
    },
    receiveFrame(frame, msg) {
      if (msg.type !== 'atelier:event' || typeof msg.name !== 'string') return;
      const { wav, ...facts } = msg.data || {};
      const ev = { name: msg.name, t: msg.t, data: facts, at: Date.now(), frame };
      bus.frameEvents.push(ev);
      if (bus.frameEvents.length > 500) bus.frameEvents.splice(0, bus.frameEvents.length - 500);
      bus.emit('frame-event', ev);
    },
    // One side-by-side frame loaded again: what it reported is gone, as `reset` does for the main preview.
    resetFrame(frame) {
      bus.frameEvents = bus.frameEvents.filter((ev) => ev.frame !== frame);
      bus.emit('frame-reload', { frame });
    },
    reset() {
      bus.events = [];
      bus.frameEvents = [];
      bus.ready = null;
      bus.loadedAt = Date.now();
      bus.emit('reload', {});
    },
  };
  return bus;
}
