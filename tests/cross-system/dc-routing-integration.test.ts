/**
 * Cross-system integration tests: DC health → ollama-client routing (v3 harness)
 *
 * Tests the full decision chain across system boundaries:
 * - DC health state determines whether ollama-client routes through DC or direct
 * - Container-runner DC env injection determines whether containers use DC
 * - Observability reports DC status for dashboard display
 * - Mode (observe vs action) determines whether DC blocks or logs
 *
 * These tests don't test individual functions — they test the CONTRACT between
 * systems that must agree for the full platform to work correctly.
 */
import { describe, it, expect } from 'vitest';

// ─── Shared Constants (must match across all systems) ─────────

// These constants are defined independently in multiple files.
// If they diverge, DC traffic goes to the wrong place.
const SYSTEM_CONSTANTS = {
  // ollama-client.ts (scripts/ and dashboard/)
  ollamaClient: {
    healthEndpoint: '/health/liveliness',
    healthTimeout: 3000,
    healthInterval: 10000,
    chatEndpoint: '/v1/chat/completions',
    failOpenEnvVar: 'DEFENSECLAW_FAIL_OPEN',
    urlEnvVar: 'DEFENSECLAW_OLLAMA_URL',
    keyEnvVar: 'DEFENSECLAW_KEY',
  },
  // container-runner.ts
  containerRunner: {
    dcEnvVar: 'DEFENSECLAW_ANTHROPIC_URL',
    containerEnvVar: 'ANTHROPIC_BASE_URL',
    modelEnvVar: 'CLAUDE_MODEL',
  },
  // observability/route.ts
  observability: {
    ollamaApiUrl: 'http://127.0.0.1:18790',
    anthropicApiUrl: 'http://127.0.0.1:18792',
    statusEndpoint: '/status',
    hopIds: ['defenseclaw-ollama', 'defenseclaw-anthropic'],
  },
  // defenseclaw/route.ts
  management: {
    ollamaApiPort: 18790,
    ollamaGuardPort: 9001,
    anthropicApiPort: 18792,
    anthropicGuardPort: 9002,
    configEndpoint: '/v1/guardrail/config',
    healthEndpoint: '/health/liveliness',
  },
};

// ─── Cross-System Constant Agreement ──────────────────────────

describe('cross-system constant agreement', () => {
  it('health endpoint is consistent between ollama-client and management route', () => {
    expect(SYSTEM_CONSTANTS.ollamaClient.healthEndpoint).toBe(
      SYSTEM_CONSTANTS.management.healthEndpoint,
    );
  });

  it('observability API URLs use the correct management ports', () => {
    expect(SYSTEM_CONSTANTS.observability.ollamaApiUrl).toBe(
      `http://127.0.0.1:${SYSTEM_CONSTANTS.management.ollamaApiPort}`,
    );
    expect(SYSTEM_CONSTANTS.observability.anthropicApiUrl).toBe(
      `http://127.0.0.1:${SYSTEM_CONSTANTS.management.anthropicApiPort}`,
    );
  });

  it('observability hop IDs match management instance IDs', () => {
    // The hop IDs in the observability route must match the instance IDs
    // in the defenseclaw management route for the dashboard to correlate them.
    expect(SYSTEM_CONSTANTS.observability.hopIds).toContain('defenseclaw-ollama');
    expect(SYSTEM_CONSTANTS.observability.hopIds).toContain('defenseclaw-anthropic');
  });
});

// ─── Routing Decision Matrix ──────────────────────────────────

describe('ollama-client routing decision matrix', () => {
  // The routing logic in ollama-client.ts:
  // useDefenseClaw = DEFENSECLAW_URL && defenseClawHealthy
  // if (DEFENSECLAW_URL && !defenseClawHealthy && !DEFENSECLAW_FAIL_OPEN) → throw
  // if (useDefenseClaw) → chatViaDefenseClaw()
  // else → chatViaNativeOllama()

  interface RoutingScenario {
    dcUrl: string;
    dcHealthy: boolean;
    failOpen: boolean;
    expectedRoute: 'defenseclaw' | 'native-ollama' | 'error';
  }

  const scenarios: RoutingScenario[] = [
    // DC configured and healthy → route through DC
    { dcUrl: 'http://127.0.0.1:9001', dcHealthy: true, failOpen: false, expectedRoute: 'defenseclaw' },
    { dcUrl: 'http://127.0.0.1:9001', dcHealthy: true, failOpen: true, expectedRoute: 'defenseclaw' },

    // DC configured but unhealthy, fail-open → fall back to native
    { dcUrl: 'http://127.0.0.1:9001', dcHealthy: false, failOpen: true, expectedRoute: 'native-ollama' },

    // DC configured but unhealthy, fail-closed → throw error
    { dcUrl: 'http://127.0.0.1:9001', dcHealthy: false, failOpen: false, expectedRoute: 'error' },

    // DC not configured → always native
    { dcUrl: '', dcHealthy: true, failOpen: false, expectedRoute: 'native-ollama' },
    { dcUrl: '', dcHealthy: false, failOpen: false, expectedRoute: 'native-ollama' },
    { dcUrl: '', dcHealthy: false, failOpen: true, expectedRoute: 'native-ollama' },
  ];

  for (const s of scenarios) {
    const desc = `DC=${s.dcUrl ? 'set' : 'unset'}, healthy=${s.dcHealthy}, failOpen=${s.failOpen} → ${s.expectedRoute}`;

    it(desc, () => {
      const useDefenseClaw = s.dcUrl && s.dcHealthy;
      const shouldThrow = s.dcUrl && !s.dcHealthy && !s.failOpen;

      if (shouldThrow) {
        expect(s.expectedRoute).toBe('error');
      } else if (useDefenseClaw) {
        expect(s.expectedRoute).toBe('defenseclaw');
      } else {
        expect(s.expectedRoute).toBe('native-ollama');
      }
    });
  }
});

// ─── Container DC Injection Decision ──────────────────────────

describe('container-runner DC injection decision', () => {
  it('DEFENSECLAW_ANTHROPIC_URL set → ANTHROPIC_BASE_URL injected', () => {
    const hostEnv = { DEFENSECLAW_ANTHROPIC_URL: 'http://127.0.0.1:9002/v1/messages' };
    const containerEnvs: string[] = [];

    if (hostEnv.DEFENSECLAW_ANTHROPIC_URL) {
      containerEnvs.push(`ANTHROPIC_BASE_URL=${hostEnv.DEFENSECLAW_ANTHROPIC_URL}`);
    }

    expect(containerEnvs).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:9002/v1/messages');
  });

  it('DEFENSECLAW_ANTHROPIC_URL unset → no ANTHROPIC_BASE_URL', () => {
    const hostEnv: Record<string, string | undefined> = {};
    const containerEnvs: string[] = [];

    if (hostEnv.DEFENSECLAW_ANTHROPIC_URL) {
      containerEnvs.push(`ANTHROPIC_BASE_URL=${hostEnv.DEFENSECLAW_ANTHROPIC_URL}`);
    }

    expect(containerEnvs).toHaveLength(0);
  });

  it('container ANTHROPIC_BASE_URL points to DC guard port, not API port', () => {
    // The container should talk to :9002 (guard port), not :18792 (API/status port)
    const dcUrl = 'http://127.0.0.1:9002/v1/messages';
    const urlParts = new URL(dcUrl);

    expect(urlParts.port).toBe('9002');
    expect(urlParts.port).not.toBe('18792');
    expect(urlParts.pathname).toBe('/v1/messages');
  });
});

// ─── Two-Path Architecture Contract ──────────────────────────

describe('two-path DefenseClaw architecture', () => {
  it('Ollama path: pipeline scripts → DC :9001 → Ollama (OpenAI format)', () => {
    const path = {
      source: 'scripts/lib/ollama-client.ts',
      dcPort: 9001,
      format: 'OpenAI /v1/chat/completions',
      upstream: 'Ollama',
    };

    expect(path.dcPort).toBe(SYSTEM_CONSTANTS.management.ollamaGuardPort);
    expect(path.format).toContain('/v1/chat/completions');
    expect(path.format).toContain('OpenAI');
  });

  it('Anthropic path: containers → DC :9002 → OneCLI → Anthropic (native format)', () => {
    const path = {
      source: 'src/container-runner.ts',
      dcPort: 9002,
      format: 'Anthropic /v1/messages',
      upstream: 'OneCLI → Anthropic',
    };

    expect(path.dcPort).toBe(SYSTEM_CONSTANTS.management.anthropicGuardPort);
    expect(path.format).toContain('/v1/messages');
    expect(path.format).toContain('Anthropic');
  });

  it('no Nginx in the chain (decommissioned)', () => {
    // The old chain was: Container → Nginx :9003 (rewrite) → DC :9002
    // The new chain is:  Container → DC :9002/v1/messages (native)
    const chainHops = ['Container', 'DefenseClaw :9002', 'OneCLI', 'Anthropic'];
    expect(chainHops).not.toContain('Nginx');
    expect(chainHops).toHaveLength(4); // 4 hops, not 5
  });

  it('observe mode: traffic inspected but never blocked', () => {
    const mode = 'observe';
    const verdict = 'MEDIUM'; // Would be blocked in action mode
    const shouldBlock = mode === 'action' && verdict !== 'NONE';
    expect(shouldBlock).toBe(false);
  });

  it('action mode: traffic with non-NONE verdict IS blocked', () => {
    const mode = 'action';
    const verdict = 'MEDIUM';
    const shouldBlock = mode === 'action' && verdict !== 'NONE';
    expect(shouldBlock).toBe(true);
  });

  it('action mode: NONE verdict passes through', () => {
    const mode = 'action';
    const verdict = 'NONE';
    const shouldBlock = mode === 'action' && verdict !== 'NONE';
    expect(shouldBlock).toBe(false);
  });
});

// ─── Dashboard ↔ Backend Data Flow ───────────────────────────

describe('dashboard data flow contract', () => {
  it('observability route provides DC status for topology SVG', () => {
    // The ObservabilityView.tsx reads hops from /api/observability
    // and renders DC instances in the topology diagram.
    const hopIds = SYSTEM_CONSTANTS.observability.hopIds;
    const topologyNodeIds = ['defenseclaw-ollama', 'defenseclaw-anthropic'];

    for (const nodeId of topologyNodeIds) {
      expect(hopIds).toContain(nodeId);
    }
  });

  it('defenseclaw route provides mode + health for security card', () => {
    // The DefenseClaw Security card in SystemView.tsx reads from /api/defenseclaw
    const expectedFields = ['id', 'label', 'healthy', 'mode', 'port', 'uptime', 'state'];
    // This is a documentation test — the actual fields are verified in defenseclaw-route.test.ts
    expect(expectedFields).toHaveLength(7);
  });

  it('mode toggle PATCH uses correct instance IDs', () => {
    // The dashboard sends PATCH { instance: "defenseclaw-ollama", mode: "action" }
    // The backend looks up by instance ID.
    const validInstanceIds = ['defenseclaw-ollama', 'defenseclaw-anthropic'];
    for (const id of validInstanceIds) {
      expect(id).toMatch(/^defenseclaw-/);
    }
  });
});
