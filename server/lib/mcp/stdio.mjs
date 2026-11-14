// MCP over stdio, written by hand (no dependency; docs/ARCHITECTURE.md section 11, docs/DECISIONS.md).
// JSON-RPC 2.0, one message per line on stdin and stdout, protocol version 2025-06-18. The server side only:
// initialize, notifications/initialized, ping, tools/list and tools/call. handleMessage is pure (a request and
// the tool table in, the answer out) so tests call it without a process; serveStdio wires it to streams.

export const PROTOCOL_VERSION = '2025-06-18';
export const ERRORS = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
export const textResult = (text, isError = false) => ({ content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) });

const TYPE_OK = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: isObject,
};

/** The arguments against the tool's input schema, one level deep (required, type, enum, array item type). A sentence, or null. */
export function checkArgs(schema, args) {
  if (!isObject(args)) return 'arguments must be an object';
  const props = schema?.properties || {};
  for (const key of schema?.required || []) if (args[key] === undefined || args[key] === null) return `${key} is required`;
  for (const [key, value] of Object.entries(args)) {
    const p = props[key];
    if (!p) {
      if (schema?.additionalProperties === false) return `${key} is not an argument of this tool (it takes ${Object.keys(props).join(', ') || 'none'})`;
      continue;
    }
    if (value === undefined || value === null) continue;
    if (p.type && !TYPE_OK[p.type]?.(value)) return `${key} must be ${p.type === 'integer' ? 'a whole number' : `a${/^[aeiou]/.test(p.type) ? 'n' : ''} ${p.type}`}`;
    if (p.enum && !p.enum.includes(value)) return `${key} must be one of ${p.enum.join(', ')}`;
    if (p.type === 'string' && p.minLength && value.trim().length < p.minLength) return `${key} must not be empty`;
    if (p.type === 'integer' && p.minimum !== undefined && value < p.minimum) return `${key} must be at least ${p.minimum}`;
    if (p.type === 'array' && p.items?.type && !value.every((x) => TYPE_OK[p.items.type]?.(x))) return `every entry of ${key} must be a ${p.items.type}`;
  }
  return null;
}

/** A tool's answer as an MCP result: a string is one text block; { content } passes through. */
function asResult(out) {
  if (typeof out === 'string') return textResult(out);
  if (isObject(out) && Array.isArray(out.content)) return out.isError ? { content: out.content, isError: true } : { content: out.content };
  return textResult(JSON.stringify(out ?? null, null, 2));
}

/**
 * One message in, the answer out: a response object, or null for a notification (no id) and for a response
 * sent to us. tools: [{ name, title?, description, inputSchema, listSchema?(), run(args) }]. A tool that throws answers a
 * result with isError true and the error's message: a failing tool is the model's to read, never a crash.
 */
export async function handleMessage(msg, { tools = [], serverInfo = { name: 'atelier', version: '0.0.0' }, instructions = null, log = () => {} } = {}) {
  if (Array.isArray(msg)) return failure(null, ERRORS.invalidRequest, 'Batches are not part of protocol 2025-06-18');
  if (!isObject(msg) || msg.jsonrpc !== '2.0') return failure(isObject(msg) ? msg.id : null, ERRORS.invalidRequest, 'Not a JSON-RPC 2.0 message');
  const hasId = Object.hasOwn(msg, 'id') && msg.id !== null && msg.id !== undefined;
  if (msg.method === undefined && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) return null; // a response from the client: this server asks nothing
  if (typeof msg.method !== 'string') return hasId ? failure(msg.id, ERRORS.invalidRequest, 'method must be a string') : null;
  if (!hasId) return null; // notifications/initialized, notifications/cancelled and any other notification: nothing to answer
  const { id, method } = msg;
  const params = isObject(msg.params) ? msg.params : {};

  if (method === 'initialize') {
    return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo, ...(instructions ? { instructions } : {}) });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    // A tool may describe its input from the studio's state (listSchema: atelier_create_task names the departments);
    // when that fails the fixed inputSchema is listed, so the list never breaks on a slow or stopped studio.
    const schemaOf = async (t) => {
      if (typeof t.listSchema !== 'function') return t.inputSchema;
      try { return (await t.listSchema()) || t.inputSchema; } catch (err) { log(`${t.name}: listed the fixed schema (${err.message})`); return t.inputSchema; }
    };
    const schemas = await Promise.all(tools.map(schemaOf));
    return reply(id, { tools: tools.map((t, i) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: schemas[i] })) });
  }
  if (method === 'tools/call') {
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) return failure(id, ERRORS.invalidParams, `Unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    const bad = checkArgs(tool.inputSchema, args);
    if (bad) return reply(id, textResult(`${tool.name}: ${bad}.`, true));
    try {
      return reply(id, asResult(await tool.run(args)));
    } catch (err) {
      log(`${tool.name} failed: ${err?.message || err}`);
      return reply(id, textResult(err?.message || String(err), true));
    }
  }
  return failure(id, ERRORS.methodNotFound, `Method not found: ${method}`);
}

/**
 * Serve over a pair of streams (process.stdin / process.stdout): each line is one message, each answer one line.
 * Requests run as they arrive, so a slow tool does not hold a ping back; answers carry their ids. Resolves when
 * the input ends and every answer is written.
 */
export function serveStdio({ input, output, log = () => {}, ...options }) {
  let buf = '';
  const pending = new Set();
  const write = (obj) => { if (obj) output.write(`${JSON.stringify(obj)}\n`); };
  const take = (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { write(failure(null, ERRORS.parse, 'Parse error: each line must be one JSON message')); return; }
    const p = handleMessage(msg, { ...options, log })
      .then(write)
      .catch((err) => { log(`internal error: ${err?.stack || err}`); write(failure(msg?.id, ERRORS.internal, 'Internal error')); })
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  input.setEncoding?.('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      take(line);
    }
  });
  return new Promise((resolve) => {
    input.on('end', async () => {
      if (buf) take(buf.replace(/\r$/, ''));
      buf = '';
      while (pending.size) await Promise.allSettled([...pending]);
      resolve();
    });
  });
}
