#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, summarizeConfig } from './config/index.js';
import { listAgentDefinitions, loadAgentDefinition } from './core/definition.js';
import { AgentEvents } from './core/events.js';
import { createRuntime } from './core/factory.js';
import { toError } from './utils/errors.js';
import { createLogger } from './utils/logger.js';
import { loadWorkflow, runWorkflow } from './workflows/runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

const USAGE = `agentic.ai -- a minimal but complete agent runtime

Usage:
  agentic run [task...] [options]        Run one agent on a task
  agentic workflow <file> [--input.k=v]  Execute a declarative workflow
  agentic tools                          List the registered tools
  agentic agents                         List the agent definitions in ./agents
  agentic config                         Print the effective configuration
  agentic help                           Show this message

Run options:
  --agent <name|path>   Agent definition (default: agents/assistant.agent.json)
  --task "<text>"       Task text (alternative to positional words)
  --provider <name>     mock | openai | openai-compatible | ollama
  --model <id>          Model identifier for the provider
  --max-steps <n>       Override the step budget for this run
  --remember            Persist the outcome to long-term memory
  --json                Print the full run record as JSON
  --trace               Stream lifecycle events to stderr as JSON lines

Examples:
  npm start -- "List the workspace files and compute 21 * 2"
  npm start -- --agent researcher "Summarise README.md"
  npm run workflow -- workflows/research-and-summarize.workflow.json
`;

/** Flags that never take a value, so they must not swallow the next argument. */
export const BOOLEAN_FLAGS = Object.freeze(['json', 'trace', 'remember', 'help', 'version']);

/** Parse `--flag value`, `--flag=value` and bare positional arguments. */
export function parseArgs(argv = []) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string') continue;

    if (token.startsWith('--')) {
      const [key, inlineValue] = token.slice(2).split('=');
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
      } else if (BOOLEAN_FLAGS.includes(key)) {
        flags[key] = true;
      } else if (argv[index + 1] !== undefined && !String(argv[index + 1]).startsWith('--')) {
        flags[key] = argv[index + 1];
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    positional.push(token);
  }

  return { flags, positional };
}

/** Resolve `--agent` to a definition file, accepting a name, a path or nothing. */
export function resolveAgentPath(value) {
  if (!value) return resolve(PACKAGE_ROOT, 'agents', 'assistant.agent.json');

  const direct = resolve(process.cwd(), String(value));
  if (existsSync(direct)) return direct;
  if (existsSync(`${direct}.agent.json`)) return `${direct}.agent.json`;

  const inPackage = resolve(PACKAGE_ROOT, 'agents', `${value}.agent.json`);
  if (existsSync(inPackage)) return inPackage;

  return direct;
}

function configOverridesFromFlags(flags) {
  const overrides = {};
  if (typeof flags.provider === 'string') overrides.provider = flags.provider;
  if (typeof flags.model === 'string') overrides.model = flags.model;
  if (typeof flags['max-steps'] === 'string') overrides.maxSteps = Number(flags['max-steps']);
  if (typeof flags['log-level'] === 'string') overrides.logLevel = flags['log-level'];
  return overrides;
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

async function commandRun({ flags, positional }) {
  const task = typeof flags.task === 'string' ? flags.task : positional.join(' ').trim();
  if (!task) {
    process.stderr.write('error: no task provided. Try: npm start -- "list the workspace files"\n');
    return 2;
  }

  const config = loadConfig(configOverridesFromFlags(flags));
  const runtime = createRuntime({ config, logger: makeLogger(config) });
  if (flags.trace) attachTracer(runtime);

  const definition = loadAgentDefinition(resolveAgentPath(flags.agent));
  const agent = runtime.createAgent(definition, flags['max-steps'] ? { maxSteps: Number(flags['max-steps']) } : {});
  const result = await agent.run(task, { remember: Boolean(flags.remember) });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.answer}\n`);
    process.stdout.write(
      `\n-- ${result.agent} (${result.provider}/${result.model}) | status=${result.status} steps=${result.step} toolCalls=${result.toolCallCount} tokens=${result.usage.totalTokens} duration=${result.durationMs}ms runId=${result.runId}\n`,
    );
  }

  return result.status === 'completed' ? 0 : 1;
}

async function commandWorkflow({ flags, positional }) {
  const file = positional[0] ?? flags.file;
  if (!file) {
    process.stderr.write('error: workflow path required, e.g. agentic workflow workflows/research-and-summarize.workflow.json\n');
    return 2;
  }

  const inputs = {};
  for (const [key, value] of Object.entries(flags)) {
    if (key.startsWith('input.')) inputs[key.slice('input.'.length)] = value;
  }

  const config = loadConfig(configOverridesFromFlags(flags));
  const runtime = createRuntime({ config, logger: makeLogger(config) });
  const workflow = loadWorkflow(file);
  const result = await runWorkflow(workflow, { runtime, inputs });

  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.output ?? JSON.stringify(result, null, 2)}\n`);

  return result.status === 'completed' ? 0 : 1;
}

function commandTools({ flags }) {
  const config = loadConfig(configOverridesFromFlags(flags));
  const runtime = createRuntime({ config, logger: makeLogger({ ...config, logLevel: 'silent' }) });

  for (const tool of runtime.registry.list()) {
    const kind = tool.sideEffects ? 'mutating' : 'read-only';
    const tags = tool.tags.filter((tag) => tag !== kind);
    process.stdout.write(`${tool.name}  [${kind}${tags.length > 0 ? `, ${tags.join(', ')}` : ''}]\n`);
    process.stdout.write(`  ${tool.description.split('\n')[0]}\n\n`);
  }
  process.stdout.write(`Registered tools: ${runtime.registry.size} (provider=${runtime.provider.name})\n`);
  return 0;
}

function commandAgents() {
  const definitions = listAgentDefinitions(resolve(PACKAGE_ROOT, 'agents'));
  if (definitions.length === 0) {
    process.stdout.write('No agent definitions found in ./agents\n');
    return 0;
  }
  for (const definition of definitions) {
    process.stdout.write(`${definition.name}  (${definition.tools ? definition.tools.length : 'all'} tools, maxSteps=${definition.maxSteps ?? 'default'})\n`);
    process.stdout.write(`  ${definition.description || '(no description)'}\n\n`);
  }
  return 0;
}

function commandConfig({ flags }) {
  const config = loadConfig(configOverridesFromFlags(flags));
  process.stdout.write(`${JSON.stringify(summarizeConfig(config), null, 2)}\n`);
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv;
  const parsed = parseArgs(rest);

  if (command === 'help' || parsed.flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.flags.version || command === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  try {
    switch (command) {
      case 'run':
        return await commandRun(parsed);
      case 'workflow':
        return await commandWorkflow(parsed);
      case 'tools':
        return commandTools(parsed);
      case 'agents':
        return commandAgents(parsed);
      case 'config':
        return commandConfig(parsed);
      default:
        process.stderr.write(`error: unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    const normalized = toError(error);
    process.stderr.write(`error[${normalized.code}]: ${normalized.message}\n`);
    if (process.env.AGENTIC_DEBUG) process.stderr.write(`${normalized.stack}\n`);
    return 1;
  }
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main, USAGE };


function makeLogger(config) {
  return createLogger({ name: 'agentic', level: config.logLevel, sink: process.stderr });
}

/** Stream lifecycle events to stderr so stdout stays machine readable. */
function attachTracer(runtime) {
  for (const event of Object.values(AgentEvents)) {
    runtime.events.on(event, (payload) => {
      process.stderr.write(`${JSON.stringify({ event, ...payload })}\n`);
    });
  }
}
