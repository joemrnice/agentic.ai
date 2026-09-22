/**
 * 03 - Declarative workflow
 *
 * A workflow chains steps: first a tool scan of the workspace, then a
 * researcher agent run whose prompt interpolates the scan output.
 *
 *   node examples/03-workflow.js
 */
import { fileURLToPath } from 'node:url';
import { createLogger, createRuntime, loadWorkflow, runWorkflow } from '../src/index.js';

const WORKFLOW_PATH = fileURLToPath(new URL('../workflows/research-and-summarize.workflow.json', import.meta.url));

const runtime = createRuntime({
  logger: createLogger({ name: 'example:03', level: 'warn', sink: process.stderr }),
});

const workflow = loadWorkflow(WORKFLOW_PATH);
console.log(`Workflow "${workflow.name}" with steps: ${workflow.steps.map((step) => step.id).join(' -> ')}\n`);

const result = await runWorkflow(workflow, {
  runtime,
  inputs: { focus: 'how the repository is organised' },
});

for (const id of result.order) {
  const step = result.steps[id];
  const preview = String(step.output).split('\n')[0].slice(0, 120);
  console.log(`[${step.status}] ${id} (${step.durationMs}ms): ${preview}...`);
}

console.log('\n--- workflow output ---');
console.log(result.output);
