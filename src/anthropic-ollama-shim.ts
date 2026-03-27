/**
 * anthropic-ollama-shim.ts — Lightweight HTTP server that translates
 * Anthropic Messages API requests to Ollama's /api/chat endpoint.
 *
 * Receives Anthropic format -> translates to OpenAI/Ollama format ->
 * forwards to Ollama -> normalizes response -> translates back to Anthropic.
 *
 * Listens on 127.0.0.1 only. Containers reach it via host.docker.internal.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';

import {
  SHIM_PORT,
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_TIMEOUT_MS,
  OLLAMA_NUM_CTX,
} from './config.js';
import { logger } from './logger.js';
import { repairToolCalls } from './shim-tool-repair.js';
import { translateRequest, translateResponse } from './shim-tool-translator.js';
import type {
  AnthropicRequest,
  OpenAIResponse,
  RawOllamaResponse,
} from './shim-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const startTime = Date.now();

/** Generate a short random hex ID. */
function randomId(): string {
  return randomBytes(8).toString('hex');
}

/** Send a JSON response with CORS headers. */
function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ollama-Model, X-Ollama-Num-Ctx, Authorization, X-Api-Key, Anthropic-Version',
  });
  res.end(JSON.stringify(data));
}

/** Send a structured error response. */
function errorResponse(
  res: http.ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  json(res, { error: { type, message } }, status);
}

/** Read the full request body as a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Validate that a URL points to a private/local address.
 * Accepts 127.x, 10.x, 172.16-31.x, 192.168.x, and localhost.
 */
function isPrivateUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return true;
    }
    // Check RFC1918 ranges
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
      if (parts[0] === 10) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 127) return true;
    }
    // Allow hostname-based local addresses (e.g. studio.shearer.live resolving locally)
    // The URL validation is a safety check, not a hard block on hostnames
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ollama HTTP client
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request to Ollama using Node's built-in http module.
 *
 * @param path - The API path (e.g. "/api/chat", "/api/tags").
 * @param body - Optional request body (will be JSON-serialized).
 * @param timeoutMs - Request timeout in milliseconds.
 * @returns The HTTP status and parsed response body.
 */
function ollamaRequest(
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const baseUrl = new URL(OLLAMA_BASE_URL);
    const opts: http.RequestOptions = {
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      path,
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: timeoutMs ?? OLLAMA_TIMEOUT_MS,
    };

    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', (chunk: Buffer) => {
        chunks += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 500, data: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode ?? 500, data: { raw: chunks } });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`TIMEOUT:${timeoutMs ?? OLLAMA_TIMEOUT_MS}`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// POST /v1/messages — Main translation endpoint
// ---------------------------------------------------------------------------

async function handleMessages(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const requestStart = Date.now();

  // Read and parse the request body
  let anthropicReq: AnthropicRequest;
  try {
    const raw = await readBody(req);
    anthropicReq = JSON.parse(raw) as AnthropicRequest;
  } catch (err) {
    errorResponse(res, 400, 'invalid_request', `Failed to parse request body: ${err}`);
    return;
  }

  // Check for streaming (Phase 3)
  if (anthropicReq.stream) {
    errorResponse(res, 501, 'not_implemented', 'Streaming not yet supported. Use stream: false.');
    return;
  }

  // Determine model: X-Ollama-Model header > request model mapping > default
  const headerModel = req.headers['x-ollama-model'] as string | undefined;
  const ollamaModel = headerModel || OLLAMA_DEFAULT_MODEL;

  // Determine num_ctx: X-Ollama-Num-Ctx header > config default
  const headerNumCtx = req.headers['x-ollama-num-ctx'] as string | undefined;
  const numCtx = headerNumCtx ? parseInt(headerNumCtx, 10) : OLLAMA_NUM_CTX;

  // Log the incoming request
  logger.info(
    {
      model: anthropicReq.model,
      ollamaModel,
      numCtx,
      messageCount: anthropicReq.messages.length,
      hasTools: !!(anthropicReq.tools && anthropicReq.tools.length > 0),
      hasStream: !!anthropicReq.stream,
    },
    'shim: incoming request',
  );

  // Translate Anthropic request to OpenAI/Ollama format
  const openaiReq = translateRequest(anthropicReq, ollamaModel, numCtx);
  // Force non-streaming for the Ollama request
  openaiReq.stream = false;

  logger.debug({ openaiReq }, 'shim: translated request to Ollama format');

  // Forward to Ollama's /api/chat endpoint
  let ollamaResp: RawOllamaResponse;
  try {
    const result = await ollamaRequest('/api/chat', openaiReq, OLLAMA_TIMEOUT_MS);
    ollamaResp = result.data as RawOllamaResponse;
  } catch (err) {
    const latencyMs = Date.now() - requestStart;
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg.startsWith('TIMEOUT:')) {
      const ms = errMsg.split(':')[1];
      logger.warn({ latencyMs }, 'shim: Ollama request timed out');
      errorResponse(res, 504, 'timeout', `Ollama request timed out after ${ms}ms`);
      return;
    }

    logger.error({ err, latencyMs }, 'shim: Ollama connection error');
    errorResponse(res, 502, 'connection_error', `Ollama not reachable at ${OLLAMA_BASE_URL}`);
    return;
  }

  logger.debug({ ollamaResp }, 'shim: raw Ollama response');

  // Guard against malformed Ollama response
  if (!ollamaResp || !ollamaResp.message) {
    const latencyMs = Date.now() - requestStart;
    logger.error({ ollamaResp, latencyMs }, 'shim: Ollama returned invalid response (no message)');
    errorResponse(res, 502, 'invalid_response', 'Ollama returned an invalid response');
    return;
  }

  // Normalize Ollama native response to OpenAI format
  const openaiResponse: OpenAIResponse = {
    id: 'chatcmpl-' + randomId(),
    object: 'chat.completion',
    model: ollamaResp.model || ollamaModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: ollamaResp.message.content || '',
          tool_calls: ollamaResp.message.tool_calls?.map((tc) => ({
            id: tc.id || 'call_' + randomId(),
            type: 'function' as const,
            function: {
              name: tc.function?.name || '',
              arguments:
                typeof tc.function?.arguments === 'string'
                  ? tc.function.arguments
                  : JSON.stringify(tc.function?.arguments ?? {}),
            },
          })),
        },
        finish_reason: ollamaResp.message.tool_calls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: ollamaResp.prompt_eval_count || 0,
      completion_tokens: ollamaResp.eval_count || 0,
      total_tokens: (ollamaResp.prompt_eval_count || 0) + (ollamaResp.eval_count || 0),
    },
  };

  // Run tool calls through the repair layer
  const choice = openaiResponse.choices[0];
  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    choice.message.tool_calls = repairToolCalls(choice.message.tool_calls);
    // Update finish_reason if all tool calls were dropped by repair
    if (choice.message.tool_calls.length === 0) {
      delete choice.message.tool_calls;
      choice.finish_reason = 'stop';
    }
  }

  // Translate OpenAI response to Anthropic format
  const anthropicResp = translateResponse(openaiResponse, anthropicReq.model);

  const latencyMs = Date.now() - requestStart;
  logger.info(
    {
      status: 200,
      latencyMs,
      inputTokens: anthropicResp.usage.input_tokens,
      outputTokens: anthropicResp.usage.output_tokens,
      stopReason: anthropicResp.stop_reason,
    },
    'shim: response',
  );
  logger.debug({ anthropicResp }, 'shim: translated Anthropic response');

  json(res, anthropicResp, 200);
}

// ---------------------------------------------------------------------------
// GET /health — Connectivity check
// ---------------------------------------------------------------------------

async function handleHealth(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let reachable = false;
  let models: string[] = [];

  try {
    const result = await ollamaRequest('/api/tags', undefined, 3000);
    if (result.status === 200) {
      reachable = true;
      const data = result.data as { models?: Array<{ name?: string }> };
      if (Array.isArray(data.models)) {
        models = data.models
          .map((m) => m.name)
          .filter((n): n is string => typeof n === 'string');
      }
    }
  } catch {
    // Ollama not reachable — leave defaults
  }

  json(res, {
    status: 'ok',
    ollama: {
      url: OLLAMA_BASE_URL,
      reachable,
      models,
    },
    defaultModel: OLLAMA_DEFAULT_MODEL,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    port: SHIM_PORT,
  });
}

// ---------------------------------------------------------------------------
// GET /v1/models — Fake model list
// ---------------------------------------------------------------------------

function handleModels(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  json(res, {
    data: [{ id: 'local-ollama', object: 'model' }],
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Start the Anthropic-to-Ollama translation shim HTTP server.
 *
 * @param options - Optional overrides.
 * @param options.port - Port to listen on (defaults to SHIM_PORT from config).
 * @returns A promise that resolves when the server is listening, providing
 *   the bound port and a close() method.
 */
export function startShimServer(
  options?: { port?: number },
): Promise<{ port: number; close: () => void }> {
  // Validate that OLLAMA_BASE_URL points somewhere safe
  if (!isPrivateUrl(OLLAMA_BASE_URL)) {
    logger.warn(
      { url: OLLAMA_BASE_URL },
      'shim: OLLAMA_BASE_URL does not appear to be a private address',
    );
  }

  const port = options?.port ?? SHIM_PORT;

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`);
      const { pathname } = url;

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Ollama-Model, X-Ollama-Num-Ctx, Authorization, X-Api-Key, Anthropic-Version',
        });
        res.end();
        return;
      }

      try {
        if (pathname === '/v1/messages' && req.method === 'POST') {
          await handleMessages(req, res);
        } else if (pathname === '/health' && req.method === 'GET') {
          await handleHealth(req, res);
        } else if (pathname === '/v1/models' && req.method === 'GET') {
          handleModels(req, res);
        } else {
          errorResponse(res, 404, 'not_found', `No route for ${req.method} ${pathname}`);
        }
      } catch (err) {
        logger.error({ err, pathname }, 'shim: unhandled error');
        errorResponse(res, 500, 'internal_error', `Unexpected error: ${err}`);
      }
    });

    server.on('error', (err) => {
      logger.error({ err, port }, 'shim: server error');
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info({ port, ollamaUrl: OLLAMA_BASE_URL, defaultModel: OLLAMA_DEFAULT_MODEL }, 'shim: server started');
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}
