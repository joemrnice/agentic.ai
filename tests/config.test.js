import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, loadConfig, summarizeConfig } from '../src/config/index.js';
import { parseDotEnv } from '../src/config/env.js';
import { createProvider } from '../src/llm/index.js';
import { ConfigError } from '../src/utils/errors.js';

const BASE = { env: {}, useDotEnv: false, cwd: '/tmp/agentic-config' };

test('loadConfig falls back to safe local defaults', () => {
  const config = loadConfig({}, BASE);
  assert.equal(config.provider, 'mock');
  assert.equal(config.model, DEFAULTS.model);
  assert.equal(config.maxSteps, DEFAULTS.maxSteps);
  assert.equal(config.allowShell, false);
  assert.equal(config.allowNetwork, false);
  assert.equal(config.workspace, '/tmp/agentic-config');
  assert.equal(config.memoryPath, '/tmp/agentic-config/memory/memory.json');
  assert.ok(Object.isFrozen(config));
});

test('environment variables are parsed and validated', () => {
  const config = loadConfig({}, {
    ...BASE,
    env: {
      AGENTIC_PROVIDER: 'ollama',
      AGENTIC_MODEL: 'llama3.2',
      AGENTIC_MAX_STEPS: '3',
      AGENTIC_TEMPERATURE: '0.7',
      AGENTIC_ALLOW_NETWORK: 'yes',
      AGENTIC_ALLOW_SHELL: '1',
      AGENTIC_ALLOWED_HOSTS: 'api.github.com, example.com',
      AGENTIC_LOG_LEVEL: 'debug',
      AGENTIC_MEMORY_PERSIST: 'false',
      AGENTIC_WORKSPACE: 'sub/dir',
    },
  });

  assert.equal(config.provider, 'ollama');
  assert.equal(config.model, 'llama3.2');
  assert.equal(config.maxSteps, 3);
  assert.equal(config.temperature, 0.7);
  assert.equal(config.allowNetwork, true);
  assert.equal(config.allowShell, true);
  assert.deepEqual(config.allowedHosts, ['api.github.com', 'example.com']);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.memoryPersist, false);
  assert.equal(config.workspace, '/tmp/agentic-config/sub/dir');
});

test('invalid configuration is rejected with a helpful error', () => {
  const load = (env) => () => loadConfig({}, { ...BASE, env });

  assert.throws(load({ AGENTIC_MAX_STEPS: 'many' }), ConfigError);
  assert.throws(load({ AGENTIC_MAX_STEPS: '0' }), /must be >= 1/);
  assert.throws(load({ AGENTIC_ALLOW_SHELL: 'maybe' }), /must be a boolean/);
  assert.throws(load({ AGENTIC_PROVIDER: 'gpt' }), /must be one of: mock, openai/);
  assert.throws(load({ AGENTIC_LOG_LEVEL: 'loud' }), /LOG_LEVEL must be one of/);
  assert.throws(load({ AGENTIC_PROVIDER: 'openai' }), /AGENTIC_API_KEY is required/);

  // openai-compatible needs an explicit base URL, enforced when the provider is built.
  const compatible = loadConfig({ provider: 'openai-compatible' }, BASE);
  assert.equal(compatible.baseUrl, null);
  assert.throws(() => createProvider(compatible), /AGENTIC_BASE_URL is required/);
});

test('explicit overrides beat the environment', () => {
  const config = loadConfig({ provider: 'ollama', maxSteps: 5, logLevel: 'silent' }, { ...BASE, env: { AGENTIC_MAX_STEPS: '99', AGENTIC_LOG_LEVEL: 'error' } });
  assert.equal(config.provider, 'ollama');
  assert.equal(config.maxSteps, 5);
  assert.equal(config.logLevel, 'silent');
});

test('summarizeConfig never leaks the API key', () => {
  const config = loadConfig({ provider: 'openai', apiKey: 'sk-secret-value' }, BASE);
  const summary = summarizeConfig(config);
  assert.equal(summary.apiKey, '[set]');
  assert.ok(!JSON.stringify(summary).includes('sk-secret-value'));
});

test('parseDotEnv understands comments, quotes and the export prefix', () => {
  const parsed = parseDotEnv(['# comment', 'AGENTIC_PROVIDER=mock', 'export AGENTIC_MODEL="gpt-4o-mini"', "AGENTIC_MEMORY_DIR='mem dir'", 'AGENTIC_MAX_STEPS=4 # inline'].join('\n'));

  assert.deepEqual(parsed, {
    AGENTIC_PROVIDER: 'mock',
    AGENTIC_MODEL: 'gpt-4o-mini',
    AGENTIC_MEMORY_DIR: 'mem dir',
    AGENTIC_MAX_STEPS: '4',
  });
  assert.deepEqual(parseDotEnv('not a dotenv line'), {});
  assert.deepEqual(parseDotEnv(''), {});
});
