# The agent loop

The loop is the reason/act cycle (ReAct): **observe → decide → act → observe ... → answer**.

```
        ┌──────────────────────────────────────────────────────────────┐
        │  system prompt (role, tools, rules, memory)  +  user task    │
        └───────────────────────────────┬──────────────────────────────┘
                                        ▼
                       ┌────────────────────────────────┐
        step n ───────▶│ provider.complete(messages,    │
                       │                   tools)       │
                       └───────────────┬────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    │                                     │
        toolCalls present                       no toolCalls
                    │                                     │
                    ▼                                     ▼
        ┌────────────────────────┐              ┌───────────────────────┐
        │ executor.execute(call) │              │ final answer returned │
        │  validate → run →      │              │ status = completed    │
        │  deadline → truncate   │              └───────────────────────┘
        └───────────┬────────────┘
                    ▼
        ┌────────────────────────┐
        │ append role:"tool"     │──── loop back (step n+1)
        │ observation to context │
        └────────────────────────┘
```

## Implementation map

| Concern | Where |
| --- | --- |
| Loop, budgets, terminal states | `src/core/agent.js` |
| Transcript, step counter, usage accounting | `src/core/context.js` |
| Tool call validation, deadline, retry, truncation | `src/core/executor.js` |
| Tool contracts | `src/core/registry.js`, `src/tools/*` |
| Prompt contract and planner prompt | `src/prompts/system.js` |

## Terminal states

| Status | Meaning | What to do |
| --- | --- | --- |
| `completed` | The model answered without requesting another tool | Ship it (or validate the answer) |
| `max_steps` | The step budget was exhausted | Raise `maxSteps`, narrow the task, or split it into a workflow |
| `stuck` | The model repeated an identical tool call too often | Usually a bad tool description or a failed observation the model cannot read past |
| `failed` | The provider or runtime threw | Inspect `error.code` on the thrown `AgentRuntimeError` |

`max_steps` and `stuck` are **deliberate** guardrails: unbounded loops are how
agent demos turn into surprise invoices and duplicated side effects.

## Failure handling philosophy

1. **Tool errors are observations, not exceptions.** A rejected call is written
   back into the transcript as `ERROR(CODE): message` so the model can adapt.
2. **Validation happens before execution.** Arguments are checked against the
   tool's JSON schema; defaults are applied first.
3. **Retries are conservative.** Read-only tools are retried (`maxToolRetries`,
   default 1). Tools with `sideEffects: true` never are.
4. **Deadlines are per tool call.** A hung tool raises `TOOL_TIMEOUT` and the
   loop continues with that observation.
5. **Only the loop's own failures throw.** Those surface as `AgentRuntimeError`
   with the provider error as `cause`.

## Prompt contract

`buildSystemPrompt()` encodes the parts the model cannot know:

- the **operating loop** ("act with a tool call, or answer") so output is parseable;
- the **tool catalogue** with argument types, required flags, side-effect notes
  and enum values;
- **rules** (never invent tool output, stay inside the workspace, do not repeat
  identical calls, answer in prose);
- the **environment** (workspace root, timestamp, timezone);
- **relevant memory** retrieved for this task;
- **agent-specific guidelines** from the definition.

Overrides: pass `systemPrompt` as a string, or as a function
`({ agent, memoryPrompt }) => string` for full control.

## Budgets

| Knob | Default | Effect |
| --- | --- | --- |
| `AGENTIC_MAX_STEPS` | 8 | Maximum reason/act iterations per run |
| `AGENTIC_TEMPERATURE` | 0.2 | Sampling temperature forwarded to the provider |
| `AGENTIC_TOOL_TIMEOUT_MS` | 15000 | Per tool-call deadline |
| `AGENTIC_MAX_TOOL_RETRIES` | 1 | Retries for read-only tools only |
| `AGENTIC_TOOL_MAX_OUTPUT_CHARS` | 4000 | Observation truncation (protects the context window) |
| `maxRepeatedCalls` (per agent) | 3 | Identical-call threshold before `stuck` |

## Planning (opt-in)

`agent.plan(task)` asks the model for an ordered JSON plan and returns
`[{ id, description, tool }]`, falling back to a single step when the response is
not parseable. The runtime does **not** auto-plan: for long horizons, express the
decomposition as a workflow so each step has its own agent, tools and budget.
