/**
 * 02 - Custom tool
 *
 * Shows the extension point every real project needs: declare a tool, and an
 * agent can use it. Uses scripted mock responses so the run is deterministic.
 *
 *   node examples/02-custom-tool.js
 */
import { createLogger, createMockProvider, createRuntime, defineTool } from '../src/index.js';

const SAMPLE = [2, 4, 4, 4, 5, 5, 7, 9];

const statsTool = defineTool({
  name: 'stats.describe',
  description: 'Compute count, sum, mean, min and max for a list of numbers.',
  parameters: {
    type: 'object',
    properties: {
      values: { type: 'array', items: { type: 'number' }, minItems: 1, description: 'Numbers to summarise.' },
    },
    required: ['values'],
    additionalProperties: false,
  },
  tags: ['analytics', 'deterministic'],
  handler: ({ values }) => {
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      count: values.length,
      sum,
      mean: Number((sum / values.length).toFixed(4)),
      min: Math.min(...values),
      max: Math.max(...values),
    };
  },
});

const provider = createMockProvider({
  responses: [
    { content: '', toolCalls: [{ name: 'stats.describe', arguments: { values: SAMPLE } }] },
    { content: `The sample of ${SAMPLE.length} values has mean 5, min 2 and max 9 -- the single high value pulls the mean above the median.` },
  ],
});

const runtime = createRuntime({
  provider,
  tools: [statsTool],
  logger: createLogger({ name: 'example:02', level: 'warn', sink: process.stderr }),
});

console.log(`Tools available: ${runtime.registry.names().join(', ')}\n`);

const result = await runtime.run('Describe the distribution of the sample values.');
console.log('--- final answer ---');
console.log(result.answer);
console.log(`\n(scripted run: status=${result.status}, toolCalls=${result.toolCallCount})`);
