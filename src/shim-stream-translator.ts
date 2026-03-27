/**
 * shim-stream-translator.ts — State machine that translates Ollama's
 * newline-delimited JSON streaming format into Anthropic SSE streaming events.
 *
 * Ollama sends chunks as `{"model":"...","message":{"role":"assistant","content":"..."},"done":false}\n`.
 * The Anthropic SDK expects SSE events like `event: content_block_delta\ndata: {...}\n\n`.
 *
 * This module bridges the two formats in real time, handling:
 * - Text content streaming
 * - Non-incremental tool calls (emitted as single input_json_delta)
 * - Multiple tool calls in a single response
 * - Partial TCP segments (buffered until newline)
 * - Missing tool call IDs (generated locally)
 *
 * Uses only Node.js built-ins. No external dependencies.
 */

import { randomBytes } from 'node:crypto';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** States the translator can be in. */
type StreamState = 'idle' | 'text_block' | 'tool_block';

/** A single Ollama streaming chunk (newline-delimited JSON). */
interface OllamaStreamChunk {
  model?: string;
  created_at?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: string | Record<string, unknown>;
      };
    }>;
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Options for constructing a StreamTranslator. */
interface StreamTranslatorOptions {
  /** The model string from the original Anthropic request (echoed back). */
  requestModel: string;
  /** Estimated input token count (from request). */
  inputTokens: number;
  /** Callback to emit an SSE event. Called as write(eventName, dataObject). */
  write: (event: string, data: unknown) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a message ID in the Anthropic `msg_` format. */
function generateMessageId(): string {
  return `msg_${randomBytes(12).toString('hex')}`;
}

/** Generate a tool use ID in the Anthropic `toolu_` format. */
function generateToolUseId(): string {
  return `toolu_${randomBytes(12).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// StreamTranslator
// ---------------------------------------------------------------------------

/**
 * Translates an Ollama streaming response (newline-delimited JSON) into
 * Anthropic SSE streaming events via a state machine.
 *
 * Usage:
 * ```
 * const translator = new StreamTranslator({ requestModel, inputTokens, write });
 * ollamaResponse.on('data', (buf) => translator.processChunk(buf.toString()));
 * ollamaResponse.on('end', () => translator.finalize());
 * ```
 */
export class StreamTranslator {
  private state: StreamState = 'idle';
  private blockIndex = 0;
  private buffer = '';
  private outputTokens = 0;
  private messageId: string;
  private requestModel: string;
  private inputTokens: number;
  private write: (event: string, data: unknown) => void;
  private finalized = false;

  constructor(options: StreamTranslatorOptions) {
    this.requestModel = options.requestModel;
    this.inputTokens = options.inputTokens;
    this.write = options.write;
    this.messageId = generateMessageId();
  }

  /**
   * Process raw data from the Ollama response stream.
   *
   * Ollama may split JSON objects across TCP segments, so we buffer
   * until we find complete newline-delimited lines.
   */
  processChunk(raw: string): void {
    this.buffer += raw;

    // Process all complete lines in the buffer
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      try {
        const chunk = JSON.parse(line) as OllamaStreamChunk;
        this.handleParsedChunk(chunk);
      } catch (err) {
        logger.warn(
          { line: line.slice(0, 200), err },
          'shim-stream: failed to parse Ollama chunk, skipping',
        );
      }
    }
  }

  /**
   * Finalize the stream after Ollama closes the connection.
   *
   * Handles any remaining buffered data and ensures all required
   * closing events are emitted even if the final `done:true` chunk
   * was missed.
   */
  finalize(): void {
    if (this.finalized) return;

    // Process any remaining data in the buffer
    const remaining = this.buffer.trim();
    if (remaining.length > 0) {
      try {
        const chunk = JSON.parse(remaining) as OllamaStreamChunk;
        this.handleParsedChunk(chunk);
      } catch (err) {
        logger.warn(
          { remaining: remaining.slice(0, 200), err },
          'shim-stream: failed to parse final buffer, skipping',
        );
      }
      this.buffer = '';
    }

    // If we never got a done:true, emit closing events now
    if (!this.finalized) {
      this.emitClosingEvents('end_turn');
    }
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  private handleParsedChunk(chunk: OllamaStreamChunk): void {
    if (this.finalized) return;

    const content = chunk.message?.content || '';
    const toolCalls = chunk.message?.tool_calls;
    const hasContent = content.length > 0;
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

    // Final chunk — emit closing events
    if (chunk.done) {
      // Capture output tokens from the final chunk
      if (chunk.eval_count != null) {
        this.outputTokens = chunk.eval_count;
      }

      // Determine stop reason
      const hasToolsInResponse = this.state === 'tool_block' || hasToolCalls;
      const stopReason = hasToolsInResponse ? 'tool_use' : 'end_turn';

      // Process any final content or tool calls before closing
      if (hasContent) {
        this.handleTextContent(content);
      }
      if (hasToolCalls) {
        this.handleToolCalls(toolCalls);
      }

      this.emitClosingEvents(stopReason);
      return;
    }

    // Non-final chunk with text content
    if (hasContent && !hasToolCalls) {
      this.handleTextContent(content);
      return;
    }

    // Non-final chunk with tool calls
    if (hasToolCalls) {
      // If there's also text content, emit it first
      if (hasContent) {
        this.handleTextContent(content);
      }
      this.handleToolCalls(toolCalls);
      return;
    }

    // Empty non-final chunk — ignore (Ollama sends these sometimes)
  }

  private handleTextContent(text: string): void {
    if (this.state === 'idle') {
      // First content — emit message_start and open a text block
      this.emitMessageStart();
      this.emitContentBlockStart({
        type: 'text',
        text: '',
      });
      this.state = 'text_block';
    } else if (this.state === 'tool_block') {
      // Transitioning from tool back to text (unusual but handle it)
      this.emitContentBlockStop();
      this.emitContentBlockStart({
        type: 'text',
        text: '',
      });
      this.state = 'text_block';
    }

    // Emit the text delta
    this.write('content_block_delta', {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: {
        type: 'text_delta',
        text,
      },
    });
  }

  private handleToolCalls(
    toolCalls: NonNullable<OllamaStreamChunk['message']>['tool_calls'],
  ): void {
    if (!toolCalls) return;

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      if (!name) {
        logger.warn(
          { toolCall: tc },
          'shim-stream: tool call missing function.name, skipping',
        );
        continue;
      }

      const toolId = tc.id || generateToolUseId();

      // Serialize arguments
      let argsJson: string;
      if (tc.function?.arguments == null) {
        argsJson = '{}';
      } else if (typeof tc.function.arguments === 'string') {
        argsJson = tc.function.arguments;
      } else {
        argsJson = JSON.stringify(tc.function.arguments);
      }

      if (this.state === 'idle') {
        // No prior content — emit message_start, then an empty text block
        // (Anthropic SDK expects a text block before tool_use blocks)
        this.emitMessageStart();
        this.emitContentBlockStart({ type: 'text', text: '' });
        this.emitContentBlockStop();
      } else if (this.state === 'text_block') {
        // Close the current text block
        this.emitContentBlockStop();
      } else if (this.state === 'tool_block') {
        // Close the previous tool block
        this.emitContentBlockStop();
      }

      // Open a new tool_use block
      this.emitContentBlockStart({
        type: 'tool_use',
        id: toolId,
        name,
        input: {},
      });
      this.state = 'tool_block';

      // Emit the entire arguments as a single input_json_delta
      // (Ollama sends tool calls non-incrementally)
      if (argsJson !== '{}') {
        this.write('content_block_delta', {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: argsJson,
          },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // SSE event emitters
  // -------------------------------------------------------------------------

  private emitMessageStart(): void {
    this.write('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.requestModel,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: 0,
        },
      },
    });
  }

  private emitContentBlockStart(block: Record<string, unknown>): void {
    this.write('content_block_start', {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: block,
    });
  }

  private emitContentBlockStop(): void {
    this.write('content_block_stop', {
      type: 'content_block_stop',
      index: this.blockIndex,
    });
    this.blockIndex++;
  }

  private emitClosingEvents(
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens',
  ): void {
    if (this.finalized) return;
    this.finalized = true;

    // Close any open block
    if (this.state === 'text_block' || this.state === 'tool_block') {
      this.emitContentBlockStop();
    }

    // If we never emitted anything (idle state), emit a minimal message
    if (this.state === 'idle') {
      this.emitMessageStart();
      this.emitContentBlockStart({ type: 'text', text: '' });
      this.emitContentBlockStop();
    }

    // message_delta with stop_reason and final output token count
    this.write('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        output_tokens: this.outputTokens,
      },
    });

    // message_stop
    this.write('message_stop', {
      type: 'message_stop',
    });
  }
}
