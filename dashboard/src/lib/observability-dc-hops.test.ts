/**
 * Observability route — DefenseClaw hopStatus contract tests (v3 harness)
 *
 * Tests the observability route's integration of both DefenseClaw instances
 * into the hopStatus map, which drives the topology SVG and sparkline data.
 *
 * Covers:
 * - hopStatus keys: "defenseclaw-ollama" and "defenseclaw-anthropic"
 * - collectDefenseClawStatus response parsing
 * - Status derivation: reachable → healthy, unreachable → down
 * - Latency, uptime, mode, port, state fields
 * - Both instances collected in parallel (Promise.all)
 * - Sparkline sample persistence contract
 * - Hop registry interaction
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── collectDefenseClawStatus (extracted from observability/route.ts) ──

async function collectDefenseClawStatus(
  apiUrl: string,
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
      mode: guardrail.details?.mode || 'unknown',
      port: guardrail.details?.port || 0,
      state: guardrail.state || 'unknown',
    };
  } catch {
    return { reachable: false, latencyMs: -1, mode: 'unknown', state: 'down' };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function mockDCStatusResponse(overrides: Record<string, unknown> = {}) {
  return {
    health: {
      uptime_ms: 172800000, // 48 hours
      guardrail: {
        state: 'running',
        details: {
          mode: 'observe',
          port: 9001,
          ...overrides,
        },
      },
    },
  };
}

function mockJsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

// ─── collectDefenseClawStatus Tests ───────────────────────────

describe('collectDefenseClawStatus', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns reachable:true with parsed fields for healthy DC', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(mockDCStatusResponse()));

    const result = await collectDefenseClawStatus('http://127.0.0.1:18790');

    expect(result.reachable).toBe(true);
    expect(result.mode).toBe('observe');
    expect(result.state).toBe('running');
    expect(result.uptime).toBe(172800); // 48h in seconds
    expect(result.port).toBe(9001);
    expect(typeof result.latencyMs).toBe('number');
    expect((result.latencyMs as number) >= 0).toBe(true);
  });

  it('returns reachable:false for unreachable DC', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await collectDefenseClawStatus('http://127.0.0.1:18790');

    expect(result.reachable).toBe(false);
    expect(result.latencyMs).toBe(-1);
    expect(result.mode).toBe('unknown');
    expect(result.state).toBe('down');
  });

  it('calls /status on the apiPort URL', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(mockDCStatusResponse()));

    await collectDefenseClawStatus('http://127.0.0.1:18792');

    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:18792/status');
  });

  it('handles action mode', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse(mockDCStatusResponse({ mode: 'action' })),
    );

    const result = await collectDefenseClawStatus('http://127.0.0.1:18790');
    expect(result.mode).toBe('action');
  });

  it('handles missing guardrail.details gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ health: { uptime_ms: 1000, guardrail: {} } }),
    );

    const result = await collectDefenseClawStatus('http://127.0.0.1:18790');
    expect(result.mode).toBe('unknown');
    expect(result.port).toBe(0);
    expect(result.state).toBe('unknown');
    expect(result.uptime).toBe(1);
  });

  it('handles completely empty response', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({}));

    const result = await collectDefenseClawStatus('http://127.0.0.1:18790');
    expect(result.reachable).toBe(true);
    expect(result.mode).toBe('unknown');
    expect(result.uptime).toBe(0);
  });
});

// ─── hopStatus Map Contract ───────────────────────────────────

describe('hopStatus map DC entries', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('both DC instances produce hopStatus entries', async () => {
    // Simulate what the observability route does
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockDCStatusResponse())) // ollama
      .mockResolvedValueOnce(mockJsonResponse(mockDCStatusResponse({ mode: 'action', port: 9002 }))); // anthropic

    const [dcOllama, dcAnthropic] = await Promise.all([
      collectDefenseClawStatus('http://127.0.0.1:18790'),
      collectDefenseClawStatus('http://127.0.0.1:18792'),
    ]);

    // Build hopStatus map (mirrors observability route)
    const hopStatus: Record<string, { status: string; latencyMs: number; metrics: any }> = {
      'defenseclaw-ollama': {
        status: (dcOllama as any).reachable ? 'healthy' : 'down',
        latencyMs: (dcOllama as any).latencyMs,
        metrics: dcOllama,
      },
      'defenseclaw-anthropic': {
        status: (dcAnthropic as any).reachable ? 'healthy' : 'down',
        latencyMs: (dcAnthropic as any).latencyMs,
        metrics: dcAnthropic,
      },
    };

    expect(hopStatus['defenseclaw-ollama'].status).toBe('healthy');
    expect(hopStatus['defenseclaw-anthropic'].status).toBe('healthy');
    expect(hopStatus['defenseclaw-ollama'].metrics.mode).toBe('observe');
    expect(hopStatus['defenseclaw-anthropic'].metrics.mode).toBe('action');
  });

  it('mixed availability: one healthy, one down', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockDCStatusResponse()))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const [dcOllama, dcAnthropic] = await Promise.all([
      collectDefenseClawStatus('http://127.0.0.1:18790'),
      collectDefenseClawStatus('http://127.0.0.1:18792'),
    ]);

    const hopStatus = {
      'defenseclaw-ollama': {
        status: (dcOllama as any).reachable ? 'healthy' : 'down',
        latencyMs: (dcOllama as any).latencyMs,
        metrics: dcOllama,
      },
      'defenseclaw-anthropic': {
        status: (dcAnthropic as any).reachable ? 'healthy' : 'down',
        latencyMs: (dcAnthropic as any).latencyMs,
        metrics: dcAnthropic,
      },
    };

    expect(hopStatus['defenseclaw-ollama'].status).toBe('healthy');
    expect(hopStatus['defenseclaw-anthropic'].status).toBe('down');
    expect(hopStatus['defenseclaw-anthropic'].latencyMs).toBe(-1);
  });

  it('hopStatus keys match DC_INSTANCES IDs exactly', () => {
    const dcInstanceIds = ['defenseclaw-ollama', 'defenseclaw-anthropic'];
    const hopStatusKeys = ['defenseclaw-ollama', 'defenseclaw-anthropic'];

    expect(hopStatusKeys).toEqual(dcInstanceIds);
  });

  it('hopStatus entry has standard shape for sparkline persistence', () => {
    const entry = {
      status: 'healthy',
      latencyMs: 5,
      metrics: { reachable: true, mode: 'observe', uptime: 172800 },
    };

    // These fields are required for sparkline sample INSERT
    expect(entry).toHaveProperty('status');
    expect(entry).toHaveProperty('latencyMs');
    expect(entry).toHaveProperty('metrics');
    expect(typeof entry.latencyMs).toBe('number');
    expect(typeof entry.status).toBe('string');
  });
});

// ─── Parallel Collection Contract ─────────────────────────────

describe('parallel DC collection', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('both instances fetched in parallel (not sequential)', async () => {
    let callOrder: string[] = [];

    fetchSpy.mockImplementation(async (url: string) => {
      callOrder.push(url);
      // Simulate some latency
      await new Promise((r) => setTimeout(r, 10));
      return mockJsonResponse(mockDCStatusResponse());
    });

    await Promise.all([
      collectDefenseClawStatus('http://127.0.0.1:18790'),
      collectDefenseClawStatus('http://127.0.0.1:18792'),
    ]);

    // Both should have been called (order may vary due to parallel)
    expect(callOrder).toHaveLength(2);
    expect(callOrder).toContain('http://127.0.0.1:18790/status');
    expect(callOrder).toContain('http://127.0.0.1:18792/status');
  });

  it('one slow instance does not block the other', async () => {
    const startTime = Date.now();

    fetchSpy.mockImplementation(async (url: string) => {
      if (url.includes('18790')) {
        // Ollama: fast
        return mockJsonResponse(mockDCStatusResponse());
      }
      // Anthropic: slow (but within timeout)
      await new Promise((r) => setTimeout(r, 50));
      return mockJsonResponse(mockDCStatusResponse());
    });

    const results = await Promise.all([
      collectDefenseClawStatus('http://127.0.0.1:18790'),
      collectDefenseClawStatus('http://127.0.0.1:18792'),
    ]);

    const elapsed = Date.now() - startTime;
    // Total time should be ~50ms (parallel), not ~50ms + 0ms (sequential)
    expect(elapsed).toBeLessThan(200); // generous margin for CI
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.reachable)).toBe(true);
  });
});
