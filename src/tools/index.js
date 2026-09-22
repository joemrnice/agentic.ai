import { createCalculatorTools } from './calculator.js';
import { createFilesystemTools } from './filesystem.js';
import { createHttpTools } from './http.js';
import { createMemoryTools } from './memory.js';
import { createShellTools } from './shell.js';
import { ToolRegistry } from '../core/registry.js';

export { createCalculatorTools, createFilesystemTools, createHttpTools, createMemoryTools, createShellTools };

/** Documentation metadata for the built-in tool packs. */
export const TOOL_PACKS = Object.freeze([
  {
    id: 'filesystem',
    tools: ['fs.list', 'fs.read', 'fs.write'],
    capability: 'Read and write files inside the workspace sandbox.',
    enabledBy: 'always on',
  },
  {
    id: 'compute',
    tools: ['calculator.eval'],
    capability: 'Deterministic arithmetic without shelling out.',
    enabledBy: 'always on',
  },
  {
    id: 'memory',
    tools: ['memory.write', 'memory.search', 'memory.recent'],
    capability: 'Long-term recall across runs.',
    enabledBy: 'when a MemoryStore is available',
  },
  {
    id: 'web',
    tools: ['http.get', 'http.post'],
    capability: 'Fetch URLs and call APIs.',
    enabledBy: 'AGENTIC_ALLOW_NETWORK=true',
  },
  {
    id: 'shell',
    tools: ['shell.exec'],
    capability: 'Run allow-listed executables without a shell.',
    enabledBy: 'AGENTIC_ALLOW_SHELL=true',
  },
]);

/**
 * Assemble the tool set for a runtime.
 *
 * Capability is opt-in: filesystem (sandboxed) and compute are always present,
 * memory appears when a store exists, and web/shell require explicit
 * configuration. The principle is *least privilege per run* -- an agent that
 * cannot reach the network cannot leak to it either.
 */
export function createDefaultTools({ config = {}, memory = null, fetchImpl = undefined } = {}) {
  const tools = [
    ...createFilesystemTools({ workspace: config.workspace ?? process.cwd() }),
    ...createCalculatorTools(),
  ];

  if (memory) tools.push(...createMemoryTools({ memory }));

  if (config.allowNetwork) {
    tools.push(
      ...createHttpTools({
        allowNetwork: true,
        allowedHosts: config.allowedHosts ?? [],
        timeoutMs: config.toolTimeoutMs ?? 10_000,
        fetchImpl,
      }),
    );
  }

  if (config.allowShell) {
    tools.push(
      ...createShellTools({
        enabled: true,
        allowlist: config.shellAllowlist ?? undefined,
        cwd: config.workspace ?? process.cwd(),
        timeoutMs: config.shellTimeoutMs ?? 15_000,
      }),
    );
  }

  return tools;
}

/** Register the default tool set on an existing registry. */
export function registerDefaultTools(registry, deps = {}) {
  return registry.registerAll(createDefaultTools(deps));
}
