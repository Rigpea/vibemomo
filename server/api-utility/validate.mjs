// A small JSON-schema-ish validator. Supports: type (string or array of types),
// properties, required, additionalProperties:false, items, enum, const,
// minLength/maxLength, minItems/maxItems, minimum/maximum. No dependencies.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected === 'number' && actual === 'integer') return true;
  return false;
}

/** Returns an array of error strings (empty when valid). */
export function validate(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  const actual = typeOf(value);
  if (actual === 'number' && !Number.isFinite(value)) {
    errors.push(`${path}: must be a finite number`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${actual}`);
      return errors;
    }
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) {
    const shown = schema.enum.length > 12 ? `${schema.enum.slice(0, 12).join(', ')}, ...` : schema.enum.join(', ');
    errors.push(`${path}: must be one of [${shown}], got ${JSON.stringify(value)}`);
  }
  if (actual === 'string') {
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: length ${value.length} exceeds maxLength ${schema.maxLength}`);
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: length ${value.length} is below minLength ${schema.minLength}`);
  }
  if (actual === 'number' || actual === 'integer') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: ${value} is below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: ${value} exceeds maximum ${schema.maximum}`);
  }
  if (actual === 'array') {
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: ${value.length} items exceeds maxItems ${schema.maxItems}`);
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: ${value.length} items is below minItems ${schema.minItems}`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
  }
  if (actual === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) validate(props[key], v, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not allowed`);
    }
  }
  return errors;
}

const UNSUPPORTED_BY_API = new Set(['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems']);

/**
 * Converts a local schema to the subset accepted by structured outputs
 * (output_config.format): strips numeric/string/array constraints (we enforce
 * those locally) and sets additionalProperties:false on every object.
 */
export function toApiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toApiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_BY_API.has(k)) continue;
    if (k === 'properties') out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toApiSchema(pv)]));
    else if (k === 'items') out[k] = toApiSchema(v);
    else out[k] = v;
  }
  const isObject = out.type === 'object' || (Array.isArray(out.type) && out.type.includes('object'));
  if (isObject) out.additionalProperties = false;
  return out;
}

// Tiny builders used by tasks.mjs to keep schemas readable.
export const str = (extra = {}) => ({ type: 'string', ...extra });
export const num = (extra = {}) => ({ type: 'number', ...extra });
export const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
export const obj = (properties, required = Object.keys(properties), extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
});
