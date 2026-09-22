import { ValidationError } from './errors.js';

/**
 * A deliberately small JSON-Schema subset.
 *
 * Tool declarations must be portable across providers, so the runtime only
 * depends on the widely supported keywords below. Supported:
 * type, properties, required, additionalProperties, items, enum, default,
 * minimum, maximum, minLength, maxLength, pattern, minItems, maxItems.
 */

export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'integer') return actual === 'integer' || (actual === 'number' && Number.isInteger(value));
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON clone for non-cloneable values */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Validate `value` against `schema`.
 * @returns {{ valid: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateAgainstSchema(value, schema = {}, { path = '$' } = {}) {
  const errors = [];

  const visit = (val, sch, p) => {
    if (!sch || typeof sch !== 'object') return;

    if (sch.type !== undefined) {
      const types = Array.isArray(sch.type) ? sch.type : [sch.type];
      if (val === undefined) {
        errors.push({ path: p, message: 'is required' });
        return;
      }
      if (!types.some((type) => matchesType(val, type))) {
        errors.push({ path: p, message: `expected ${types.join(' | ')}, received ${typeOf(val)}` });
        return;
      }
    }

    if (val === undefined || val === null) return;

    if (Array.isArray(sch.enum) && !sch.enum.some((candidate) => candidate === val)) {
      errors.push({ path: p, message: `must be one of ${sch.enum.map((v) => JSON.stringify(v)).join(', ')}` });
    }

    if (typeof val === 'string') {
      if (sch.minLength !== undefined && val.length < sch.minLength) {
        errors.push({ path: p, message: `must be at least ${sch.minLength} characters long` });
      }
      if (sch.maxLength !== undefined && val.length > sch.maxLength) {
        errors.push({ path: p, message: `must be at most ${sch.maxLength} characters long` });
      }
      if (sch.pattern && !new RegExp(sch.pattern).test(val)) {
        errors.push({ path: p, message: `must match pattern ${sch.pattern}` });
      }
    }

    if (typeof val === 'number') {
      if (sch.minimum !== undefined && val < sch.minimum) {
        errors.push({ path: p, message: `must be >= ${sch.minimum}` });
      }
      if (sch.maximum !== undefined && val > sch.maximum) {
        errors.push({ path: p, message: `must be <= ${sch.maximum}` });
      }
    }

    if (Array.isArray(val)) {
      if (sch.minItems !== undefined && val.length < sch.minItems) {
        errors.push({ path: p, message: `must contain at least ${sch.minItems} item(s)` });
      }
      if (sch.maxItems !== undefined && val.length > sch.maxItems) {
        errors.push({ path: p, message: `must contain at most ${sch.maxItems} item(s)` });
      }
      if (sch.items) val.forEach((item, index) => visit(item, sch.items, `${p}[${index}]`));
    }

    if (typeOf(val) === 'object') {
      const properties = sch.properties ?? {};
      for (const key of sch.required ?? []) {
        if (val[key] === undefined) errors.push({ path: `${p}.${key}`, message: 'is required' });
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (val[key] !== undefined) visit(val[key], propertySchema, `${p}.${key}`);
      }
      if (sch.additionalProperties === false) {
        for (const key of Object.keys(val)) {
          if (!Object.hasOwn(properties, key)) {
            errors.push({ path: `${p}.${key}`, message: 'is not an allowed property' });
          }
        }
      }
    }
  };

  visit(value, schema, path);
  return { valid: errors.length === 0, errors };
}

/** Validate and throw a {@link ValidationError} carrying every violation. */
export function assertValid(value, schema = {}, { path = '$', label = 'value' } = {}) {
  const { valid, errors } = validateAgainstSchema(value, schema, { path });
  if (!valid) {
    const summary = errors.map((error) => `${error.path} ${error.message}`).join('; ');
    throw new ValidationError(`Invalid ${label}: ${summary}`, { details: { label, errors } });
  }
  return value;
}

/** Recursively apply `default` values declared in the schema. */
export function applyDefaults(value, schema = {}) {
  if (!schema || typeof schema !== 'object') return value;

  if (value === undefined && Object.hasOwn(schema, 'default')) return clone(schema.default);
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return schema.items ? value.map((item) => applyDefaults(item, schema.items)) : value;
  }

  if (typeOf(value) === 'object') {
    const result = { ...value };
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (result[key] === undefined) {
        if (Object.hasOwn(propertySchema, 'default')) result[key] = clone(propertySchema.default);
      } else {
        result[key] = applyDefaults(result[key], propertySchema);
      }
    }
    return result;
  }

  return value;
}

/** Human readable one-liner used in prompts, e.g. `path (string, required)`. */
export function describeSchema(schema = {}) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.join(' | ')})`;
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  return schema.type ?? 'any';
}
