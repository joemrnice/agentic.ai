import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolsExist, defineTool, ToolRegistry } from '../src/core/registry.js';
import { ToolNotFoundError, ValidationError } from '../src/utils/errors.js';

const echo = defineTool({
  name: 'demo.echo',
  description: 'Echo the provided text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  handler: ({ text }) => ({ text }),
  tags: ['demo'],
});

const risky = defineTool({
  name: 'demo.write',
  description: 'Pretend to mutate state.',
  sideEffects: true,
  handler: () => ({ ok: true }),
});

test('defineTool validates its declaration', () => {
  assert.equal(echo.name, 'demo.echo');
  assert.equal(echo.sideEffects, false);
  assert.deepEqual(echo.tags, ['demo']);
  assert.throws(() => defineTool({ name: 'bad name', description: 'x', handler: () => {} }), ValidationError);
  assert.throws(() => defineTool({ name: 'ok', description: '', handler: () => {} }), /non-empty description/);
  assert.throws(() => defineTool({ name: 'ok', description: 'x' }), /handler function/);
});

test('registry registers, resolves and rejects duplicates', () => {
  const registry = new ToolRegistry([echo]);
  assert.equal(registry.size, 1);
  assert.equal(registry.has('demo.echo'), true);
  assert.equal(registry.get('demo.echo').name, 'demo.echo');
  assert.deepEqual(registry.names(), ['demo.echo']);
  assert.throws(() => registry.register(echo), /already registered/);
  assert.throws(() => registry.get('missing.tool'), (error) => {
    assert.ok(error instanceof ToolNotFoundError);
    assert.deepEqual(error.details.available, ['demo.echo']);
    return true;
  });
});

test('subset() scopes an agent to a set of tools', () => {
  const registry = new ToolRegistry([echo, risky]);
  const scoped = registry.subset(['demo.echo']);
  assert.deepEqual(scoped.names(), ['demo.echo']);
  assert.equal(registry.subset(null), registry, 'null means "all tools"');
  assert.throws(() => registry.subset(['nope']), ToolNotFoundError);
  assert.deepEqual(assertToolsExist(registry, ['demo.echo']), ['demo.echo']);
  assert.throws(() => assertToolsExist(registry, ['nope'], { label: 'agent "x"' }), /agent "x" references unknown tool/);
});

test('toToolSchemas and describe expose provider- and prompt-facing views', () => {
  const registry = new ToolRegistry([echo, risky]);
  const [schema] = registry.toToolSchemas();
  assert.equal(schema.name, 'demo.echo');
  assert.equal(schema.parameters.required[0], 'text');
  assert.equal(schema.handler, undefined, 'handlers never leak into schemas');

  const description = registry.describe();
  assert.match(description, /- demo\.echo\(text: string \(required\)\): Echo the provided text back\./);
  assert.match(description, /- demo\.write\(no arguments\): Pretend to mutate state\./);

  const truncated = registry.describe({ maxDescriptionChars: 12 }).split('\n')[0];
  assert.match(truncated, /Echo the pro\.\.\./);
});

test('unregister removes a tool', () => {
  const registry = new ToolRegistry([echo]);
  assert.equal(registry.unregister('demo.echo'), true);
  assert.equal(registry.has('demo.echo'), false);
  assert.equal(registry.unregister('demo.echo'), false);
});
