/**
 * Error taxonomy for the agent runtime.
 *
 * Every failure surfaced by the runtime carries a stable machine readable
 * `code` plus a `details` bag so that callers (CLI, workflow runner, host app)
 * can react programmatically instead of string-matching messages.
 */

export class AgenticError extends Error {
  /**
   * @param {string} message human readable description
   * @param {{ code?: string, details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    const { code = 'AGENTIC_ERROR', details = {}, cause } = options;
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Invalid or contradictory configuration (env vars, files, overrides). */
export class ConfigError extends AgenticError {
  constructor(message, options = {}) {
    super(message, { code: 'CONFIG_ERROR', ...options });
  }
}

/** Anything raised by an LLM provider (transport, auth, malformed payload). */
export class ProviderError extends AgenticError {
  constructor(message, options = {}) {
    super(message, { code: 'PROVIDER_ERROR', ...options });
  }
}

/** Base class for every tool related failure. */
export class ToolError extends AgenticError {
  constructor(message, options = {}) {
    super(message, { code: 'TOOL_ERROR', ...options });
  }
}

/** A tool call referenced a name that is not registered. */
export class ToolNotFoundError extends ToolError {
  constructor(message, options = {}) {
    super(message, { code: 'TOOL_NOT_FOUND', ...options });
  }
}

/** A registered tool raised while handling a call. */
export class ToolExecutionError extends ToolError {
  constructor(message, options = {}) {
    super(message, { code: 'TOOL_EXECUTION_ERROR', ...options });
  }
}

/** A tool call exceeded its deadline. */
export class ToolTimeoutError extends ToolError {
  constructor(message, options = {}) {
    super(message, { code: 'TOOL_TIMEOUT', retryable: true, ...options });
  }
}

/** Schema validation failure (tool arguments, agent definitions, workflows). */
export class ValidationError extends AgenticError {
  constructor(message, options = {}) {
    super(message, { code: 'VALIDATION_ERROR', ...options });
  }
}

/** A run failed after it had already started (loop, provider failure, abort). */
export class AgentRuntimeError extends AgenticError {
  constructor(message, options = {}) {
    super(message, { code: 'AGENT_RUNTIME_ERROR', ...options });
  }
}

/** Normalize any unknown thrown value into an Error instance. */
export function toError(value) {
  if (value instanceof Error) return value;
  return new AgenticError(typeof value === 'string' ? value : 'Unknown error', {
    code: 'UNKNOWN_ERROR',
    details: { value: safeSerialize(value) },
  });
}

function safeSerialize(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
