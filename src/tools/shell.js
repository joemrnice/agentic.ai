import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineTool } from '../core/registry.js';
import { ToolExecutionError, ToolTimeoutError, ValidationError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

/** Characters that would let a "command" turn into an arbitrary shell program. */
const FORBIDDEN_CHARACTERS = /[|&;><`$(){}[\]\\!*?~#\n\r]/;

/**
 * Split a command string into an argv array **without** invoking a shell.
 *
 * This is the single most important safety property of the shell tool: the
 * runtime never hands the model's text to `sh -c`, so pipes, redirects, command
 * substitution and chaining cannot appear at all. Combined with an executables
 * allowlist, the blast radius stays small and auditable.
 */
export function parseCommand(command) {
  const text = String(command ?? '').trim();
  if (text === '') throw new ValidationError('command must not be empty');
  if (text.length > 500) throw new ValidationError('command is too long (max 500 characters)');

  const tokens = [];
  let current = '';
  let quote = null;

  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (FORBIDDEN_CHARACTERS.test(char)) {
      throw new ValidationError(`Shell metacharacter "${char}" is not allowed; run a single command with arguments instead`);
    }
    current += char;
  }

  if (quote) throw new ValidationError('Unterminated quote in command');
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * Shell execution, disabled by default and allowlisted when enabled.
 *
 * Enabled with `AGENTIC_ALLOW_SHELL=true`; `AGENTIC_SHELL_ALLOWLIST` limits which
 * executables may run. Commands execute with the workspace as cwd, a wall-clock
 * deadline and a bounded output buffer.
 */
export function createShellTools({
  enabled = false,
  allowlist = ['ls', 'cat', 'pwd', 'node', 'npm', 'git', 'rg', 'grep', 'find', 'wc', 'head', 'tail', 'echo'],
  cwd = process.cwd(),
  timeoutMs = 15_000,
  maxOutputBytes = 20_000,
} = {}) {
  const allowed = new Set(allowlist);

  const execTool = defineTool({
    name: 'shell.exec',
    description:
      'Run a single allow-listed executable with arguments inside the workspace and return its exit code, stdout and stderr. Shell features (pipes, redirects, &&, variables) are unavailable by design; issue separate calls instead.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 500, description: 'Executable name plus arguments, e.g. "node --version" or "ls -la src".' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    tags: ['shell', 'mutating'],
    sideEffects: true,
    timeoutMs,
    handler: async ({ command }, toolContext) => {
      if (!enabled) {
        throw new ToolExecutionError('Shell tool is disabled. Set AGENTIC_ALLOW_SHELL=true to enable it.');
      }

      const argv = parseCommand(command);
      const executable = argv[0];
      if (!allowed.has(executable)) {
        throw new ToolExecutionError(`Executable "${executable}" is not in the allowlist`, {
          details: { executable, allowlist: [...allowed] },
        });
      }

      try {
        const { stdout, stderr } = await execFileAsync(executable, argv.slice(1), {
          cwd,
          timeout: timeoutMs,
          maxBuffer: maxOutputBytes,
          signal: toolContext?.signal,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, CI: '1' },
        });
        return { command, exitCode: 0, stdout: stdout.slice(0, maxOutputBytes), stderr: stderr.slice(0, maxOutputBytes) };
      } catch (error) {
        if (error?.killed || error?.signal === 'SIGTERM' || error?.code === 'ABORT_ERR') {
          throw new ToolTimeoutError(`Command "${command}" exceeded its ${timeoutMs}ms deadline`, { details: { command, timeoutMs } });
        }
        if (typeof error?.code === 'number') {
          return {
            command,
            exitCode: error.code,
            stdout: String(error.stdout ?? '').slice(0, maxOutputBytes),
            stderr: String(error.stderr ?? '').slice(0, maxOutputBytes),
          };
        }
        throw new ToolExecutionError(`Failed to run "${command}": ${error?.message}`, { cause: error, details: { command } });
      }
    },
  });

  return [execTool];
}
