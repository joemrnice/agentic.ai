import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { defineTool } from '../core/registry.js';
import { ToolExecutionError, ValidationError } from '../utils/errors.js';

const DEFAULT_IGNORES = Object.freeze(['node_modules', '.git', '.cache', 'dist', 'coverage']);

function toPosix(path) {
  return path.split(/[\\/]/).join('/');
}

/**
 * Resolve `target` inside the workspace sandbox.
 *
 * Every filesystem tool funnels through here, which is what makes the sandbox a
 * *property of the runtime* rather than a convention the model is politely
 * asked to respect. Traversal (`../`), absolute escapes (`/etc/passwd`) and
 * path juggling are rejected before any I/O happens.
 */
export function resolveWithinWorkspace(workspace, target = '.') {
  const root = resolve(workspace ?? process.cwd());
  const requested = String(target ?? '.').trim() === '' ? '.' : String(target).trim();
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const rel = relative(root, absolute);

  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new ToolExecutionError(`Path "${requested}" escapes the workspace sandbox (${root})`, {
      details: { requested, workspace: root },
    });
  }

  return { root, absolute, relativePath: rel === '' ? '.' : toPosix(rel) };
}

/**
 * Filesystem tools scoped to a single workspace directory.
 *
 * There is deliberately no delete/rename/chmod tool: destructive verbs are easy
 * to add later, but they should be an explicit, reviewable decision rather than
 * a scaffold default.
 */
export function createFilesystemTools({ workspace = process.cwd(), maxBytes = 200_000, maxEntries = 500, ignore = DEFAULT_IGNORES } = {}) {
  const ignored = new Set(ignore);

  const listTool = defineTool({
    name: 'fs.list',
    description:
      'List the immediate contents of a directory inside the workspace. Use it to discover what exists before reading or writing files. Hidden entries are skipped unless includeHidden is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root. Defaults to ".".', default: '.' },
        includeHidden: { type: 'boolean', description: 'Include dotfiles such as .gitignore or .env.example.', default: false },
      },
      additionalProperties: false,
    },
    tags: ['filesystem', 'read-only'],
    handler: async ({ path = '.', includeHidden = false }) => {
      const { absolute, relativePath } = resolveWithinWorkspace(workspace, path);

      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch (error) {
        throw new ToolExecutionError(`Cannot list "${relativePath}": ${error.code === 'ENOENT' ? 'directory not found' : error.message}`, {
          details: { path: relativePath, code: error.code },
        });
      }

      const visible = entries
        .filter((entry) => (includeHidden || !entry.name.startsWith('.')) && !ignored.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, maxEntries);

      const detailed = await Promise.all(
        visible.map(async (entry) => {
          const type = entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';
          if (type !== 'file') return { name: entry.name, type };
          try {
            const info = await stat(resolve(absolute, entry.name));
            return { name: entry.name, type, size: info.size };
          } catch {
            return { name: entry.name, type };
          }
        }),
      );

      return { path: relativePath, count: detailed.length, truncated: entries.length > detailed.length, entries: detailed };
    },
  });

  const readTool = defineTool({
    name: 'fs.read',
    description: `Read a UTF-8 text file inside the workspace (max ${maxBytes} bytes). Returns the content plus line/byte counts so you can decide whether to read a slice.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'File path relative to the workspace root.' },
        maxBytes: { type: 'integer', minimum: 1, maximum: maxBytes, description: `Byte budget for the returned content (default ${maxBytes}).` },
      },
      required: ['path'],
      additionalProperties: false,
    },
    tags: ['filesystem', 'read-only'],
    handler: async ({ path, maxBytes: requestedMax }) => {
      const { absolute, relativePath } = resolveWithinWorkspace(workspace, path);
      const limit = Math.min(Number(requestedMax ?? maxBytes), maxBytes);

      let buffer;
      try {
        buffer = await readFile(absolute);
      } catch (error) {
        throw new ToolExecutionError(`Cannot read "${relativePath}": ${error.code === 'ENOENT' ? 'file not found' : error.message}`, {
          details: { path: relativePath, code: error.code },
        });
      }

      if (buffer.includes(0)) {
        return { path: relativePath, binary: true, bytes: buffer.byteLength, message: 'Binary file detected; content omitted.' };
      }

      const text = buffer.subarray(0, limit).toString('utf8');
      return {
        path: relativePath,
        bytes: buffer.byteLength,
        lines: text.split('\n').length,
        truncated: buffer.byteLength > limit,
        content: text,
      };
    },
  });

  const writeTool = defineTool({
    name: 'fs.write',
    description:
      'Write UTF-8 text to a file inside the workspace, creating parent directories as needed and replacing existing content. Report back exactly what you wrote.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Target file path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    tags: ['filesystem', 'mutating'],
    sideEffects: true,
    handler: async ({ path, content }) => {
      if (typeof content !== 'string') throw new ValidationError('content must be a string');
      const { absolute, relativePath } = resolveWithinWorkspace(workspace, path);
      const parent = resolve(absolute, '..');
      await mkdir(parent, { recursive: true }).catch(() => {});
      await writeFile(absolute, content, 'utf8');
      return { path: relativePath, bytes: Buffer.byteLength(content, 'utf8'), lines: content.split('\n').length, written: true };
    },
  });

  return [listTool, readTool, writeTool];
}
