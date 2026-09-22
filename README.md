# agentic.ai

**A zero-dependency, production-shaped scaffold for building autonomous AI agents — and a working explanation of what "agentic AI" actually means.**

Everything here runs on Node.js built-ins only. No SDK, no framework, nothing to
install: clone it, run `npm test`, run `npm start -- "list the files and compute 21 * 2"`,
and you have a real agent loop executing real tools with real guardrails — offline,
using a deterministic mock model. Point it at an LLM with three environment
variables and the exact same code path runs against a production provider.

```bash
git clone https://github.com/joemrnice/agentic.ai && cd agentic.ai
npm test                                    # 75 tests, zero dependencies
npm start -- "List the workspace files and compute 21 * 2"
```

---

## Table of contents

- [What agentic AI is all about](#what-agentic-ai-is-all-about)
- [The five pillars, and where they live in this repo](#the-five-pillars-and-where-they-live-in-this-repo)
- [Quickstart](#quickstart)
- [Project layout](#project-layout)
- [How a run actually executes](#how-a-run-actually-executes)
- [CLI reference](#cli-reference)
- [Using it as a library](#using-it-as-a-library)
- [Defining agents](#defining-agents)
- [Defining workflows](#defining-workflows)
- [Adding tools](#adding-tools)
- [Configuration](#configuration)
- [Safety model](#safety-model)
- [Testing](#testing)
- [Design decisions and honest limits](#design-decisions-and-honest-limits)
- [Roadmap](#roadmap)
- [Further reading](#further-reading)

---

## What agentic AI is all about

A plain LLM call is **one shot**: prompt in, text out. It cannot look anything up,
cannot check its work and cannot do anything about it when it is wrong. An
**agent** is what you get when you wrap that model in a loop and give it the
ability to act:

> **Agentic AI = a model + a goal + a loop + tools + memory + guardrails.**

That is the whole idea, and it changes the unit of work from *a response* to *a
completed task*. Concretely, an agentic system exhibits six behaviours:

**1. Autonomy over steps.** You supply the goal ("find out how this repository is
organised and write a brief"), not the steps. The system decides what to do next,
how many steps that takes, and when it is finished. The loop is the core
mechanism: reason → act → observe → repeat.

**2. Tool use.** Text cannot read a file, run a query or call an API. Tools are
typed, described functions the model can invoke; the harness executes them and
feeds the result back. This is what closes the gap between *saying* and *doing*.

**3. Memory.** Short-term memory is the transcript of the current run. Long-term
memory is what survives it — preferences, decisions, findings — so the tenth
conversation is not the first conversation all over again.

**4. Verification.** Because the model can act, it can check. "Compute this"
becomes a `calculator.eval` call whose result is arithmetic rather than a
plausible guess. Agentic systems trade a little latency for ground truth.

**5. Bounded execution.** Autonomy without limits is a bug. Real systems impose
step budgets, per-tool deadlines, retry policies, cost caps and explicit terminal
states (`completed`, `max_steps`, `stuck`, `failed`). That is the difference
between a demo and something you let run unattended.

**6. Observability.** A run that cannot be replayed cannot be trusted, debugged or
improved. Every step — model call, proposed tool call, observation, failure — is
emitted as a structured event.

### What changes in practice

| | Single LLM call | Agentic system |
| --- | --- | --- |
| Unit of work | A response | A completed task |
| Control flow | You write it | The model proposes, the harness disposes |
| Ground truth | Whatever the model memorised | Whatever the tools reported |
| Failure mode | Confidently wrong text | Recovered run, retried call, or explicit blocker |
| Bounded by | Output tokens | Step budgets, deadlines, allowlists |
| Debugging | Read the prompt | Replay the trace |

### What it is *not*

Agentic AI is not a magic autonomy upgrade, and this repo does not pretend
otherwise. A loop does not fix an under-specified task; a tool cannot rescue a bad
description; an agent holding the wrong tools will confidently do the wrong thing
faster than before. Most "agent failures" are really **harness failures** — missing
budgets, unreadable error messages, ambiguous tools, no sandbox. That is why this
scaffold spends most of its code on the harness rather than on prompts.

---

## The five pillars, and where they live in this repo

| Pillar | What it means | Where it lives |
| --- | --- | --- |
| **Loop** | Reason → act → observe, until the model answers or a budget stops it | `src/core/agent.js`, `src/core/context.js`, [`docs/agent-loop.md`](docs/agent-loop.md) |
| **Tools** | Typed, described capabilities the model can call; validated before they run | `src/core/registry.js`, `src/core/executor.js`, `src/tools/*`, [`docs/tools.md`](docs/tools.md) |
| **Memory** | Transcript within a run, durable recall across runs | `src/core/context.js`, `src/core/memory.js`, `src/tools/memory.js` |
| **Guardrails** | Step budgets, deadlines, sandboxed paths, capability allowlists | `src/config/index.js`, `src/tools/filesystem.js`, `src/tools/shell.js`, `src/tools/http.js` |
| **Observability** | Every lifecycle transition emitted as a structured event | `src/core/events.js`, `src/utils/logger.js` |

Each pillar is demonstrable from the terminal, with no API key:

| Pillar | Command | What you should see |
| --- | --- | --- |
| Loop | `npm start -- "List the workspace files and compute 21 * 2"` | Two model steps; two tool calls; a final answer |
| Trace | `npm start -- --trace "List the workspace files and compute 21 * 2"` | `run:start`, `step:start`, `model:completion`, `tool:start`/`tool:end`, `run:end` |
| Tools | `npm run tools` | The catalogue with side-effect and tag annotations |
| Memory (write) | `npm start -- --remember "Remember that this project targets Node 24 and ES modules"` | A `memory.write` observation |
| Memory (recall) | `npm start -- "What do you know about Node modules here"` | A `memory.search` observation with matches |
| Guardrails (off) | `npm run tools` | No `http.*`, no `shell.exec` |
| Guardrails (on) | `AGENTIC_ALLOW_NETWORK=true AGENTIC_ALLOW_SHELL=true npm run tools` | `http.get`, `http.post`, `shell.exec` appear |
| Records | `npm start -- --json "compute 21 * 2"` | The full run record: transcript, steps, tokens, timings |

---

## Quickstart

**Requirements:** Node.js ≥ 20 (developed and tested on Node 24). There are **no
runtime dependencies** — `src/` imports only `node:*` built-ins.

```bash
git clone https://github.com/joemrnice/agentic.ai
cd agentic.ai

npm test          # 76 tests covering the loop, executor, tools, memory, workflows
npm start -- "List the workspace files and compute 21 * 2"
```

Expected output (the model is a deterministic offline mock by default):

```
(mock model) Completed the request with 2 tool call(s).

Observations:
- calculator.eval: 21 * 2 = 42
- fs.list: 7 entries (agents/, docs/, examples/, memory/, package.json, README.md, src/, ...)

Numeric results: 21 * 2 = 42

No further tool calls are required.

-- assistant (mock/mock-1) | status=completed steps=2 toolCalls=2 tokens=2431 duration=47ms runId=d76198c9-...
```

### Point it at a real model

The mock provider exists so the project is runnable, testable and CI-friendly
offline. Nothing else changes when you switch — same loop, same tools, same
guardrails, same events:

```bash
cp .env.example .env

# OpenAI
echo 'AGENTIC_PROVIDER=openai' >> .env
echo 'AGENTIC_MODEL=gpt-4o-mini' >> .env
echo 'AGENTIC_API_KEY=sk-...' >> .env

# ...or any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, OpenRouter, Groq, Azure)
# AGENTIC_PROVIDER=ollama
# AGENTIC_BASE_URL=http://localhost:11434/v1
# AGENTIC_MODEL=llama3.1

npm start -- "Read README.md and summarise the architecture in five bullets"
npm run agent -- researcher "Write a brief about how this repository is organised"
```

Everything is verified with `npm run config` (which never prints the API key) and
`npm run tools` (which shows the catalogue the model will actually be offered).

---

## Project layout

```
agentic.ai/
├── src/
│   ├── index.js                  Public API (everything below, re-exported)
│   ├── cli.js                    `agentic run | workflow | tools | agents | config`
│   ├── config/
│   │   ├── index.js              Config resolution + validation (overrides → env → .env → defaults)
│   │   └── env.js                Dependency-free .env parser
│   ├── core/
│   │   ├── agent.js              The reason/act loop, budgets, terminal states
│   │   ├── context.js            Run state: transcript, step counter, usage, scratchpad
│   │   ├── definition.js         Agent definition loading + validation (idempotent normalize)
│   │   ├── events.js             Lifecycle event bus (`run:*`, `step:*`, `tool:*`, `workflow:*`)
│   │   ├── executor.js           Tool call → validated, deadline-bounded, truncated observation
│   │   ├── factory.js            createRuntime(): wires config, provider, tools, memory, events
│   │   ├── memory.js             Long-term memory store (search, retention, atomic persistence)
│   │   └── registry.js           defineTool() + ToolRegistry (schemas, subsets, prompt catalogue)
│   ├── llm/
│   │   ├── index.js              Provider factory + custom-provider validation
│   │   ├── mock-provider.js      Deterministic offline provider (scripted or heuristic)
│   │   └── openai-provider.js    fetch-based OpenAI-compatible client (tool calling)
│   ├── prompts/
│   │   └── system.js             System prompt contract + planner prompt
│   ├── tools/
│   │   ├── index.js              Tool packs assembled per config
│   │   ├── calculator.js         Arithmetic via a hand-written parser (never eval)
│   │   ├── filesystem.js         fs.list / fs.read / fs.write, sandboxed to the workspace
│   │   ├── http.js               http.get / http.post, host allowlist, credential stripping
│   │   ├── memory.js             memory.write / memory.search / memory.recent
│   │   └── shell.js              shell.exec with an executable allowlist, no shell involved
│   ├── utils/
│   │   ├── errors.js             Error taxonomy with stable codes (`TOOL_TIMEOUT`, ...)
│   │   ├── logger.js             Structured JSON-lines logger with levels and child loggers
│   │   └── schema.js             JSON-Schema subset: validation, defaults, rendering
│   └── workflows/
│       └── runner.js             Workflow loading, `{{ }}` interpolation, DAG execution
├── agents/
│   ├── assistant.agent.json      Generalist: reads the workspace, computes, answers
│   └── researcher.agent.json     Read-only investigator that writes findings to memory
├── workflows/
│   └── research-and-summarize.workflow.json
├── examples/
│   ├── 01-hello-agent.js         Smallest end-to-end run with event subscriptions
│   ├── 02-custom-tool.js         defineTool() + scripted provider (deterministic)
│   └── 03-workflow.js            Tool step → agent step → interpolated output
├── docs/
│   ├── architecture.md           Layering, lifecycle, sandbox model, extension points
│   ├── agent-loop.md             The loop, terminal states, budgets, prompt contract
│   ├── tools.md                  Authoring tools: schema, side effects, failure shapes
│   └── glossary.md               Vocabulary (agent, run, observation, stuck, ...)
├── tests/                        13 files, `node:test`, no test framework dependency
├── memory/                       Persisted long-term memory (contents gitignored)
├── .env.example                  Every knob, documented, with safe defaults
└── package.json                  No dependencies; scripts for every entry point
```

**Why these folders.** `core/` is the harness (loop, state, execution), `llm/` is
the interchangeable model boundary, `tools/` is where capabilities are added,
`agents/` and `workflows/` are *data* (reviewable in a diff), and `docs/` holds the
reasoning behind the code. The split exists so that "add a capability" and "change
the model" never require touching the same file.

---

## How a run actually executes

`npm start -- --trace "List the files in the workspace and compute 21 * 2"` emits one
structured event per transition. Abridged, real output:

```json
{"event":"run:start","agent":"assistant","provider":"mock","tools":["calculator.eval","fs.list","fs.read","memory.recent","memory.search","memory.write"],"maxSteps":8}
{"event":"step:start","step":1,"remaining":7}
{"event":"model:completion","step":1,"stopReason":"tool_calls","usage":{"promptTokens":973,"completionTokens":9,"totalTokens":982},"toolCalls":2}
{"event":"tool:start","callId":"call_1_calculator-eval","tool":"calculator.eval","args":{"expression":"21 * 2"}}
{"event":"tool:end","tool":"calculator.eval","ok":true,"durationMs":10,"attempts":1,"error":null}
{"event":"tool:start","tool":"fs.list","args":{"path":"."}}
{"event":"tool:end","tool":"fs.list","ok":true,"durationMs":4,"attempts":1,"error":null}
{"event":"step:end","step":1,"observations":[{"tool":"calculator.eval","ok":true},{"tool":"fs.list","ok":true}]}
{"event":"step:start","step":2,"remaining":6}
{"event":"model:completion","step":2,"stopReason":"stop","toolCalls":0}
{"event":"run:end","status":"completed","steps":2,"durationMs":124}
```

Read top to bottom, that is the whole architecture in eleven lines:

1. **`run:start`** — the loop opens with a task, a provider, the agent's scoped tool
   catalogue and a step budget.
2. **Prompt assembly** — persona, tool catalogue (with argument types and required
   flags), rules, environment and relevant memory become the system message; the
   task becomes the user message.
3. **`model:completion`** — the model either requests tools or answers. Token usage
   is accounted per step so cost is observable, not guessed.
4. **`tool:start`** — arguments are parsed, defaults applied and the JSON schema
   validated. Rejection happens *before* any handler runs.
5. **`tool:end`** — the handler ran under a deadline; the observation was
   serialised and truncated to protect the context window. Failures return as
   `ERROR(CODE): message` that the model can read and recover from.
6. **`step:end`** — observations are appended to the transcript as
   `role: "tool"` messages.
7. **Answer or stop** — no tool calls means the answer is final; otherwise the loop
   repeats. Budget exhaustion yields `max_steps`, identical repeated calls yield
   `stuck`, and thrown errors yield `failed`.

Nothing in that sequence is provider-specific: the offline mock and a production
LLM traverse the exact same events, which is what makes the test suite meaningful.

---

## CLI reference

```
agentic run [task...] [options]        Run one agent on a task
agentic workflow <file> [--input.k=v]  Execute a declarative workflow
agentic tools                          List the registered tools
agentic agents                         List the agent definitions in ./agents
agentic config                         Print the effective configuration
agentic help                           Show usage
```

| Command | Example | Notes |
| --- | --- | --- |
| `npm start -- "<task>"` | `npm start -- "Read README.md and list the headings"` | Runs `agents/assistant.agent.json` |
| `npm run agent -- <name> "<task>"` | `npm run agent -- researcher "brief me"` | Resolves a name from `agents/` or any path |
| `npm run workflow -- <file>` | `npm run workflow -- workflows/research-and-summarize.workflow.json` | Add `--input.focus="entry points"` |
| `npm run tools` | `AGENTIC_ALLOW_SHELL=true npm run tools` | Shows exactly what the model will be offered |
| `npm run config` | `npm run config` | Sanitized config (the API key is never printed) |

Run flags: `--agent <name|path>`, `--task "<text>"`, `--provider <name>`,
`--model <id>`, `--max-steps <n>`, `--remember`, `--json`, `--trace`.

Exit codes: `0` completed, `1` failed / non-completing status, `2` usage error —
so the CLI composes with `&&`, CI steps and shell scripts.

---

## Using it as a library

`src/index.js` re-exports the whole public surface (61 symbols):

```js
import { AgentEvents, createRuntime } from 'agentic.ai';

const runtime = createRuntime(); // zero config: mock model, sandboxed tools

runtime.events.on(AgentEvents.TOOL_END, ({ tool, ok, durationMs }) => {
  console.log(`${ok ? 'ok' : 'fail'} ${tool} in ${durationMs}ms`);
});

const result = await runtime.run('List the workspace files and compute 21 * 2');

console.log(result.answer);        // the final answer
console.log(result.status);        // 'completed' | 'max_steps' | 'stuck' | 'failed'
console.log(result.step);          // how many reason/act iterations it took
console.log(result.usage);         // { promptTokens, completionTokens, totalTokens, completions }
console.log(result.messages);      // the full transcript, replayable
console.log(result.runId);         // correlate with your own logs
```

Wire it up yourself when you need control over the pieces:

```js
import {
  AgentEvents,
  MemoryStore,
  createDefaultTools,
  createRuntime,
  defineTool,
  loadConfig,
} from 'agentic.ai';

const config = loadConfig({ allowNetwork: true, allowedHosts: ['api.github.com'] });
const memory = new MemoryStore({ path: config.memoryPath }); // durable across runs

const weatherTool = defineTool({
  name: 'weather.now',
  description: 'Return the current temperature for a city. Use it before making any claim about today\'s weather.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', minLength: 1 } },
    required: ['city'],
    additionalProperties: false,
  },
  handler: ({ city }) => ({ city, celsius: 21 }),
});

const runtime = createRuntime({
  config,
  memory,
  tools: [...createDefaultTools({ config, memory }), weatherTool],
  // provider: myGateway,  // anything exposing complete({ messages, tools })
});

const agent = runtime.createAgent({
  name: 'repo-explorer',
  persona: 'You map unfamiliar codebases methodically.',
  tools: ['fs.list', 'fs.read', 'memory.write', 'memory.search'],
  maxSteps: 10,
  memory: { read: true, write: true },
});

const result = await agent.run('List the workspace structure and remember its entry points');

runtime.memory.search('entry points'); // what the agent decided to keep
runtime.describe();                     // provider, tools, budgets, capabilities
```

Other public helpers worth knowing:

| Helper | Use it for |
| --- | --- |
| `agent.plan(task)` | Opt-in decomposition into `[{ id, description, tool }]` |
| `runWorkflow(loadWorkflow(path), { runtime, inputs })` | Multi-step / multi-agent orchestration |
| `ToolRegistry#subset(names)` | Give an agent a least-privilege tool set |
| `ToolExecutor` | Run tool calls with validation, deadlines and retries, standalone |
| `createMockProvider({ responses })` | Deterministic, scripted model calls in tests |
| `validateAgainstSchema` / `applyDefaults` | The same schema engine the executor uses |
| `AgentEvents` | Subscribe to `run:*`, `step:*`, `tool:*`, `memory:*`, `workflow:*` |

---

## Defining agents

An agent is **data**, not a subclass — so its identity is reviewable in a diff and
versionable next to the prompts it uses. `agents/researcher.agent.json`:

```json
{
  "version": 1,
  "name": "researcher",
  "description": "Read-only investigator that gathers evidence and writes findings to memory.",
  "persona": "You are an evidence-driven researcher. Every claim must be traceable to a file you read or a memory entry you retrieved.",
  "tools": ["fs.list", "fs.read", "memory.search", "memory.write", "memory.recent"],
  "maxSteps": 12,
  "temperature": 0.1,
  "memory": { "read": true, "write": true },
  "guidelines": [
    "Prefer breadth first: map directories before reading files.",
    "Quote short excerpts rather than pasting whole files.",
    "Return a markdown report with sections: Summary, Evidence, Open questions."
  ]
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string | *required* | Agent identity; `[a-z0-9][a-z0-9_.-]*` |
| `description` | string | `""` | Shown by `npm run agents` |
| `persona` | string | `null` | Injected into the system prompt |
| `guidelines` | string[] | `[]` | Extra rules appended to the prompt |
| `tools` | string[] \| `null` | `null` | `null` = every registered tool; otherwise a least-privilege subset (validated against the registry) |
| `maxSteps` | integer | config `maxSteps` | Step budget for this agent |
| `temperature` | number | config `temperature` | Sampling temperature override |
| `model` | string | config `model` | Model override for this agent |
| `memory.read` | boolean | `true` | Inject relevant memories and expose search tools |
| `memory.write` | boolean | `false` | Persist a summary of completed runs |
| `version` | integer | `1` | Definition schema version |

Definitions are validated: unknown keys are rejected (a typo like `tooLs` fails
loudly instead of silently disabling a capability), out-of-range temperatures and
budgets are refused, and an agent that references an unregistered tool throws at
`createAgent()` time rather than mid-run.

`--agent` resolution order: an existing path in the current directory → that path
plus `.agent.json` → `agents/<name>.agent.json` shipped with this package.

---

## Defining workflows

A workflow is a DAG of **tool steps** and **agent steps** with `{{ }}` output
interpolation. It is how you orchestrate multiple agents without writing
orchestration code. `workflows/research-and-summarize.workflow.json`:

```json
{
  "version": 1,
  "name": "research-and-summarize",
  "inputs": { "focus": "the overall repository layout and entry points" },
  "steps": [
    {
      "id": "scan",
      "uses": "tool",
      "tool": "fs.list",
      "input": { "path": "." }
    },
    {
      "id": "brief",
      "uses": "agent",
      "agent": "../agents/researcher.agent.json",
      "dependsOn": ["scan"],
      "input": "Focus: {{inputs.focus}}\n\nWorkspace root contents (JSON):\n{{steps.scan.output}}\n\nWrite the brief."
    }
  ],
  "output": "{{steps.brief.output}}"
}
```

```bash
npm run workflow -- workflows/research-and-summarize.workflow.json
npm run workflow -- workflows/research-and-summarize.workflow.json --input.focus="how the runtime is wired"
```

| Step field | Meaning |
| --- | --- |
| `id` | Unique step name; also the key in `{{steps.<id>.output}}` |
| `uses` | `"tool"` or `"agent"` |
| `tool` | Registered tool name (tool steps) |
| `agent` | Path to a definition (relative to the workflow file) or an inline definition object |
| `input` | Arguments for the tool, or `"task text"` / `{ task }` for the agent — templates allowed |
| `dependsOn` | Step ids that must finish first |
| `overrides` | Per-step agent overrides (`maxSteps`, `persona`, ...) |

Semantics that matter:

- Steps run **in file order**, gated by `dependsOn` — deterministic and easy to reason about.
- `{{inputs.*}}` and `{{steps.<id>.output}}` are substituted in strings, arrays and objects. Unknown placeholders are **left visible** rather than silently becoming `undefined`.
- A failing step short-circuits the run: `runWorkflow` returns `{ status: 'failed', failedStep, steps }` and downstream steps never execute.
- Each step emits `workflow:step` events (`running` → `completed`/`failed`), so a workflow run is as observable as a single agent run.

---

## Adding tools

Tools are the extension point you will use most. Full guide:
[`docs/tools.md`](docs/tools.md). The short version:

```js
import { defineTool, ToolRegistry } from 'agentic.ai';

const todoTool = defineTool({
  name: 'todo.add',
  description: 'Add an item to the project todo list. Use it when the user asks to track work.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, description: 'Short, actionable title.' },
      priority: { type: 'string', enum: ['low', 'normal', 'high'], default: 'normal' },
    },
    required: ['title'],
    additionalProperties: false,
  },
  tags: ['productivity'],
  sideEffects: true,   // disables retries: writes must never be duplicated
  handler: async ({ title, priority }, toolContext) => {
    // toolContext: { signal, workspace, memory, logger, runId, emit }
    return { id: 'todo-1', title, priority, created: true };
  },
});

// Option A: replace the tool set entirely
const runtime = createRuntime({ tools: [todoTool] });

// Option B: add to the built-in packs
runtime.registry.register(todoTool);

// Option C: a shared registry for several runtimes
const registry = new ToolRegistry([...createDefaultTools({ config }), todoTool]);
```

Rules that keep tools reliable:

| Rule | Why |
| --- | --- |
| Describe **when** to use the tool, not just what it does | That sentence is what changes model behaviour |
| Return structured data | Traceable observations; let the model format the prose |
| Set `sideEffects: true` for anything mutating | Prevents duplicate writes and duplicate spend on retry |
| Fail with a precise reason | The model reads `ERROR(...)` and adapts instead of crashing |
| Never `eval`, never trust a model-supplied path | Use explicit parsers and `resolveWithinWorkspace()` |

---

## Configuration

Resolution order: **explicit overrides → `AGENTIC_*` environment → `.env` file →
safe defaults**. `npm run config` prints the effective result (API key redacted).

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTIC_PROVIDER` | `mock` | `mock` \| `openai` \| `openai-compatible` \| `ollama` |
| `AGENTIC_MODEL` | `mock-1` | Model id (provider defaults apply for `openai`/`ollama`) |
| `AGENTIC_BASE_URL` | — | Required for `openai-compatible`; optional override for `openai`/`ollama` |
| `AGENTIC_API_KEY` | — | Required by `openai`; never logged |
| `AGENTIC_TEMPERATURE` | `0.2` | Sampling temperature (0–2) |
| `AGENTIC_MAX_STEPS` | `8` | Maximum reason/act iterations per run |
| `AGENTIC_TOOL_TIMEOUT_MS` | `15000` | Per tool-call deadline |
| `AGENTIC_MAX_TOOL_RETRIES` | `1` | Retries for read-only tools only |
| `AGENTIC_TOOL_MAX_OUTPUT_CHARS` | `4000` | Observation truncation limit |
| `AGENTIC_LOG_LEVEL` | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `AGENTIC_WORKSPACE` | cwd | Sandbox root for the filesystem tools |
| `AGENTIC_MEMORY_DIR` | `memory` | Long-term memory directory (relative to the workspace) |
| `AGENTIC_MEMORY_LIMIT` | `500` | Retained memory entries |
| `AGENTIC_MEMORY_PERSIST` | `true` | Write memory to disk (disabled ⇒ in-process only) |
| `AGENTIC_ALLOW_NETWORK` | `false` | Register `http.get` / `http.post` |
| `AGENTIC_ALLOWED_HOSTS` | *(empty)* | Comma-separated host allowlist for HTTP tools (empty = any host) |
| `AGENTIC_ALLOW_SHELL` | `false` | Register `shell.exec` |
| `AGENTIC_SHELL_ALLOWLIST` | `ls,cat,pwd,node,npm,git,rg,grep,find,wc,head,tail,echo` | Executables the shell tool may run |
| `AGENTIC_SHELL_TIMEOUT_MS` | `15000` | Shell command deadline |

Invalid values throw a `ConfigError` **at startup** naming the variable and the
expected shape — a misconfigured agent should fail before it spends tokens.

---

## Safety model

An agent with tools is code execution with extra steps, so the defaults are
**deny by default**:

| Capability | Default | Runtime guardrail |
| --- | --- | --- |
| Read/write files | on | Every path is resolved inside `AGENTIC_WORKSPACE`; `../`, absolute escapes and traversal are rejected *before* I/O. Paths are model input, treated as untrusted. |
| Arithmetic | on | A hand-written recursive-descent parser with a function whitelist. No `eval`, no `Function`, no shell. |
| Long-term memory | read: on, write: per agent | Bounded entry count; atomic write (temp file + rename) |
| Network | **off** | Opt-in; optional host allowlist; `authorization`/`cookie` headers supplied by the model are stripped |
| Shell | **off** | Opt-in; executable allowlist; commands are split into argv and executed with `execFile` — **a shell is never invoked**, so `;`, `|`, `&&`, backticks, `$(...)` and globs cannot appear at all |
| Model output | untrusted | Tool arguments are schema-validated; failures become observations, not execution |
| Runaway loops | bounded | Step budget, identical-call detection (`stuck`), per-tool deadlines, retry limits |
| Secrets | never printed | `AGENTIC_API_KEY` is redacted in `npm run config` and never logged |

For production deployments, add the layers this scaffold deliberately leaves out:
human approval for mutating tools, per-tenant workspaces, rate and cost limits,
secret management, and an evaluation suite that asserts task success rather than
event shapes. The interfaces are designed so those bolt on without rewriting the
loop: guardrails belong in the tool handlers and the `AgentEvents` stream.

---

## Testing

```bash
npm test               # 76 tests, ~2s, offline
npm run test:watch
node --test "tests/**/*.test.js"
```

The suite uses Node's built-in runner only — no Jest, no Vitest, no config file.

| File | Covers |
| --- | --- |
| `tests/agent.test.js` | The loop, terminal states, memory policy, prompts, usage accounting |
| `tests/executor.test.js` | Validation, JSON arguments, retries, deadlines, truncation, events |
| `tests/registry.test.js` | Tool declaration, subsets, duplicate/unknown handling, prompt catalogue |
| `tests/schema.test.js` | Validation errors, defaults, schema rendering |
| `tests/memory.test.js` | Search ranking, retention, persistence, memory tools |
| `tests/filesystem-tools.test.js` | Listing, reading, writing, sandbox escape rejection |
| `tests/shell-tools.test.js` | argv parsing, metacharacter rejection, allowlist, deadline |
| `tests/calculator.test.js` | Precedence, associativity, unsafe input rejection |
| `tests/definition.test.js` | Definition validation, idempotent normalization, discovery |
| `tests/workflow.test.js` | Template interpolation, DAG ordering, failure short-circuit |
| `tests/runtime.test.js` | Wiring, capability opt-in, agent scoping, end-to-end run |
| `tests/config.test.js` | Env parsing, validation, override precedence, key redaction |

Two conventions make the tests meaningful — both are worth copying:

**1. Inject everything.** Nothing reaches for a global. `createRuntime({ provider, memory, logger, tools })`
lets a test replace the model, the disk and the log sink:

```js
const runtime = createRuntime({
  provider: createMockProvider({ responses: [{ content: 'scripted' }] }),
  memory: new MemoryStore(),
  logger: createNoopLogger(),
});
```

**2. Script the model, then assert the harness.** Because the provider is
replaceable, tests pin exact model behaviour and verify the *harness*: retries,
deadlines, validation, budgets, events. That is where agent bugs actually live.

```js
const provider = createMockProvider({
  responses: [
    { toolCalls: [{ name: 'calculator.eval', arguments: { expression: '21 * 2' } }] },
    { content: 'The answer is 42.' },
  ],
});
```

---

## Examples

```bash
npm run examples   # all three, in order
node examples/01-hello-agent.js   # runtime + default agent + live event log
node examples/02-custom-tool.js   # defineTool() + scripted provider (deterministic)
node examples/03-workflow.js      # tool step → agent step → interpolated output
```

`examples/02-custom-tool.js` is the shortest complete demonstration of the pattern
this scaffold exists to teach: declare a capability, let the model decide to use
it, execute it safely, feed the result back.

---

## Design decisions and honest limits

**Decisions.**

- **Zero dependencies.** For a reference implementation, a readable `src/` beats a
  deep `node_modules`. Nothing is hidden behind a framework, so the harness logic
  is the thing you read.
- **Provider-agnostic.** All non-mock providers speak OpenAI chat-completions —
  the de-facto interop standard — so OpenAI, Ollama, vLLM, LM Studio, OpenRouter,
  Groq and Azure all work with different `baseUrl`/`model` values. A custom
  provider is just an object with `complete({ messages, tools })`.
- **Tool errors are observations.** A failed call must teach the model something,
  so failures are written back as `ERROR(CODE): message` instead of aborting.
- **Retries only where they are safe.** Read-only tools retry; anything declaring
  `sideEffects: true` never does. Duplicate writes are worse than a failed call.
- **Guardrails are code, not prompt text.** Sandboxing, allowlists and budgets are
  enforced by the runtime; prompts can be talked out of things, `resolveWithinWorkspace()` cannot.
- **Bounded observations.** Every tool result is truncated before it enters the
  context window, because one verbose tool can otherwise poison a whole run.
- **Agents and workflows are data.** Reviewable in a diff, versionable with the
  prompts they depend on, and serializable from another system.
- **Structured logs, clean stdout.** JSON-lines to stderr means `--json` output
  stays pipeable while traces remain greppable.

**Limits — stated plainly, because a scaffold that oversells itself is worse than none.**

- The `mock` provider is a **heuristic stand-in**, not a model. It pattern-matches
  task text to exercise the harness offline. It is not a benchmark of agent quality.
- Memory retrieval is **keyword overlap**, not semantic search. Swap
  `MemoryStore#search` for embeddings when recall quality starts to matter.
- **No streaming**, no partial answers, no token-by-token UI.
- Tool calls within a step execute **sequentially**; parallel execution is not implemented.
- **No run checkpointing or resume.** The transcript is returned, but a crashed
  process loses the run (the event bus is in-process).
- **No approval gates, cost caps or rate limits.** Token usage is reported, not
  enforced. Add these before letting an agent touch production systems.
- Shell safety is **allowlist + argv execution**, not container isolation. If you
  need to run untrusted code, run it in a container or microVM.
- **Prompt injection is mitigated, not solved.** Sandboxing limits what a poisoned
  instruction can reach; it does not stop the model from being misled.
- **Single-tenant.** There is no per-user workspace or memory partitioning out of the box.

---

## Roadmap

Ideas that fit the existing seams without redesigning the loop:

- [ ] Streaming completions (`AgentEvents.COMPLETION_DELTA` already has a natural shape)
- [ ] Pluggable memory backends (embeddings, Redis, Postgres) behind `MemoryStore`
- [ ] Human-in-the-loop approval gates for `sideEffects` tools
- [ ] Cost budgets enforced per run, not just reported
- [ ] Parallel tool execution with per-tool concurrency limits
- [ ] OTLP/OpenTelemetry export of `AgentEvents`
- [ ] An eval harness that scores task success against golden tasks
- [ ] MCP (Model Context Protocol) adapter to import external tool servers
- [ ] Container-based shell sandbox profile
- [ ] Run persistence (resume a run from its transcript)

---

## Further reading

- Loop pattern background: [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)
- Tool interop: [Model Context Protocol](https://modelcontextprotocol.io)
- Provider tool-calling format: [OpenAI function calling guide](https://platform.openai.com/docs/guides/function-calling)
- Schema subset used here: [JSON Schema](https://json-schema.org)
- Test runner used here: [Node.js test runner](https://nodejs.org/api/test.html)
- This project's own docs: [architecture](docs/architecture.md) · [agent loop](docs/agent-loop.md) · [writing tools](docs/tools.md) · [glossary](docs/glossary.md)

---

## License

ISC — see `package.json`.








