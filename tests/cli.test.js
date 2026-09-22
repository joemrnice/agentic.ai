import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { parseArgs, resolveAgentPath, USAGE } from '../src/cli.js';

test('parseArgs handles positional text, valued flags and booleans', () => {
  const { flags, positional } = parseArgs(['list', 'the', 'files', '--agent', 'researcher', '--max-steps=3', '--json', '--trace']);

  assert.deepEqual(positional, ['list', 'the', 'files']);
  assert.equal(flags.agent, 'researcher');
  assert.equal(flags['max-steps'], '3');
  assert.equal(flags.json, true);
  assert.equal(flags.trace, true);
});

test('boolean flags never swallow the following task text', () => {
  const { flags, positional } = parseArgs(['--trace', 'summarise', 'the', 'docs', '--remember']);
  assert.equal(flags.trace, true);
  assert.equal(flags.remember, true);
  assert.deepEqual(positional, ['summarise', 'the', 'docs']);
});

test('parseArgs keeps quoted task text intact as one positional group', () => {
  const { flags, positional } = parseArgs(['--task', 'compute 21 * 2', '--provider=ollama']);
  assert.equal(flags.task, 'compute 21 * 2');
  assert.equal(flags.provider, 'ollama');
  assert.deepEqual(positional, []);
});

test('resolveAgentPath accepts a name, a path, an extension-less path or nothing', () => {
  const byName = resolveAgentPath('researcher');
  assert.ok(existsSync(byName));
  assert.match(byName, /researcher\.agent\.json$/);

  const byPackagePath = resolveAgentPath('agents/assistant.agent.json');
  assert.ok(existsSync(byPackagePath));
  assert.match(byPackagePath, /assistant\.agent\.json$/);

  const fallback = resolveAgentPath();
  assert.match(fallback, /assistant\.agent\.json$/);

  const unknown = resolveAgentPath('nope-not-here');
  assert.match(unknown, /nope-not-here$/);
});

test('the usage text documents every command', () => {
  for (const command of ['run', 'workflow', 'tools', 'agents', 'config', 'help']) {
    assert.match(USAGE, new RegExp(`agentic ${command}`));
  }
  assert.match(USAGE, /--agent/);
  assert.match(USAGE, /--provider/);
});
