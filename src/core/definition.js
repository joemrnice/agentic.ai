import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ValidationError } from '../utils/errors.js';
import { applyDefaults, assertValid } from '../utils/schema.js';

export const DEFINITION_VERSION = 1;

/**
 * Symbol brand marking an already-normalized definition, so normalization is
 * idempotent (the runtime passes normalized definitions around freely).
 */
const NORMALIZED = Symbol.for('agentic.ai.normalizedDefinition');

const DEFINITION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    version: { type: 'integer', minimum: 1 },
    $schema: { type: 'string' },
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]*$', minLength: 1, maxLength: 64 },
    description: { type: 'string', maxLength: 500, default: '' },
    persona: { type: 'string', maxLength: 4000 },
    guidelines: { type: 'array', items: { type: 'string' }, default: [] },
    tools: { type: 'array', items: { type: 'string' } },
    model: { type: 'string' },
    temperature: { type: 'number', minimum: 0, maximum: 2 },
    maxSteps: { type: 'integer', minimum: 1, maximum: 100 },
    memory: {
      type: 'object',
      properties: { read: { type: 'boolean', default: true }, write: { type: 'boolean', default: false } },
      additionalProperties: false,
      default: { read: true, write: false },
    },
  },
  required: ['name'],
  additionalProperties: false,
});

/**
 * Normalize and validate a declarative agent definition.
 *
 * Keeping agents *data* (rather than subclasses) means an agent's identity --
 * persona, allowed tools, budgets, memory policy -- is reviewable in a diff and
 * versionable next to the prompts it uses.
 */
export function normalizeDefinition(raw = {}, { source = null } = {}) {
  if (raw !== null && typeof raw === 'object' && raw[NORMALIZED]) return raw;

  const definition = applyDefaults(raw, DEFINITION_SCHEMA);
  assertValid(definition, DEFINITION_SCHEMA, { label: source ? `agent definition (${source})` : 'agent definition' });

  return Object.freeze({
    version: definition.version ?? DEFINITION_VERSION,
    name: definition.name,
    description: definition.description ?? '',
    persona: definition.persona ?? null,
    guidelines: Object.freeze([...(definition.guidelines ?? [])]),
    tools: definition.tools ? Object.freeze([...definition.tools]) : null,
    model: definition.model ?? null,
    temperature: definition.temperature ?? null,
    maxSteps: definition.maxSteps ?? null,
    memory: Object.freeze({ read: definition.memory?.read ?? true, write: definition.memory?.write ?? false }),
    source,
    dir: source ? dirname(source) : null,
    [NORMALIZED]: true,
  });
}

/** Load one `*.agent.json` file from disk. */
export function loadAgentDefinition(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new ValidationError(`Agent definition not found: ${absolute}`);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new ValidationError(`Agent definition is not valid JSON (${absolute}): ${error.message}`);
  }

  return normalizeDefinition(parsed, { source: absolute });
}

/** List every `*.agent.json` in a directory, skipping files that fail to parse. */
export function listAgentDefinitions(directory = 'agents', { logger = null } = {}) {
  const absolute = resolve(directory);
  if (!existsSync(absolute)) return [];

  const definitions = [];
  for (const file of readdirSync(absolute).filter((name) => name.endsWith('.agent.json')).sort()) {
    const path = resolve(absolute, file);
    try {
      definitions.push(loadAgentDefinition(path));
    } catch (error) {
      logger?.warn('skipping invalid agent definition', { path, error: error.message });
    }
  }
  return definitions;
}
