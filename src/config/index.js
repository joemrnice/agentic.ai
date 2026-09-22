import { resolve } from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { isLogLevel } from '../utils/logger.js';
import { loadDotEnv } from './env.js';

/** Environment variable prefix understood by the runtime. */
export const ENV_PREFIX = 'AGENTIC_';

export const PROVIDERS = Object.freeze(['mock', 'openai', 'openai-compatible', 'ollama']);

export const DEFAULTS = Object.freeze({
  provider: 'mock',
  model: 'mock-1',
  baseUrl: null,
  apiKey: null,
  temperature: 0.2,
  maxSteps: 8,
  toolTimeoutMs: 15_000,
  toolMaxOutputChars: 4_000,
  maxToolRetries: 1,
  logLevel: 'info',
  memoryDir: 'memory',
  memoryLimit: 500,
  memoryPersist: true,
  allowShell: false,
  allowNetwork: false,
  allowedHosts: Object.freeze([]),
  shellAllowlist: Object.freeze(['ls', 'cat', 'pwd', 'node', 'npm', 'git', 'rg', 'grep', 'find', 'wc', 'head', 'tail', 'echo']),
  shellTimeoutMs: 15_000,
});

function toBoolean(raw, name, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), received "${raw}"`, { details: { variable: name } });
}

function toNumber(raw, name, fallback, { min, max, integer = false } = {}) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${name} must be a number, received "${raw}"`, { details: { variable: name } });
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer, received "${raw}"`, { details: { variable: name } });
  }
  if (min !== undefined && value < min) {
    throw new ConfigError(`${name} must be >= ${min}, received "${raw}"`, { details: { variable: name } });
  }
  if (max !== undefined && value > max) {
    throw new ConfigError(`${name} must be <= ${max}, received "${raw}"`, { details: { variable: name } });
  }
  return value;
}

function toStringList(raw, fallback) {
  if (raw === undefined || raw === '') return [...fallback];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toEnum(raw, name, fallback, allowed) {
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw new ConfigError(`${name} must be one of: ${allowed.join(', ')} (received "${raw}")`, { details: { variable: name } });
  }
  return value;
}

/** Resolve a value from overrides first, then the `AGENTIC_*` environment. */
function pick(env, overrides, key) {
  const overrideValue = overrides[key];
  if (overrideValue !== undefined && overrideValue !== null) return overrideValue;
  return env[`${ENV_PREFIX}${key.replace(/[A-Z]/g, (char) => `_${char}`).toUpperCase()}`];
}

/**
 * Resolve the effective runtime configuration.
 *
 * Precedence: explicit `overrides` > `AGENTIC_*` environment > `.env` file > defaults.
 *
 * @param {Record<string, unknown>} [overrides]
 * @param {{ env?: Record<string, string|undefined>, cwd?: string, useDotEnv?: boolean }} [options]
 */
export function loadConfig(overrides = {}, { env = process.env, cwd = process.cwd(), useDotEnv = true } = {}) {
  if (useDotEnv) loadDotEnv({ path: resolve(cwd, '.env'), env });

  const provider = toEnum(pick(env, overrides, 'provider'), `${ENV_PREFIX}PROVIDER`, DEFAULTS.provider, PROVIDERS);

  const rawLogLevel = pick(env, overrides, 'logLevel');
  const logLevel = rawLogLevel === undefined || rawLogLevel === '' ? DEFAULTS.logLevel : String(rawLogLevel).toLowerCase();
  if (!isLogLevel(logLevel)) {
    throw new ConfigError(`${ENV_PREFIX}LOG_LEVEL must be one of: silent, error, warn, info, debug, trace (received "${rawLogLevel}")`);
  }

  const workspace = resolve(cwd, String(pick(env, overrides, 'workspace') ?? cwd));
  const memoryDir = String(pick(env, overrides, 'memoryDir') ?? DEFAULTS.memoryDir);
  const apiKey = pick(env, overrides, 'apiKey') ?? DEFAULTS.apiKey;

  if (provider === 'openai' && !apiKey) {
    throw new ConfigError('AGENTIC_API_KEY is required when AGENTIC_PROVIDER=openai');
  }

  const config = {
    provider,
    model: String(pick(env, overrides, 'model') ?? DEFAULTS.model),
    baseUrl: pick(env, overrides, 'baseUrl') ?? DEFAULTS.baseUrl,
    apiKey,
    temperature: toNumber(pick(env, overrides, 'temperature'), `${ENV_PREFIX}TEMPERATURE`, DEFAULTS.temperature, { min: 0, max: 2 }),
    maxSteps: toNumber(pick(env, overrides, 'maxSteps'), `${ENV_PREFIX}MAX_STEPS`, DEFAULTS.maxSteps, { min: 1, max: 200, integer: true }),
    toolTimeoutMs: toNumber(pick(env, overrides, 'toolTimeoutMs'), `${ENV_PREFIX}TOOL_TIMEOUT_MS`, DEFAULTS.toolTimeoutMs, {
      min: 1,
      max: 600_000,
      integer: true,
    }),
    toolMaxOutputChars: toNumber(
      pick(env, overrides, 'toolMaxOutputChars'),
      `${ENV_PREFIX}TOOL_MAX_OUTPUT_CHARS`,
      DEFAULTS.toolMaxOutputChars,
      { min: 200, max: 200_000, integer: true },
    ),
    maxToolRetries: toNumber(pick(env, overrides, 'maxToolRetries'), `${ENV_PREFIX}MAX_TOOL_RETRIES`, DEFAULTS.maxToolRetries, {
      min: 0,
      max: 5,
      integer: true,
    }),
    logLevel,
    cwd,
    workspace,
    memoryDir,
    memoryLimit: toNumber(pick(env, overrides, 'memoryLimit'), `${ENV_PREFIX}MEMORY_LIMIT`, DEFAULTS.memoryLimit, { min: 1, max: 100_000, integer: true }),
    memoryPersist: toBoolean(pick(env, overrides, 'memoryPersist'), `${ENV_PREFIX}MEMORY_PERSIST`, DEFAULTS.memoryPersist),
    allowShell: toBoolean(pick(env, overrides, 'allowShell'), `${ENV_PREFIX}ALLOW_SHELL`, DEFAULTS.allowShell),
    allowNetwork: toBoolean(pick(env, overrides, 'allowNetwork'), `${ENV_PREFIX}ALLOW_NETWORK`, DEFAULTS.allowNetwork),
    allowedHosts: toStringList(pick(env, overrides, 'allowedHosts'), DEFAULTS.allowedHosts),
    shellAllowlist: toStringList(pick(env, overrides, 'shellAllowlist'), DEFAULTS.shellAllowlist),
    shellTimeoutMs: toNumber(pick(env, overrides, 'shellTimeoutMs'), `${ENV_PREFIX}SHELL_TIMEOUT_MS`, DEFAULTS.shellTimeoutMs, {
      min: 1,
      max: 600_000,
      integer: true,
    }),
  };

  return Object.freeze({ ...config, memoryPath: resolve(workspace, memoryDir, 'memory.json') });
}

/** Configuration snapshot that is safe to log or print: never leaks the API key. */
export function summarizeConfig(config) {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKey: apiKey ? '[set]' : null };
}
