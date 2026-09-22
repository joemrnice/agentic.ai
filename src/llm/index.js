import { ConfigError } from '../utils/errors.js';
import { createMockProvider } from './mock-provider.js';
import { createOpenAIProvider } from './openai-provider.js';

export { createMockProvider, createOpenAIProvider };

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const MOCK_DEFAULT_MODEL = 'mock-1';

const PROVIDER_DEFAULT_MODELS = Object.freeze({
  openai: 'gpt-4o-mini',
  ollama: 'llama3.1',
  'openai-compatible': 'gpt-4o-mini',
});

/**
 * Build the provider described by `config.provider`.
 *
 * All non-mock providers speak the OpenAI chat-completions dialect, which is
 * the de-facto interop standard: OpenAI, Azure, Ollama, vLLM, LM Studio,
 * OpenRouter, Groq... Only base URL, key and model differ.
 */
export function createProvider(config, { logger, fetchImpl = globalThis.fetch } = {}) {
  const provider = config?.provider ?? 'mock';
  const isDefaultModel = !config?.model || config.model === MOCK_DEFAULT_MODEL;
  const model = config?.baseUrl && isDefaultModel ? config.model : isDefaultModel ? PROVIDER_DEFAULT_MODELS[provider] ?? config?.model : config.model;

  switch (provider) {
    case 'mock':
      return createMockProvider({ model: config?.model ?? MOCK_DEFAULT_MODEL, logger });

    case 'openai':
      return createOpenAIProvider({
        baseUrl: config.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
        apiKey: config.apiKey,
        model,
        temperature: config.temperature,
        logger,
        fetchImpl,
      });

    case 'ollama':
      return createOpenAIProvider({
        baseUrl: config.baseUrl ?? OLLAMA_DEFAULT_BASE_URL,
        apiKey: config.apiKey ?? 'ollama',
        model,
        temperature: config.temperature,
        logger,
        fetchImpl,
      });

    case 'openai-compatible':
      if (!config.baseUrl) {
        throw new ConfigError('AGENTIC_BASE_URL is required when AGENTIC_PROVIDER=openai-compatible');
      }
      return createOpenAIProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model,
        temperature: config.temperature,
        logger,
        fetchImpl,
      });

    default:
      throw new ConfigError(`Unknown provider "${provider}". Expected one of: mock, openai, openai-compatible, ollama`);
  }
}

/**
 * Normalize a caller-supplied provider so a host application can plug in its
 * own model client (Bedrock, Vertex, an internal gateway, a fake in tests).
 */
export function assertProvider(candidate) {
  if (!candidate || typeof candidate.complete !== 'function') {
    throw new ConfigError('A custom provider must expose an async complete({ messages, tools }) method');
  }
  return {
    name: candidate.name ?? 'custom',
    model: candidate.model ?? 'unknown',
    complete: candidate.complete.bind(candidate),
  };
}
