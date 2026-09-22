import { ProviderError } from '../utils/errors.js';

/** Rough token estimate; good enough for offline usage accounting. */
function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

function firstLine(text, max = 220) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findLast(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) return { message: messages[index], index };
  }
  return { message: null, index: -1 };
}

function slugify(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'task';
}

const MATH_PATTERN = /(-?\d+(?:\.\d+)?(?:\s*[-+*/%^]\s*-?\d+(?:\.\d+)?)+)/;
const LIST_PATTERN = /\b(list|ls|enumerate|dir|directory|files|folders|layout|structure|tree|workspace)\b/i;
const READ_PATTERN = /\b(read|open|show|inspect|cat)\b[^"'`]*?["'`]?([\w./-]*\.[A-Za-z0-9]+)["'`]?/i;
const REMEMBER_PATTERN = /\b(remember|note that|keep in mind|save that|make a note)\b/i;
const RECALL_PATTERN = /\b(recall|search memory|do you remember|what do you know|lookup)\b/i;
const QUOTED_PATH_PATTERN = /["'`]([\w./-]+)["'`]/;
const DOCUMENT_PATTERN = /(?:^|\s)["'`]?([\w./-]+\.(?:md|markdown|json|jsonl|js|mjs|cjs|ts|tsx|txt|ya?ml|toml|csv|html|css|py|sh|sql))(?=\s|$|[.,;:!?])/i;

/** Best-effort path extraction from a natural language task (mock provider only). */
function extractPath(text) {
  const explicit = [
    /\b(?:path|directory|folder|dir)\b\s*[:=]?\s*["'`]([\w./-]+)["'`]/i,
    /\b(?:in|under|inside)\s+["'`]([\w./-]+)["'`]/i,
    /\b(?:list|ls|read|open|show|cat|inspect)\s+["'`]([\w./-]+)["'`]/i,
  ];
  for (const pattern of explicit) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }

  const generic = QUOTED_PATH_PATTERN.exec(text);
  if (generic && (generic[1].includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(generic[1]))) return generic[1];

  const bare = /(?:^|\s)(\.{1,2}\/[\w./-]+|[\w.-]+\/[\w./-]+)/.exec(text);
  return bare ? bare[1] : '.';
}

/** Turn a serialized tool observation into a human line for the mock answer. */
function describeObservation(observation) {
  const parsed = tryParseJson(observation.content);
  if (!parsed || typeof parsed !== 'object') return firstLine(observation.content, 160);

  switch (observation.name) {
    case 'calculator.eval':
      return `${parsed.expression} = ${parsed.result}`;
    case 'fs.list': {
      const names = (parsed.entries ?? []).map((entry) => (entry.type === 'dir' ? `${entry.name}/` : entry.name));
      return `${names.length} entr${names.length === 1 ? 'y' : 'ies'} (${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''})`;
    }
    case 'fs.read':
      return `${parsed.path}: ${parsed.lines ?? 0} line(s), ${parsed.bytes ?? 0} byte(s)`;
    case 'fs.write':
      return `wrote ${parsed.bytes ?? 0} byte(s) to ${parsed.path}`;
    case 'memory.write':
      return `stored memory ${parsed.id ?? ''}`.trim();
    case 'memory.search':
      return `${(parsed.matches ?? []).length} memory match(es)`;
    case 'memory.recent':
      return `${(parsed.entries ?? []).length} recent memory entr(ies)`;
    case 'http.get':
      return `${parsed.url ?? ''} -> ${parsed.status ?? '?'}`;
    case 'shell.exec':
      return `\`${parsed.command ?? ''}\` exited ${parsed.exitCode ?? '?'}`;
    default:
      return firstLine(JSON.stringify(parsed), 160);
  }
}

/**
 * A deterministic, dependency-free provider that behaves like a small ReAct
 * model. It exists so the scaffold is runnable, testable and demonstrable with
 * **no API key and no network**: `npm test` and `npm run example` work offline
 * and CI has something deterministic to assert against.
 *
 * Two modes:
 *   - automatic (default): inspects the task text, emits plausible tool calls,
 *     then summarises the observations it received.
 *   - scripted: pass `responses`, and each `complete()` call consumes the next
 *     entry -- this lets tests pin exact agent behaviour.
 */
export function createMockProvider({ model = 'mock-1', responses = [], logger = null } = {}) {
  let scriptIndex = 0;

  return {
    name: 'mock',
    model,

    async complete({ messages = [], tools = [], temperature, signal, model: overrideModel } = {}) {
      if (signal?.aborted) throw new ProviderError('Completion aborted', { code: 'ABORTED' });

      const activeModel = overrideModel ?? model;
      const toolNames = new Set(tools.map((tool) => tool.name));
      const promptTokens = estimateTokens(messages.map((message) => `${message.role}:${message.content ?? ''}`).join('\n'));
      logger?.debug('mock completion', { messages: messages.length, tools: tools.length, scripted: scriptIndex < responses.length });

      // --- scripted mode --------------------------------------------------
      if (scriptIndex < responses.length) {
        const scripted = responses[scriptIndex++];
        const content = typeof scripted === 'string' ? scripted : (scripted.content ?? '');
        const toolCalls = (typeof scripted === 'object' && scripted.toolCalls ? scripted.toolCalls : []).map((call, index) => ({
          id: call.id ?? `call_${scriptIndex}_${index + 1}`,
          name: call.name,
          arguments: call.arguments ?? {},
        }));
        return buildResult({ content, toolCalls, promptTokens, model: activeModel, stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop' });
      }

      const { message: userMessage, index: lastUserIndex } = findLast(messages, 'user');
      const task = userMessage?.content ?? '';
      const observations = messages.slice(lastUserIndex + 1).filter((message) => message.role === 'tool');

      // --- observations received: finish with the final answer -------------
      if (observations.length > 0) {
        const lines = [
          `(mock model) Completed the request with ${observations.length} tool call(s).`,
          '',
          'Observations:',
          ...observations.map((observation) => `- ${observation.name}: ${describeObservation(observation)}`),
        ];
        const numeric = observations
          .map((observation) => tryParseJson(observation.content))
          .filter((parsed) => parsed && typeof parsed.result === 'number' && typeof parsed.expression === 'string');
        if (numeric.length > 0) {
          lines.push('', `Numeric results: ${numeric.map((parsed) => `${parsed.expression} = ${parsed.result}`).join('; ')}`);
        }
        lines.push('', 'No further tool calls are required.');
        return buildResult({ content: lines.join('\n'), toolCalls: [], promptTokens, model: activeModel, stopReason: 'stop' });
      }

      // --- nothing observed yet: decide which tools to call ----------------
      const toolCalls = [];
      const addCall = (name, args) => {
        if (!toolNames.has(name)) return;
        toolCalls.push({ id: `call_${toolCalls.length + 1}_${slugify(name)}`, name, arguments: args });
      };

      const mathMatch = MATH_PATTERN.exec(task);
      if (mathMatch) addCall('calculator.eval', { expression: mathMatch[1].trim() });

      if (RECALL_PATTERN.test(task)) addCall('memory.search', { query: task, limit: 3 });
      else if (REMEMBER_PATTERN.test(task)) addCall('memory.write', { content: task, kind: 'note', tags: ['mock'] });

      if (LIST_PATTERN.test(task)) {
        addCall('fs.list', { path: extractPath(task) });
      }

      const readMatch = READ_PATTERN.exec(task);
      if (readMatch?.[2]) addCall('fs.read', { path: readMatch[2] });
      else {
        // A bare document reference ("Summarise README.md") is a strong hint.
        const documentMatch = DOCUMENT_PATTERN.exec(task);
        if (documentMatch) addCall('fs.read', { path: documentMatch[1] });
      }

      if (toolCalls.length > 0) {
        return buildResult({ content: '', toolCalls, promptTokens, model: activeModel, stopReason: 'tool_calls' });
      }

      // --- no tool needed: answer directly ---------------------------------
      return buildResult({
        content: [
          `(mock model) No tool was required for: "${firstLine(task, 120)}"`,
          '',
          'This reply comes from the offline mock provider. Set AGENTIC_PROVIDER=openai (or openai-compatible / ollama) to route the same agent loop through a real LLM.',
          `(model=${activeModel}, temperature=${temperature ?? 'default'})`,
        ].join('\n'),
        toolCalls: [],
        promptTokens,
        model: activeModel,
        stopReason: 'stop',
      });
    },
  };
}

function buildResult({ content, toolCalls, promptTokens, model, stopReason }) {
  const completionTokens = estimateTokens(content) + toolCalls.reduce((total, call) => total + estimateTokens(JSON.stringify(call.arguments)), 0);
  return {
    content,
    toolCalls,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    stopReason,
    model,
    provider: 'mock',
  };
}
