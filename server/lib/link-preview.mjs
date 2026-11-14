// A link card's title and preview image, fetched by the server (docs/ARCHITECTURE.md section 22). The rules:
// only http and https; never a local or private address, checked on the URL, on every redirect and on what the
// name resolves to (the lookup that checks is the lookup that connects, so a name cannot answer twice); one
// deadline for the page and one for the image; a byte cap on both. A page that refuses, times out or is not HTML
// is not an error: the card is then a plain link, and the reason is kept as words.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { HttpError } from './paths.mjs';
import { imageType, imageSize } from './image-type.mjs';

export const LINK_TIMEOUT_MS = 8000;
/** How much of a page is read for its title and preview: some sites send those after a megabyte of markup
 *  (linear.app's title sat at 960 KB on 2026-11-13), so the cap is generous and the deadline is what bounds a slow one. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PREVIEW_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_REDIRECTS = 4;
export const URL_MAX = 2000;
const AGENT = 'Mozilla/5.0 (compatible; AtelierLinkPreview/1.0)';

const v4Private = ([a, b, c]) => a === 0 || a === 10 || a === 127 || a >= 224
  || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
  || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
  || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);

/** An IPv6 address as eight 16-bit numbers, or null. Takes :: and an IPv4 tail; a zone (%eth0) is dropped. */
function v6Groups(text) {
  let s = String(text).replace(/%.*$/, '');
  const tail = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h ? h.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** True for an address the studio never fetches from: loopback, private, link-local, carrier NAT, multicast,
 *  reserved and documentation ranges, and IPv6 forms that carry such an IPv4 address. Not an address at all: true. */
export function isPrivateAddress(ip) {
  const text = String(ip || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(text)) return v4Private(text.split('.').map(Number));
  const g = net.isIPv6(text.replace(/%.*$/, '')) ? v6Groups(text) : null;
  if (!g) return true;
  const v4 = (hi, lo) => v4Private([hi >> 8, hi & 255, lo >> 8]);
  if (g.slice(0, 6).every((x) => x === 0)) return g[6] === 0 && g[7] <= 1 ? true : v4(g[6], g[7]); // ::, ::1, ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6], g[7]); // NAT64
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo carries an IPv4 address behind a NAT
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/i;
const unsafe = (message) => new HttpError(400, 'unsafe_link', message);

/**
 * The link as a URL the studio may fetch, or a 400 that says why not. Checked before any request and again on
 * every redirect. guard(ip) answers true for an address to refuse (isPrivateAddress; the tests pass their own).
 */
export function checkLinkUrl(raw, { guard = isPrivateAddress } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'invalid_input', 'A link card needs a url');
  const text = raw.trim();
  if (text.length > URL_MAX) throw new HttpError(400, 'invalid_input', `A link is at most ${URL_MAX} characters`);
  let url;
  try { url = new URL(text); } catch { throw new HttpError(400, 'invalid_input', `That is not a link the studio can read: ${text.slice(0, 80)}`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unsafe(`Only http and https links can be kept; this one starts with ${url.protocol}`);
  if (url.username || url.password) throw unsafe('A link with a user name or password in it is not kept; remove them from the address');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new HttpError(400, 'invalid_input', 'That link has no host name');
  const where = `That link points at a private or local address (${host}); the studio does not fetch or keep those`;
  if (net.isIP(host) ? guard(host) : LOCAL_NAME.test(host) || !host.includes('.')) throw Object.assign(unsafe(where), { local: true });
  return url;
}

/** A lookup for http.request that refuses a name when any address it resolves to is one the guard refuses. */
export function guardedLookup({ guard = isPrivateAddress, lookup = dns.lookup } = {}) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    lookup(hostname, { all: true, family: opts.family || 0 }, (err, list) => {
      if (err) return cb(err);
      const addresses = (Array.isArray(list) ? list : [{ address: list, family: net.isIPv6(String(list)) ? 6 : 4 }]).filter((a) => a?.address);
      const bad = addresses.find((a) => guard(a.address));
      if (bad || !addresses.length) return cb(Object.assign(new Error(`${hostname} resolves to a private or local address${bad ? ` (${bad.address})` : ''}`), { code: 'EPRIVATE' }));
      if (opts.all) cb(null, addresses); else cb(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** One GET with a deadline and a byte cap. Resolves { status, headers, body, truncated }; rejects with words. */
function get(url, { lookup, deadline, maxBytes, accept, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const late = () => Object.assign(new Error('timed out'), { code: 'EDEADLINE', timeoutMs });
    const left = deadline - Date.now();
    if (left <= 0) return reject(late());
    const lib = url.protocol === 'https:' ? https : http;
    let done = false;
    const end = (fn, value) => { if (done) return; done = true; clearTimeout(timer); fn(value); };
    // agent: false: a connection of its own, so no socket opened under another lookup is ever reused here.
    // Each address a name resolves to gets 2 s to connect (Node's 250 ms gave up on a slow first hop).
    const req = lib.request(url, { method: 'GET', lookup, agent: false, autoSelectFamilyAttemptTimeout: 2000, headers: { 'User-Agent': AGENT, Accept: accept, 'Accept-Language': 'en', 'Accept-Encoding': 'gzip, deflate, br' } }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const unpack = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
      const stream = unpack ? res.pipe(unpack) : res;
      const cap = typeof maxBytes === 'function' ? maxBytes(res.headers) : maxBytes; // the cap may depend on what is answered
      const chunks = [];
      let size = 0;
      const finish = (truncated) => { end(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).subarray(0, cap), truncated }); req.destroy(); };
      stream.on('data', (c) => { chunks.push(c); size += c.length; if (size > cap) finish(true); });
      stream.on('end', () => finish(false));
      stream.on('error', (err) => (chunks.length ? finish(true) : end(reject, err)));
      res.on('error', (err) => end(reject, err));
    });
    const timer = setTimeout(() => { req.destroy(); end(reject, late()); }, left);
    req.on('error', (err) => end(reject, err));
    req.end();
  });
}

/** Follow redirects by hand, checking each address before it is asked. Resolves the answer and the URL it came from. */
async function getFollowing(start, opts) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res;
    try { res = await get(url, opts); } catch (err) {
      if (hop > 0 && err?.code === 'EPRIVATE') throw Object.assign(new Error('it redirects to a private or local address, which the studio does not follow'), { code: 'EREDIRECT' });
      throw err;
    }
    if (![301, 302, 303, 307, 308].includes(res.status) || !res.headers.location) return { ...res, url };
    let next;
    try { next = checkLinkUrl(new URL(res.headers.location, url).href, { guard: opts.guard }); } catch (err) {
      throw Object.assign(new Error(err.local ? 'it redirects to a private or local address, which the studio does not follow' : 'it redirects to an address the studio cannot read'), { code: 'EREDIRECT' });
    }
    url = next;
  }
  throw Object.assign(new Error(`it redirects more than ${MAX_REDIRECTS} times`), { code: 'EREDIRECT' });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', bull: '•' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  try { return code > 0 ? String.fromCodePoint(code) : ''; } catch { return ''; }
});
const oneLine = (s, max) => { const t = decode(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };

/** What a page says about itself: { title, description, site, image } from its title element and its Open Graph,
 *  Twitter and description meta elements; each '' when absent. Scripts, styles and comments are not read. */
export function pageMeta(html) {
  const s = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  const meta = {};
  for (const m of s.matchAll(/<meta\b([^>]*)>/gi)) {
    const attr = (name) => { const a = m[1].match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')); return a ? (a[1] ?? a[2] ?? a[3]) : null; };
    const key = (attr('property') || attr('name') || '').toLowerCase();
    const content = attr('content');
    if (key && content != null && !(key in meta)) meta[key] = content;
  }
  const title = s.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '';
  return {
    title: oneLine(meta['og:title'] || meta['twitter:title'] || title, 200),
    description: oneLine(meta['og:description'] || meta['twitter:description'] || meta.description || '', 300),
    site: oneLine(meta['og:site_name'] || meta['application-name'] || '', 80),
    image: decode(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || '').trim(),
  };
}

const text = (body, headers) => {
  const label = String(headers['content-type'] || '').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || body.toString('latin1', 0, 2048).match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
  try { return new TextDecoder(label).decode(body); } catch { return new TextDecoder('utf-8').decode(body); }
};
const failWords = (err) => {
  if (err?.code === 'EPRIVATE') return 'its name resolves to a private or local address';
  if (err?.code === 'EREDIRECT') return err.message;
  if (err?.code === 'EDEADLINE') return `it did not answer within ${Math.round((err.timeoutMs || LINK_TIMEOUT_MS) / 100) / 10} s`; // this module's own deadline
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return 'its name was not found';
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET' || err?.code === 'EPIPE') return 'it refused the connection';
  if (/^(ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/.test(err?.code || '')) return 'it could not be reached'; // the connection itself, not the deadline
  if (/CERT|SSL|TLS/i.test(`${err?.code} ${err?.message}`)) return 'its certificate could not be checked';
  return 'it could not be read';
};

async function previewImage(ref, base, opts) {
  let url;
  try { url = checkLinkUrl(new URL(ref, base).href, { guard: opts.guard }); } catch { return { image: null, imageReason: 'the page names a preview image at an address the studio does not fetch' }; }
  try {
    const res = await getFollowing(url, { ...opts, deadline: Date.now() + opts.timeoutMs, maxBytes: PREVIEW_IMAGE_MAX_BYTES, accept: 'image/*' });
    if (res.status < 200 || res.status > 299) return { image: null, imageReason: `the preview image answered ${res.status}` };
    if (res.truncated) return { image: null, imageReason: `the preview image is over ${PREVIEW_IMAGE_MAX_BYTES / 1024 / 1024} MB` };
    const type = imageType(res.body);
    if (!type) return { image: null, imageReason: 'the preview image is not a PNG, JPEG, WebP, GIF or SVG' };
    return { image: { buf: res.body, type, ...(imageSize(res.body, type) || {}) } };
  } catch (err) { return { image: null, imageReason: `the preview image was not fetched: ${failWords(err)}` }; }
}

/**
 * Fetch what a link card shows. Resolves { ok: true, url, title, description, site, image: { buf, type, width?,
 * height? } | null, imageReason? } or { ok: false, reason } in words; it rejects (400 unsafe_link) only when the link
 * itself is one the studio never fetches: a bad scheme, a local name, or a name that resolves to a private address.
 */
// image: false asks for the words only (a reference's title, server/lib/references.mjs): no preview image is fetched.
export async function fetchLinkPreview(raw, { guard = isPrivateAddress, lookup = dns.lookup, timeoutMs = LINK_TIMEOUT_MS, image = true } = {}) {
  const start = checkLinkUrl(raw, { guard });
  const opts = { guard, lookup: guardedLookup({ guard, lookup }), timeoutMs };
  let res;
  try {
    // A link straight to an image is read up to the image cap; a page only as far as its head needs.
    const maxBytes = (headers) => (image && String(headers['content-type'] || '').toLowerCase().startsWith('image/') ? PREVIEW_IMAGE_MAX_BYTES : PAGE_MAX_BYTES);
    res = await getFollowing(start, { ...opts, deadline: Date.now() + timeoutMs, maxBytes, accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5' });
  } catch (err) {
    if (err?.code === 'EPRIVATE') throw unsafe(`That link's name resolves to a private or local address (${start.hostname}); the studio does not fetch or keep those`);
    return { ok: false, reason: `No preview: ${failWords(err)}` };
  }
  if (res.status < 200 || res.status > 299) return { ok: false, reason: `No preview: the page answered ${res.status}` };
  const kind = String(res.headers['content-type'] || '').toLowerCase();
  const type = imageType(res.body);
  if (type && (kind.startsWith('image/') || !/html|xml|text/.test(kind))) { // the link is an image itself
    const name = oneLine(decodeURIComponent(res.url.pathname.split('/').filter(Boolean).pop() || res.url.hostname), 200);
    if (!image) return { ok: true, url: res.url.href, title: name, description: '', site: '', image: null };
    if (res.truncated) return { ok: true, url: res.url.href, title: name, description: '', site: '', image: null, imageReason: `the image is over ${PREVIEW_IMAGE_MAX_BYTES / 1024 / 1024} MB` };
    return { ok: true, url: res.url.href, title: name, description: '', site: '', image: { buf: res.body, type, ...(imageSize(res.body, type) || {}) } };
  }
  if (kind && !/html|xml/.test(kind)) return { ok: false, reason: `No preview: the address answers ${kind.split(';')[0]}, not a page` };
  const meta = pageMeta(text(res.body, res.headers));
  const picture = image && meta.image ? await previewImage(meta.image, res.url, opts) : { image: null };
  return { ok: true, url: res.url.href, title: meta.title, description: meta.description, site: meta.site, ...picture };
}
