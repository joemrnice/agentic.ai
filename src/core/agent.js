import { AgentRuntimeError, ValidationError } from '../utils/errors.js';
import { createNoopLogger } from '../utils/logger.js';
import { buildPlannerPrompt, buildSystemPrompt } from '../prompts/system.js';
import { RunContext } from './context.js';
import { AgentEvents, createEventBus } from './events.js';
import { ToolExecutor } from './executor.js';

/**
 * A configured agent: identity + model + tools + budgets + memory policy.
 *
 * `run()` implements the reason/act (ReAct) loop:
 *
 *   observe -> decide -> act (tool call) -> observe -> ... -> answer
 *
 * Everything the loop touches is injectable (provider, registry, executor,
 * memory, event bus), which is what makes the behaviour testable: the same
 * agent runs against a mock model in CI and a real LLM in production.
 */
export class Agent {
  constructor({
    name = 'agent',
    description = '',
    persona = null,
    guidelines = [],
    provider,
    registry,
    memory = null,
    executor = null,
    events = null,
    logger = null,
    config = {},
    maxSteps = 8,
    temperature = 0.2,
    model = null,
    memoryRead = true,
    memoryWrite = false,
    systemPrompt = null,
    maxRepeatedCalls = 3,
  } = {}) {
    if (!provider || typeof provider.complete !== 'function') {
      throw new ValidationError('Agent requires a provider exposing complete({ messages, tools })');
    }
    if (!registry) throw new ValidationError('Agent requires a ToolRegistry (possibly empty)');

    this.name = name;
    this.description = description ?? '';
    this.persona = persona;
    this.guidelines = [...guidelines];
    this.provider = provider;
    this.registry = registry;
    this.memory = memory;
    this.events = events ?? createEventBus({ logger });
    this.logger = logger ?? createNoopLogger();
    this.config = config;
    this.maxSteps = maxSteps;
    this.temperature = temperature;
    this.model = model ?? provider.model ?? null;
    this.memoryRead = memoryRead;
    this.memoryWrite = memoryWrite;
    this.systemPromptOption = systemPrompt;
    this.maxRepeatedCalls = maxRepeatedCalls;

    this.executor =
      executor ??
      new ToolExecutor({
        registry,
        logger: this.logger,
        events: this.events,
        timeoutMs: config.toolTimeoutMs ?? 15_000,
        maxOutputChars: config.toolMaxOutputChars ?? 4_000,
        maxRetries: config.maxToolRetries ?? 0,
      });
  }

  get toolNames() {
    return this.registry.names();
  }

  /** Render the system prompt for a run (override with a string or a function). */
  buildPrompt({ memoryPrompt = '', maxSteps = this.maxSteps } = {}) {
    if (typeof this.systemPromptOption === 'function') return this.systemPromptOption({ agent: this, memoryPrompt });
    if (typeof this.systemPromptOption === 'string') return this.systemPromptOption;

    return buildSystemPrompt({
      agentName: this.name,
      persona: this.persona,
      guidelines: this.guidelines,
      tools: this.registry.list(),
      workspace: this.config.workspace ?? process.cwd(),
      maxSteps,
      memoryPrompt,
    });
  }

  /**
   * Ask the model to decompose a goal into ordered steps (opt-in planning).
   * Returns `[{ id, description, tool }]`; falls back to a single-step plan when
   * the model does not return parseable JSON.
   */
  async plan(task, { signal, maxSteps = 5 } = {}) {
    const prompt = buildPlannerPrompt({ goal: task, tools: this.registry.list(), maxSteps });
    const completion = await this.#complete({ messages: [{ role: 'user', content: prompt }], tools: [], signal });

    const match = /\[[\s\S]*\]/.exec(completion.content ?? '');
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((step, index) => ({
            id: Number.isInteger(step.id) ? step.id : index + 1,
            description: String(step.description ?? step.step ?? '').trim() || `Step ${index + 1}`,
            tool: step.tool ?? null,
          }));
        }
      } catch {
        this.logger.warn('planner returned unparseable JSON', { agent: this.name });
      }
    }

    return [{ id: 1, description: task, tool: null }];
  }

  /**
   * Execute the reason/act loop until the agent answers, the step budget runs
   * out, or the agent gets stuck repeating itself.
   *
   * @param {string} task natural language goal
   * @param {{ signal?: AbortSignal, metadata?: object, remember?: boolean, memoryQuery?: string }} [options]
   */
  async run(task, { signal, metadata = {}, remember = null, memoryQuery = null } = {}) {
    if (typeof task !== 'string' || task.trim() === '') {
      throw new ValidationError('Agent.run requires a non-empty task string');
    }

    const context = new RunContext({
      task,
      agentName: this.name,
      workspace: this.config.workspace ?? process.cwd(),
      memory: this.memory,
      logger: this.logger,
      maxSteps: this.maxSteps,
      metadata,
    });
    const { runId } = context;

    this.events.emit(AgentEvents.RUN_START, {
      runId,
      agent: this.name,
      task: context.task,
      provider: this.provider.name,
      model: this.model,
      tools: this.toolNames,
      maxSteps: this.maxSteps,
    });
    this.logger.info('run started', { runId, agent: this.name, task: context.task.slice(0, 160) });

    try {
      const memoryPrompt = this.memoryRead && this.memory ? this.memory.toPrompt({ limit: 5, query: memoryQuery ?? context.task }) : '';
      context.addMessage({ role: 'system', content: this.buildPrompt({ memoryPrompt }) });
      context.addUserMessage(context.task);

      const repeats = new Map();

      while (context.canStep()) {
        const step = context.nextStep();
        this.events.emit(AgentEvents.STEP_START, { runId, step, remaining: context.remainingSteps });

        const completion = await this.#complete({ messages: context.messages, tools: this.registry.toToolSchemas(), signal });
        context.recordUsage(completion.usage);
        this.events.emit(AgentEvents.COMPLETION, {
          runId,
          step,
          stopReason: completion.stopReason,
          usage: completion.usage,
          toolCalls: completion.toolCalls.length,
        });

        context.addAssistantMessage({ content: completion.content ?? '', toolCalls: completion.toolCalls });

        // Terminal case 1: the model stopped calling tools -> final answer.
        if (completion.toolCalls.length === 0) {
          const answer = (completion.content ?? '').trim() || '(the model returned an empty answer)';
          context.finish({ status: 'completed', answer });
          this.#remember(context, answer, remember);
          this.events.emit(AgentEvents.RUN_END, { runId, agent: this.name, status: 'completed', steps: context.step, durationMs: context.durationMs });
          this.logger.info('run completed', { runId, agent: this.name, steps: context.step, durationMs: context.durationMs });
          return this.#result(context);
        }

        // Terminal case 2: identical repeated calls -> the model is stuck.
        const signature = JSON.stringify(completion.toolCalls.map((call) => [call.name, call.arguments]));
        const repeated = (repeats.get(signature) ?? 0) + 1;
        repeats.set(signature, repeated);
        if (repeated > this.maxRepeatedCalls) {
          const answer = `Stopped after repeating the same tool call ${repeated} times without progress: ${completion.toolCalls
            .map((call) => call.name)
            .join(', ')}.`;
          context.finish({ status: 'stuck', answer });
          this.events.emit(AgentEvents.RUN_END, { runId, agent: this.name, status: 'stuck', steps: context.step, durationMs: context.durationMs });
          this.logger.warn('run stopped: repeated identical tool calls', { runId, agent: this.name, repeated });
          return this.#result(context);
        }

        const observations = [];
        for (const call of completion.toolCalls) {
          const observation = await this.executor.execute(call, context);
          context.addToolResult({ toolCallId: observation.id, name: observation.name, content: observation.output });
          observations.push(observation);
        }
        this.events.emit(AgentEvents.STEP_END, {
          runId,
          step,
          observations: observations.map((observation) => ({ tool: observation.name, ok: observation.ok, durationMs: observation.durationMs })),
        });
      }

      // Terminal case 3: the step budget ran out.
      const lastAssistant = [...context.messages].reverse().find((message) => message.role === 'assistant');
      const answer = lastAssistant?.content?.trim() || `Step budget of ${this.maxSteps} exhausted before a final answer was produced.`;
      context.finish({ status: 'max_steps', answer });
      this.#remember(context, answer, remember);
      this.events.emit(AgentEvents.RUN_END, { runId, agent: this.name, status: 'max_steps', steps: context.step, durationMs: context.durationMs });
      this.logger.warn('run hit the step budget', { runId, agent: this.name, steps: context.step });
      return this.#result(context);
    } catch (error) {
      const wrapped =
        error instanceof AgentRuntimeError
          ? error
          : new AgentRuntimeError(`Run failed: ${error?.message}`, { cause: error, details: { runId, agent: this.name } });
      context.finish({ status: 'failed' });
      this.events.emit(AgentEvents.RUN_ERROR, { runId, agent: this.name, code: wrapped.code, error: wrapped.message });
      this.logger.error('run failed', { runId, agent: this.name, code: wrapped.code, error: wrapped.message });
      throw wrapped;
    }
  }

  #result(context) {
    return {
      ...context.toJSON(),
      agent: this.name,
      answer: context.answer,
      provider: this.provider.name,
      model: this.model,
    };
  }

  #remember(context, answer, remember) {
    const shouldRemember = remember ?? this.memoryWrite;
    if (!shouldRemember || !this.memory || context.status !== 'completed') return null;
    return this.memory.add({
      content: `Task: ${context.task}\nOutcome: ${answer}`,
      kind: 'summary',
      tags: [this.name],
      metadata: { runId: context.runId, status: context.status, steps: context.step },
    });
  }

  async #complete({ messages, tools, signal }) {
    try {
      return await this.provider.complete({ messages, tools, model: this.model, temperature: this.temperature, signal });
    } catch (error) {
      throw new AgentRuntimeError(`Model call failed: ${error?.message}`, {
        cause: error,
        details: { agent: this.name, provider: this.provider.name, providerCode: error?.code },
      });
    }
  }
}
