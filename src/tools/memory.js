import { defineTool } from '../core/registry.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Memory tools: how an agent records and recalls knowledge across runs.
 *
 * Short-term memory is the message list inside a single run. These tools expose
 * *long-term* memory: facts that must survive the end of the conversation, such
 * as user preferences, decisions or intermediate findings.
 */
export function createMemoryTools({ memory } = {}) {
  if (!memory) throw new ValidationError('Memory tools require a MemoryStore instance');

  const writeTool = defineTool({
    name: 'memory.write',
    description:
      'Persist a durable note or fact to long-term memory so future runs can recall it. Use it for user preferences, decisions, entity facts and conclusions that outlive this conversation.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 4000, description: 'The fact or note to remember, written as a standalone sentence.' },
        kind: { type: 'string', enum: ['note', 'fact', 'preference', 'decision', 'summary'], default: 'note', description: 'Category of the memory.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional retrieval tags, e.g. ["project", "agentic.ai"].' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    tags: ['memory', 'mutating'],
    sideEffects: true,
    handler: ({ content, kind = 'note', tags = [] }, toolContext) => {
      const entry = memory.add({ content, kind, tags, metadata: { runId: toolContext?.runId ?? null } });
      toolContext?.emit?.('memory:write', { id: entry.id, kind, tags });
      return { id: entry.id, kind, tags, stored: true };
    },
  });

  const searchTool = defineTool({
    name: 'memory.search',
    description:
      'Search long-term memory for entries relevant to a query, ranked by keyword overlap. Call it before asking the user to repeat themselves or before re-deriving something you may already know.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'What to look for, in natural language.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Maximum number of memories to return.' },
        kind: { type: 'string', enum: ['note', 'fact', 'preference', 'decision', 'summary'], description: 'Restrict results to one category.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    tags: ['memory', 'read-only'],
    handler: ({ query, limit = 5, kind }, toolContext) => {
      const matches = memory.search(query, { limit, kind }).map((entry) => ({
        id: entry.id,
        ts: entry.ts,
        kind: entry.kind,
        content: entry.content,
        tags: entry.tags,
        score: Number(entry.score.toFixed(2)),
      }));
      toolContext?.emit?.('memory:read', { query, matches: matches.length });
      return { query, count: matches.length, matches };
    },
  });

  const recentTool = defineTool({
    name: 'memory.recent',
    description: 'Return the most recently written long-term memories, newest first. Useful at the start of a run to re-establish context.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 5, description: 'How many entries to return.' },
      },
      additionalProperties: false,
    },
    tags: ['memory', 'read-only'],
    handler: ({ limit = 5 }) => {
      const entries = memory.recent(limit).map((entry) => ({ id: entry.id, ts: entry.ts, kind: entry.kind, content: entry.content, tags: entry.tags }));
      return { count: entries.length, size: memory.size, entries };
    },
  });

  return [writeTool, searchTool, recentTool];
}
