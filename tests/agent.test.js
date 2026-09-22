import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from '../src/core/agent.js';
import { AgentEvents, createEventBus } from '../src/core/events.js';
import { MemoryStore } from '../src/core/memory.js';
import { defineTool, ToolRegistry } from '../src/core/registry.js';
import { AgentRuntimeError, ValidationError } from '../src/utils/errors.js';

const echoTool = defineTool({
  name: 'demo.echo',
  description: 'Echo text back.',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  handler: ({ text }) => ({ text }),
});

/** Provider that replays scripted responses; entries may be functions. */
function scriptedProvider(responses) {
  let index = 0;
  return {
    name: 'scripted',
    model: 'scripted-1',
    async complete() {
      const entry = responses[Math.min(index, responses.length - 1)];
      index += 1;
      const resolved = typeof entry === 'function' ? entry(index) : typeof entry === 'string' ? { content: entry } : entry;
      const toolCalls = resolved.toolCalls ?? [];
      return {
        content: resolved.content ?? '',
        toolCalls,
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        model: 'scripted-1',
        provider: 'scripted',
      };
    },
  };
}

function makeAgent(responses, options = {}) {
  const events = createEventBus({ historyLimit: 100 });
  const agent = new Agent({
    name: 'tester',
    provider: scriptedProvider(responses),
    registry: new ToolRegistry([echoTool]),
    events,
    maxSteps: 8,
    ...options,
  });
  return { agent, events };
}

test('run executes the reason/act loop and returns the final answer', async () => {
  const { agent, events } = makeAgent([
    { toolCalls: [{ name: 'demo.echo', arguments: { text: 'hello' } }] },
    { content: 'The tool said hello.' },
  ]);

  const result = await agent.run('echo hello');

  assert.equal(result.status, 'completed');
  assert.equal(result.answer, 'The tool said hello.');
  assert.equal(result.step, 2);
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.usage.completions, 2);
  assert.equal(result.usage.totalTokens, 10);

  const roles = result.messages.map((message) => message.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(result.messages[3].name, 'demo.echo');
  assert.match(result.messages[3].content, /hello/, 'observation is fed back to the model');

  const emitted = events.history.map((entry) => entry.event);
  assert.ok(emitted.includes(AgentEvents.RUN_START));
  assert.ok(emitted.includes(AgentEvents.STEP_START));
  assert.ok(emitted.includes(AgentEvents.COMPLETION));
  assert.ok(emitted.includes(AgentEvents.TOOL_END));
  assert.equal(emitted.at(-1), AgentEvents.RUN_END);
});

test('the system prompt carries persona, tools, guidelines and memory', () => {
  const memory = new MemoryStore();
  memory.add({ content: 'The project uses Node 24 and ES modules.', kind: 'fact' });

  const { agent } = makeAgent([{ content: 'ok' }], {
    persona: 'You are terse.',
    guidelines: ['Always cite files.'],
    memory,
    memoryRead: true,
    config: { workspace: '/tmp/workspace' },
  });

  const prompt = agent.buildPrompt({ memoryPrompt: memory.toPrompt({ query: 'node version' }) });
  assert.match(prompt, /You are "tester"/);
  assert.match(prompt, /You are terse\./);
  assert.match(prompt, /demo\.echo\(text: string/);
  assert.match(prompt, /Always cite files\./);
  assert.match(prompt, /workspace root: \/tmp\/workspace/);
  assert.match(prompt, /Node 24/);

  assert.equal(makeAgent([{ content: 'ok' }], { systemPrompt: 'CUSTOM' }).agent.buildPrompt(), 'CUSTOM');
  assert.equal(makeAgent([{ content: 'ok' }], { systemPrompt: ({ agent: self }) => `for ${self.name}` }).agent.buildPrompt(), 'for tester');
});

test('an agent that repeats itself forever is stopped as "stuck"', async () => {
  const { agent } = makeAgent([{ toolCalls: [{ name: 'demo.echo', arguments: { text: 'same' } }] }]);
  const result = await agent.run('loop please');

  assert.equal(result.status, 'stuck');
  assert.equal(result.step, 4, 'three repeats allowed, stopped on the fourth');
  assert.match(result.answer, /repeating the same tool call/);
});


test('exhausting the step budget stops the run with status "max_steps"', async () => {
  const { agent } = makeAgent([(index) => ({ toolCalls: [{ name: 'demo.echo', arguments: { text: `call-${index}` } }] })], { maxSteps: 3 });
  const result = await agent.run('keep going');

  assert.equal(result.status, 'max_steps');
  assert.equal(result.step, 3);
  assert.match(result.answer, /Step budget of 3 exhausted/);
});

test('provider failures surface as AgentRuntimeError and emit run:error', async () => {
  const failing = {
    name: 'broken',
    model: 'broken-1',
    complete: async () => {
      throw new Error('upstream 503');
    },
  };
  const events = createEventBus({ historyLimit: 20 });
  const agent = new Agent({ name: 'tester', provider: failing, registry: new ToolRegistry([echoTool]), events });

  await assert.rejects(() => agent.run('anything'), (error) => {
    assert.ok(error instanceof AgentRuntimeError);
    assert.match(error.message, /upstream 503/);
    return true;
  });
  assert.equal(events.history.at(-1).event, AgentEvents.RUN_ERROR);
});

test('memory write policy persists completed runs only', async () => {
  const memory = new MemoryStore();
  const { agent } = makeAgent([{ content: 'All done.' }], { memory, memoryWrite: true });
  await agent.run('remember this');
  assert.equal(memory.size, 1);
  assert.equal(memory.all()[0].kind, 'summary');
  assert.match(memory.all()[0].content, /All done\./);
  assert.deepEqual(memory.all()[0].tags, ['tester']);

  const quietMemory = new MemoryStore();
  const { agent: quiet } = makeAgent([{ content: 'quiet' }], { memory: quietMemory, memoryWrite: false });
  await quiet.run('do not remember');
  assert.equal(quietMemory.size, 0);

  const stuckMemory = new MemoryStore();
  const { agent: looping } = makeAgent([{ toolCalls: [{ name: 'demo.echo', arguments: { text: 'same' } }] }], { memory: stuckMemory, memoryWrite: true });
  await looping.run('loop');
  assert.equal(stuckMemory.size, 0, 'unfinished runs are not remembered');
});

test('plan() parses model plans and falls back to a single step', async () => {
  const { agent } = makeAgent(['Sure! Here you go:\n[{"id":1,"description":"List files","tool":"fs.list"},{"id":2,"description":"Summarise"}]']);
  const plan = await agent.plan('map the repo');
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0], { id: 1, description: 'List files', tool: 'fs.list' });
  assert.equal(plan[1].tool, null);

  const { agent: unparseable } = makeAgent(['I cannot plan that.']);
  assert.deepEqual(await unparseable.plan('map the repo'), [{ id: 1, description: 'map the repo', tool: null }]);
});

test('run and construction validate their inputs', async () => {
  const { agent } = makeAgent([{ content: 'ok' }]);
  await assert.rejects(() => agent.run('   '), ValidationError);
  assert.throws(() => new Agent({ registry: new ToolRegistry() }), /requires a provider/);
  assert.throws(() => new Agent({ provider: { complete: () => {} } }), /requires a ToolRegistry/);
});
