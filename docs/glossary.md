# Glossary

Short, opinionated definitions of the vocabulary this codebase uses. File
references point at where the concept lives in code.

| Term | Meaning in this repo |
| --- | --- |
| **Agent** | An identity (persona + guidelines) bound to a model, a scoped tool set and budgets. `src/core/agent.js`. Agents are *data* (`agents/*.agent.json`), not subclasses. |
| **Agent definition** | The declarative JSON describing an agent: name, persona, tools, memory policy, budgets. Validated by `src/core/definition.js`. |
| **Agentic AI** | Software that pursues a goal across multiple steps: it decides what to do next, uses tools to change state or gather information, and verifies outcomes instead of only generating text. |
| **Budget** | Hard limits that make a run bounded: `maxSteps`, per-tool `timeoutMs`, `maxToolRetries`, observation size. See `docs/agent-loop.md`. |
| **Completion** | One model call. A *run* usually contains several completions. `AgentEvents.COMPLETION`. |
| **Context window** | The finite token budget the model can see. Observations are truncated (`serializeToolOutput`) to protect it. |
| **Executor** | The component that turns a proposed tool call into a validated, deadline-bounded observation. `src/core/executor.js`. |
| **Guardrail** | A runtime-enforced constraint (sandbox paths, allowlists, step caps) rather than a prompt instruction. Prompts can be manipulated; guardrails cannot. |
| **Hallucination** | A plausible but unverified claim. The loop's answer to it: force tool verification and require evidence in the final answer. |
| **Long-term memory** | Facts that outlive a conversation, persisted as JSON and retrieved by keyword scoring. `src/core/memory.js`. |
| **Observation** | The result of a tool call, injected into the transcript with `role: "tool"`. Errors are observations too. |
| **Planner** | Optional decomposition step (`agent.plan(task)`) that turns a goal into ordered steps. `src/prompts/system.js`. |
| **Provider** | Anything exposing `complete({ messages, tools })`. Ships as `mock` and `openai-compatible`. `src/llm/`. |
| **Reason/act loop (ReAct)** | The observe → decide → act cycle implemented in `Agent#run`. |
| **Run** | One `agent.run(task)` invocation: a transcript, a step count, usage totals and a terminal status. `RunContext` / `runId`. |
| **Short-term memory** | The message transcript of the current run. Dies with the run. |
| **Stuck** | Terminal status: the model repeated an identical tool call too many times. A signal to fix a tool description, not to raise the budget. |
| **Tool** | A declared, schema-validated capability with a handler. `defineTool()` in `src/core/registry.js`. |
| **Tool call** | The model's structured request to run a tool: `{ id, name, arguments }`. |
| **Trace** | The stream of `AgentEvents` emitted during a run, suitable for logs, UIs and evaluation. |
| **Workflow** | A declared DAG of agent and tool steps with `{{ }}` output interpolation. `workflows/*.workflow.json`, `src/workflows/runner.js`. |
| **Zero-dependency** | This scaffold runs on Node built-ins only: no SDK, no framework, nothing to audit beyond `src/`. |
