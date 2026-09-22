import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentEvents, createEventBus } from '../src/core/events.js';
import { parseToolArguments, serializeToolOutput, ToolExecutor } from '../src/core/executor.js';
import { defineTool, ToolRegistry } from '../src/core/registry.js';

const context = { runId: 'test-run', workspace: process.cwd(), memory: null };

function makeExecutor(tools, options = {}) {
  const events = createEventBus({ historyLimit: 100 });
  const executor = new ToolExecutor({
    registry: new ToolRegistry(tools),
    events,
    timeoutMs: 500,
    maxOutputChars: 100,
    maxRetries: 1,
    ...options,
  });
  return { executor, events };
}

const echo = defineTool({
  name: 'test.echo',
  description: 'Echo text back.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 }, repeat: { type: 'integer', default: 1 } },
    required: ['text'],
    additionalProperties: false,
  },
  handler: ({ text, repeat }) => ({ text, repeat }),
});

test('execute runs a tool, applies defaults and records both events', async () => {
  const { executor, events } = makeExecutor([echo]);
  const observation = await executor.execute({ id: 'c1', name: 'test.echo', arguments: { text: 'hi' } }, context);

  assert.equal(observation.ok, true);
  assert.equal(observation.attempts, 1);
  assert.deepEqual(JSON.parse(observation.output), { text: 'hi', repeat: 1 }, 'defaults applied');
  assert.equal(observation.error, null);

  const names = events.history.map((entry) => entry.event);
  assert.deepEqual(names, [AgentEvents.TOOL_START, AgentEvents.TOOL_END]);
});

test('execute accepts JSON string arguments (how models usually send them)', async () => {
  const { executor } = makeExecutor([echo]);
  const observation = await executor.execute({ name: 'test.echo', arguments: '{"text":"from-string"}' }, context);
  assert.equal(observation.ok, true);
  assert.match(observation.output, /from-string/);
});

test('failures are returned as observations the model can read', async () => {
  const { executor, events } = makeExecutor([echo]);

  const unknown = await executor.execute({ name: 'nope.missing', arguments: {} }, context);
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /^ERROR\(TOOL_NOT_FOUND\)/);
  assert.equal(unknown.attempts, 0);

  const invalid = await executor.execute({ name: 'test.echo', arguments: { wrong: true } }, context);
  assert.match(invalid.output, /^ERROR\(VALIDATION_ERROR\)/);
  assert.match(invalid.output, /\$\.text is required/);

  const malformed = await executor.execute({ name: 'test.echo', arguments: '{"text":' }, context);
  assert.match(malformed.output, /not valid JSON/);

  assert.ok(events.history.some((entry) => entry.event === AgentEvents.TOOL_ERROR));
});

test('read-only tools are retried, mutating tools are not', async () => {
  let readAttempts = 0;
  let writeAttempts = 0;

  const flaky = defineTool({
    name: 'test.flaky',
    description: 'Fails once, then succeeds.',
    handler: () => {
      readAttempts += 1;
      if (readAttempts === 1) throw new Error('transient');
      return { attempt: readAttempts };
    },
  });

  const mutating = defineTool({
    name: 'test.mutate',
    description: 'Always fails and must never be retried.',
    sideEffects: true,
    handler: () => {
      writeAttempts += 1;
      throw new Error('boom');
    },
  });

  const { executor } = makeExecutor([flaky, mutating], { maxRetries: 1 });

  const retried = await executor.execute({ name: 'test.flaky', arguments: {} }, context);
  assert.equal(retried.ok, true);
  assert.equal(retried.attempts, 2);
  assert.equal(readAttempts, 2);

  const notRetried = await executor.execute({ name: 'test.mutate', arguments: {} }, context);
  assert.equal(notRetried.ok, false);
  assert.equal(notRetried.attempts, 1);
  assert.equal(writeAttempts, 1);
});

test('a hung tool trips the deadline instead of hanging the run', async () => {
  const slow = defineTool({
    name: 'test.slow',
    description: 'Never returns in time.',
    sideEffects: true,
    handler: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return 'too late';
    },
  });

  const { executor } = makeExecutor([slow], { timeoutMs: 20 });
  const startedAt = Date.now();
  const observation = await executor.execute({ name: 'test.slow', arguments: {} }, context);

  assert.equal(observation.ok, false);
  assert.match(observation.output, /^ERROR\(TOOL_TIMEOUT\)/);
  assert.ok(Date.now() - startedAt < 190, 'did not wait for the slow handler');
});

test('verbose tool output is truncated before it reaches the context window', async () => {
  const chatty = defineTool({
    name: 'test.chatty',
    description: 'Returns far more text than the budget allows.',
    handler: () => 'x'.repeat(500),
  });

  const { executor } = makeExecutor([chatty], { maxOutputChars: 50 });
  const observation = await executor.execute({ name: 'test.chatty', arguments: {} }, context);

  assert.equal(observation.ok, true);
  assert.ok(observation.output.length < 200);
  assert.match(observation.output, /truncated 450 characters/);
});

test('serializeToolOutput and parseToolArguments handle edge cases', () => {
  assert.equal(serializeToolOutput('plain'), 'plain');
  assert.equal(serializeToolOutput(undefined), 'null');
  assert.equal(serializeToolOutput({ a: 1 }), '{\n  "a": 1\n}');
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments(''), {});
  assert.deepEqual(parseToolArguments({ provided: true }), { provided: true });
  assert.throws(() => parseToolArguments('[1,2]'), /must be a JSON object|not valid JSON/);
  assert.throws(() => parseToolArguments('nope'), /not valid JSON/);
});
