import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFilesystemTools, resolveWithinWorkspace } from '../src/tools/filesystem.js';
import { ToolExecutionError } from '../src/utils/errors.js';

function makeWorkspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-fs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# hello\nsecond line\n');
  writeFileSync(join(dir, '.env.example'), 'AGENTIC_PROVIDER=mock\n');
  writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 1;\n');
  return dir;
}

test('resolveWithinWorkspace keeps every path inside the sandbox', () => {
  const workspace = '/tmp/agentic-root';
  assert.equal(resolveWithinWorkspace(workspace, '.').relativePath, '.');
  assert.equal(resolveWithinWorkspace(workspace, 'src/app.js').relativePath, 'src/app.js');
  assert.equal(resolveWithinWorkspace(workspace, './src/../src/app.js').relativePath, 'src/app.js');
  assert.throws(() => resolveWithinWorkspace(workspace, '../escape.txt'), ToolExecutionError);
  assert.throws(() => resolveWithinWorkspace(workspace, '/etc/passwd'), /escapes the workspace sandbox/);
});

test('fs.list discovers files and hides dotfiles by default', async (t) => {
  const workspace = makeWorkspace(t);
  const [listTool] = createFilesystemTools({ workspace });
  assert.equal(listTool.sideEffects, false);

  const hidden = await listTool.handler({ path: '.' }, {});
  const names = hidden.entries.map((entry) => entry.name);
  assert.deepEqual(names, ['README.md', 'src']);
  assert.equal(hidden.entries.find((entry) => entry.name === 'src').type, 'dir');
  assert.ok(hidden.entries.find((entry) => entry.name === 'README.md').size > 0);

  const shown = await listTool.handler({ path: '.', includeHidden: true }, {});
  assert.ok(shown.entries.some((entry) => entry.name === '.env.example'));
});

test('fs.list reports missing directories as tool errors', async (t) => {
  const workspace = makeWorkspace(t);
  const [listTool] = createFilesystemTools({ workspace });
  await assert.rejects(() => listTool.handler({ path: 'nope' }, {}), /directory not found/);
  await assert.rejects(() => listTool.handler({ path: '..' }, {}), /escapes the workspace sandbox/);
});

test('fs.read returns text, counts and truncation flags', async (t) => {
  const workspace = makeWorkspace(t);
  const [, readTool] = createFilesystemTools({ workspace });

  const file = await readTool.handler({ path: 'README.md' }, {});
  assert.equal(file.content, '# hello\nsecond line\n');
  assert.equal(file.lines, 3);
  assert.equal(file.truncated, false);

  const limited = await readTool.handler({ path: 'README.md', maxBytes: 8 }, {});
  assert.equal(limited.content, '# hello\n');
  assert.equal(limited.truncated, true);

  writeFileSync(join(workspace, 'blob.bin'), Buffer.from([1, 0, 2, 3]));
  const binary = await readTool.handler({ path: 'blob.bin' }, {});
  assert.equal(binary.binary, true);
  assert.equal(binary.content, undefined);

  await assert.rejects(() => readTool.handler({ path: 'missing.txt' }, {}), /file not found/);
});

test('fs.write creates parent directories and reports what it wrote', async (t) => {
  const workspace = makeWorkspace(t);
  const [, , writeTool] = createFilesystemTools({ workspace });
  assert.equal(writeTool.sideEffects, true);

  const result = await writeTool.handler({ path: 'notes/deep/todo.md', content: 'line one\nline two\n' }, {});
  assert.equal(result.written, true);
  assert.equal(result.bytes, 18);
  assert.equal(result.lines, 3);

  const [, readTool] = createFilesystemTools({ workspace });
  const readBack = await readTool.handler({ path: 'notes/deep/todo.md' }, {});
  assert.equal(readBack.content, 'line one\nline two\n');

  await assert.rejects(() => writeTool.handler({ path: '../outside.txt', content: 'nope' }, {}), /escapes the workspace sandbox/);
});
