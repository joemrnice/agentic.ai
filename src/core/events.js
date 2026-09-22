import { createNoopLogger } from '../utils/logger.js';

/**
 * Canonical lifecycle events emitted during a run.
 *
 * Observability is a first-class concern for agents: a run that cannot be
 * replayed or audited is a run you cannot trust. Subscribe to these events to
 * stream traces to a UI, a log pipeline or a test assertion.
 */
export const AgentEvents = Object.freeze({
  RUN_START: 'run:start',
  RUN_END: 'run:end',
  RUN_ERROR: 'run:error',
  STEP_START: 'step:start',
  STEP_END: 'step:end',
  COMPLETION: 'model:completion',
  TOOL_START: 'tool:start',
  TOOL_END: 'tool:end',
  TOOL_ERROR: 'tool:error',
  MEMORY_WRITE: 'memory:write',
  MEMORY_READ: 'memory:read',
  WORKFLOW_START: 'workflow:start',
  WORKFLOW_STEP: 'workflow:step',
  WORKFLOW_END: 'workflow:end',
});

/**
 * Tiny synchronous event bus with wildcard ("*") support.
 *
 * Listener failures are logged and swallowed: a broken observer must never
 * abort an in-flight agent run.
 */
export class EventBus {
  #listeners = new Map();
  #logger;
  #history = [];
  #historyLimit;

  constructor({ logger, historyLimit = 0 } = {}) {
    this.#logger = logger ?? createNoopLogger();
    this.#historyLimit = historyLimit;
  }

  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('Event handler must be a function');
    const handlers = this.#listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.#listeners.set(event, handlers);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  off(event, handler) {
    this.#listeners.get(event)?.delete(handler);
  }

  listenerCount(event) {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /** Events emitted so far, when the bus was created with a `historyLimit`. */
  get history() {
    return [...this.#history];
  }

  emit(event, payload = {}) {
    const record = { event, ...payload };
    if (this.#historyLimit > 0) {
      this.#history.push(record);
      if (this.#history.length > this.#historyLimit) this.#history.shift();
    }

    this.#logger.debug('event', { event, ...payload });

    for (const handler of this.#listeners.get(event) ?? []) {
      try {
        handler(record);
      } catch (error) {
        this.#logger.warn('event handler failed', { event, error: error?.message });
      }
    }
    for (const handler of this.#listeners.get('*') ?? []) {
      try {
        handler(record);
      } catch (error) {
        this.#logger.warn('wildcard event handler failed', { event, error: error?.message });
      }
    }
    return record;
  }
}

export function createEventBus(options = {}) {
  return new EventBus(options);
}
