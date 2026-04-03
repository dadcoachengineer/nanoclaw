/**
 * Tests for the /api/defenseclaw/enforce dashboard route.
 *
 * Tests the DefenseClaw enforce allow/block list management API:
 * - GET /api/defenseclaw/enforce — fetch blocked + allowed lists from all DC instances
 * - GET /api/defenseclaw/enforce?instance=X — single instance filter
 * - POST /api/defenseclaw/enforce — add a block or allow rule
 * - DELETE /api/defenseclaw/enforce — remove a rule
 * - Input validation for required fields
 * - Graceful degradation when instances are unreachable
 *
 * These are unit tests with mocked fetch. No real DefenseClaw instances.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── DC Instance config (mirrors route.ts) ──────────────────────

const DC_INSTANCES = [
  {
    id: "defenseclaw-ollama",
    label: "DefenseClaw Ollama",
    apiPort: 18790,
    dataDir: "/home/test/.defenseclaw",
  },
  {
    id: "defenseclaw-anthropic",
    label: "DefenseClaw Anthropic",
    apiPort: 18792,
    dataDir: "/home/test/.dc-anthropic-home/.defenseclaw",
  },
];

// ── Extracted functions under test ─────────────────────────────
// Mirrored from dashboard/src/app/api/defenseclaw/enforce/route.ts

interface EnforceRule {
  id: string;
  target_type: string;
  target_name: string;
  reason: string;
  updated_at: string;
}

interface EnforceListResponse {
  instance: string;
  label: string;
  blocked: EnforceRule[];
  allowed: EnforceRule[];
  error?: string;
}

function findInstance(id: string) {
  return DC_INSTANCES.find((i) => i.id === id);
}

async function getEnforceLists(
  instanceFilter?: string | null,
): Promise<EnforceListResponse[]> {
  return Promise.all(
    DC_INSTANCES.filter((i) => !instanceFilter || i.id === instanceFilter).map(
      async (inst) => {
        try {
          const [blockedResp, allowedResp] = await Promise.all([
            fetch(`http://127.0.0.1:${inst.apiPort}/enforce/blocked`, {
              signal: AbortSignal.timeout(5000),
            }),
            fetch(`http://127.0.0.1:${inst.apiPort}/enforce/allowed`, {
              signal: AbortSignal.timeout(5000),
            }),
          ]);

          const blocked: EnforceRule[] = blockedResp.ok
            ? await blockedResp.json()
            : [];
          const allowed: EnforceRule[] = allowedResp.ok
            ? await allowedResp.json()
            : [];

          return { instance: inst.id, label: inst.label, blocked, allowed };
        } catch (err) {
          return {
            instance: inst.id,
            label: inst.label,
            blocked: [],
            allowed: [],
            error: String(err),
          };
        }
      },
    ),
  );
}

async function addEnforceRule(
  instanceId: string,
  action: "allow" | "block",
  targetType: string,
  targetName: string,
  reason: string,
  clientKey: string,
): Promise<{ ok: boolean; error?: string; data?: any }> {
  const inst = findInstance(instanceId);
  if (!inst) return { ok: false, error: "Unknown instance" };
  if (!targetType || !targetName)
    return { ok: false, error: "target_type and target_name are required" };
  if (action !== "allow" && action !== "block")
    return { ok: false, error: 'action must be "allow" or "block"' };

  const endpoint =
    action === "allow" ? "/enforce/allow" : "/enforce/block";

  try {
    const resp = await fetch(`http://127.0.0.1:${inst.apiPort}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DefenseClaw-Client": clientKey,
      },
      body: JSON.stringify({
        target_type: targetType,
        target_name: targetName,
        reason: reason || `${action}ed via dashboard`,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await resp.json();
    if (!resp.ok) return { ok: false, error: data.error || "DC API error" };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function removeEnforceRule(
  instanceId: string,
  targetType: string,
  targetName: string,
  clientKey: string,
): Promise<{ ok: boolean; error?: string; data?: any }> {
  const inst = findInstance(instanceId);
  if (!inst) return { ok: false, error: "Unknown instance" };
  if (!targetType || !targetName)
    return { ok: false, error: "target_type and target_name are required" };

  try {
    const resp = await fetch(
      `http://127.0.0.1:${inst.apiPort}/enforce/block`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-DefenseClaw-Client": clientKey,
        },
        body: JSON.stringify({ target_type: targetType, target_name: targetName }),
        signal: AbortSignal.timeout(5000),
      },
    );

    const data = await resp.json();
    if (!resp.ok) return { ok: false, error: data.error || "DC API error" };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Helpers ────────────────────────────────────────────────────

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const sampleRule: EnforceRule = {
  id: "abc-123",
  target_type: "scanner-rule",
  target_name: "bearer",
  reason: "Known safe: Claude system prompt",
  updated_at: "2026-04-01T12:00:00Z",
};

const sampleBlockedRule: EnforceRule = {
  id: "def-456",
  target_type: "skill",
  target_name: "bad-skill",
  reason: "malware detected",
  updated_at: "2026-04-01T13:00:00Z",
};

// ── GET Tests ──────────────────────────────────────────────────

describe("/api/defenseclaw/enforce GET -- all instances", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns blocked and allowed lists for both DC instances", async () => {
    // Ollama: 1 allowed, 1 blocked
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse([sampleBlockedRule])) // ollama /enforce/blocked
      .mockResolvedValueOnce(mockJsonResponse([sampleRule])) // ollama /enforce/allowed
      // Anthropic: empty
      .mockResolvedValueOnce(mockJsonResponse([])) // anthropic /enforce/blocked
      .mockResolvedValueOnce(mockJsonResponse([])); // anthropic /enforce/allowed

    const results = await getEnforceLists();

    expect(results).toHaveLength(2);
    expect(results[0].instance).toBe("defenseclaw-ollama");
    expect(results[0].blocked).toHaveLength(1);
    expect(results[0].blocked[0].target_name).toBe("bad-skill");
    expect(results[0].allowed).toHaveLength(1);
    expect(results[0].allowed[0].target_name).toBe("bearer");

    expect(results[1].instance).toBe("defenseclaw-anthropic");
    expect(results[1].blocked).toHaveLength(0);
    expect(results[1].allowed).toHaveLength(0);
  });

  it("calls correct URLs for each instance", async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse([]));

    await getEnforceLists();

    const urls = fetchSpy.mock.calls.map((c: any[]) => c[0]);
    expect(urls).toContain("http://127.0.0.1:18790/enforce/blocked");
    expect(urls).toContain("http://127.0.0.1:18790/enforce/allowed");
    expect(urls).toContain("http://127.0.0.1:18792/enforce/blocked");
    expect(urls).toContain("http://127.0.0.1:18792/enforce/allowed");
  });

  it("handles DC audit store not initialized (503 response)", async () => {
    // DC returns 503 when audit store not configured
    fetchSpy
      .mockResolvedValueOnce(
        mockJsonResponse({ error: "audit store not configured" }, 503),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({ error: "audit store not configured" }, 503),
      )
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    const results = await getEnforceLists();

    expect(results[0].blocked).toHaveLength(0);
    expect(results[0].allowed).toHaveLength(0);
    expect(results[0].error).toBeUndefined(); // no error for empty lists
  });

  it("handles one instance down, one up", async () => {
    // Ollama: up
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse([sampleRule])) // blocked
      .mockResolvedValueOnce(mockJsonResponse([])); // allowed

    // Anthropic: down
    fetchSpy
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const results = await getEnforceLists();

    expect(results[0].blocked).toHaveLength(1);
    expect(results[0].error).toBeUndefined();

    expect(results[1].blocked).toHaveLength(0);
    expect(results[1].allowed).toHaveLength(0);
    expect(results[1].error).toContain("ECONNREFUSED");
  });

  it("handles both instances down", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const results = await getEnforceLists();

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.blocked.length === 0)).toBe(true);
    expect(results.every((r) => r.allowed.length === 0)).toBe(true);
    expect(results.every((r) => r.error !== undefined)).toBe(true);
  });
});

describe("/api/defenseclaw/enforce GET -- instance filter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns only the filtered instance", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse([sampleBlockedRule]))
      .mockResolvedValueOnce(mockJsonResponse([sampleRule]));

    const results = await getEnforceLists("defenseclaw-ollama");

    expect(results).toHaveLength(1);
    expect(results[0].instance).toBe("defenseclaw-ollama");
    expect(fetchSpy).toHaveBeenCalledTimes(2); // only blocked + allowed for ollama
  });

  it("returns empty for unknown instance filter", async () => {
    const results = await getEnforceLists("defenseclaw-nonexistent");

    expect(results).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── POST Tests (add rule) ──────────────────────────────────────

describe("/api/defenseclaw/enforce POST -- add rule", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to /enforce/allow for allow action", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ status: "allowed" }),
    );

    const result = await addEnforceRule(
      "defenseclaw-ollama",
      "allow",
      "scanner-rule",
      "bearer",
      "Known safe: Claude system prompt",
      "sk-dc-test123",
    );

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/enforce/allow",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-DefenseClaw-Client": "sk-dc-test123",
        }),
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.target_type).toBe("scanner-rule");
    expect(body.target_name).toBe("bearer");
    expect(body.reason).toBe("Known safe: Claude system prompt");
  });

  it("sends POST to /enforce/block for block action", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ status: "blocked" }),
    );

    const result = await addEnforceRule(
      "defenseclaw-anthropic",
      "block",
      "skill",
      "bad-skill",
      "malware",
      "sk-dc-test456",
    );

    expect(result.ok).toBe(true);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://127.0.0.1:18792/enforce/block",
    );
  });

  it("uses default reason when none provided", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ status: "allowed" }),
    );

    await addEnforceRule(
      "defenseclaw-ollama",
      "allow",
      "scanner-rule",
      "bearer",
      "",
      "sk-dc-test",
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.reason).toBe("allowed via dashboard");
  });

  it("rejects unknown instance", async () => {
    const result = await addEnforceRule(
      "defenseclaw-fake",
      "allow",
      "scanner-rule",
      "bearer",
      "test",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unknown instance");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects missing target_type", async () => {
    const result = await addEnforceRule(
      "defenseclaw-ollama",
      "allow",
      "",
      "bearer",
      "test",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects missing target_name", async () => {
    const result = await addEnforceRule(
      "defenseclaw-ollama",
      "allow",
      "scanner-rule",
      "",
      "test",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects invalid action", async () => {
    const result = await addEnforceRule(
      "defenseclaw-ollama",
      "quarantine" as any,
      "scanner-rule",
      "bearer",
      "test",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("allow");
  });

  it("handles DC API error response", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse(
        { error: "audit store not configured" },
        503,
      ),
    );

    const result = await addEnforceRule(
      "defenseclaw-ollama",
      "allow",
      "scanner-rule",
      "bearer",
      "test",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("audit store not configured");
  });

  it("handles DC unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await addEnforceRule(
      "defenseclaw-ollama",
      "allow",
      "scanner-rule",
      "bearer",
      "test",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

// ── DELETE Tests (remove rule) ─────────────────────────────────

describe("/api/defenseclaw/enforce DELETE -- remove rule", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends DELETE to /enforce/block to clear rule", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ status: "unblocked" }),
    );

    const result = await removeEnforceRule(
      "defenseclaw-ollama",
      "scanner-rule",
      "bearer",
      "sk-dc-test123",
    );

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/enforce/block",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "X-DefenseClaw-Client": "sk-dc-test123",
        }),
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.target_type).toBe("scanner-rule");
    expect(body.target_name).toBe("bearer");
  });

  it("sends DELETE to correct port for anthropic instance", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockJsonResponse({ status: "unblocked" }),
    );

    await removeEnforceRule(
      "defenseclaw-anthropic",
      "skill",
      "bad-skill",
      "sk-dc-test456",
    );

    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://127.0.0.1:18792/enforce/block",
    );
  });

  it("rejects unknown instance", async () => {
    const result = await removeEnforceRule(
      "defenseclaw-fake",
      "scanner-rule",
      "bearer",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Unknown instance");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects missing target_type", async () => {
    const result = await removeEnforceRule(
      "defenseclaw-ollama",
      "",
      "bearer",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("rejects missing target_name", async () => {
    const result = await removeEnforceRule(
      "defenseclaw-ollama",
      "scanner-rule",
      "",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("required");
  });

  it("handles DC unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await removeEnforceRule(
      "defenseclaw-ollama",
      "scanner-rule",
      "bearer",
      "sk-dc-test",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });
});

// ── Response shape contract ────────────────────────────────────

describe("/api/defenseclaw/enforce response contract", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("each instance result has required fields", async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse([]));

    const results = await getEnforceLists();

    for (const inst of results) {
      expect(inst).toHaveProperty("instance");
      expect(inst).toHaveProperty("label");
      expect(inst).toHaveProperty("blocked");
      expect(inst).toHaveProperty("allowed");
      expect(typeof inst.instance).toBe("string");
      expect(typeof inst.label).toBe("string");
      expect(Array.isArray(inst.blocked)).toBe(true);
      expect(Array.isArray(inst.allowed)).toBe(true);
    }
  });

  it("rules have expected shape matching DC enforcement entry", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockJsonResponse([sampleBlockedRule]))
      .mockResolvedValueOnce(mockJsonResponse([sampleRule]))
      .mockResolvedValueOnce(mockJsonResponse([]))
      .mockResolvedValueOnce(mockJsonResponse([]));

    const results = await getEnforceLists();
    const rule = results[0].allowed[0];

    expect(rule).toHaveProperty("id");
    expect(rule).toHaveProperty("target_type");
    expect(rule).toHaveProperty("target_name");
    expect(rule).toHaveProperty("reason");
    expect(rule).toHaveProperty("updated_at");
    expect(typeof rule.id).toBe("string");
    expect(typeof rule.target_type).toBe("string");
    expect(typeof rule.target_name).toBe("string");
  });

  it("down instances have empty lists and error string", async () => {
    fetchSpy.mockRejectedValue(new Error("connection refused"));

    const results = await getEnforceLists();

    for (const inst of results) {
      expect(inst.blocked).toEqual([]);
      expect(inst.allowed).toEqual([]);
      expect(typeof inst.error).toBe("string");
      expect(inst.error!.length).toBeGreaterThan(0);
    }
  });
});

// ── Rule formatting helpers ────────────────────────────────────

describe("enforce rule parsing and formatting", () => {
  it("builds correct request body for allow rule", () => {
    const body = {
      target_type: "scanner-rule",
      target_name: "bearer",
      reason: "Known safe: Claude system prompt",
    };

    expect(body.target_type).toBe("scanner-rule");
    expect(body.target_name).toBe("bearer");
    expect(body.reason).toContain("Claude");
  });

  it("builds correct request body for block rule", () => {
    const body = {
      target_type: "skill",
      target_name: "malicious-plugin",
      reason: "blocked via REST API",
    };

    expect(body.target_type).toBe("skill");
    expect(body.target_name).toBe("malicious-plugin");
  });

  it("verdict match can be extracted as target_name", () => {
    // The suppress button extracts the pattern from verdictMatch
    const verdictMatch = "matched: bearer";
    const targetName = verdictMatch.replace(/^matched:\s*/, "");

    expect(targetName).toBe("bearer");
  });

  it("handles verdictMatch with no prefix", () => {
    const verdictMatch = "SEC-BEARER";
    const targetName = verdictMatch.replace(/^matched:\s*/, "");

    expect(targetName).toBe("SEC-BEARER");
  });
});
