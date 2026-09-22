import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createNoopLogger } from '../utils/logger.js';

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were', 'what', 'when', 'how', 'why', 'does', 'did', 'you', 'your']);

function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

/**
 * Long-term memory: an append-only, searchable store of facts, notes and run
 * summaries that survive across runs (and processes, when persisted to disk).
 *
 * Retrieval is intentionally simple and deterministic (keyword overlap) so the
 * scaffold has no embedding dependency. Swap `search()` for a vector store when
 * semantic recall is required -- the interface stays the same.
 */
export class MemoryStore {
  #entries = [];
  #path;
  #limit;
  #autoSave;
  #logger;

  constructor({ path = null, limit = 500, autoSave = true, logger = createNoopLogger() } = {}) {
    this.#path = path;
    this.#limit = limit;
    this.#autoSave = autoSave && Boolean(path);
    this.#logger = logger;
    if (path) this.load();
  }

  static fromConfig(config, { logger } = {}) {
    return new MemoryStore({
      path: config.memoryPersist ? config.memoryPath : null,
      limit: config.memoryLimit,
      logger,
    });
  }

  get size() {
    return this.#entries.length;
  }

  get path() {
    return this.#path;
  }

  add({ content, kind = 'note', tags = [], metadata = {}, id = randomUUID(), ts = new Date().toISOString() } = {}) {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new TypeError('Memory entry requires non-empty string content');
    }
    const entry = Object.freeze({
      id,
      ts,
      kind,
      content: content.trim(),
      tags: Object.freeze([...tags]),
      metadata: Object.freeze({ ...metadata }),
    });
    this.#entries.push(entry);
    if (this.#entries.length > this.#limit) this.#entries.splice(0, this.#entries.length - this.#limit);
    if (this.#autoSave) this.save();
    return entry;
  }

  all() {
    return [...this.#entries];
  }

  recent(limit = 5) {
    return this.#entries.slice(-Math.max(0, limit)).reverse();
  }

  get(id) {
    return this.#entries.find((entry) => entry.id === id) ?? null;
  }

  /** Rank entries by keyword overlap with `query`. */
  search(query, { limit = 5, kind, tags = [] } = {}) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return this.recent(limit);

    const scored = [];
    for (const entry of this.#entries) {
      if (kind && entry.kind !== kind) continue;
      if (tags.length > 0 && !tags.every((tag) => entry.tags.includes(tag))) continue;

      const haystack = `${entry.content} ${entry.tags.join(' ')}`;
      const haystackTokens = new Set(tokenize(haystack));
      let score = 0;
      for (const token of queryTokens) {
        if (haystackTokens.has(token)) score += 1;
        else if (haystack.toLowerCase().includes(token)) score += 0.5;
      }
      if (score > 0) {
        scored.push({ entry, score, scoreNormalized: score / queryTokens.length });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score || b.entry.ts.localeCompare(a.entry.ts))
      .slice(0, limit)
      .map((hit) => ({ ...hit.entry, score: hit.scoreNormalized }));
  }

  forget(id) {
    const index = this.#entries.findIndex((entry) => entry.id === id);
    if (index === -1) return false;
    this.#entries.splice(index, 1);
    if (this.#autoSave) this.save();
    return true;
  }

  clear() {
    this.#entries = [];
    if (this.#autoSave) this.save();
  }

  /** Render the most relevant memories for prompt injection. */
  toPrompt({ limit = 5, query = null, maxChars = 220 } = {}) {
    const entries = query ? this.search(query, { limit }) : this.recent(limit);
    if (entries.length === 0) return '';
    return entries
      .map((entry) => {
        const content = entry.content.length > maxChars ? `${entry.content.slice(0, maxChars)}...` : entry.content;
        const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        return `- (${entry.kind})${tags} ${content}`;
      })
      .join('\n');
  }

  load() {
    if (!this.#path || !existsSync(this.#path)) return 0;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(entries)) return 0;
      this.#entries = entries
        .filter((entry) => entry && typeof entry.content === 'string')
        .map((entry) =>
          Object.freeze({
            id: entry.id ?? randomUUID(),
            ts: entry.ts ?? new Date().toISOString(),
            kind: entry.kind ?? 'note',
            content: entry.content,
            tags: Object.freeze(Array.isArray(entry.tags) ? entry.tags : []),
            metadata: Object.freeze(entry.metadata ?? {}),
          }),
        )
        .slice(-this.#limit);
      this.#logger.debug('memory loaded', { path: this.#path, entries: this.#entries.length });
      return this.#entries.length;
    } catch (error) {
      this.#logger.warn('failed to load memory', { path: this.#path, error: error?.message });
      return 0;
    }
  }

  save() {
    if (!this.#path) return 0;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const payload = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries: this.#entries }, null, 2);
      const tmpPath = `${this.#path}.tmp`;
      writeFileSync(tmpPath, payload, 'utf8');
      renameSync(tmpPath, this.#path);
      return this.#entries.length;
    } catch (error) {
      this.#logger.warn('failed to persist memory', { path: this.#path, error: error?.message });
      return 0;
    }
  }
}
