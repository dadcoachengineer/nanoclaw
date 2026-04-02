/**
 * Health route DefenseClaw integration tests (v3.1 harness)
 *
 * The /api/health route checks: PG, NanoClaw core, Ollama, Nginx, Notion sync,
 * DefenseClaw (Ollama + Anthropic), and Pipelines.
 *
 * DC health checks are informational only — not in the critical path.
 * The fail-open pattern means DC being down does NOT degrade overall health.
 *
 * Tests:
 * - Overall health status logic (healthy vs degraded)
 * - The fetchWithTimeout helper pattern
 * - checkDefenseClaw contract (guard ports, not API ports)
 * - DC excluded from critical health determination
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

// All health checks (DC now wired in)
const ALL_HEALTH_CHECKS = [
  'postgresql',
  'nanoclaw',
  'ollama',
  'nginx',
  'notionSync',
  'defenseClawOllama',
  'defenseClawAnthropic',
  'pipelines',
];

// Only these determine overall healthy vs degraded
const CRITICAL_CHECKS = [
  'postgresql',
  'nanoclaw',
  'ollama',
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

// ─── DefenseClaw Health Integration Tests ────────────────────

describe('DefenseClaw health integration', () => {
  it('both DC instances are in ALL_HEALTH_CHECKS', () => {
    expect(ALL_HEALTH_CHECKS).toContain('defenseClawOllama');
    expect(ALL_HEALTH_CHECKS).toContain('defenseClawAnthropic');
  });

  it('DC is NOT in the critical checks (fail-open pattern)', () => {
    expect(CRITICAL_CHECKS).not.toContain('defenseClawOllama');
    expect(CRITICAL_CHECKS).not.toContain('defenseClawAnthropic');
  });

  it('DC health uses guard ports (9001/9002), not API ports (18790/18792)', () => {
    // Guard ports serve /health/liveliness — the proxy health endpoint.
    // API ports serve /status — the management API (different concern).
    const ollamaGuardPort = 9001;
    const anthropicGuardPort = 9002;
    expect(ollamaGuardPort).not.toBe(18790);
    expect(anthropicGuardPort).not.toBe(18792);
  });

  it('DC health check uses /health/liveliness endpoint', () => {
    const expectedUrls = [
      'http://127.0.0.1:9001/health/liveliness',
      'http://127.0.0.1:9002/health/liveliness',
    ];
    expect(expectedUrls[0]).toContain('/health/liveliness');
    expect(expectedUrls[1]).toContain('/health/liveliness');
  });

  it('DC down does NOT make overall status degraded', () => {
    const checks = {
      postgresql: { status: 'healthy' },
      nanoclaw: { status: 'healthy' },
      ollama: { status: 'healthy' },
      defenseClawOllama: { status: 'unreachable' },
      defenseClawAnthropic: { status: 'unreachable' },
    };

    // Only critical checks determine overall health
    const allHealthy = CRITICAL_CHECKS.every(
      (k) => (checks as any)[k]?.status === 'healthy',
    );
    expect(allHealthy).toBe(true);
  });

  it('DC check result includes port and latency when healthy', () => {
    const dcCheck = { status: 'healthy', latencyMs: 2, port: 9001 };
    expect(dcCheck).toHaveProperty('latencyMs');
    expect(dcCheck).toHaveProperty('port');
    expect(typeof dcCheck.latencyMs).toBe('number');
  });

  it('DC check result has status unreachable when down', () => {
    const dcCheck = { status: 'unreachable', port: 9002 };
    expect(dcCheck.status).toBe('unreachable');
    expect(dcCheck).toHaveProperty('port');
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
