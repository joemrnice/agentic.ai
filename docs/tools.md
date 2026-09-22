# Writing tools

A tool is the only way an agent can affect the world (or read anything it did not
already memorise). Treat the catalogue as your **API for the model**: descriptions
are prompts, schemas are type signatures, and the runtime enforces both.

## Anatomy

```js
import { defineTool } from '../core/registry.js';

export const lookupTool = defineTool({
  name: 'crm.lookup', // dotted namespace, unique in the registry
  description:
    'Find a customer record by exact email address. Returns id, plan and createdAt. ' +
    'Use it before answering questions about a specific account.',
  parameters: {
    // enforced before the handler runs
    type: 'object',
    properties: {
      email: { type: 'string', pattern: '^[^@]+@[^@]+$', description: 'Exact email address.' },
      includeInvoices: { type: 'boolean', default: false, description: 'Attach the last 5 invoices.' },
    },
    required: ['email'],
    additionalProperties: false,
  },
  tags: ['crm', 'read-only'],          // surfaced in prompts and `npm run tools`
  sideEffects: false,                  // false => retryable, true => never retried
  timeoutMs: 5000,                     // optional per-tool deadline override
  handler: async ({ email, includeInvoices }, toolContext) => {
    // toolContext: { signal, workspace, memory, logger, runId, emit }
    return { email, plan: 'pro', invoices: includeInvoices ? [] : undefined };
  },
});
```

Register it (all three are equivalent):

```js
const runtime = createRuntime({ tools: [lookupTool] });      // replace the default pack
runtime.registry.register(lookupTool);                        // add to the default pack
new ToolRegistry([...createDefaultTools({ config }), lookupTool]);
```

## Rules of thumb

| Rule | Why |
| --- | --- |
| One verb per tool | The model picks tools by name; `crm.lookup` beats `crm.manageEverything` |
| Describe the *when*, not just the *what* | "Use it before answering questions about an account" is what changes model behaviour |
| Return structured data, not prose | Observation JSON stays inspectable in traces; the model formats the prose |
| Keep the result small | Observations are truncated at `AGENTIC_TOOL_MAX_OUTPUT_CHARS`; paginate instead of dumping |
| Set `sideEffects: true` for anything mutating | It disables retries, which prevents duplicate writes and duplicate spend |
| Fail loudly, precisely | Throw `ToolExecutionError` with the reason; the model reads it and adapts |
| Never call `eval`, never trust model text as a path | Use `resolveWithinWorkspace()` and explicit parsers (see `calculator.js`) |

## The built-in packs

| Pack | Tools | Enabled by |
| --- | --- | --- |
| filesystem | `fs.list`, `fs.read`, `fs.write` | always (sandboxed to `AGENTIC_WORKSPACE`) |
| compute | `calculator.eval` | always |
| memory | `memory.write`, `memory.search`, `memory.recent` | when a `MemoryStore` is present |
| web | `http.get`, `http.post` | `AGENTIC_ALLOW_NETWORK=true` |
| shell | `shell.exec` | `AGENTIC_ALLOW_SHELL=true` |

`TOOL_PACKS` in `src/tools/index.js` is the machine-readable version of that table.

## Observations the model can act on

Errors are returned, never thrown out of the loop, in this shape:

```
ERROR(VALIDATION_ERROR): Invalid arguments for tool "fs.read": $.path is required
ERROR(TOOL_NOT_FOUND): Unknown tool "fs.listt"
ERROR(TOOL_TIMEOUT): Tool "http.get" exceeded its 10000ms deadline
ERROR(TOOL_EXECUTION_ERROR): Cannot read "docs/missing.md": file not found
```

Because the model sees the code and the message, it can fix its own arguments or
choose a different tool. That is the difference between a crash and a recovered run.

## Testing a tool

```js
const [tool] = createFilesystemTools({ workspace });
const observation = await tool.handler({ path: 'README.md' }, { runId: 'test' });
assert.match(observation.content, /# agentic/);
```

The executor-level behaviour (validation, retries, deadlines, truncation) is
already covered in `tests/executor.test.js` -- test your handler's logic, not the
harness.

## Naming conventions in this repo

- `<domain>.<verb>`: `fs.list`, `http.post`, `memory.search`, `shell.exec`
- Plural factory per module: `createCalculatorTools()`, `createFilesystemTools()`
- Handler signature: `(args, toolContext) => unknown | Promise<unknown>`
- Dotted names sort together, which keeps the prompt catalogue readable.
