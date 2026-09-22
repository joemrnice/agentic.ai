import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/index.js';
import { createRuntime } from '../src/core/factory.js';
import { MemoryStore } from '../src/core/memory.js';
import { loadWorkflow, renderTemplate, runWorkflow } from '../src/workflows/runner.js';
import { createNoopLogger } from '../src/utils/logger.js';
import { ValidationError } from '../src/utils/errors.js';

function makeRuntime(providerResponses = ['agent output']) {
  const config = loadConfig({}, { env: {}, useDotEnv: false, cwd: process.cwd() });
  return createRuntime({
    config,
    memory: new MemoryStore(),
    logger: createNoopLogger(),
    provider: {
      name: 'scripted',
      model: 'scripted-1',
      complete: async () => ({ content: providerResponses.shift() ?? 'agent output', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, stopReason: 'stop' }),
    },
  });
}

test('renderTemplate resolves inputs, steps and nested structures', () => {
  const scope = { inputs: { topic: 'agents' }, steps: { scan: { output: { count: 3 } } } };

  assert.equal(renderTemplate('about {{inputs.topic}}', scope), 'about agents');
  assert.equal(renderTemplate('{{missing.value}} stays', scope), '{{missing.value}} stays');
  assert.deepEqual(renderTemplate(['{{inputs.topic}}', 1], scope), ['agents', 1]);
  assert.deepEqual(renderTemplate({ prompt: 'count is {{steps.scan.output.count}}' }, scope), { prompt: 'count is 3' });
  assert.equal(renderTemplate(42, scope), 42);
});

test('loadWorkflow validates structure and dependencies', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-wf-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name, payload) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(payload));
    return path;
  };

  const valid = loadWorkflow(write('ok.json', { name: 'ok', steps: [{ id: 'a', uses: 'tool', tool: 'fs.list' }] }));
  assert.equal(valid.name, 'ok');
  assert.equal(valid.dir, dir);

  assert.throws(() => loadWorkflow(join(dir, 'missing.json')), /not found/);
  assert.throws(() => loadWorkflow(write('nos.json', { steps: [] })), /non-empty "steps"/);
  assert.throws(() => loadWorkflow(write('dup.json', { steps: [{ id: 'a', uses: 'tool', tool: 'x' }, { id: 'a', uses: 'tool', tool: 'x' }] })), /duplicated/);
  assert.throws(() => loadWorkflow(write('baduses.json', { steps: [{ id: 'a', uses: 'worker' }] })), /must set uses/);
  assert.throws(() => loadWorkflow(write('notool.json', { steps: [{ id: 'a', uses: 'tool' }] })), /no "tool" name/);
  assert.throws(() => loadWorkflow(write('badep.json', { steps: [{ id: 'a', uses: 'tool', tool: 'x', dependsOn: ['ghost'] }] })), /unknown step "ghost"/);
  assert.throws(() => loadWorkflow(write('broken.json', { name: 'broken' })), ValidationError);
});

test('runWorkflow chains a tool step into an agent step', async () => {
  const runtime = makeRuntime(['A brief about the workspace.']);
  const workflow = {
    name: 'chain',
    inputs: { focus: 'layout' },
    steps: [
      { id: 'scan', uses: 'tool', tool: 'fs.list', input: { path: '.' } },
      { id: 'brief', uses: 'agent', agent: { name: 'writer' }, dependsOn: ['scan'], input: { task: 'Focus: {{inputs.focus}}' } },
    ],
    output: '{{steps.brief.output}}',
  };

  const result = await runWorkflow(workflow, { runtime });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.order, ['scan', 'brief']);
  assert.equal(result.output, 'A brief about the workspace.');
  assert.match(result.steps.scan.output, /entries/);

  const workflowEvents = runtime.events.history.filter((entry) => entry.event.startsWith('workflow:'));
  assert.equal(workflowEvents.at(0).event, 'workflow:start');
  assert.equal(workflowEvents.at(-1).event, 'workflow:end');
  assert.equal(workflowEvents.at(-1).status, 'completed');
});

test('runWorkflow reports the failing step and stops the run', async () => {
  const runtime = makeRuntime();
  const workflow = {
    name: 'broken',
    steps: [
      { id: 'bad', uses: 'tool', tool: 'ghost.tool', input: {} },
      { id: 'never', uses: 'agent', agent: { name: 'x' }, dependsOn: ['bad'], input: 'hi' },
    ],
  };

  const result = await runWorkflow(workflow, { runtime });
  assert.equal(result.status, 'failed');
  assert.equal(result.steps.bad.status, 'failed');
  assert.match(result.steps.bad.error.message, /TOOL_NOT_FOUND/);
  assert.equal(result.steps.never, undefined, 'downstream steps do not run');
  assert.equal(runtime.events.history.at(-1).status, 'failed');
});
