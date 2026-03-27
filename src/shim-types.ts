/**
 * shim-types.ts — TypeScript interfaces for both Anthropic Messages API
 * and OpenAI Chat Completions API (as spoken by Ollama).
 *
 * Pure type definitions, no runtime code. Consumed by shim-tool-translator
 * and the shim HTTP server.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Standard JSON Schema object (subset used by both APIs). */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  description?: string;
  items?: JSONSchema;
  enum?: unknown[];
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

/** Text content block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Tool use content block (appears in assistant responses). */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Tool result content block (appears in user messages). */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
}

/** Union of all content block types. */
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** A single message in the Anthropic Messages API. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** Tool definition in the Anthropic format. */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

/**
 * Anthropic tool_choice parameter.
 * - `"auto"` — model decides
 * - `"any"` — model must call at least one tool
 * - `{ type: "tool", name: "X" }` — force a specific tool
 */
export type AnthropicToolChoice =
  | "auto"
  | "any"
  | { type: "tool"; name: string };

/** Token usage reported by the Anthropic API. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Full Anthropic Messages API request body. */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicToolDef[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
}

/** Full Anthropic Messages API response body. */
export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions API (Ollama-compatible)
// ---------------------------------------------------------------------------

/** Function descriptor inside an OpenAI tool call. */
export interface OpenAIFunctionCall {
  name: string;
  /** Stringified JSON in spec; Ollama may return a parsed object. */
  arguments: string | Record<string, unknown>;
}

/**
 * A single tool call in an OpenAI assistant message.
 *
 * Ollama adds a non-standard `function.index` field — the shim strips it
 * during translation.
 */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: OpenAIFunctionCall;
}

/**
 * Raw tool call as received from Ollama, before repair.
 * May have `function.index` and other non-standard fields.
 */
export interface RawOllamaToolCall {
  id?: string;
  type?: "function";
  function?: {
    index?: number;
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
}

/** A message in the OpenAI Chat Completions format. */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  /** Present when role is "tool" — references the tool call this responds to. */
  tool_call_id?: string;
}

/** Tool definition in the OpenAI format. */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/**
 * OpenAI tool_choice parameter.
 * - `"auto"` — model decides
 * - `"none"` — no tool calls
 * - `"required"` — must call at least one tool
 * - `{ type: "function", function: { name: "X" } }` — force a specific tool
 */
export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/** A single choice in the OpenAI response. */
export interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: "stop" | "length" | "tool_calls" | null;
}

/** Token usage reported by the OpenAI API / Ollama. */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Full OpenAI Chat Completions API request body (with Ollama extensions). */
export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  tool_choice?: OpenAIToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  /** Ollama-specific: runtime options. */
  options?: {
    num_ctx?: number;
    [key: string]: unknown;
  };
}

/**
 * Full OpenAI Chat Completions API response body.
 *
 * Ollama also returns top-level fields like `done`, `done_reason`,
 * `total_duration`, etc. — those are ignored by the shim.
 */
export interface OpenAIResponse {
  id: string;
  object: string;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

/**
 * Raw Ollama response shape (superset of OpenAI).
 * Includes Ollama-specific timing fields and the non-standard
 * top-level message field (used when NOT in OpenAI-compat mode).
 */
export interface RawOllamaResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
    tool_calls?: RawOllamaToolCall[];
  };
  done: boolean;
  done_reason: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}
