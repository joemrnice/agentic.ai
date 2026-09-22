import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDefaults, assertValid, describeSchema, validateAgainstSchema } from '../src/utils/schema.js';
import { ValidationError } from '../src/utils/errors.js';

const SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 10 },
    limit: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
    mode: { type: 'string', enum: ['fast', 'safe'], default: 'safe' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
  required: ['path'],
  additionalProperties: false,
};

test('validateAgainstSchema accepts conforming values', () => {
  assert.deepEqual(validateAgainstSchema({ path: 'a', limit: 2, mode: 'fast', tags: ['x'] }, SCHEMA), { valid: true, errors: [] });
});

test('validateAgainstSchema reports every violation with a path', () => {
  const result = validateAgainstSchema({ limit: 9, mode: 'other', tags: ['a', 'b', 'c'], extra: true }, SCHEMA);
  assert.equal(result.valid, false);
  const messages = result.errors.map((error) => `${error.path} ${error.message}`);

  assert.ok(messages.some((message) => message.startsWith('$.path is required')));
  assert.ok(messages.some((message) => message.includes('$.limit must be <= 5')));
  assert.ok(messages.some((message) => message.includes('$.mode must be one of')));
  assert.ok(messages.some((message) => message.includes('$.tags must contain at most 2')));
  assert.ok(messages.some((message) => message.includes('$.extra is not an allowed property')));
});

test('type mismatches and nested paths are reported', () => {
  const result = validateAgainstSchema({ path: 5, tags: [1] }, SCHEMA);
  assert.ok(result.errors.some((error) => error.path === '$.path' && error.message.includes('expected string')));
  assert.ok(result.errors.some((error) => error.path === '$.tags[0]' && error.message.includes('expected string')));
});

test('applyDefaults fills declared defaults without mutating the input', () => {
  const input = { path: 'file.txt' };
  const filled = applyDefaults(input, SCHEMA);
  assert.deepEqual(filled, { path: 'file.txt', limit: 3, mode: 'safe' });
  assert.deepEqual(input, { path: 'file.txt' }, 'input stays untouched');
});

test('assertValid throws a ValidationError with details', () => {
  assert.throws(() => assertValid({}, SCHEMA, { label: 'arguments' }), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.match(error.message, /Invalid arguments/);
    assert.equal(error.details.errors.length, 1);
    return true;
  });
});

test('describeSchema renders compact type hints for prompts', () => {
  assert.equal(describeSchema({ type: 'string' }), 'string');
  assert.equal(describeSchema({ type: 'string', enum: ['a', 'b'] }), 'enum(a | b)');
  assert.equal(describeSchema({ type: ['object', 'string'] }), 'object | string');
  assert.equal(describeSchema(undefined), 'any');
});
