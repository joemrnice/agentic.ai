import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal `.env` parser (no dependencies).
 *
 * Supports `KEY=value`, `export KEY=value`, `#` comments, quoted values and
 * escaped newlines inside double quotes. It intentionally does not attempt to
 * emulate shell expansion.
 */
export function parseDotEnv(source = '') {
  const result = {};
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;

    if (isDoubleQuoted) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"');
    } else if (isSingleQuoted) {
      value = value.slice(1, -1);
    } else {
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
    }

    result[key] = value;
  }
  return result;
}

/**
 * Load a `.env` file into `env` (defaults to `process.env`).
 * Existing variables win unless `override` is true, matching dotenv semantics.
 *
 * @returns {Record<string, string>} the variables that were applied
 */
export function loadDotEnv({
  path = resolve(process.cwd(), '.env'),
  env = process.env,
  override = false,
  readFileImpl = readFileSync,
} = {}) {
  if (!existsSync(path)) return {};

  let parsed;
  try {
    parsed = parseDotEnv(readFileImpl(path, 'utf8'));
  } catch {
    return {};
  }

  const applied = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && env[key] !== undefined) continue;
    env[key] = value;
    applied[key] = value;
  }
  return applied;
}
