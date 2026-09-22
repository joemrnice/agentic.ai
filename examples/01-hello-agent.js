/**
 * 01 - Hello agent
 *
 * The smallest useful end-to-end run: build a runtime, run the default
 * assistant against a task, watch the tool calls happen.
 *
 * Runs fully offline thanks to the mock provider:
 *   node examples/01-hello-agent.js
 */
import { AgentEvents, createLogger, createRuntime } from '../src/index.js';

const runtime = createRuntime({
  logger: createLogger({ name: 'example:01', level: 'warn', sink: process.stderr }),
});

// Subscribe to lifecycle events to see what the agent actually does.
runtime.events.on(AgentEvents.TOOL_START, ({ tool, args }) => {
  console.log(`  -> calling ${tool}(${JSON.stringify(args)})`);
});
runtime.events.on(AgentEvents.TOOL_END, ({ tool, ok, durationMs }) => {
  console.log(`  <- ${tool} ${ok ? 'ok' : 'FAILED'} in ${durationMs}ms`);
});

console.log(`Runtime: provider=${runtime.provider.name} model=${runtime.provider.model}`);
console.log(`Tools:   ${runtime.registry.names().join(', ')}\n`);

const result = await runtime.run('List the files in the workspace and compute 21 * 2');

console.log('\n--- final answer ---');
console.log(result.answer);

console.log('\n--- run record ---');
console.log({
  status: result.status,
  steps: result.step,
  toolCalls: result.toolCallCount,
  tokens: result.usage.totalTokens,
  durationMs: result.durationMs,
  transcriptMessages: result.messages.length,
});
