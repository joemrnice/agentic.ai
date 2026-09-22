import { loadConfig } from '../config/index.js';
import { assertProvider, createProvider } from '../llm/index.js';
import { createDefaultTools } from '../tools/index.js';
import { createLogger, createNoopLogger } from '../utils/logger.js';
import { Agent } from './agent.js';
import { loadAgentDefinition, normalizeDefinition } from './definition.js';
import { createEventBus } from './events.js';
import { ToolExecutor } from './executor.js';
import { MemoryStore } from './memory.js';
import { assertToolsExist, ToolRegistry } from './registry.js';

/**
 * Wire the whole runtime together: config, logging, provider, memory, tools,
 * executor and event bus. Every collaborator can be injected, so a host app can
 * swap the model, reuse a shared memory store or attach telemetry without
 * touching the loop.
 */
export function createRuntime({ config = loadConfig(), logger, provider, memory, registry, tools, events, fetchImpl } = {}) {
  const log = logger ?? (config.logLevel === 'silent' ? createNoopLogger() : createLogger({ name: 'agentic', level: config.logLevel }));
  const bus = events ?? createEventBus({ logger: log, historyLimit: 500 });
  const memoryStore = memory ?? MemoryStore.fromConfig(config, { logger: log.child('memory') });
  const toolRegistry =
    registry ?? new ToolRegistry(tools ?? createDefaultTools({ config, memory: memoryStore, fetchImpl }));
  if (registry && tools) toolRegistry.registerAll(tools);
  const llm = provider ? assertProvider(provider) : createProvider(config, { logger: log.child('provider'), fetchImpl });

  const executor = new ToolExecutor({
    registry: toolRegistry,
    logger: log.child('tools'),
    events: bus,
    timeoutMs: config.toolTimeoutMs,
    maxOutputChars: config.toolMaxOutputChars,
    maxRetries: config.maxToolRetries,
  });

  const resolveDefinition = (definition) => {
    if (!definition) return normalizeDefinition({ name: 'assistant', description: 'Default general-purpose agent.' });
    if (typeof definition === 'string') return loadAgentDefinition(definition);
    return normalizeDefinition(definition);
  };

  const runtime = {
    config,
    logger: log,
    events: bus,
    memory: memoryStore,
    registry: toolRegistry,
    provider: llm,
    executor,

    /**
     * Build an agent from a definition (file path, object, or nothing for a
     * default generalist agent).
     *
     * @param {string|object|null} definition
     * @param {object} [overrides] per-call overrides: name, persona, tools, maxSteps, ...
     */
    createAgent(definition = null, overrides = {}) {
      const resolved = resolveDefinition(definition);
      const toolNames = overrides.tools ?? resolved.tools;
      assertToolsExist(toolRegistry, toolNames ?? [], { label: `agent "${resolved.name}"` });

      const scopedRegistry = toolNames ? toolRegistry.subset(toolNames) : toolRegistry;
      const memoryEnabled = resolved.memory.read || resolved.memory.write;

      return new Agent({
        name: overrides.name ?? resolved.name,
        description: resolved.description,
        persona: overrides.persona ?? resolved.persona,
        guidelines: overrides.guidelines ?? resolved.guidelines,
        provider: overrides.provider ?? llm,
        registry: overrides.registry ?? scopedRegistry,
        memory: overrides.memory ?? (memoryEnabled ? memoryStore : null),
        events: bus,
        logger: log.child(resolved.name),
        config,
        maxSteps: overrides.maxSteps ?? resolved.maxSteps ?? config.maxSteps,
        temperature: overrides.temperature ?? resolved.temperature ?? config.temperature,
        model: overrides.model ?? resolved.model ?? (config.provider === 'mock' ? 'mock-1' : config.model),
        memoryRead: overrides.memoryRead ?? resolved.memory.read,
        memoryWrite: overrides.memoryWrite ?? resolved.memory.write,
        systemPrompt: overrides.systemPrompt ?? null,
      });
    },

    /** Convenience: build and run in one call. */
    async run(task, definition = null, options = {}) {
      const agent = runtime.createAgent(definition, options.agent ?? {});
      return agent.run(task, options.run ?? {});
    },

    /** Sanitized one-screen description of how this runtime is wired. */
    describe() {
      return {
        provider: llm.name,
        model: llm.model,
        workspace: config.workspace,
        memory: { path: memoryStore.path, entries: memoryStore.size, persist: config.memoryPersist },
        tools: toolRegistry.names(),
        capabilities: { shell: config.allowShell, network: config.allowNetwork, allowedHosts: config.allowedHosts },
        budgets: { maxSteps: config.maxSteps, toolTimeoutMs: config.toolTimeoutMs, temperature: config.temperature },
      };
    },
  };

  return runtime;
}
