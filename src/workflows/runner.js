import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AgentEvents } from '../core/events.js';
import { createRuntime } from '../core/factory.js';
import { ValidationError, toError } from '../utils/errors.js';

/** Load and validate a declarative workflow (a DAG of agent/tool steps). */
export function loadWorkflow(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ValidationError(`Workflow file not found: ${absolute}`);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new ValidationError(`Workflow is not valid JSON (${absolute}): ${error.message}`);
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new ValidationError(`Workflow ${parsed.name ?? absolute} must declare a non-empty "steps" array`);
  }

  const ids = new Set();
  for (const [index, step] of parsed.steps.entries()) {
    if (!step || typeof step !== 'object' || !step.id) throw new ValidationError(`Workflow step #${index + 1} must have an "id"`);
    if (ids.has(step.id)) throw new ValidationError(`Workflow step id "${step.id}" is duplicated`);
    ids.add(step.id);
    if (step.uses !== 'agent' && step.uses !== 'tool') {
      throw new ValidationError(`Workflow step "${step.id}" must set uses to "agent" or "tool"`);
    }
    if (step.uses === 'tool' && !step.tool) throw new ValidationError(`Workflow step "${step.id}" uses a tool but has no "tool" name`);
    if (step.uses === 'agent' && !step.agent) throw new ValidationError(`Workflow step "${step.id}" uses an agent but has no "agent" definition`);
  }

  for (const step of parsed.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new ValidationError(`Workflow step "${step.id}" depends on unknown step "${dependency}"`);
    }
  }

  return Object.freeze({ ...parsed, source: absolute, dir: dirname(absolute) });
}

function resolvePath(scope, expression) {
  const segments = expression.split(/[.[\]]+/).filter(Boolean);
  let current = scope;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Substitute `{{ placeholders }}` in strings, arrays and objects.
 *
 * Available roots: `{{ inputs.x }}` and `{{ steps.<id>.output }}`. Unknown
 * placeholders are left untouched, so a broken reference stays visible instead
 * of silently becoming "undefined".
 */
export function renderTemplate(value, scope) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (match, expression) => {
      const resolved = resolvePath(scope, expression);
      if (resolved === undefined || resolved === null) return match;
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => renderTemplate(entry, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderTemplate(entry, scope)]));
  }
  return value;
}

function toTask(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return String(input.task ?? input.prompt ?? JSON.stringify(input));
  return String(input ?? '');
}


/**
 * Execute a workflow sequentially, honouring `dependsOn` ordering.
 *
 * A workflow is the multi-agent counterpart of the tool loop: each step is
 * either one agent run or one tool call, and earlier outputs can be
 * interpolated into later prompts. Failures short-circuit the run and are
 * reported together with the failing step id.
 */
export async function runWorkflow(workflow, { runtime = createRuntime(), inputs = {}, logger = undefined } = {}) {
  const log = logger ?? runtime.logger;
  const name = workflow.name ?? 'workflow';
  const scope = { inputs: { ...(workflow.inputs ?? {}), ...inputs }, steps: {} };
  const results = {};
  const order = [];
  const pending = [...workflow.steps];
  const completed = new Set();

  runtime.events.emit(AgentEvents.WORKFLOW_START, { workflow: name, steps: workflow.steps.length, inputs: scope.inputs });

  while (pending.length > 0) {
    const index = pending.findIndex((step) => (step.dependsOn ?? []).every((dependency) => completed.has(dependency)));
    if (index === -1) throw new ValidationError('Workflow steps form a cycle or reference an unreachable dependency');

    const [step] = pending.splice(index, 1);
    const renderedInput = renderTemplate(step.input ?? {}, scope);
    const startedAt = Date.now();
    runtime.events.emit(AgentEvents.WORKFLOW_STEP, { workflow: name, step: step.id, uses: step.uses, status: 'running' });

    try {
      let output;
      if (step.uses === 'tool') {
        const observation = await runtime.executor.execute(
          { name: step.tool, arguments: typeof renderedInput === 'object' && renderedInput !== null ? renderedInput : { input: renderedInput } },
          { runId: `workflow:${name}`, workspace: runtime.config.workspace, memory: runtime.memory },
        );
        if (!observation.ok) throw new ValidationError(`Tool step "${step.id}" failed: ${observation.output}`);
        output = observation.output;
      } else {
        const definition = typeof step.agent === 'string' && workflow.dir ? resolve(workflow.dir, step.agent) : step.agent;
        const agent = runtime.createAgent(definition, step.overrides ?? {});
        const result = await agent.run(toTask(renderedInput), { metadata: { workflow: name, step: step.id } });
        output = result.answer;
      }

      scope.steps[step.id] = { output };
      completed.add(step.id);
      order.push(step.id);
      results[step.id] = { status: 'completed', output, durationMs: Date.now() - startedAt };
      runtime.events.emit(AgentEvents.WORKFLOW_STEP, { workflow: name, step: step.id, status: 'completed', durationMs: results[step.id].durationMs });
      log.debug('workflow step completed', { workflow: name, step: step.id, uses: step.uses });
    } catch (error) {
      const normalized = toError(error);
      const failure = normalized.toJSON?.() ?? { message: normalized.message };
      results[step.id] = { status: 'failed', error: failure, durationMs: Date.now() - startedAt };
      runtime.events.emit(AgentEvents.WORKFLOW_STEP, { workflow: name, step: step.id, status: 'failed', error: normalized.message });
      runtime.events.emit(AgentEvents.WORKFLOW_END, { workflow: name, status: 'failed', failedStep: step.id, order });
      log.error('workflow step failed', { workflow: name, step: step.id, error: normalized.message });
      return { status: 'failed', workflow: name, order, steps: results, output: null, error: failure };
    }
  }

  const output = workflow.output ? renderTemplate(workflow.output, scope) : (results[order.at(-1)]?.output ?? null);
  runtime.events.emit(AgentEvents.WORKFLOW_END, { workflow: name, status: 'completed', order });

  return { status: 'completed', workflow: name, order, steps: results, output };
}
