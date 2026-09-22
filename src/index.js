/**
 * agentic.ai -- public API.
 *
 * ```js
 * import { createRuntime } from 'agentic.ai';
 *
 * const runtime = createRuntime();          // zero-config: mock model, sandboxed fs tools
 * const result = await runtime.run('List the workspace files and compute 21 * 2');
 * console.log(result.answer);
 * ```
 */
export { loadConfig, summarizeConfig, DEFAULTS, PROVIDERS, ENV_PREFIX } from './config/index.js';
export { loadDotEnv, parseDotEnv } from './config/env.js';

export { Agent } from './core/agent.js';
export { RunContext } from './core/context.js';
export { ToolExecutor, parseToolArguments, serializeToolOutput } from './core/executor.js';
export { createRuntime } from './core/factory.js';
export { DEFINITION_VERSION, listAgentDefinitions, loadAgentDefinition, normalizeDefinition } from './core/definition.js';
export { AgentEvents, createEventBus, EventBus } from './core/events.js';
export { MemoryStore } from './core/memory.js';
export { assertToolsExist, defineTool, ToolRegistry } from './core/registry.js';

export { assertProvider, createMockProvider, createOpenAIProvider, createProvider } from './llm/index.js';
export { buildPlannerPrompt, buildSystemPrompt } from './prompts/system.js';

export {
  createCalculatorTools,
  createDefaultTools,
  createFilesystemTools,
  createHttpTools,
  createMemoryTools,
  createShellTools,
  registerDefaultTools,
  TOOL_PACKS,
} from './tools/index.js';
export { evaluateExpression } from './tools/calculator.js';
export { parseCommand } from './tools/shell.js';
export { resolveWithinWorkspace } from './tools/filesystem.js';

export { loadWorkflow, renderTemplate, runWorkflow } from './workflows/runner.js';

export {
  AgenticError,
  AgentRuntimeError,
  ConfigError,
  ProviderError,
  ToolError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolTimeoutError,
  ValidationError,
  toError,
} from './utils/errors.js';
export { createLogger, createNoopLogger, LOG_LEVELS } from './utils/logger.js';
export { applyDefaults, assertValid, describeSchema, validateAgainstSchema } from './utils/schema.js';
