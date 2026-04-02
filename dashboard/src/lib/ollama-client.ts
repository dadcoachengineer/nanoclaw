/**
 * Shared Ollama client for Next.js dashboard API routes.
 * Routes inference through DefenseClaw when DEFENSECLAW_OLLAMA_URL is set.
 *
 * IMPORTANT: This is a parallel copy of scripts/lib/ollama-client.ts.
 * Next.js can't import outside its root, so the core routing/health-check/
 * format-translation logic is duplicated here. Any changes to that logic
 * MUST be applied to both files. This copy omits ollamaEmbed and the images
 * parameter (dashboard routes don't use these).
 */

const OLLAMA_URL = process.env.OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://studio.shearer.live:11434";
const DEFENSECLAW_URL = process.env.DEFENSECLAW_OLLAMA_URL || "";
const DEFENSECLAW_KEY = process.env.DEFENSECLAW_KEY || "";
const DEFENSECLAW_FAIL_OPEN = process.env.DEFENSECLAW_FAIL_OPEN === "true";

let defenseClawHealthy = true;
let healthCheckStarted = false;

function startHealthCheck(): void {
  if (!DEFENSECLAW_URL || healthCheckStarted) return;
  healthCheckStarted = true;
  setInterval(async () => {
    try {
      const resp = await fetch(`${DEFENSECLAW_URL}/health/liveliness`, {
        signal: AbortSignal.timeout(3000),
      });
      defenseClawHealthy = resp.ok;
    } catch {
      defenseClawHealthy = false;
    }
  }, 10000).unref?.();
}

if (DEFENSECLAW_URL) startHealthCheck();

export interface OllamaChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export async function ollamaChat(opts: {
  model: string;
  messages: { role: string; content: string }[];
  options?: { num_ctx?: number; temperature?: number };
  timeoutMs?: number;
}): Promise<OllamaChatResult> {
  const start = Date.now();
  const timeout = opts.timeoutMs || 120000;
  const useDefenseClaw = DEFENSECLAW_URL && defenseClawHealthy;

  if (DEFENSECLAW_URL && !defenseClawHealthy && !DEFENSECLAW_FAIL_OPEN) {
    throw new Error("DefenseClaw is unhealthy and DEFENSECLAW_FAIL_OPEN is not set");
  }

  if (useDefenseClaw) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (DEFENSECLAW_KEY) headers["Authorization"] = `Bearer ${DEFENSECLAW_KEY}`;

    const resp = await fetch(`${DEFENSECLAW_URL}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        max_tokens: 4096,
        stream: false,
        ...(opts.options?.temperature !== undefined && { temperature: opts.options.temperature }),
      }),
      cache: "no-store" as RequestCache,
      signal: AbortSignal.timeout(timeout),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`DefenseClaw ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    return {
      content: (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      latencyMs: Date.now() - start,
    };
  }

  // Native Ollama path
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: false,
      options: opts.options || {},
    }),
    cache: "no-store" as RequestCache,
    signal: AbortSignal.timeout(timeout),
  });

  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${resp.statusText}`);

  const data = await resp.json() as any;
  return {
    content: (data.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(),
    promptTokens: data.prompt_eval_count || 0,
    completionTokens: data.eval_count || 0,
    latencyMs: Date.now() - start,
  };
}
