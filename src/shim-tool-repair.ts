/**
 * shim-tool-repair.ts — Safety net for malformed tool calls from local models.
 *
 * Local models (especially smaller ones) sometimes produce tool calls with
 * broken JSON in arguments, missing fields, or non-standard extras.
 * This module attempts to repair those into valid OpenAIToolCall objects.
 *
 * Uses only Node.js built-ins. No external dependencies.
 */

import { randomBytes } from "node:crypto";

import { logger } from "./logger.js";
import type { OpenAIToolCall } from "./shim-types.js";

/** Toggle repair processing. When false, tool calls pass through unmodified. */
export let repairEnabled = true;

/** Enable or disable the repair layer at runtime. */
export function setRepairEnabled(enabled: boolean): void {
  repairEnabled = enabled;
}

/**
 * Generate a random tool call ID in the same format Ollama uses.
 * Format: `call_` followed by 8 random hex characters.
 */
function generateCallId(): string {
  return `call_${randomBytes(4).toString("hex")}`;
}

/**
 * Attempt to strip trailing commas from a JSON string.
 *
 * Targets the common pattern of `{ "key": "value", }` produced by some
 * local models. Only removes commas that appear before closing braces
 * or brackets.
 */
function stripTrailingCommas(str: string): string {
  return str.replace(/,\s*([\]}])/g, "$1");
}

/**
 * Attempt to fix unquoted keys in a JSON-like string.
 *
 * Targets patterns like `{ key: "value" }` and converts them to
 * `{ "key": "value" }`. Only handles simple word-character keys.
 */
function fixUnquotedKeys(str: string): string {
  // Match `{ key:` or `, key:` patterns where key is not already quoted
  return str.replace(
    /([{,]\s*)([a-zA-Z_]\w*)\s*:/g,
    '$1"$2":',
  );
}

/**
 * Attempt to parse a potentially malformed JSON arguments value.
 *
 * Tries, in order:
 * 1. Direct JSON.parse
 * 2. Strip trailing commas, then parse
 * 3. Fix unquoted keys, then parse
 * 4. Both fixes combined, then parse
 * 5. Fall back to `{ raw: originalString }`
 *
 * @param raw - The raw arguments value (string).
 * @returns A parsed object, or `{ raw: string }` as last resort.
 */
function parseArguments(raw: string): Record<string, unknown> {
  // Attempt 1: direct parse
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // continue
  }

  // Attempt 2: strip trailing commas
  try {
    return JSON.parse(stripTrailingCommas(raw)) as Record<string, unknown>;
  } catch {
    // continue
  }

  // Attempt 3: fix unquoted keys
  try {
    return JSON.parse(fixUnquotedKeys(raw)) as Record<string, unknown>;
  } catch {
    // continue
  }

  // Attempt 4: both fixes
  try {
    return JSON.parse(
      stripTrailingCommas(fixUnquotedKeys(raw)),
    ) as Record<string, unknown>;
  } catch {
    // continue
  }

  // Give up — wrap raw string so downstream can at least see what the model said
  logger.warn({ raw }, "shim-repair: could not parse tool call arguments, wrapping as raw");
  return { raw };
}

/**
 * Attempt to repair a single tool call into a valid `OpenAIToolCall`.
 *
 * Handles these failure modes from local models:
 * - `arguments` is a JSON string instead of an object -> parse it
 * - `arguments` has trailing commas or unquoted keys -> fix and parse
 * - Missing `id` field -> generate one
 * - Missing `function.name` -> return null (unrecoverable)
 * - `function.index` present -> strip it
 *
 * @param toolCall - A raw tool call object (possibly malformed).
 * @returns A valid OpenAIToolCall, or null if the call is unrecoverable.
 */
export function repairToolCall(toolCall: unknown): OpenAIToolCall | null {
  if (!repairEnabled) {
    return toolCall as OpenAIToolCall;
  }

  // Must be an object at minimum
  if (toolCall == null || typeof toolCall !== "object") {
    logger.warn({ toolCall }, "shim-repair: tool call is not an object, skipping");
    return null;
  }

  const raw = toolCall as Record<string, unknown>;
  const fn = raw.function as Record<string, unknown> | undefined;

  // Missing function entirely
  if (!fn || typeof fn !== "object") {
    logger.warn({ toolCall }, "shim-repair: tool call missing function field, skipping");
    return null;
  }

  // Missing function.name is unrecoverable
  if (!fn.name || typeof fn.name !== "string") {
    logger.warn({ toolCall }, "shim-repair: tool call missing function.name, skipping");
    return null;
  }

  const repairs: string[] = [];

  // Repair: generate missing ID
  let id = raw.id as string | undefined;
  if (!id || typeof id !== "string") {
    id = generateCallId();
    repairs.push(`generated id ${id}`);
  }

  // Repair: strip function.index (Ollama-specific non-standard field)
  if ("index" in fn) {
    repairs.push(`stripped function.index=${fn.index}`);
  }

  // Repair: parse/fix arguments
  let args: string;
  const rawArgs = fn.arguments;
  if (rawArgs == null) {
    args = "{}";
    repairs.push("defaulted missing arguments to {}");
  } else if (typeof rawArgs === "string") {
    // Parse it — may need repair
    const parsed = parseArguments(rawArgs);
    args = JSON.stringify(parsed);
    if (rawArgs !== args) {
      repairs.push("parsed/repaired string arguments");
    }
  } else if (typeof rawArgs === "object") {
    // Already an object (Ollama's typical behavior) — stringify for spec compliance
    args = JSON.stringify(rawArgs);
  } else {
    args = JSON.stringify({ raw: String(rawArgs) });
    repairs.push(`coerced non-standard arguments type: ${typeof rawArgs}`);
  }

  if (repairs.length > 0) {
    logger.info(
      { toolName: fn.name, repairs },
      "shim-repair: repaired tool call",
    );
  }

  return {
    id,
    type: "function",
    function: {
      name: fn.name as string,
      arguments: args,
    },
  };
}

/**
 * Repair an array of tool calls, filtering out any that are unrecoverable.
 *
 * @param toolCalls - Array of raw tool call objects from the model.
 * @returns Array of valid OpenAIToolCall objects (unrecoverable calls removed).
 */
export function repairToolCalls(toolCalls: unknown[]): OpenAIToolCall[] {
  if (!repairEnabled) {
    return toolCalls as OpenAIToolCall[];
  }

  const results: OpenAIToolCall[] = [];
  let droppedCount = 0;

  for (const tc of toolCalls) {
    const repaired = repairToolCall(tc);
    if (repaired) {
      results.push(repaired);
    } else {
      droppedCount++;
    }
  }

  if (droppedCount > 0) {
    logger.warn(
      { droppedCount, totalReceived: toolCalls.length },
      "shim-repair: dropped unrecoverable tool calls",
    );
  }

  return results;
}
