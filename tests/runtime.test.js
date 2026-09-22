import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { createRuntime } from '../src/core/factory.js';
import { MemoryStore } from '../src/core/memory.js';
import { createMockProvider } from '../src/llm/mock-provider.js';
import { ToolNotFoundError } from '../src/utils/errors.js';
import { createNoopLogger } from '../src/utils/logger.js';

function makeRuntime(overrides = {}, deps = {}) {
  const config = loadConfig(overrides, { env: {}, useDotEnv: false, cwd: process.cwd() });
  return createRuntime({ config, memory: new MemoryStore(), logger: createNoopLogger(), ...deps });
}

test('a zero-config runtime is sandboxed: no network, no shell', () => {
  const runtime = makeRuntime();
  const names = runtime.registry.names();

  assert.equal(runtime.provider.name, 'mock');
  assert.ok(names.includes('fs.list'));
  assert.ok(names.includes('calculator.eval'));
  assert.ok(names.includes('memory.search'));
  assert.ok(!names.includes('http.get'), 'network tools are opt-in');
  assert.ok(!names.includes('shell.exec'), 'shell tools are opt-in');
});

test('dangerous capabilities are registered only when explicitly enabled', () => {
  const runtime = makeRuntime({ allowNetwork: true, allowedHosts: ['example.com'], allowShell: true });
  const names = runtime.registry.names();
  assert.ok(names.includes('http.get'));
  assert.ok(names.includes('http.post'));
  assert.ok(names.includes('shell.exec'));
  assert.deepEqual(runtime.describe().capabilities, { shell: true, network: true, allowedHosts: ['example.com'] });
});

test('runtime.describe() gives a one-screen wiring summary', () => {
  const described = makeRuntime().describe();
  assert.equal(described.provider, 'mock');
  assert.equal(described.model, 'mock-1');
  assert.equal(described.memory.path, null, 'an injected in-memory store has no path');
  assert.ok(Array.isArray(described.tools));
  assert.equal(described.budgets.maxSteps, 8);
});

test('createAgent scopes tools from the definition and validates them', () => {
  const runtime = makeRuntime();

  const scoped = runtime.createAgent({ name: 'minimal', tools: ['calculator.eval'], maxSteps: 2, temperature: 0 });
  assert.deepEqual(scoped.toolNames, ['calculator.eval']);
  assert.equal(scoped.maxSteps, 2);
  assert.equal(scoped.temperature, 0);
  assert.equal(scoped.memory, runtime.memory, 'definitions read memory by default; writes stay opt-in');

  const wide = runtime.createAgent(null);
  assert.equal(wide.toolNames.length, runtime.registry.names().length);

  assert.throws(() => runtime.createAgent({ name: 'broken', tools: ['nope.tool'] }), ToolNotFoundError);
});

test('createAgent loads a definition file and honours its memory policy', () => {
  const runtime = makeRuntime();
  const path = fileURLToPath(new URL('../agents/researcher.agent.json', import.meta.url));
  const agent = runtime.createAgent(path);

  assert.equal(agent.name, 'researcher');
  assert.equal(agent.maxSteps, 12);
  assert.ok(agent.memory, 'researcher writes and reads memory');
  assert.ok(agent.toolNames.includes('fs.read'));
  assert.ok(!agent.toolNames.includes('fs.write'), 'researcher is read-only towards the filesystem');
});

test('runtime.run() completes an end-to-end task with the mock provider', async () => {
  const runtime = makeRuntime();
  const result = await runtime.run('List the files in the workspace and compute 21 * 2');

  assert.equal(result.status, 'completed');
  assert.equal(result.toolCallCount, 2);
  assert.match(result.answer, /21 \* 2 = 42/);
  assert.match(result.answer, /entries/);
});

test('a custom provider can be injected', () => {
  const runtime = makeRuntime({}, { provider: { name: 'acme-gateway', model: 'acme-1', complete: async () => ({ content: 'ok', toolCalls: [] }) } });
  assert.equal(runtime.provider.name, 'acme-gateway');
  assert.equal(runtime.describe().model, 'acme-1');
  assert.throws(() => createRuntime({ config: runtime.config, provider: {}, memory: new MemoryStore() }), /must expose an async complete/);
});

test('the mock provider is exposed for offline and scripted use', async () => {
  const runtime = createRuntime({
    config: loadConfig({}, { env: {}, useDotEnv: false }),
    memory: new MemoryStore(),
    logger: createNoopLogger(),
    provider: createMockProvider({ responses: [{ content: 'scripted answer' }] }),
  });

  const result = await runtime.run('anything at all');
  assert.equal(result.answer, 'scripted answer');
  assert.equal(result.toolCallCount, 0);
});
