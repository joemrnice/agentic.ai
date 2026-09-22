import { defineTool } from '../core/registry.js';
import { ToolExecutionError, ValidationError } from '../utils/errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function assertUrlAllowed(rawUrl, { allowedHosts, allowNetwork }) {
  if (!allowNetwork) {
    throw new ToolExecutionError('Network access is disabled. Set AGENTIC_ALLOW_NETWORK=true to enable HTTP tools.');
  }

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new ValidationError(`"${rawUrl}" is not a valid absolute URL`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new ValidationError(`Unsupported protocol "${url.protocol}" (only http and https are allowed)`);
  }

  if (allowedHosts.length > 0 && !allowedHosts.includes(url.hostname)) {
    throw new ToolExecutionError(`Host "${url.hostname}" is not in AGENTIC_ALLOWED_HOSTS`, {
      details: { hostname: url.hostname, allowedHosts },
    });
  }

  return url;
}

async function readBody(response, maxBytes) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { body: text, truncated: false };
  return { body: text.slice(0, maxBytes), truncated: true };
}

/**
 * HTTP tools for web-aware agents.
 *
 * Registered only when `AGENTIC_ALLOW_NETWORK=true`, and optionally pinned to a
 * host allowlist. Authentication headers supplied by the agent are stripped so
 * a hijacked prompt cannot exfiltrate credentials it was never meant to see.
 */
export function createHttpTools({
  allowNetwork = true,
  allowedHosts = [],
  timeoutMs = 10_000,
  maxBytes = 100_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

  const sanitizeHeaders = (headers = {}) => {
    const safe = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
      safe[key] = value;
    }
    return safe;
  };

  const request = async (method, { url, headers, body }, toolContext) => {
    const target = assertUrlAllowed(url, { allowedHosts, allowNetwork });

    const init = { method, headers: sanitizeHeaders(headers), signal: toolContext?.signal };
    if (body !== undefined && method !== 'GET') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      init.headers = { 'content-type': 'application/json', ...init.headers };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const response = await fetchImpl(target, { ...init, signal: toolContext?.signal ?? controller.signal });
      const { body: text, truncated } = await readBody(response, maxBytes);

      return {
        url: target.toString(),
        status: response.status,
        ok: response.ok,
        contentType: response.headers?.get?.('content-type') ?? null,
        bytes: Buffer.byteLength(text, 'utf8'),
        truncated,
        body: text,
      };
    } catch (error) {
      throw new ToolExecutionError(`Request to ${target} failed: ${error?.message}`, { cause: error, details: { url: target.toString(), method } });
    } finally {
      clearTimeout(timer);
    }
  };

  const getTool = defineTool({
    name: 'http.get',
    description:
      'Perform an HTTP GET request and return the status, content type and (truncated) response body. Use it to consult documentation or APIs instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, description: 'Absolute http(s) URL to fetch.' },
        headers: { type: 'object', description: 'Optional request headers (authentication headers are ignored).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    tags: ['network', 'read-only'],
    handler: (args, toolContext) => request('GET', args, toolContext),
  });

  const postTool = defineTool({
    name: 'http.post',
    description: 'Perform an HTTP POST request with an optional JSON body and return the status and (truncated) response body.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, description: 'Absolute http(s) URL to post to.' },
        body: { type: ['object', 'string'], description: 'JSON payload (object) or raw string body.' },
        headers: { type: 'object', description: 'Optional request headers (authentication headers are ignored).' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    tags: ['network', 'mutating'],
    sideEffects: true,
    handler: (args, toolContext) => request('POST', args, toolContext),
  });

  return [getTool, postTool];
}
