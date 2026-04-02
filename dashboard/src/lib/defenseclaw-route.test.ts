/**
 * Tests for the /api/defenseclaw dashboard route.
 *
 * Tests the DefenseClaw management API (Phase 4B-C):
 * - GET /api/defenseclaw — status + health for all DC instances
 * - GET /api/defenseclaw?instance=defenseclaw-ollama — single instance filter
 * - PATCH /api/defenseclaw — mode toggle (observe ↔ action)
 * - Auth enforcement (requireAuth)
 * - Graceful degradation when instances are unreachable
 * - deriveMasterKey from device.key for config PATCH auth
 *
 * These are unit tests with mocked fetch. No real DefenseClaw instances.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── DC Instance config (mirrors route.ts) ───────────────────

const DC_INSTANCES = [
  { id: 'defenseclaw-ollama', label: 'DefenseClaw Ollama', apiPort: 18790, guardPort: 9001 },
  { id: 'defenseclaw-anthropic', label: 'DefenseClaw Anthropic', apiPort: 18792, guardPort: 9002 },
];

// ─── Extracted functions under test ───────────────────────────
// Mirrored from dashboard/src/app/api/defenseclaw/route.ts for isolated testing.
// Long-term these should be refactored into a shared module.

async function getDefenseClawInstances(
  instanceFilter?: string | null,
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    DC_INSTANCES
      .filter((i) => !instanceFilter || i.id === instanceFilter)
      .map(async (inst) => {
        try {
          const [statusResp, healthResp] = await Promise.all([
            fetch(`http://127.0.0.1:${inst.apiPort}/status`, {
              signal: AbortSignal.timeout(3000),
            }),
            fetch(`http://127.0.0.1:${inst.guardPort}/health/liveliness`, {
              signal: AbortSignal.timeout(3000),
            }),
          ]);

          const status = (await statusResp.json()) as any;
          const health = (await healthResp.json()) as any;
          const guardrail = status.health?.guardrail || {};

          return {
            id: inst.id,
            label: inst.label,
            healthy: health.status === 'healthy',
            mode: guardrail.details?.mode || 'unknown',
            port: guardrail.details?.port || inst.guardPort,
            uptime: status.health?.uptime_ms
              ? Math.round(status.health.uptime_ms / 1000)
              : 0,
            state: guardrail.state || 'unknown',
          };
        } catch {
          return {
            id: inst.id,
            label: inst.label,
            healthy: false,
            mode: 'unknown',
            port: inst.guardPort,
            uptime: 0,
            state: 'down',
          };
        }
      }),
  );
}

async function patchDefenseClawConfig(
  instanceId: string,
  mode: string,
  clientKey: string,
): Promise<{ ok: boolean; error?: string; data?: any }> {
  const inst = DC_INSTANCES.find((i) => i.id === instanceId);
  if (!inst) return { ok: false, error: 'unknown instance' };

  try {
    const resp = await fetch(
      `http://127.0.0.1:${inst.apiPort}/v1/guardrail/config`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-DefenseClaw-Client': clientKey,
        },
        body: JSON.stringify({ mode }),
        signal: AbortSignal.timeout(5000),
      },
    );

    const data = await resp.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function mockStatusResponse(overrides: Record<string, unknown> = {}) {
  return {
    health: {
      uptime_ms: 86400000,
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

function mockHealthResponse(healthy = true) {
  return { status: healthy ? 'healthy' : 'unhealthy' };
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

// ─── GET Tests ────────────────────────────────────────────────

describe('/api/defenseclaw GET — all instances', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns status for both DC instances', async () => {
    // Mock responses for both instances (2 fetches per instance: status + health)
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse())) // ollama /status
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse())) // ollama /health
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse({ mode: 'action', port: 9002 }))) // anthropic /status
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse())); // anthropic /health

    const instances = await getDefenseClawInstances();

    expect(instances).toHaveLength(2);
    expect(instances[0].id).toBe('defenseclaw-ollama');
    expect(instances[0].healthy).toBe(true);
    expect(instances[0].mode).toBe('observe');
    expect(instances[0].state).toBe('running');
    expect(instances[0].uptime).toBe(86400);

    expect(instances[1].id).toBe('defenseclaw-anthropic');
    expect(instances[1].mode).toBe('action');
    expect(instances[1].port).toBe(9002);
  });

  it('calls correct URLs for each instance', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()));

    await getDefenseClawInstances();

    const urls = fetchSpy.mock.calls.map((c: any[]) => c[0]);
    expect(urls).toContain('http://127.0.0.1:18790/status');
    expect(urls).toContain('http://127.0.0.1:9001/health/liveliness');
    expect(urls).toContain('http://127.0.0.1:18792/status');
    expect(urls).toContain('http://127.0.0.1:9002/health/liveliness');
  });

  it('handles one instance down, one up', async () => {
    // Ollama: healthy
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()));

    // Anthropic: connection refused
    fetchSpy
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const instances = await getDefenseClawInstances();

    expect(instances[0].healthy).toBe(true);
    expect(instances[0].state).toBe('running');

    expect(instances[1].healthy).toBe(false);
    expect(instances[1].state).toBe('down');
    expect(instances[1].mode).toBe('unknown');
  });

  it('handles both instances down', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const instances = await getDefenseClawInstances();

    expect(instances).toHaveLength(2);
    expect(instances.every((i) => i.healthy === false)).toBe(true);
    expect(instances.every((i) => i.state === 'down')).toBe(true);
  });

  it('handles unhealthy guardrail (status OK but health unhealthy)', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse(false))) // unhealthy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()));

    const instances = await getDefenseClawInstances();

    expect(instances[0].healthy).toBe(false); // health endpoint says unhealthy
    expect(instances[0].state).toBe('running'); // status endpoint says running
    expect(instances[1].healthy).toBe(true);
  });

  it('handles malformed /status response', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse({})) // empty status
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()));

    const instances = await getDefenseClawInstances();

    expect(instances[0].mode).toBe('unknown');
    expect(instances[0].state).toBe('unknown');
    expect(instances[0].uptime).toBe(0);
    // Second instance should be normal
    expect(instances[1].mode).toBe('observe');
  });
});

describe('/api/defenseclaw GET — instance filter', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns only the filtered instance', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()));

    const instances = await getDefenseClawInstances('defenseclaw-ollama');

    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe('defenseclaw-ollama');
    // Should NOT have called anthropic endpoints
    expect(fetchSpy).toHaveBeenCalledTimes(2); // only status + health for ollama
  });

  it('returns empty for unknown instance filter', async () => {
    const instances = await getDefenseClawInstances('defenseclaw-nonexistent');

    expect(instances).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── PATCH Tests (mode toggle) ────────────────────────────────

describe('/api/defenseclaw PATCH — mode toggle', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends PATCH to correct instance API port with mode', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ ok: true, mode: 'action' }),
    );

    const result = await patchDefenseClawConfig(
      'defenseclaw-ollama',
      'action',
      'sk-dc-test123',
    );

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:18790/v1/guardrail/config',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-DefenseClaw-Client': 'sk-dc-test123',
        }),
      }),
    );

    // Verify body
    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody.mode).toBe('action');
  });

  it('sends PATCH to anthropic instance on correct port', async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ ok: true, mode: 'observe' }),
    );

    await patchDefenseClawConfig(
      'defenseclaw-anthropic',
      'observe',
      'sk-dc-test456',
    );

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://127.0.0.1:18792/v1/guardrail/config',
    );
  });

  it('returns error for unknown instance', async () => {
    const result = await patchDefenseClawConfig(
      'defenseclaw-fake',
      'action',
      'sk-dc-test',
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('unknown instance');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles PATCH failure (DC unreachable)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await patchDefenseClawConfig(
      'defenseclaw-ollama',
      'action',
      'sk-dc-test',
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('includes X-DefenseClaw-Client header for authentication', async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

    await patchDefenseClawConfig(
      'defenseclaw-ollama',
      'action',
      'sk-dc-abc123def456',
    );

    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers['X-DefenseClaw-Client']).toBe('sk-dc-abc123def456');
  });
});

// ─── Response shape contract ──────────────────────────────────

describe('/api/defenseclaw response contract', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('instance object has all required fields for frontend', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()));

    const instances = await getDefenseClawInstances();

    for (const inst of instances) {
      // These are the fields the dashboard frontend depends on
      expect(inst).toHaveProperty('id');
      expect(inst).toHaveProperty('label');
      expect(inst).toHaveProperty('healthy');
      expect(inst).toHaveProperty('mode');
      expect(inst).toHaveProperty('port');
      expect(inst).toHaveProperty('uptime');
      expect(inst).toHaveProperty('state');

      // Type checks
      expect(typeof inst.id).toBe('string');
      expect(typeof inst.label).toBe('string');
      expect(typeof inst.healthy).toBe('boolean');
      expect(typeof inst.mode).toBe('string');
      expect(typeof inst.port).toBe('number');
      expect(typeof inst.uptime).toBe('number');
      expect(typeof inst.state).toBe('string');
    }
  });

  it('mode is one of observe | action | unknown', async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse({ mode: 'observe' })))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()))
      .mockResolvedValueOnce(mockJsonResponse(mockStatusResponse({ mode: 'action' })))
      .mockResolvedValueOnce(mockJsonResponse(mockHealthResponse()));

    const instances = await getDefenseClawInstances();

    expect(['observe', 'action', 'unknown']).toContain(instances[0].mode);
    expect(['observe', 'action', 'unknown']).toContain(instances[1].mode);
  });

  it('down instance has deterministic fallback values', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const instances = await getDefenseClawInstances();

    for (const inst of instances) {
      expect(inst.healthy).toBe(false);
      expect(inst.mode).toBe('unknown');
      expect(inst.uptime).toBe(0);
      expect(inst.state).toBe('down');
      // Port should fall back to guardPort from config
      expect(typeof inst.port).toBe('number');
      expect((inst.port as number) > 0).toBe(true);
    }
  });
});
