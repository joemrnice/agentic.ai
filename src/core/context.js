import { randomUUID } from 'node:crypto';
import { ValidationError } from '../utils/errors.js';

const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Per-run working state.
 *
 * The context is the *only* channel between the model and the runtime: the
 * model sees `messages`, the runtime counts `step`, and the scratchpad keeps
 * process-local bookkeeping out of the prompt. Keeping it in one object makes
 * runs reconstructable from a transcript.
 */
export class RunContext {
  constructor({
    task,
    agentName = 'agent',
    workspace = process.cwd(),
    memory = null,
    logger = null,
    maxSteps = 8,
    runId = randomUUID(),
    startedAt = new Date(),
    metadata = {},
  } = {}) {
    if (typeof task !== 'string' || task.trim() === '') {
      throw new ValidationError('RunContext requires a non-empty task string');
    }
    this.runId = runId;
    this.agentName = agentName;
    this.task = task.trim();
    this.workspace = workspace;
    this.memory = memory;
    this.logger = logger;
    this.maxSteps = maxSteps;
    this.startedAt = startedAt;
    this.metadata = { ...metadata };

    this._messages = [];
    this._scratchpad = new Map();
    this.step = 0;
    this.plan = null;
    this.status = 'pending';
    this.answer = null;
    this.endedAt = null;
    this.toolCallCount = 0;
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, completions: 0 };
  }

  get messages() {
    return [...this._messages];
  }

  get lastMessage() {
    return this._messages.at(-1) ?? null;
  }

  get remainingSteps() {
    return Math.max(0, this.maxSteps - this.step);
  }

  get durationMs() {
    return (this.endedAt ? this.endedAt.getTime() : Date.now()) - this.startedAt.getTime();
  }

  canStep() {
    return this.remainingSteps > 0 && this.status !== 'aborted';
  }

  addMessage(message) {
    if (!message || typeof message !== 'object') throw new ValidationError('Message must be an object');
    if (!ROLES.has(message.role)) {
      throw new ValidationError(`Message role must be one of ${[...ROLES].join(', ')}, received "${message.role}"`);
    }
    this._messages.push(Object.freeze({ ...message }));
    return this.lastMessage;
  }

  addUserMessage(content, extra = {}) {
    return this.addMessage({ role: 'user', content, ...extra });
  }

  addAssistantMessage({ content = '', toolCalls = [], ...extra } = {}) {
    return this.addMessage({ role: 'assistant', content, ...(toolCalls.length > 0 ? { toolCalls } : {}), ...extra });
  }

  addToolResult({ toolCallId, name, content }) {
    this.toolCallCount += 1;
    return this.addMessage({ role: 'tool', toolCallId, name, content });
  }

  setPlan(plan) {
    this.plan = plan;
    return plan;
  }

  /** Advance the step counter; throws when the budget is exhausted. */
  nextStep() {
    if (!this.canStep()) return null;
    this.step += 1;
    return this.step;
  }

  scratchpad(token, value) {
    if (value === undefined) return this._scratchpad.get(token);
    this._scratchpad.set(token, value);
    return value;
  }

  recordUsage(usage = {}) {
    this.usage.promptTokens += usage.promptTokens ?? 0;
    this.usage.completionTokens += usage.completionTokens ?? 0;
    this.usage.totalTokens += usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    this.usage.completions += 1;
    return this.usage;
  }

  finish({ status = 'completed', answer = null } = {}) {
    this.status = status;
    this.answer = answer ?? this.answer;
    this.endedAt = new Date();
    return this.toJSON();
  }

  /** Full, JSON-serializable reconstruction of the run. */
  toJSON() {
    return {
      runId: this.runId,
      agentName: this.agentName,
      task: this.task,
      status: this.status,
      step: this.step,
      maxSteps: this.maxSteps,
      toolCallCount: this.toolCallCount,
      usage: { ...this.usage },
      plan: this.plan,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.endedAt ? this.endedAt.toISOString() : null,
      durationMs: this.durationMs,
      messages: this._messages.map((message) => ({ ...message })),
      metadata: { ...this.metadata },
    };
  }
}
