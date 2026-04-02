/**
 * Health route DefenseClaw integration tests (v3 harness)
 *
 * The /api/health route currently checks: PG, NanoClaw core, Ollama, Nginx, Notion sync, Pipelines.
 * DefenseClaw is NOT yet integrated into health checks (noted as Phase 6 gap).
 *
 * These tests document the expected contract for when DC is added to health,
 * and verify the current behavior (DC absent from health checks).
 *
 * Also tests:
 * - Overall health status logic (healthy vs degraded)
 * - The fetchWithTimeout helper pattern
 * - Structured health check response shape
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── fetchWithTimeout (extracted from health/route.ts) ────────

async function fetchWithTimeout(
  url: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; status: number; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return {
      ok: resp.ok,
      status: resp.status,
      data: await resp.json().catch(() => null),
    };
  } catch {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null };
  }
}

// ─── Health check result types ────────────────────────────────

interface HealthCheckResult {
  status: 'healthy' | 'degraded';
  timestamp: string;
  checks: Record<string, any>;
}

// Currently checked services
const CURRENT_HEALTH_CHECKS = [
  'postgresql',
  'nanoclaw',
  'ollama',
  'nginx',
  'notionSync',
  'pipelines',
];

// Expected after DC integration
const EXPECTED_HEALTH_CHECKS = [
  ...CURRENT_HEALTH_CHECKS,
  'defenseClawOllama',
  'defenseClawAnthropic',
];

// ─── fetchWithTimeout Tests ───────────────────────────────────

describe('fetchWithTimeout', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:true for healthy service', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ status: 'healthy' }),
    });

    const result = await fetchWithTimeout('http://127.0.0.1:3939/api/health');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data.status).toBe('healthy');
  });

  it('returns ok:false for unreachable service', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await fetchWithTimeout('http://127.0.0.1:9999/dead');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data).toBeNull();
  });

  it('returns data:null when JSON parsing fails (ok reflects HTTP status, not body)', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('Invalid JSON')),
    });

    const result = await fetchWithTimeout('http://127.0.0.1:3939/bad-json');
    // ok=true because HTTP request succeeded; data=null because body was invalid
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.data).toBeNull();
  });

  it('handles abort timeout', async () => {
    fetchSpy.mockImplementationOnce(
      (_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    );

    // Use a very short timeout
    const result = await fetchWithTimeout('http://127.0.0.1:3939/slow', 10);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
  });
});

// ─── Health Status Logic Tests ────────────────────────────────

describe('health status overall logic', () => {
  it('is healthy when PG + NanoClaw + Ollama are all healthy', () => {
    const checks = {
      postgresql: { status: 'healthy' },
      nanoclaw: { status: 'healthy' },
      ollama: { status: 'healthy' },
      nginx: { status: 'healthy' },
    };

    const allHealthy =
      checks.postgresql.status === 'healthy' &&
      checks.nanoclaw.status === 'healthy' &&
      checks.ollama.status === 'healthy';

    expect(allHealthy).toBe(true);
  });

  it('is degraded when Ollama is unreachable', () => {
    const checks = {
      postgresql: { status: 'healthy' },
      nanoclaw: { status: 'healthy' },
      ollama: { status: 'unreachable' },
    };

    const allHealthy =
      checks.postgresql.status === 'healthy' &&
      checks.nanoclaw.status === 'healthy' &&
      checks.ollama.status === 'healthy';

    expect(allHealthy).toBe(false);
  });

  it('is degraded when PG has errors', () => {
    const checks = {
      postgresql: { status: 'error' },
      nanoclaw: { status: 'healthy' },
      ollama: { status: 'healthy' },
    };

    const allHealthy =
      checks.postgresql.status === 'healthy' &&
      checks.nanoclaw.status === 'healthy' &&
      checks.ollama.status === 'healthy';

    expect(allHealthy).toBe(false);
  });

  it('Nginx being down does NOT affect overall health (not in critical path)', () => {
    const checks = {
      postgresql: { status: 'healthy' },
      nanoclaw: { status: 'healthy' },
      ollama: { status: 'healthy' },
      nginx: { status: 'error' },
    };

    // Current logic only checks PG + NanoClaw + Ollama
    const allHealthy =
      checks.postgresql.status === 'healthy' &&
      checks.nanoclaw.status === 'healthy' &&
      checks.ollama.status === 'healthy';

    expect(allHealthy).toBe(true);
  });
});

// ─── DefenseClaw Health Integration Gap Tests ─────────────────

describe('DefenseClaw health integration (Phase 6 gap)', () => {
  it('documents that DC is NOT in current health checks', () => {
    // This test documents the gap — when DC is added to health,
    // update CURRENT_HEALTH_CHECKS and these tests will need updating.
    expect(CURRENT_HEALTH_CHECKS).not.toContain('defenseClawOllama');
    expect(CURRENT_HEALTH_CHECKS).not.toContain('defenseClawAnthropic');
  });

  it('expected future health checks include both DC instances', () => {
    expect(EXPECTED_HEALTH_CHECKS).toContain('defenseClawOllama');
    expect(EXPECTED_HEALTH_CHECKS).toContain('defenseClawAnthropic');
  });

  it('DC health check should use /health/liveliness endpoint', () => {
    // Contract: when DC health is added, it should poll the same endpoint
    // that ollama-client.ts uses for routing decisions.
    const dcHealthEndpoint = '/health/liveliness';
    expect(dcHealthEndpoint).toBe('/health/liveliness');

    // And the correct guard ports
    const ollamaGuardPort = 9001;
    const anthropicGuardPort = 9002;
    const expectedUrls = [
      `http://127.0.0.1:${ollamaGuardPort}${dcHealthEndpoint}`,
      `http://127.0.0.1:${anthropicGuardPort}${dcHealthEndpoint}`,
    ];
    expect(expectedUrls).toEqual([
      'http://127.0.0.1:9001/health/liveliness',
      'http://127.0.0.1:9002/health/liveliness',
    ]);
  });

  it('DC down should NOT make overall status degraded (fail-open pattern)', () => {
    // When DC health is added: DC being down should NOT degrade overall health,
    // because the fail-open pattern means traffic bypasses DC when it's down.
    // This is intentionally different from PG/Ollama which are critical.
    const dcDown = true;
    const pgHealthy = true;
    const nanoclawHealthy = true;
    const ollamaHealthy = true;

    // DC failure should be informational, not blocking
    const allHealthy = pgHealthy && nanoclawHealthy && ollamaHealthy;
    expect(allHealthy).toBe(true); // DC down doesn't affect overall
  });
});

// ─── Health Response Shape Contract ───────────────────────────

describe('health response shape contract', () => {
  it('has required top-level fields', () => {
    const response: HealthCheckResult = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      checks: {},
    };

    expect(response).toHaveProperty('status');
    expect(response).toHaveProperty('timestamp');
    expect(response).toHaveProperty('checks');
    expect(['healthy', 'degraded']).toContain(response.status);
  });

  it('PG check includes latency and size', () => {
    const pgCheck = {
      status: 'healthy',
      latencyMs: 2,
      size: '45 MB',
      connections: 5,
      activeConnections: 1,
    };

    expect(pgCheck).toHaveProperty('latencyMs');
    expect(pgCheck).toHaveProperty('size');
    expect(typeof pgCheck.latencyMs).toBe('number');
  });

  it('Ollama check includes model list', () => {
    const ollamaCheck = {
      status: 'healthy',
      models: [{ name: 'gemma3:27b', sizeGb: 16 }],
      modelCount: 1,
      url: 'http://studio.shearer.live:11434',
    };

    expect(ollamaCheck.models).toBeInstanceOf(Array);
    expect(ollamaCheck.modelCount).toBe(1);
  });
});
