import { describeSchema } from '../utils/schema.js';

function formatTool(tool) {
  const properties = Object.entries(tool.parameters?.properties ?? {});
  const required = new Set(tool.parameters?.required ?? []);
  const signature = properties
    .map(([key, schema]) => `${key}${required.has(key) ? '' : '?'}: ${describeSchema(schema)}`)
    .join(', ');
  const notes = [tool.sideEffects ? 'writes/executes (not retried)' : 'read-only (retryable)'];
  if (tool.tags.length > 0) notes.push(`tags: ${tool.tags.join(', ')}`);
  const description = tool.description.replace(/\s+/g, ' ').trim();
  const line = `- ${tool.name}(${signature || 'no arguments'}) [${notes.join('; ')}]\n  ${description}`;
  const enumHints = properties
    .filter(([, schema]) => Array.isArray(schema.enum))
    .map(([key, schema]) => `${key} ∈ {${schema.enum.join(', ')}}`)
    .join(', ');
  return enumHints ? `${line}\n  allowed values: ${enumHints}` : line;
}

/**
 * Build the system prompt that defines the agent's operating contract.
 *
 * This is where the *harness* (not the model) encodes policy: when to use
 * tools, when to stop, what safety boundaries apply and in which shape the
 * final answer must come back.
 */
export function buildSystemPrompt({
  agentName = 'agent',
  persona = null,
  guidelines = [],
  tools = [],
  workspace = '.',
  maxSteps,
  memoryPrompt = '',
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
} = {}) {
  const sections = [];

  sections.push(`You are "${agentName}", an autonomous AI agent running inside a sandboxed agent-runtime.`);
  if (persona) sections.push(persona.trim());

  sections.push(
    [
      '## Operating loop',
      'For every step you do exactly one of two things:',
      '1. **Act** - request one or more tool calls with strict JSON arguments.',
      '2. **Answer** - reply with the final answer and no tool call.',
      'Between actions you will be shown the tool observation as a `tool` message. Read it before deciding what to do next.',
    ].join('\n'),
  );

  if (tools.length > 0) {
    sections.push(`## Available tools\n${tools.map(formatTool).join('\n')}`);
  } else {
    sections.push('## Available tools\nNone. Answer from your own knowledge and say so when you are unsure.');
  }

  const rules = [
    'Never invent tool names, arguments, file contents, command output or URLs. If a fact matters, verify it with a tool.',
    'Only reference paths inside the workspace sandbox; all filesystem paths are resolved relative to it.',
    'If a tool fails, read the error, adjust and try a different approach at most once, then report the blocker.',
    'Prefer the smallest number of tool calls that fully answers the task. Do not repeat an identical call you already made.',
    'Ask a clarifying question (as your final answer) when the task is genuinely ambiguous or unsafe.',
    'The final answer must be self-contained prose or markdown: no raw JSON payloads, no unfinished plans, no tool call syntax.',
  ];
  if (maxSteps) rules.push(`You have a budget of at most ${maxSteps} steps in this run; finish before it is exhausted.`);
  sections.push(`## Rules\n${rules.map((rule) => `- ${rule}`).join('\n')}`);

  const contextLines = [`- workspace root: ${workspace}`, `- current time: ${new Date().toISOString()}`, `- timezone: ${timezone}`];
  sections.push(`## Environment\n${contextLines.join('\n')}`);

  if (memoryPrompt) sections.push(`## Relevant memory\n${memoryPrompt}`);
  if (guidelines.length > 0) sections.push(`## Agent-specific guidelines\n${guidelines.map((line) => `- ${line}`).join('\n')}`);

  return sections.join('\n\n');
}

/** Prompt used when a planner asks the model to decompose a goal. */
export function buildPlannerPrompt({ goal, tools = [], maxSteps = 5 } = {}) {
  const toolList = tools.map((tool) => `- ${tool.name}: ${tool.description.split('\n')[0]}`).join('\n');
  return [
    'Decompose the goal below into an ordered plan of at most ' + maxSteps + ' concrete steps.',
    'Each step must be achievable with the available tools or with reasoning alone.',
    'Reply with a JSON array of objects: {"id": number, "description": string, "tool": string|null}.',
    'Do not include any prose outside the JSON array.',
    '',
    `Goal: ${goal}`,
    '',
    `Available tools:\n${toolList || '- none'}`,
  ].join('\n');
}
