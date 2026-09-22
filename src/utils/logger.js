import { ConfigError } from './errors.js';

/** Ordered log levels; higher number = more verbose. */
export const LOG_LEVELS = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
});

export const LOG_LEVEL_NAMES = Object.freeze(Object.keys(LOG_LEVELS));

export function isLogLevel(value) {
  return Object.hasOwn(LOG_LEVELS, String(value));
}

function normalizeLevel(level) {
  if (!isLogLevel(level)) {
    throw new ConfigError(`Unknown log level "${level}". Expected one of: ${LOG_LEVEL_NAMES.join(', ')}`);
  }
  return String(level);
}

function safeStringify(record) {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ level: record.level, name: record.name, msg: 'unserializable log record' });
  }
}

/**
 * Create a structured (newline delimited JSON) logger.
 *
 * The runtime logs machine readable records so that agent traces can be
 * replayed or shipped to any collector. Pass a custom `sink` (any object with
 * `write(string)`) in tests to capture records.
 */
export function createLogger({
  name = 'agentic',
  level = 'info',
  sink = process.stdout,
  base = {},
  now = () => new Date(),
} = {}) {
  let currentLevel = normalizeLevel(level);

  const write = (levelName, message, fields) => {
    if (LOG_LEVELS[levelName] > LOG_LEVELS[currentLevel]) return;
    const isObjectMessage = typeof message === 'object' && message !== null;
    const record = {
      ts: now().toISOString(),
      level: levelName,
      name,
      ...(isObjectMessage ? message : { msg: String(message ?? '') }),
      ...base,
      ...(fields && typeof fields === 'object' ? fields : {}),
    };
    try {
      sink.write(`${safeStringify(record)}\n`);
    } catch {
      // A broken sink (closed pipe, EPIPE on a TTY) must never crash a run.
    }
  };

  return {
    get name() {
      return name;
    },
    get level() {
      return currentLevel;
    },
    levels: LOG_LEVEL_NAMES,
    setLevel(next) {
      currentLevel = normalizeLevel(next);
    },
    child(childName, extra = {}) {
      return createLogger({
        name: `${name}:${childName}`,
        level: currentLevel,
        sink,
        base: { ...base, ...extra },
        now,
      });
    },
    error: (message, fields) => write('error', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    info: (message, fields) => write('info', message, fields),
    debug: (message, fields) => write('debug', message, fields),
    trace: (message, fields) => write('trace', message, fields),
  };
}

/** A logger that discards everything (handy in tests and library embedding). */
export function createNoopLogger() {
  return createLogger({ level: 'silent', sink: { write() {} } });
}
