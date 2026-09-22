import { ProviderError } from '../utils/errors.js';

function toOpenAIMessages(messages = []) {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const payload = { role: 'assistant', content: message.content || null };
      if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        payload.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
          },
        }));
      }
      return payload;
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId ?? message.id, content: String(message.content ?? '') };
    }
    return { role: message.role, content: String(message.content ?? '') };
  });
}

function toOpenAITools(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * Provider for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Works with OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio, OpenRouter,
 * Together, Groq and friends -- the only difference is `baseUrl`, `apiKey` and
 * `model`. Implementations use the global `fetch`, so there is no SDK to pin.
 */
export function createOpenAIProvider({
  baseUrl = 'https://api.openai.com/v1',
  apiKey = null,
  model = 'gpt-4o-mini',
  temperature = 0.2,
  organization = null,
  headers = {},
  timeoutMs = 60_000,
  extraBody = {},
  fetchImpl = globalThis.fetch,
  logger = null,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ProviderError('No fetch implementation available (Node >= 18 is required)');
  }

  const endpoint = /\/chat\/completions\/?$/.test(baseUrl) ? baseUrl : `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  return {
    name: 'openai-compatible',
    model,
    endpoint,

    async complete({ messages = [], tools = [], temperature: temperatureOverride, model: modelOverride, toolChoice = 'auto', signal, maxTokens } = {}) {
      const body = {
        model: modelOverride ?? model,
        messages: toOpenAIMessages(messages),
        temperature: temperatureOverride ?? temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        ...(tools.length > 0 ? { tools: toOpenAITools(tools), tool_choice: toolChoice } : {}),
        ...extraBody,
      };

      const requestHeaders = {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(organization ? { 'openai-organization': organization } : {}),
        ...headers,
      };

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      let response;
      try {
        response = await fetchImpl(endpoint, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body), signal: combinedSignal });
      } catch (error) {
        throw new ProviderError(`Request to ${endpoint} failed: ${error?.message}`, {
          code: error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'ABORTED' : 'PROVIDER_ERROR',
          cause: error,
          details: { endpoint, model: body.model },
        });
      }

      if (!response.ok) {
        const detail = await safeText(response);
        throw new ProviderError(`Provider returned HTTP ${response.status}`, {
          code: 'PROVIDER_ERROR',
          details: { endpoint, status: response.status, body: detail.slice(0, 800) },
        });
      }

      const payload = await response.json().catch(async (error) => {
        throw new ProviderError(`Provider returned invalid JSON: ${error.message}`, { details: { endpoint } });
      });

      const choice = payload?.choices?.[0];
      if (!choice?.message) {
        throw new ProviderError('Provider response contained no choices', { details: { endpoint } });
      }

      const toolCalls = (choice.message.tool_calls ?? []).map((call, index) => {
        const rawArguments = call.function?.arguments ?? '{}';
        let parsedArguments = rawArguments;
        try {
          parsedArguments = JSON.parse(rawArguments || '{}');
        } catch {
          logger?.warn('model returned malformed tool arguments', { tool: call.function?.name, raw: String(rawArguments).slice(0, 200) });
        }
        return { id: call.id ?? `call_${index + 1}`, name: call.function?.name ?? 'unknown', arguments: parsedArguments, rawArguments };
      });

      return {
        content: choice.message.content ?? '',
        toolCalls,
        usage: {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          totalTokens: payload.usage?.total_tokens ?? 0,
        },
        stopReason: choice.finish_reason ?? 'stop',
        model: payload.model ?? body.model,
        provider: 'openai-compatible',
      };
    },
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
