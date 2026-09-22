import { AgenticError, ToolExecutionError, ToolNotFoundError, ToolTimeoutError, ValidationError, toError } from '../utils/errors.js';
import { applyDefaults, validateAgainstSchema } from '../utils/schema.js';
import { AgentEvents } from './events.js';

/** Convert any tool return value into a bounded string observation. */
export function serializeToolOutput(value, { maxChars = 4000 } = {}) {
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (value === undefined || value === null) {
    text = 'null';
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} characters]`;
  }
  return text;
}

/** Tool arguments usually arrive as a JSON string from the model. */
export function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new ValidationError(`Tool arguments are not valid JSON (${error.message}): ${String(raw).slice(0, 200)}`);
  }
}

/**
 * Turns a model-proposed tool call into an observed result.
 *
 * Responsibilities kept here (and deliberately *out* of tools):
 *   - schema validation and default application
 *   - deadlines (a hung tool must not hang the run)
 *   - retry policy: read-only tools are retried, mutating tools never are
 *   - output truncation so one verbose tool cannot exhaust the context window
 *
 * Failures are returned as observations rather than thrown, because the model
 * needs to see the error in order to adapt on the next step.
 */
export class ToolExecutor {
  #registry;
  #logger;
  #events;
  #timeoutMs;
  #maxOutputChars;
  #maxRetries;
  #counter = 0;

  constructor({ registry, logger, events, timeoutMs = 15_000, maxOutputChars = 4_000, maxRetries = 0 } = {}) {
    if (!registry) throw new ValidationError('ToolExecutor requires a registry');
    this.#registry = registry;
    this.#logger = logger ?? null;
    this.#events = events ?? null;
    this.#timeoutMs = timeoutMs;
    this.#maxOutputChars = maxOutputChars;
    this.#maxRetries = maxRetries;
  }

  get registry() {
    return this.#registry;
  }

  /**
   * @param {{ id?: string, name: string, arguments?: unknown }} call
   * @param {import('./context.js').RunContext} context
   */
  async execute(call, context) {
    const id = call?.id ?? `call_${++this.#counter}`;
    const name = call?.name ?? 'unknown';
    const startedAt = Date.now();
    let args = call?.arguments ?? {};

    this.#events?.emit(AgentEvents.TOOL_START, { runId: context?.runId, callId: id, tool: name, args });

    const finish = (result) => {
      const durationMs = Date.now() - startedAt;
      const observation = { id, name, durationMs, ...result };
      this.#events?.emit(result.ok ? AgentEvents.TOOL_END : AgentEvents.TOOL_ERROR, {
        runId: context?.runId,
        callId: id,
        tool: name,
        ok: result.ok,
        durationMs,
        attempts: result.attempts,
        error: result.error,
      });
      this.#logger?.debug('tool finished', { tool: name, ok: result.ok, durationMs, attempts: result.attempts });
      return observation;
    };

    let tool;
    try {
      args = parseToolArguments(args);
      tool = this.#registry.get(name);
      args = applyDefaults(args, tool.parameters);
      const { valid, errors } = validateAgainstSchema(args, tool.parameters);
      if (!valid) {
        throw new ValidationError(
          `Invalid arguments for tool "${name}": ${errors.map((error) => `${error.path} ${error.message}`).join('; ')}`,
          { details: { tool: name, errors } },
        );
      }
    } catch (error) {
      const normalized = toError(error);
      this.#logger?.warn('tool call rejected', { tool: name, error: normalized.message });
      return finish({
        ok: false,
        attempts: 0,
        args: typeof args === 'object' && args !== null ? args : {},
        output: `ERROR(${normalized.code}): ${normalized.message}`,
        error: normalized.toJSON?.() ?? { name: normalized.name, message: normalized.message },
      });
    }

    const maxAttempts = tool.sideEffects ? 1 : Math.max(1, this.#maxRetries + 1);
    let attempt = 0;
    let lastError = null;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const value = await this.#invokeWithTimeout(tool, args, context);
        return finish({
          ok: true,
          attempts: attempt,
          args,
          output: serializeToolOutput(value, { maxChars: this.#maxOutputChars }),
          error: null,
        });
      } catch (error) {
        lastError = toError(error);
        const retryable = !tool.sideEffects && lastError.retryable !== false && attempt < maxAttempts;
        this.#logger?.warn('tool failed', { tool: name, attempt, retryable, error: lastError.message });
        if (!retryable) break;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }

    // Keep specific tool error codes (TOOL_TIMEOUT, TOOL_NOT_FOUND, ...) visible
    // to the model so it can choose a different recovery strategy.
    const failed =
      lastError instanceof AgenticError
        ? lastError
        : new ToolExecutionError(`Tool "${name}" failed: ${lastError?.message ?? 'unknown error'}`, { cause: lastError, retryable: false });

    return finish({ ok: false, attempts: attempt, args, output: `ERROR(${failed.code}): ${failed.message}`, error: failed.toJSON() });
  }

  /** Run a tool handler under a deadline, exposing an AbortSignal for cancellation. */
  async #invokeWithTimeout(tool, args, context) {
    const timeoutMs = tool.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    let timer;

    const toolContext = {
      signal: controller.signal,
      runId: context?.runId,
      workspace: context?.workspace,
      memory: context?.memory ?? null,
      logger: this.#logger,
      emit: (event, payload) => this.#events?.emit(event, { runId: context?.runId, ...payload }),
    };

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ToolTimeoutError(`Tool "${tool.name}" exceeded its ${timeoutMs}ms deadline`, { details: { tool: tool.name, timeoutMs } }));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([Promise.resolve(tool.handler(args, toolContext)), timeout]);
    } catch (error) {
      if (error instanceof ToolNotFoundError || error instanceof ToolTimeoutError || error instanceof ToolExecutionError) throw error;
      const normalized = toError(error);
      throw new ToolExecutionError(`Tool "${tool.name}" threw: ${normalized.message}`, {
        cause: normalized,
        details: { tool: tool.name, toolCode: normalized.code },
        retryable: false,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
