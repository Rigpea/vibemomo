// Device providers: the contract every phone provider implements (docs/ARCHITECTURE.md section 10).
//
// A provider is a plain object made per request for one project:
//
//   id        'android' | 'ios'
//   label     what the panel shows ('Android', 'iPhone')
//   status()                -> { ok: true, id, label, available, reason?, ... }   what is there right now
//   boot()                  -> { ok, serial?, waited? }       start the virtual device and wait until it is up
//   build({ log })          -> { ok, steps? }                 build and install the app; log(line) gets every line
//   launch()                -> { ok }                         start the app on the device
//   stop()                  -> { ok }                         stop the virtual device (a real phone says it cannot)
//   screenshot()            -> { ok, png: Buffer, width, height }   the PNG bytes as the device gave them
//   input(action)           -> { ok }   action = { type: 'tap', x, y } | { type: 'swipe', x, y, x2, y2, ms }
//                                               | { type: 'key', key } | { type: 'text', text }; device pixels
//   inspect({ x, y })       -> { ok, point, element, candidates }   what is under that device point
//
// Every method answers { ok: true, ... } or { ok: false, code, message }. Nothing throws for a tool that
// is missing, a device that is offline or an app that is not running: those are answers, with the reason.
// Nothing is made up: every value comes from the device tools, the device or a build that actually ran.
//
// Codes the routes map to HTTP statuses: invalid_input -> 400, build_running -> 409; every other
// ok:false answer is a 200 the panel reads (the screenshot route answers 503, an image cannot carry JSON).

export const PROVIDER_IDS = ['android', 'ios'];
export const PROVIDER_METHODS = ['status', 'boot', 'build', 'launch', 'stop', 'screenshot', 'input', 'inspect'];

/** The failure answer. `extra` adds facts beside it (the path tried, what was waited for). */
export const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/** Whether an object carries the whole contract; used by the tests and by providersFor. */
export function implementsContract(provider) {
  return !!provider && PROVIDER_IDS.includes(provider.id) && typeof provider.label === 'string' && PROVIDER_METHODS.every((m) => typeof provider[m] === 'function');
}
