import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { listAgentDefinitions, loadAgentDefinition, normalizeDefinition } from '../src/core/definition.js';
import { ValidationError } from '../src/utils/errors.js';

const VALID = {
  version: 1,
  name: 'helper',
  description: 'Helps.',
  persona: 'Be brief.',
  guidelines: ['Cite sources.'],
  tools: ['fs.list'],
  maxSteps: 4,
  memory: { read: true, write: true },
};

test('normalizeDefinition applies defaults and freezes the result', () => {
  const definition = normalizeDefinition({ name: 'helper' });
  assert.equal(definition.version, 1);
  assert.equal(definition.description, '');
  assert.deepEqual(definition.guidelines, []);
  assert.equal(definition.tools, null, 'null means "every registered tool"');
  assert.equal(definition.temperature, null);
  assert.deepEqual(definition.memory, { read: true, write: false });
  assert.ok(Object.isFrozen(definition));
});

test('normalizeDefinition is idempotent', () => {
  const once = normalizeDefinition(VALID);
  const twice = normalizeDefinition(once);
  assert.equal(twice, once, 'an already normalized definition is returned as-is');
});

test('normalizeDefinition rejects malformed definitions', () => {
  assert.throws(() => normalizeDefinition({}), /Invalid agent definition/);
  assert.throws(() => normalizeDefinition({ name: 'Bad Name' }), /\.name/);
  assert.throws(() => normalizeDefinition({ name: 'ok', temperature: 9 }), /temperature must be <= 2/);
  assert.throws(() => normalizeDefinition({ name: 'ok', typo: true }), /not an allowed property/);
  assert.throws(() => normalizeDefinition({ name: 'ok', tools: 'fs.list' }), /tools expected array/);
});

test('loadAgentDefinition reads the shipped agent definitions', () => {
  const assistant = loadAgentDefinition(fileURLToPath(new URL('../agents/assistant.agent.json', import.meta.url)));
  assert.equal(assistant.name, 'assistant');
  assert.ok(assistant.tools.includes('calculator.eval'));
  assert.ok(assistant.guidelines.length > 0);
  assert.match(assistant.source, /assistant\.agent\.json$/);
  assert.match(assistant.dir, /agents$/);

  const researcher = loadAgentDefinition(fileURLToPath(new URL('../agents/researcher.agent.json', import.meta.url)));
  assert.equal(researcher.name, 'researcher');
  assert.equal(researcher.memory.write, true);

  assert.throws(() => loadAgentDefinition('agents/does-not-exist.agent.json'), ValidationError);
});

test('listAgentDefinitions skips broken files instead of failing the whole listing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-defs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'good.agent.json'), JSON.stringify(VALID));
  writeFileSync(join(dir, 'broken.agent.json'), '{ not json');
  writeFileSync(join(dir, 'ignored.json'), JSON.stringify({ name: 'ignored' }));

  const definitions = listAgentDefinitions(dir);
  assert.equal(definitions.length, 1, 'only *.agent.json files are considered');
  assert.equal(definitions[0].name, 'helper');

  assert.deepEqual(listAgentDefinitions(join(dir, 'missing')), []);
});
