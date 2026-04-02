/**
 * Shared Ollama client — single cutover point for all pipeline scripts.
 *
 * Routes inference through DefenseClaw when DEFENSECLAW_OLLAMA_URL is set.
 * Embedding calls always go direct to Ollama (DefenseClaw doesn't inspect embeddings).
 *
 * IMPORTANT: A parallel copy exists at dashboard/src/lib/ollama-client.ts for
 * Next.js dashboard routes. Next.js can't import outside its root, so the logic
 * is duplicated. Any changes to routing, health-check, or format translation
 * logic MUST be applied to both files. The dashboard copy omits ollamaEmbed
 * and the images parameter (dashboard routes don't use these).
 *
 * Usage:
 *   import { ollamaChat, ollamaEmbed } from './lib/ollama-client.js';
 *   const result = await ollamaChat({ model: 'gemma3:27b', messages, options: { num_ctx: 16384 } });
 */

const OLLAMA_URL = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://studio.shearer.live:11434";
const DEFENSECLAW_URL = process.env.DEFENSECLAW_OLLAMA_URL || "";
const DEFENSECLAW_KEY = process.env.DEFENSECLAW_KEY || "";
const DEFENSECLAW_FAIL_OPEN = process.env.DEFENSECLAW_FAIL_OPEN === "true";

// Health-check poll state — pre-computed failover, not discovered on real requests
let defenseClawHealthy = true;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function startHealthCheck(): void {
  if (!DEFENSECLAW_URL || healthCheckInterval) return;
  healthCheckInterval = setInterval(async () => {
    try {
      const resp = await fetch(`${DEFENSECLAW_URL}/health/liveliness`, {
        signal: AbortSignal.timeout(3000),
      });
      defenseClawHealthy = resp.ok;
    } catch {
      defenseClawHealthy = false;
    }
  }, 10000);
  // Don't keep process alive just for health checks
  healthCheckInterval.unref?.();
}

if (DEFENSECLAW_URL) startHealthCheck();

// ── Chat completion ──────────────────────

export interface OllamaChatOptions {
  model: string;
  messages: { role: string; content: string }[];
  options?: { num_ctx?: number; temperature?: number };
  timeoutMs?: number;
  images?: string[]; // For vision models (Boox OCR)
}

export interface OllamaChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  rawResponse?: string; // For debugging
}

export async function ollamaChat(opts: OllamaChatOptions): Promise<OllamaChatResult> {
  const start = Date.now();
  const timeout = opts.timeoutMs || 120000;
  const useDefenseClaw = DEFENSECLAW_URL && defenseClawHealthy;

  if (DEFENSECLAW_URL && !defenseClawHealthy && !DEFENSECLAW_FAIL_OPEN) {
    throw new Error("DefenseClaw is unhealthy and DEFENSECLAW_FAIL_OPEN is not set");
  }

  if (useDefenseClaw) {
    return chatViaDefenseClaw(opts, timeout, start);
  }
  return chatViaNativeOllama(opts, timeout, start);
}

/** Send in OpenAI format through DefenseClaw → Ollama */
async function chatViaDefenseClaw(
  opts: OllamaChatOptions, timeout: number, start: number
): Promise<OllamaChatResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (DEFENSECLAW_KEY) headers["Authorization"] = `Bearer ${DEFENSECLAW_KEY}`;

  const body = {
    model: opts.model,
    messages: opts.messages.map((m) => {
      // Vision: attach images as content array if present
      if (m.role === "user" && opts.images?.length) {
        return {
          role: m.role,
          content: [
            { type: "text", text: m.content },
            ...opts.images.map((img) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${img}` } })),
          ],
        };
      }
      return m;
    }),
    max_tokens: 4096,
    stream: false,
    ...(opts.options?.temperature !== undefined && { temperature: opts.options.temperature }),
  };

  const resp = await fetch(`${DEFENSECLAW_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`DefenseClaw ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content || "";
  return {
    content: content.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    latencyMs: Date.now() - start,
  };
}

/** Send in Ollama native format directly */
async function chatViaNativeOllama(
  opts: OllamaChatOptions, timeout: number, start: number
): Promise<OllamaChatResult> {
  const messages: any[] = opts.messages.map((m) => {
    if (m.role === "user" && opts.images?.length) {
      return { role: m.role, content: m.content, images: opts.images };
    }
    return m;
  });

  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: false,
      options: opts.options || {},
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!resp.ok) {
    throw new Error(`Ollama ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json() as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const content = data.message?.content || "";
  return {
    content: content.replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
    promptTokens: data.prompt_eval_count || 0,
    completionTokens: data.eval_count || 0,
    latencyMs: Date.now() - start,
  };
}

// ── Embeddings (always direct to Ollama, bypasses DefenseClaw) ──────────────────────

export interface OllamaEmbedOptions {
  model?: string;
  input: string | string[];
}

export async function ollamaEmbed(opts: OllamaEmbedOptions): Promise<number[][]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model || "nomic-embed-text",
      input: opts.input,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) throw new Error(`Ollama embed ${resp.status}`);
  const data = await resp.json() as { embeddings: number[][] };
  return data.embeddings;
}
