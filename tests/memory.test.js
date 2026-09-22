import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryStore } from '../src/core/memory.js';
import { createMemoryTools } from '../src/tools/memory.js';

test('memory stores, ranks and recalls entries', () => {
  const memory = new MemoryStore({ limit: 100 });
  memory.add({ content: 'The deployment target is Kubernetes on GKE.', kind: 'fact', tags: ['infra'] });
  memory.add({ content: 'User prefers TypeScript over JavaScript.', kind: 'preference', tags: ['style'] });
  memory.add({ content: 'Decided to use PostgreSQL as the database for the ledger.', kind: 'decision', tags: ['db'] });

  assert.equal(memory.size, 3);

  const matches = memory.search('which database did we choose');
  assert.ok(matches.length >= 1);
  assert.match(matches[0].content, /PostgreSQL/);
  assert.ok(matches[0].score > 0);

  const filtered = memory.search('prefers', { kind: 'preference' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].kind, 'preference');

  assert.equal(memory.recent(1)[0].kind, 'decision', 'recent is newest first');
  assert.match(memory.toPrompt({ limit: 3 }), /- \(decision\)/);
});

test('memory enforces its retention limit', () => {
  const memory = new MemoryStore({ limit: 2 });
  memory.add({ content: 'first' });
  memory.add({ content: 'second' });
  memory.add({ content: 'third' });
  assert.equal(memory.size, 2);
  assert.deepEqual(
    memory.all().map((entry) => entry.content),
    ['second', 'third'],
  );
});

test('memory can forget and clear entries', () => {
  const memory = new MemoryStore();
  const entry = memory.add({ content: 'temporary' });
  assert.equal(memory.get(entry.id).content, 'temporary');
  assert.equal(memory.forget(entry.id), true);
  assert.equal(memory.forget(entry.id), false);
  memory.add({ content: 'another' });
  memory.clear();
  assert.equal(memory.size, 0);
});

test('memory rejects empty content', () => {
  const memory = new MemoryStore();
  assert.throws(() => memory.add({ content: '   ' }), /non-empty string content/);
});

test('memory persists to disk and reloads (survives a new process)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-memory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'memory.json');

  const first = new MemoryStore({ path });
  first.add({ content: 'Persisted fact about the project.', tags: ['project'] });
  assert.equal(first.size, 1);

  const second = new MemoryStore({ path });
  assert.equal(second.size, 1);
  assert.equal(second.all()[0].content, 'Persisted fact about the project.');
  assert.deepEqual(second.all()[0].tags, ['project']);
});

test('memory tools expose write, search and recent through the registry contract', async () => {
  const memory = new MemoryStore();
  const tools = createMemoryTools({ memory });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['memory.write', 'memory.search', 'memory.recent'],
  );

  const [writeTool, searchTool, recentTool] = tools;
  assert.equal(writeTool.sideEffects, true, 'writing memory is a side effect');

  const events = [];
  const written = await writeTool.handler({ content: 'Agent prefers short answers.', kind: 'preference' }, { runId: 'r1', emit: (event, payload) => events.push({ event, payload }) });
  assert.equal(written.stored, true);
  assert.equal(events[0].event, 'memory:write');

  const found = await searchTool.handler({ query: 'short answers', limit: 3 }, {});
  assert.equal(found.count, 1);
  assert.match(found.matches[0].content, /short answers/);

  const recent = await recentTool.handler({ limit: 5 }, {});
  assert.equal(recent.size, 1);
});

test('memory tools require a store', () => {
  assert.throws(() => createMemoryTools({}), /MemoryStore instance/);
});
