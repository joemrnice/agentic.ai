# Architecture

`agentic.ai` is a **harness**, not a model. It wraps an LLM in the machinery that
turns text prediction into reliable work: a bounded loop, validated tools, memory
that survives the conversation, and events you can audit.

## Layering

```
                        ┌────────────────────────────────────────────┐
   interfaces           │  src/cli.js        src/index.js (library)   │
                        └───────────────┬────────────────────────────┘
                                        │
   orchestration        ┌───────────────▼────────────┐   ┌──────────────────────┐
                        │  core/factory.js           │   │  workflows/runner.js │
                        │  (wires everything)        │──▶│  (DAG of steps)      │
                        └───────────────┬────────────┘   └──────────────────────┘
                                        │
   agent                ┌───────────────▼────────────┐
                        │  core/agent.js  (ReAct)    │
                        │  core/context.js (state)   │
                        └───┬───────────────────┬────┘
                            │                   │
   capabilities   ┌────────▼────────┐  ┌───────▼─────────┐  ┌──────────────────┐
                  │ core/executor.js│  │ core/memory.js  │  │ prompts/system.js│
                  │ validation,     │  │ durable recall  │  │ prompt contract  │
                  │ timeouts, retry │  └─────────────────┘  └──────────────────┘
                  └────────┬────────┘
                           │
   extension points  ┌────▼─────┐   ┌────────────────┐   ┌───────────────────┐
                     │ tools/*  │   │ llm/*provider* │   │ core/events.js    │
                     │ registry │   │ model access   │   │ observability     │
                     └──────────┘   └────────────────┘   └───────────────────┘
```

Dependencies point **inwards only**: tools never import the agent, and providers
never import tools. That is what allows a host application to swap the model,
reuse the tools elsewhere, or run the loop against scripted responses in tests.

## Request lifecycle

1. `createRuntime()` resolves config (overrides → env → `.env` → defaults), builds
   the logger, provider, tool registry, memory store, event bus and executor.
2. `runtime.createAgent(definition)` resolves the agent definition, checks that
   every tool it references exists, and scopes the registry to that subset.
3. `agent.run(task)` creates a `RunContext`, seeds the system prompt (with memory
   if enabled) and enters the loop in [agent-loop.md](./agent-loop.md).
4. Each tool call passes through `ToolExecutor`: JSON parsing → schema validation
   → defaults → deadline → retry policy (read-only only) → truncated observation.
5. The run ends as `completed`, `max_steps`, `stuck` or `failed`, and every
   transition is emitted on the event bus as a structured record.

## Sandbox model

| Capability | Default | Guardrail |
| --- | --- | --- |
| Filesystem | on | every path resolved inside `AGENTIC_WORKSPACE`; escaping paths rejected before I/O |
| Compute | on | hand-written expression parser, never `eval` |
| Memory | on (read), write opt-in per agent | capped entry count; atomic JSON persistence |
| Network | **off** | `AGENTIC_ALLOW_NETWORK=true` plus optional `AGENTIC_ALLOWED_HOSTS`; auth headers stripped |
| Shell | **off** | `AGENTIC_ALLOW_SHELL=true` plus executable allowlist; no shell invocation at all |

The sandbox is enforced by the runtime, not requested in the prompt. Prompts can
be manipulated; `resolveWithinWorkspace()` cannot.

## Why zero dependencies

The entire runtime runs on Node built-ins (`node:test`, `fetch`, `node:events`,
`node:fs`). For a reference implementation the benefit is that every behaviour is
readable, there is no supply-chain surface, and the code you copy into a real
project is the code you can also debug. Swap in zod/pino/LangChain-style pieces
where you need them -- the interfaces here are deliberately small.

## Extension points

| Want to... | Do this |
| --- | --- |
| Add a capability | `defineTool()` and register it (`src/tools/index.js` already assembles the packs) |
| Use another model vendor | `createRuntime({ provider })` with anything exposing `complete({ messages, tools })` |
| Change the agent's contract | pass `systemPrompt` (string or function) to `createAgent()` |
| Replace short-term memory with vectors | reimplement `MemoryStore#search`; the interface stays |
| React to a run | subscribe to `AgentEvents` on `runtime.events` |
| Run many agents in order | express it as a workflow JSON and use `runWorkflow()` |
