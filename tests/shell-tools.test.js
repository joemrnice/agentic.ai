import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createShellTools, parseCommand } from '../src/tools/shell.js';
import { ValidationError } from '../src/utils/errors.js';

test('parseCommand splits argv without ever invoking a shell', () => {
  assert.deepEqual(parseCommand('ls -la src'), ['ls', '-la', 'src']);
  assert.deepEqual(parseCommand('cat "my file.txt"'), ['cat', 'my file.txt']);
  assert.deepEqual(parseCommand("git log --oneline   -5"), ['git', 'log', '--oneline', '-5']);
  assert.deepEqual(parseCommand('node ./scripts/build.mjs'), ['node', './scripts/build.mjs']);
});

test('parseCommand refuses shell metacharacters and malformed input', () => {
  for (const command of ['ls; rm -rf /', 'ls | wc -l', 'echo $(whoami)', 'cat > /etc/passwd', 'echo `id`', 'ls && rm -rf .', 'echo *', 'ls ~/secret']) {
    assert.throws(() => parseCommand(command), ValidationError, `should reject: ${command}`);
  }
  assert.throws(() => parseCommand('cat "unterminated'), /Unterminated quote/);
  assert.throws(() => parseCommand('   '), /must not be empty/);
  assert.throws(() => parseCommand(`node ${'x'.repeat(600)}`), /too long/);
});

test('the shell tool is disabled unless explicitly enabled', async () => {
  const [tool] = createShellTools({ enabled: false });
  assert.equal(tool.sideEffects, true);
  await assert.rejects(() => tool.handler({ command: 'echo hi' }, {}), /Shell tool is disabled/);
});

test('an allowlist gates which executables may run', async () => {
  const [tool] = createShellTools({ enabled: true, allowlist: ['echo'], cwd: tmpdir() });
  await assert.rejects(() => tool.handler({ command: 'node --version' }, {}), /not in the allowlist/);
});

test('allow-listed commands run in the workspace and report their output', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'agentic-shell-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const [tool] = createShellTools({ enabled: true, allowlist: ['echo'], cwd });
  const ok = await tool.handler({ command: 'echo hello agent' }, {});
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), 'hello agent');

  const [lsTool] = createShellTools({ enabled: true, allowlist: ['ls'], cwd });
  const failed = await lsTool.handler({ command: 'ls /definitely/missing/path' }, {});
  assert.notEqual(failed.exitCode, 0, 'non-zero exits are returned, not thrown');
  assert.ok(failed.stderr.length > 0);
});

test('a command that outlives its deadline is killed', async () => {
  const [tool] = createShellTools({ enabled: true, allowlist: ['sleep'], timeoutMs: 100, cwd: tmpdir() });
  const startedAt = Date.now();
  await assert.rejects(() => tool.handler({ command: 'sleep 5' }, {}), /exceeded its 100ms deadline/);
  assert.ok(Date.now() - startedAt < 2000);
});
