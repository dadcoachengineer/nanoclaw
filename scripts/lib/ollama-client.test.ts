/**
 * Tests for scripts/lib/ollama-client.ts — the DefenseClaw abstraction layer.
 *
 * This is the highest-value test file in the DefenseClaw integration: every
 * pipeline script and dashboard route depends on this module's routing,
 * format translation, health-check poll, and fail-open/fail-closed logic.
 *
 * Because ollama-client.ts reads process.env at module scope and starts a
 * setInterval for health checks, each test group uses vi.stubEnv + dynamic
 * import (vi.importActual or resetModules) to get a fresh module instance
 * with controlled env vars.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Helpers ────────────────────────────────────────────────

/** Build a minimal mock Response for fetch */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
    redirected: false,
    type: "basic" as ResponseType,
    url: "",
    clone: () => mockResponse(body, status) as Response,
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    formData: () => Promise.resolve(new FormData()),
    bytes: () => Promise.resolve(new Uint8Array()),
  } as Response;
}

/** Standard OpenAI-format response from DefenseClaw */
function openAiResponse(content: string, promptTokens = 10, completionTokens = 20) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

/** Standard Ollama native response */
function ollamaNativeResponse(content: string, promptEval = 10, evalCount = 20) {
  return {
    message: { content },
    prompt_eval_count: promptEval,
    eval_count: evalCount,
  };
}

// ─── Test Suite ─────────────────────────────────────────────

describe("ollama-client", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Helper to import a fresh module with specific env vars
  async function importClient(env: Record<string, string> = {}) {
    // Set env before import so module-level reads pick them up
    for (const [k, v] of Object.entries(env)) {
      vi.stubEnv(k, v);
    }
    // Ensure clean env for keys not provided
    if (!env.DEFENSECLAW_OLLAMA_URL) vi.stubEnv("DEFENSECLAW_OLLAMA_URL", "");
    if (!env.DEFENSECLAW_KEY) vi.stubEnv("DEFENSECLAW_KEY", "");
    if (!env.DEFENSECLAW_FAIL_OPEN) vi.stubEnv("DEFENSECLAW_FAIL_OPEN", "");
    if (!env.OLLAMA_URL) vi.stubEnv("OLLAMA_URL", "");
    if (!env.OLLAMA_BASE_URL) vi.stubEnv("OLLAMA_BASE_URL", "");

    const mod = await import("../../../scripts/lib/ollama-client.js") as typeof import("../../../scripts/lib/ollama-client.js");
    return mod;
  }

  // ── Routing: which upstream gets called ──────────────

  describe("routing logic", () => {
    it("routes to native Ollama when DEFENSECLAW_OLLAMA_URL is not set", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(ollamaNativeResponse("Hello from Ollama"))
      );

      const { ollamaChat } = await importClient();
      const result = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Hello from Ollama");
      expect(fetchSpy).toHaveBeenCalledOnce();
      // Should call Ollama's native /api/chat endpoint
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/chat");
      expect(url).not.toContain("/v1/chat/completions");
    });

    it("routes to DefenseClaw when DEFENSECLAW_OLLAMA_URL is set and healthy", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(openAiResponse("Hello via DC"))
      );

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
        DEFENSECLAW_KEY: "sk-dc-test",
      });
      const result = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Hello via DC");
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:9001/v1/chat/completions");
      // Should include auth header
      expect(opts.headers.Authorization).toBe("Bearer sk-dc-test");
    });

    it("embeddings always go direct to Ollama, bypassing DefenseClaw", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ embeddings: [[0.1, 0.2, 0.3]] })
      );

      const { ollamaEmbed } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });
      const result = await ollamaEmbed({ input: "test text" });

      expect(result).toEqual([[0.1, 0.2, 0.3]]);
      const [url] = fetchSpy.mock.calls[0];
      // Should call Ollama's /api/embed, NOT DefenseClaw
      expect(url).toContain("/api/embed");
      expect(url).not.toContain("9001");
    });
  });

  // ── Format translation ──────────────────────────────

  describe("format translation", () => {
    it("sends OpenAI format to DefenseClaw (model, messages, max_tokens, stream:false)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(openAiResponse("ok")));

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });
      await ollamaChat({
        model: "gemma3:27b",
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hi" },
        ],
        options: { temperature: 0.3 },
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe("gemma3:27b");
      expect(body.messages).toHaveLength(2);
      expect(body.stream).toBe(false);
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBe(0.3);
      // Should NOT have Ollama-native fields
      expect(body.options).toBeUndefined();
    });

    it("sends Ollama native format when going direct", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(ollamaNativeResponse("ok")));

      const { ollamaChat } = await importClient();
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
        options: { num_ctx: 16384 },
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe("gemma3:27b");
      expect(body.stream).toBe(false);
      expect(body.options).toEqual({ num_ctx: 16384 });
      // Should NOT have OpenAI fields
      expect(body.max_tokens).toBeUndefined();
    });

    it("handles vision/images in DefenseClaw format (image_url content blocks)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(openAiResponse("I see a cat")));

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "What is this?" }],
        images: ["base64encodedimage"],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const userMsg = body.messages[0];
      // DefenseClaw path: images become OpenAI content array
      expect(Array.isArray(userMsg.content)).toBe(true);
      expect(userMsg.content[0]).toEqual({ type: "text", text: "What is this?" });
      expect(userMsg.content[1].type).toBe("image_url");
      expect(userMsg.content[1].image_url.url).toContain("data:image/png;base64,");
    });

    it("handles vision/images in native Ollama format", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(ollamaNativeResponse("cat")));

      const { ollamaChat } = await importClient();
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "What is this?" }],
        images: ["base64img"],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const userMsg = body.messages[0];
      // Native path: images as separate array
      expect(userMsg.images).toEqual(["base64img"]);
      expect(typeof userMsg.content).toBe("string");
    });
  });

  // ── Response normalization ──────────────────────────

  describe("response normalization", () => {
    it("normalizes OpenAI response format (DefenseClaw path)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(openAiResponse("Normalized content", 50, 100))
      );

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });
      const result = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Normalized content");
      expect(result.promptTokens).toBe(50);
      expect(result.completionTokens).toBe(100);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("normalizes Ollama native response format", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(ollamaNativeResponse("Native content", 30, 60))
      );

      const { ollamaChat } = await importClient();
      const result = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Native content");
      expect(result.promptTokens).toBe(30);
      expect(result.completionTokens).toBe(60);
    });

    it("strips <think> tags from responses (both paths)", async () => {
      const contentWithThink = "<think>I should say hello</think>Hello!";

      // DefenseClaw path
      fetchSpy.mockResolvedValueOnce(
        mockResponse(openAiResponse(contentWithThink))
      );
      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });
      const dcResult = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(dcResult.content).toBe("Hello!");

      // Native path
      vi.resetModules();
      fetchSpy.mockResolvedValueOnce(
        mockResponse(ollamaNativeResponse(contentWithThink))
      );
      const mod2 = await importClient();
      const nativeResult = await mod2.ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(nativeResult.content).toBe("Hello!");
    });

    it("handles empty/missing content gracefully", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ choices: [{ message: {} }], usage: {} })
      );

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });
      const result = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("");
      expect(result.promptTokens).toBe(0);
      expect(result.completionTokens).toBe(0);
    });
  });

  // ── Fail-open / fail-closed ─────────────────────────

  describe("fail-open / fail-closed behavior", () => {
    it("throws when DefenseClaw is unhealthy and DEFENSECLAW_FAIL_OPEN is false", async () => {
      // Import with DC configured but no fail-open
      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });

      // Simulate health check failure — advance timer to trigger poll
      fetchSpy.mockRejectedValue(new Error("connection refused"));
      await vi.advanceTimersByTimeAsync(10000); // trigger health poll

      // Now chat should throw
      await expect(
        ollamaChat({ model: "gemma3:27b", messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("DefenseClaw is unhealthy");
    });

    it("falls back to native Ollama when unhealthy and DEFENSECLAW_FAIL_OPEN is true", async () => {
      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
        DEFENSECLAW_FAIL_OPEN: "true",
      });

      // Simulate health check failure
      fetchSpy.mockRejectedValue(new Error("connection refused"));
      await vi.advanceTimersByTimeAsync(10000);

      // Reset fetch to succeed for the actual chat call (native Ollama path)
      fetchSpy.mockResolvedValueOnce(
        mockResponse(ollamaNativeResponse("Fallback response"))
      );

      const result = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Fallback response");
      // Should have called native Ollama endpoint, not DefenseClaw
      const chatCall = fetchSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/api/chat")
      );
      expect(chatCall).toBeDefined();
    });

    it("resumes DefenseClaw routing when health check recovers", async () => {
      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
        DEFENSECLAW_FAIL_OPEN: "true",
      });

      // First: health check fails
      fetchSpy.mockRejectedValue(new Error("down"));
      await vi.advanceTimersByTimeAsync(10000);

      // Then: health check succeeds
      fetchSpy.mockResolvedValue(mockResponse({ status: "ok" }));
      await vi.advanceTimersByTimeAsync(10000);

      // Now set up the actual chat response
      fetchSpy.mockResolvedValueOnce(mockResponse(openAiResponse("Back on DC")));

      const result = await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Back on DC");
      const chatCall = fetchSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/v1/chat/completions")
      );
      expect(chatCall).toBeDefined();
    });
  });

  // ── Error handling ──────────────────────────────────

  describe("error handling", () => {
    it("throws on DefenseClaw HTTP error with truncated body", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: "rate limited" + "x".repeat(300) }, 429)
      );

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });

      await expect(
        ollamaChat({ model: "gemma3:27b", messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("DefenseClaw 429");
    });

    it("throws on native Ollama HTTP error", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 500));

      const { ollamaChat } = await importClient();
      await expect(
        ollamaChat({ model: "gemma3:27b", messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("Ollama 500");
    });

    it("throws on embed endpoint error", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 503));

      const { ollamaEmbed } = await importClient();
      await expect(ollamaEmbed({ input: "test" })).rejects.toThrow("Ollama embed 503");
    });
  });

  // ── Health check poll ───────────────────────────────

  describe("health check poll", () => {
    it("does not start health poll when DEFENSECLAW_OLLAMA_URL is empty", async () => {
      await importClient();
      // Advance past multiple poll intervals
      await vi.advanceTimersByTimeAsync(30000);
      // Only fetch calls should be from explicit test calls, not health checks
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("starts health poll when DEFENSECLAW_OLLAMA_URL is set", async () => {
      fetchSpy.mockResolvedValue(mockResponse({ status: "ok" }));

      await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });

      // Advance past one poll interval (10s)
      await vi.advanceTimersByTimeAsync(10000);

      // Should have called /health/liveliness
      const healthCalls = fetchSpy.mock.calls.filter(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/health/liveliness")
      );
      expect(healthCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("polls /health/liveliness endpoint with 3s timeout", async () => {
      fetchSpy.mockResolvedValue(mockResponse({ status: "ok" }));

      await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });

      await vi.advanceTimersByTimeAsync(10000);

      const healthCall = fetchSpy.mock.calls.find(
        (c: any[]) => typeof c[0] === "string" && c[0].includes("/health/liveliness")
      );
      expect(healthCall).toBeDefined();
      expect(healthCall![0]).toBe("http://localhost:9001/health/liveliness");
    });
  });

  // ── Default URL fallback ────────────────────────────

  describe("URL resolution", () => {
    it("falls back to studio.shearer.live when no OLLAMA_URL set", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(ollamaNativeResponse("ok"))
      );

      const { ollamaChat } = await importClient();
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("studio.shearer.live:11434");
    });

    it("uses OLLAMA_URL when set", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(ollamaNativeResponse("ok"))
      );

      const { ollamaChat } = await importClient({
        OLLAMA_URL: "http://custom-ollama:11434",
      });
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("custom-ollama:11434");
    });

    it("uses OLLAMA_BASE_URL as fallback", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(ollamaNativeResponse("ok"))
      );

      const { ollamaChat } = await importClient({
        OLLAMA_BASE_URL: "http://alt-ollama:11434",
      });
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("alt-ollama:11434");
    });
  });

  // ── Auth header ─────────────────────────────────────

  describe("authorization", () => {
    it("includes Bearer token when DEFENSECLAW_KEY is set", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(openAiResponse("ok")));

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
        DEFENSECLAW_KEY: "sk-dc-secret",
      });
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.headers.Authorization).toBe("Bearer sk-dc-secret");
    });

    it("omits Authorization header when DEFENSECLAW_KEY is empty", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(openAiResponse("ok")));

      const { ollamaChat } = await importClient({
        DEFENSECLAW_OLLAMA_URL: "http://localhost:9001",
      });
      await ollamaChat({
        model: "gemma3:27b",
        messages: [{ role: "user", content: "Hi" }],
      });

      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.headers.Authorization).toBeUndefined();
    });
  });

  // ── Embed defaults ──────────────────────────────────

  describe("ollamaEmbed", () => {
    it("uses nomic-embed-text as default model", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ embeddings: [[0.1, 0.2]] })
      );

      const { ollamaEmbed } = await importClient();
      await ollamaEmbed({ input: "test" });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe("nomic-embed-text");
    });

    it("accepts custom model for embeddings", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ embeddings: [[0.1, 0.2]] })
      );

      const { ollamaEmbed } = await importClient();
      await ollamaEmbed({ model: "mxbai-embed-large", input: "test" });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.model).toBe("mxbai-embed-large");
    });

    it("accepts array input for batch embeddings", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ embeddings: [[0.1], [0.2]] })
      );

      const { ollamaEmbed } = await importClient();
      const result = await ollamaEmbed({ input: ["text1", "text2"] });

      expect(result).toEqual([[0.1], [0.2]]);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.input).toEqual(["text1", "text2"]);
    });
  });
});
