import { ToolNotFoundError, ValidationError } from '../utils/errors.js';
import { assertValid, describeSchema } from '../utils/schema.js';

/**
 * Declare a tool.
 *
 * A tool is the only way an agent can affect the world, so each declaration is
 * explicit about three things:
 *   - `parameters`: a JSON-Schema subset the runtime enforces *before* running
 *   - `sideEffects`: whether retrying is safe (read-only tools are retried,
 *     mutating tools are not)
 *   - `handler`: a pure async function `(args, ctx) => result`
 */
export function defineTool({ name, description, parameters = { type: 'object', properties: {} }, handler, tags = [], sideEffects = false, timeoutMs } = {}) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new ValidationError(`Tool name must be a non-empty identifier-like string, received "${name}"`);
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new ValidationError(`Tool "${name}" must have a non-empty description (the model reads it to decide when to call it)`);
  }
  if (typeof handler !== 'function') {
    throw new ValidationError(`Tool "${name}" must provide a handler function`);
  }
  if (parameters && parameters.type !== undefined && parameters.type !== 'object') {
    throw new ValidationError(`Tool "${name}" parameters must be an object schema`);
  }

  return Object.freeze({ name, description, parameters, handler, tags: Object.freeze([...tags]), sideEffects, timeoutMs });
}

/** Collects tools and exposes them to both the runtime and the LLM. */
export class ToolRegistry {
  #tools = new Map();

  constructor(tools = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool) {
    const normalized = tool?.name && typeof tool.handler === 'function' ? tool : defineTool(tool);
    if (this.#tools.has(normalized.name)) {
      throw new ValidationError(`Tool "${normalized.name}" is already registered`);
    }
    this.#tools.set(normalized.name, normalized);
    return this;
  }

  registerAll(tools = []) {
    for (const tool of tools) this.register(tool);
    return this;
  }

  unregister(name) {
    return this.#tools.delete(name);
  }

  has(name) {
    return this.#tools.has(name);
  }

  get(name) {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(`Unknown tool "${name}"`, { details: { tool: name, available: this.names() } });
    }
    return tool;
  }

  names() {
    return [...this.#tools.keys()].sort();
  }

  list() {
    return this.names().map((name) => this.#tools.get(name));
  }

  get size() {
    return this.#tools.size;
  }

  /** A new registry limited to `names`; throws if any name is unknown. */
  subset(names) {
    if (!names) return this;
    return new ToolRegistry(names.map((name) => this.get(name)));
  }

  /** Provider-facing JSON schema descriptions (`tools` request parameter). */
  toToolSchemas() {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /** Compact plain-text catalogue embedded in the system prompt. */
  describe({ maxDescriptionChars = 240 } = {}) {
    return this.list()
      .map((tool) => {
        const params = Object.entries(tool.parameters?.properties ?? {})
          .map(([key, schema]) => {
            const required = (tool.parameters?.required ?? []).includes(key);
            return `${key}: ${describeSchema(schema)}${required ? ' (required)' : ''}`;
          })
          .join(', ');
        const description = tool.description.length > maxDescriptionChars ? `${tool.description.slice(0, maxDescriptionChars)}...` : tool.description;
        return `- ${tool.name}(${params || 'no arguments'}): ${description}`;
      })
      .join('\n');
  }
}

/** Validate a definition-level tool name list against the registry. */
export function assertToolsExist(registry, names = [], { label = 'definition' } = {}) {
  const missing = names.filter((name) => !registry.has(name));
  if (missing.length > 0) {
    throw new ToolNotFoundError(`${label} references unknown tool(s): ${missing.join(', ')}`, {
      details: { missing, available: registry.names() },
    });
  }
  return names;
}
