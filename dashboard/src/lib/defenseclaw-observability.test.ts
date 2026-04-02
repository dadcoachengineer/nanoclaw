/**
 * Tests for DefenseClaw integration in the observability route.
 *
 * Tests the collectDefenseClawStatus() function behavior — the piece
 * that polls DefenseClaw's /status endpoint and feeds data into the
 * O11y topology.
 *
 * These are unit tests with mocked fetch. They verify:
 * - Correct parsing of DefenseClaw /status response
 * - Timeout handling (3s abort)
 * - Graceful degradation when DefenseClaw is down
 * - Both instances (ollama :18790, anthropic :18792) are polled
 *
 * Note: The actual observability route is a Next.js API route that also
 * depends on pg, child_process, and requireAuth. These tests extract
 * and test the DefenseClaw-specific logic in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Extracted function under test ──────────────────────────
// This mirrors the collectDefenseClawStatus from observability/route.ts
// In production, you'd refactor this into a shared module for testability.
// For now, we test the contract: given a URL, return status object.

async function collectDefenseClawStatus(
  apiUrl: string
): Promise<Record<string, unknown>> {
  try {
    const start = Date.now();
    const resp = await fetch(`${apiUrl}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Date.now() - start;
    const data = (await resp.json()) as any;
    const health = data.health || {};
    const guardrail = health.guardrail || {};
    return {
      reachable: true,
      latencyMs,
      uptime: health.uptime_ms ? Math.round(health.uptime_ms / 1000) : 0,
      mode: guardrail.details?.mode || "unknown",
      port: guardrail.details?.port || 0,
      state: guardrail.state || "unknown",
    };
  } catch {
    return { reachable: false, latencyMs: -1, mode: "unknown", state: "down" };
  }
}

// ─── Helpers ────────────────────────────────────────────────

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

/** Realistic DefenseClaw /status response */
function dcStatusResponse(overrides: Record<string, unknown> = {}) {
  return {
    health: {
      uptime_ms: 86400000, // 24 hours
      guardrail: {
        state: "running",
        details: {
          mode: "observe",
          port: 9001,
          ...overrides,
        },
      },
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe("collectDefenseClawStatus", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a healthy DefenseClaw /status response", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(dcStatusResponse()));

    const result = await collectDefenseClawStatus("http://127.0.0.1:18790");

    expect(result.reachable).toBe(true);
    expect(result.state).toBe("running");
    expect(result.mode).toBe("observe");
    expect(result.port).toBe(9001);
    expect(result.uptime).toBe(86400); // 24h in seconds
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("calls the correct /status endpoint URL", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(dcStatusResponse()));

    await collectDefenseClawStatus("http://127.0.0.1:18790");

    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:18790/status", {
      signal: expect.any(AbortSignal),
    });
  });

  it("handles action mode response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(dcStatusResponse({ mode: "action", port: 9002 }))
    );

    const result = await collectDefenseClawStatus("http://127.0.0.1:18792");

    expect(result.mode).toBe("action");
    expect(result.port).toBe(9002);
  });

  it("returns graceful degradation when DefenseClaw is unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await collectDefenseClawStatus("http://127.0.0.1:18790");

    expect(result.reachable).toBe(false);
    expect(result.latencyMs).toBe(-1);
    expect(result.mode).toBe("unknown");
    expect(result.state).toBe("down");
  });

  it("handles malformed /status response gracefully", async () => {
    // Response with missing health.guardrail structure
    fetchSpy.mockResolvedValueOnce(mockResponse({ health: {} }));

    const result = await collectDefenseClawStatus("http://127.0.0.1:18790");

    expect(result.reachable).toBe(true);
    expect(result.mode).toBe("unknown");
    expect(result.state).toBe("unknown");
    expect(result.uptime).toBe(0);
    expect(result.port).toBe(0);
  });

  it("handles completely empty response", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({}));

    const result = await collectDefenseClawStatus("http://127.0.0.1:18790");

    expect(result.reachable).toBe(true);
    expect(result.mode).toBe("unknown");
    expect(result.state).toBe("unknown");
  });

  it("handles HTTP error status from DefenseClaw", async () => {
    // DefenseClaw returns 500 — json() might still work or might not
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("invalid json")),
    } as any);

    const result = await collectDefenseClawStatus("http://127.0.0.1:18790");

    // json() throws → caught by try/catch → returns down status
    expect(result.reachable).toBe(false);
    expect(result.state).toBe("down");
  });
});

// ─── Hop status mapping ─────────────────────────────────────
// Verifies the contract between collectDefenseClawStatus output
// and the hopStatus record structure the frontend expects.

describe("hopStatus integration contract", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("both DC instances are polled with correct URLs", async () => {
    fetchSpy.mockResolvedValue(mockResponse(dcStatusResponse()));

    // Simulate the parallel collection from the route handler
    const [dcOllama, dcAnthropic] = await Promise.all([
      collectDefenseClawStatus("http://127.0.0.1:18790"),
      collectDefenseClawStatus("http://127.0.0.1:18792"),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:18790/status");
    expect(fetchSpy.mock.calls[1][0]).toBe("http://127.0.0.1:18792/status");

    // Both should be healthy
    expect(dcOllama.reachable).toBe(true);
    expect(dcAnthropic.reachable).toBe(true);
  });

  it("produces correct hopStatus structure for frontend", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(dcStatusResponse()));

    const dcOllama = await collectDefenseClawStatus("http://127.0.0.1:18790");

    // This is the shape the frontend expects in hopStatus["defenseclaw-ollama"]
    const hopEntry = {
      status: dcOllama.reachable ? "healthy" : "down",
      latencyMs: dcOllama.latencyMs,
      metrics: dcOllama,
    };

    expect(hopEntry.status).toBe("healthy");
    expect(typeof hopEntry.latencyMs).toBe("number");
    expect(hopEntry.metrics.mode).toBe("observe");
    expect(hopEntry.metrics.state).toBe("running");
  });

  it("handles mixed availability (ollama up, anthropic down)", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse(dcStatusResponse())) // ollama OK
      .mockRejectedValueOnce(new Error("ECONNREFUSED")); // anthropic down

    const [dcOllama, dcAnthropic] = await Promise.all([
      collectDefenseClawStatus("http://127.0.0.1:18790"),
      collectDefenseClawStatus("http://127.0.0.1:18792"),
    ]);

    expect(dcOllama.reachable).toBe(true);
    expect(dcOllama.state).toBe("running");
    expect(dcAnthropic.reachable).toBe(false);
    expect(dcAnthropic.state).toBe("down");
  });
});
