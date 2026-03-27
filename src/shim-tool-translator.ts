/**
 * shim-tool-translator.ts — Bidirectional translation between Anthropic
 * Messages API and OpenAI Chat Completions API formats.
 *
 * All functions are pure (no side effects, no network). They are consumed
 * by the shim HTTP server to translate requests to Ollama and responses back.
 */

import { randomBytes } from 'node:crypto';

import type {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolChoice,
  AnthropicToolDef,
  AnthropicUsage,
  ContentBlock,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIToolDef,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from './shim-types.js';

// ---------------------------------------------------------------------------
// Tool definition translation (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

/**
 * Convert an array of Anthropic tool definitions to OpenAI format.
 *
 * Maps `input_schema` to `parameters` and wraps each tool in the
 * `{ type: "function", function: { ... } }` envelope that the OpenAI
 * Chat Completions API (and Ollama) expects.
 */
export function translateToolDefs(tools: AnthropicToolDef[]): OpenAIToolDef[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Tool choice translation (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

/**
 * Convert an Anthropic `tool_choice` value to its OpenAI equivalent.
 *
 * Mapping:
 * - `"auto"` -> `"auto"`
 * - `"any"` -> `"required"` (must call at least one tool)
 * - `{ type: "tool", name: "X" }` -> `{ type: "function", function: { name: "X" } }`
 */
export function translateToolChoice(
  choice: AnthropicToolChoice,
): OpenAIToolChoice {
  if (choice === 'auto') return 'auto';
  if (choice === 'any') return 'required';
  // Specific tool forced
  return {
    type: 'function' as const,
    function: { name: choice.name },
  };
}

// ---------------------------------------------------------------------------
// Request message translation (Anthropic → OpenAI)
// ---------------------------------------------------------------------------

/**
 * Convert Anthropic message history to OpenAI message format.
 *
 * - Prepends a system message if `system` is provided.
 * - String content passes through directly.
 * - ContentBlock arrays are decomposed:
 *   - TextBlock entries are concatenated into the message `content` string.
 *   - ToolResultBlock entries become separate `{ role: "tool" }` messages.
 *   - ToolUseBlock entries in assistant messages are mapped to `tool_calls`.
 *
 * @param messages - The Anthropic message array.
 * @param system - Optional system prompt to prepend.
 * @returns Ordered array of OpenAI-formatted messages.
 */
export function translateRequestMessages(
  messages: AnthropicMessage[],
  system?: string,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // Prepend system message if present
  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    // Simple string content — pass through
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Content is an array of blocks — need to decompose
    const blocks = msg.content;

    if (msg.role === 'assistant') {
      // Assistant messages may contain text + tool_use blocks
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              // Ollama expects arguments as an object, not stringified JSON
              arguments: block.input as unknown as string,
            },
          });
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('') || null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    } else {
      // User messages may contain text + tool_result blocks
      const textParts: string[] = [];
      const toolResults: { tool_call_id: string; content: string }[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_result') {
          const resultContent = serializeToolResultContent(block.content);
          toolResults.push({
            tool_call_id: block.tool_use_id,
            content: resultContent,
          });
        }
      }

      // Emit the text part as a user message (if any)
      if (textParts.length > 0) {
        result.push({ role: 'user', content: textParts.join('') });
      }

      // Emit each tool result as a separate tool message
      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.tool_call_id,
        });
      }
    }
  }

  return result;
}

/**
 * Serialize a ToolResultBlock's content to a plain string.
 * If the content is already a string, return it. If it is an array of
 * ContentBlocks, concatenate the text blocks.
 */
function serializeToolResultContent(
  content: ToolResultBlock['content'],
): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ---------------------------------------------------------------------------
// Response translation (OpenAI/Ollama → Anthropic)
// ---------------------------------------------------------------------------

/**
 * Generate a unique message ID with the `msg_` prefix used by the Anthropic API.
 */
function generateMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}

/**
 * Convert an OpenAI Chat Completions response (or Ollama native response
 * normalized to OpenAI shape) into an Anthropic Messages API response.
 *
 * Handles the known Ollama quirks:
 * - Strips `function.index` from tool calls.
 * - Detects tool_use from `message.tool_calls` presence (not stop reason).
 * - Parses `arguments` if it arrives as a string.
 * - Emits an empty text block before tool_use blocks when content is empty.
 *
 * @param ollamaResp - The OpenAI-formatted response from Ollama.
 * @param requestModel - The model string from the original Anthropic request
 *   (preserved in the response for client compatibility).
 * @returns An Anthropic Messages API response body.
 */
export function translateResponse(
  ollamaResp: OpenAIResponse,
  requestModel: string,
): AnthropicResponse {
  const choice = ollamaResp.choices?.[0];
  const message = choice?.message;

  const contentBlocks: ContentBlock[] = [];
  const hasToolCalls =
    Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;

  // Text content
  const textContent = message?.content ?? '';
  const hasText = typeof textContent === 'string' && textContent.length > 0;

  if (hasText) {
    contentBlocks.push({ type: 'text', text: textContent });
  } else if (hasToolCalls) {
    // Emit empty text block before tool_use blocks (Anthropic SDK may expect it)
    contentBlocks.push({ type: 'text', text: '' });
  }

  // Tool use blocks
  if (hasToolCalls) {
    for (const tc of message.tool_calls!) {
      const fn = tc.function as OpenAIToolCall['function'] & {
        index?: number;
      };
      // Strip the non-standard `index` field
      const { index: _index, ...cleanFn } = fn;

      // Parse arguments: may be string (spec) or object (Ollama)
      let input: Record<string, unknown>;
      if (typeof cleanFn.arguments === 'string') {
        try {
          input = JSON.parse(cleanFn.arguments) as Record<string, unknown>;
        } catch {
          input = { raw: cleanFn.arguments };
        }
      } else {
        input = cleanFn.arguments as Record<string, unknown>;
      }

      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: cleanFn.name,
        input,
      } satisfies ToolUseBlock);
    }
  }

  // Determine stop_reason: tool_calls presence wins over finish_reason
  let stopReason: AnthropicResponse['stop_reason'];
  if (hasToolCalls) {
    stopReason = 'tool_use';
  } else {
    const fr = choice?.finish_reason;
    if (fr === 'length') {
      stopReason = 'max_tokens';
    } else {
      // "stop" and anything else maps to "end_turn"
      stopReason = 'end_turn';
    }
  }

  // Map usage
  const usage: AnthropicUsage = {
    input_tokens: ollamaResp.usage?.prompt_tokens ?? 0,
    output_tokens: ollamaResp.usage?.completion_tokens ?? 0,
  };

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ---------------------------------------------------------------------------
// Full request translation (Anthropic → OpenAI/Ollama)
// ---------------------------------------------------------------------------

/**
 * Translate a complete Anthropic Messages API request into an OpenAI Chat
 * Completions request suitable for Ollama.
 *
 * - Replaces the model string with the actual Ollama model name.
 * - Sets `options.num_ctx` for context window sizing.
 * - Translates messages, tools, and tool_choice.
 *
 * @param anthropicReq - The incoming Anthropic-formatted request.
 * @param ollamaModel - The Ollama model tag to use (e.g. "qwen3-coder:30b").
 * @param numCtx - Context window size in tokens for Ollama.
 * @returns An OpenAI-formatted request body ready to POST to Ollama.
 */
export function translateRequest(
  anthropicReq: AnthropicRequest,
  ollamaModel: string,
  numCtx: number,
): OpenAIRequest {
  const req: OpenAIRequest = {
    model: ollamaModel,
    messages: translateRequestMessages(
      anthropicReq.messages,
      anthropicReq.system,
    ),
    stream: anthropicReq.stream ?? false,
    options: { num_ctx: numCtx },
  };

  // Optional fields — only include if set
  if (anthropicReq.max_tokens != null) {
    req.max_tokens = anthropicReq.max_tokens;
  }
  if (anthropicReq.temperature != null) {
    req.temperature = anthropicReq.temperature;
  }
  if (anthropicReq.top_p != null) {
    req.top_p = anthropicReq.top_p;
  }
  if (anthropicReq.stop_sequences != null) {
    req.stop = anthropicReq.stop_sequences;
  }
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    req.tools = translateToolDefs(anthropicReq.tools);
  }
  if (anthropicReq.tool_choice != null) {
    req.tool_choice = translateToolChoice(anthropicReq.tool_choice);
  }

  return req;
}
