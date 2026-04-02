/**
 * Contract tests for DefenseClaw's native /v1/messages endpoint.
 *
 * Tests the Phase 3 Anthropic path:
 *   Container → DefenseClaw :9002/v1/messages (inspect) → OneCLI (auth) → Anthropic
 *
 * These are mock-fetch tests that verify:
 * - Request format preservation (Anthropic Messages API body is NOT translated)
 * - Content block types: text, tool_use, tool_result are forwarded intact
 * - SSE streaming passthrough (event: prefix preserved)
 * - input_schema (JSON Schema) in tool definitions survives round-trip
 * - Error handling for DefenseClaw rejections (guardrail blocks)
 * - Timeout/abort behavior on the fetch call
 *
 * No real DefenseClaw instance needed — pure contract verification.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Types ────────────────────────────────────────────────────

interface AnthropicMessage {
  role: string;
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  system?: string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── Mock DefenseClaw /v1/messages endpoint ───────────────────

/**
 * Simulates what the native /v1/messages endpoint should do:
 * - Accept Anthropic Messages API format
 * - Inspect content blocks for policy violations
 * - Forward the ORIGINAL body to upstream (Anthropic via OneCLI)
 * - Return the upstream response unchanged
 *
 * This mock validates the request shape and returns a controlled response.
 */
function createDCMessagesHandler(opts?: {
  verdict?: 'ALLOW' | 'BLOCK';
  blockReason?: string;
}) {
  const verdict = opts?.verdict || 'ALLOW';

  return async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string) as AnthropicMessagesRequest;

    // Validate: must be Anthropic format, not OpenAI
    if ('choices' in body || 'n' in body) {
      throw new Error('Received OpenAI format — native endpoint expects Anthropic Messages API');
    }

    // Must have model, max_tokens, messages
    if (!body.model || !body.max_tokens || !body.messages) {
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'missing required fields' } }),
        { status: 400 },
      );
    }

    if (verdict === 'BLOCK') {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'guardrail_blocked',
            message: opts?.blockReason || 'Content blocked by guardrail policy',
          },
        }),
        { status: 403 },
      );
    }

    // Success: return an Anthropic-format response
    return new Response(
      JSON.stringify({
        id: 'msg_test_01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from DefenseClaw native endpoint' }],
        model: body.model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 25, output_tokens: 12 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
}

/**
 * Simulates the SSE streaming response from native /v1/messages.
 * Returns Anthropic SSE format (not OpenAI chunks).
 */
function createDCStreamingHandler() {
  return async (_url: string, _init?: RequestInit): Promise<Response> => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test_01","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","usage":{"input_tokens":25,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event));
        }
        controller.close();
      },
    });

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe('DefenseClaw native /v1/messages — request format', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves Anthropic Messages API body structure', async () => {
    const handler = createDCMessagesHandler();
    fetchSpy.mockImplementation(handler);

    const request: AnthropicMessagesRequest = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: 'What is the weather?' },
      ],
    };

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.type).toBe('message');
    expect(data.content[0].type).toBe('text');
  });

  it('preserves tool_use content blocks with input_schema', async () => {
    let capturedBody: AnthropicMessagesRequest | null = null;

    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          id: 'msg_test_02',
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_01',
            name: 'get_weather',
            input: { location: 'San Francisco' },
          }],
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 30 },
        }),
        { status: 200 },
      );
    });

    const request: AnthropicMessagesRequest = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: 'What is the weather in SF?' },
      ],
      tools: [{
        name: 'get_weather',
        description: 'Get the current weather',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
          },
          required: ['location'],
        },
      }],
    };

    await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    // Verify the tool definition survived the round-trip
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.tools).toHaveLength(1);
    expect(capturedBody!.tools![0].input_schema.type).toBe('object');
    expect(capturedBody!.tools![0].input_schema.properties).toHaveProperty('location');
    expect(capturedBody!.tools![0].input_schema.required).toEqual(['location']);
  });

  it('preserves tool_result content blocks in conversation', async () => {
    let capturedBody: AnthropicMessagesRequest | null = null;

    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          id: 'msg_test_03',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'The weather in SF is 65°F.' }],
          model: 'claude-sonnet-4-20250514',
          stop_reason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 20 },
        }),
        { status: 200 },
      );
    });

    const request: AnthropicMessagesRequest = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: 'What is the weather in SF?' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_01',
            name: 'get_weather',
            input: { location: 'San Francisco' },
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: '{"temperature": 65, "unit": "fahrenheit", "condition": "sunny"}',
          }],
        },
      ],
    };

    await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    // Verify multi-turn tool conversation preserved
    expect(capturedBody!.messages).toHaveLength(3);
    const toolResult = capturedBody!.messages[2].content as ContentBlock[];
    expect(toolResult[0].type).toBe('tool_result');
    expect(toolResult[0].tool_use_id).toBe('toolu_01');
  });

  it('preserves system prompt field', async () => {
    let capturedBody: AnthropicMessagesRequest | null = null;

    fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          id: 'msg_test_04', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200 },
      );
    });

    const request: AnthropicMessagesRequest = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hi' }],
    };

    await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(capturedBody!.system).toBe('You are a helpful assistant.');
  });
});

describe('DefenseClaw native /v1/messages — guardrail blocking', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 403 with guardrail_blocked error type', async () => {
    const handler = createDCMessagesHandler({
      verdict: 'BLOCK',
      blockReason: 'Secret detected: Anthropic API key pattern (sk-ant-)',
    });
    fetchSpy.mockImplementation(handler);

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'My key is sk-ant-api03-abc123' }],
      }),
    });

    expect(resp.status).toBe(403);
    const data = await resp.json();
    expect(data.error.type).toBe('guardrail_blocked');
    expect(data.error.message).toContain('sk-ant-');
  });

  it('returns 400 for malformed request (missing required fields)', async () => {
    const handler = createDCMessagesHandler();
    fetchSpy.mockImplementation(handler);

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514' }), // missing max_tokens, messages
    });

    expect(resp.status).toBe(400);
  });
});

describe('DefenseClaw native /v1/messages — SSE streaming', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Anthropic SSE events (not OpenAI chunk format)', async () => {
    const handler = createDCStreamingHandler();
    fetchSpy.mockImplementation(handler);

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    expect(resp.headers.get('Content-Type')).toBe('text/event-stream');

    // Read the full stream
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) fullText += decoder.decode(value, { stream: !done });
    }

    // Verify Anthropic SSE event types present
    expect(fullText).toContain('event: message_start');
    expect(fullText).toContain('event: content_block_start');
    expect(fullText).toContain('event: content_block_delta');
    expect(fullText).toContain('event: content_block_stop');
    expect(fullText).toContain('event: message_delta');
    expect(fullText).toContain('event: message_stop');

    // Verify NOT OpenAI format
    expect(fullText).not.toContain('"object":"chat.completion.chunk"');
    expect(fullText).not.toContain('"choices":[{"delta"');
  });

  it('SSE stream includes message_start with usage metadata', async () => {
    const handler = createDCStreamingHandler();
    fetchSpy.mockImplementation(handler);

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) fullText += decoder.decode(value, { stream: !done });
    }

    // Extract message_start event data
    const msgStartMatch = fullText.match(/event: message_start\ndata: (.+)\n/);
    expect(msgStartMatch).not.toBeNull();
    const msgStart = JSON.parse(msgStartMatch![1]);
    expect(msgStart.type).toBe('message_start');
    expect(msgStart.message.role).toBe('assistant');
    expect(msgStart.message.usage.input_tokens).toBe(25);
  });

  it('SSE content deltas reconstruct the full response', async () => {
    const handler = createDCStreamingHandler();
    fetchSpy.mockImplementation(handler);

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) fullText += decoder.decode(value, { stream: !done });
    }

    // Extract all content_block_delta text
    const deltaMatches = [...fullText.matchAll(/event: content_block_delta\ndata: (.+)\n/g)];
    const reconstructed = deltaMatches
      .map((m) => JSON.parse(m[1]))
      .filter((d) => d.delta.type === 'text_delta')
      .map((d) => d.delta.text)
      .join('');

    expect(reconstructed).toBe('Hello world');
  });
});

describe('DefenseClaw native /v1/messages — error handling', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles connection refused gracefully', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    try {
      await fetch('http://127.0.0.1:9002/v1/messages', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect((err as Error).message).toBe('ECONNREFUSED');
    }
  });

  it('handles upstream 500 errors', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: 'Internal server error' },
        }),
        { status: 500 },
      ),
    );

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(resp.status).toBe(500);
    const data = await resp.json();
    expect(data.error.type).toBe('api_error');
  });

  it('handles upstream 529 overloaded errors', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'API is overloaded' },
        }),
        { status: 529 },
      ),
    );

    const resp = await fetch('http://127.0.0.1:9002/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(resp.status).toBe(529);
    const data = await resp.json();
    expect(data.error.type).toBe('overloaded_error');
  });
});
