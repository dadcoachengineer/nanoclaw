/**
 * Tests for the /api/defenseclaw/tool-inspect dashboard route.
 *
 * Tests the DefenseClaw tool inspection API:
 * - POST /api/defenseclaw/tool-inspect -- proxy tool inspection to DC
 * - GET /api/defenseclaw/tool-inspect -- fetch recent tool inspection audit events
 * - Request formatting for both OpenAI-format and Anthropic-format tool calls
 * - Verdict response parsing and classification
 * - Input validation and error handling
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

// ── Types (mirrored from route.ts) ──────────────────────

interface DetailedFinding {
  rule_id: string;
  title: string;
  severity: string;
  confidence: number;
  evidence?: string;
  tags?: string[];
}

interface ToolInspectVerdict {
  action: "allow" | "alert" | "block";
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  reason: string;
  findings: string[];
  detailed_findings?: DetailedFinding[];
  mode: string;
}

// ── Extracted functions under test ─────────────────────────────
// Mirrored from dashboard/src/app/api/defenseclaw/tool-inspect/route.ts

function findInstance(id: string) {
  return DC_INSTANCES.find((i) => i.id === id);
}

/** Build the request body for DC /api/v1/inspect/tool */
function buildInspectBody(
  tool: string,
  args?: Record<string, unknown>,
  content?: string,
  direction?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { tool };
  if (args) body.args = args;
  if (content) body.content = content;
  if (direction) body.direction = direction;
  return body;
}

/** Send a tool inspection request to a DC instance */
async function inspectTool(
  instanceId: string,
  tool: string,
  args?: Record<string, unknown>,
  content?: string,
  direction?: string,
  clientKey?: string,
): Promise<{ ok: boolean; verdict?: ToolInspectVerdict; error?: string }> {
  if (!tool) return { ok: false, error: "tool is required" };

  const inst = findInstance(instanceId);
  if (!inst) return { ok: false, error: "unknown instance" };

  try {
    const body = buildInspectBody(tool, args, content, direction);
    const resp = await fetch(
      `http://127.0.0.1:${inst.apiPort}/api/v1/inspect/tool`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DefenseClaw-Client": clientKey || "",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      },
    );

    const verdict = (await resp.json()) as ToolInspectVerdict;
    return { ok: true, verdict };
  } catch (err) {
    return { ok: false, error: `DefenseClaw unreachable: ${String(err)}` };
  }
}

/** Parse tool inspection details string from audit event */
function parseInspectDetails(details: string): {
  severity: string;
  confidence: string;
  reason: string;
  elapsed: string;
  mode: string;
} {
  const severityMatch = /severity=(\S+)/.exec(details);
  const confidenceMatch = /confidence=(\S+)/.exec(details);
  const reasonMatch = /reason=(.+?)(?:\s+elapsed=|\s*$)/.exec(details);
  const elapsedMatch = /elapsed=(\S+)/.exec(details);
  const modeMatch = /mode=(\S+)/.exec(details);
  return {
    severity: severityMatch?.[1] || "NONE",
    confidence: confidenceMatch?.[1] || "0",
    reason: reasonMatch?.[1] || "",
    elapsed: elapsedMatch?.[1] || "",
    mode: modeMatch?.[1] || "observe",
  };
}

/** Classify a verdict by highest priority for display */
function classifyVerdict(verdict: ToolInspectVerdict): {
  color: string;
  label: string;
  isBlocking: boolean;
} {
  const sevColors: Record<string, string> = {
    NONE: "#3fb950",
    LOW: "#d29922",
    MEDIUM: "#d29922",
    HIGH: "#f85149",
    CRITICAL: "#f85149",
  };
  return {
    color: sevColors[verdict.severity] || "#8b949e",
    label: verdict.severity === "NONE" ? "pass" : verdict.severity,
    isBlocking: verdict.action === "block",
  };
}

/** Summarize tool args for display (truncated) */
function summarizeArgs(
  args: Record<string, unknown> | undefined,
  maxLen = 80,
): string {
  if (!args) return "";
  const s = JSON.stringify(args);
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
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

const sampleAllowVerdict: ToolInspectVerdict = {
  action: "allow",
  severity: "NONE",
  confidence: 0,
  reason: "",
  findings: [],
  mode: "observe",
};

const sampleBlockVerdict: ToolInspectVerdict = {
  action: "block",
  severity: "CRITICAL",
  confidence: 0.9975,
  reason: "matched: CMD-RM-RF:Recursive force delete from critical root path",
  findings: ["CMD-RM-RF:Recursive force delete from critical root path"],
  detailed_findings: [
    {
      rule_id: "CMD-RM-RF",
      title: "Recursive force delete from critical root path",
      severity: "CRITICAL",
      confidence: 0.9975,
      evidence: 'rm -rf /etc"',
      tags: ["destructive"],
    },
  ],
  mode: "observe",
};

const sampleAlertVerdict: ToolInspectVerdict = {
  action: "alert",
  severity: "LOW",
  confidence: 0.55,
  reason: "matched: CMD-BASH-C:Shell -c execution",
  findings: ["CMD-BASH-C:Shell -c execution"],
  detailed_findings: [
    {
      rule_id: "CMD-BASH-C",
      title: "Shell -c execution",
      severity: "LOW",
      confidence: 0.55,
      evidence: 'bash -c "echo hello"',
      tags: ["execution"],
    },
  ],
  mode: "observe",
};

const sampleSSHVerdict: ToolInspectVerdict = {
  action: "block",
  severity: "HIGH",
  confidence: 0.9975,
  reason: "matched: PATH-SSH-DIR:SSH directory access, PATH-SSH-KEY:SSH key file path",
  findings: [
    "PATH-SSH-DIR:SSH directory access",
    "PATH-SSH-KEY:SSH key file path",
  ],
  detailed_findings: [
    {
      rule_id: "PATH-SSH-DIR",
      title: "SSH directory access",
      severity: "HIGH",
      confidence: 0.9975,
      evidence: "/home/user/.ssh/",
      tags: ["credential", "file-sensitive"],
    },
    {
      rule_id: "PATH-SSH-KEY",
      title: "SSH key file path",
      severity: "HIGH",
      confidence: 0.945,
      evidence: "/id_rsa",
      tags: ["credential", "file-sensitive"],
    },
  ],
  mode: "observe",
};

// ── POST Tests (inspect tool) ──────────────────────────────────

describe("/api/defenseclaw/tool-inspect POST -- proxy inspection", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends inspection request to correct DC instance endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleAllowVerdict));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "shell",
      { command: "ls -la" },
    );

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/api/v1/inspect/tool",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("sends to anthropic instance when specified", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleAllowVerdict));

    await inspectTool("defenseclaw-anthropic", "shell", { command: "ls" });

    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://127.0.0.1:18792/api/v1/inspect/tool",
    );
  });

  it("returns allow verdict for safe command", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleAllowVerdict));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "shell",
      { command: "ls -la" },
    );

    expect(result.ok).toBe(true);
    expect(result.verdict!.action).toBe("allow");
    expect(result.verdict!.severity).toBe("NONE");
    expect(result.verdict!.findings).toHaveLength(0);
  });

  it("returns block verdict for destructive command", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleBlockVerdict));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "shell",
      { command: "rm -rf /etc" },
    );

    expect(result.ok).toBe(true);
    expect(result.verdict!.action).toBe("block");
    expect(result.verdict!.severity).toBe("CRITICAL");
    expect(result.verdict!.findings).toContain(
      "CMD-RM-RF:Recursive force delete from critical root path",
    );
    expect(result.verdict!.detailed_findings).toHaveLength(1);
    expect(result.verdict!.detailed_findings![0].rule_id).toBe("CMD-RM-RF");
    expect(result.verdict!.detailed_findings![0].tags).toContain("destructive");
  });

  it("returns alert verdict for low-severity command", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleAlertVerdict));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "shell",
      { command: 'bash -c "echo hello"' },
    );

    expect(result.ok).toBe(true);
    expect(result.verdict!.action).toBe("alert");
    expect(result.verdict!.severity).toBe("LOW");
  });

  it("returns block for sensitive path access", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleSSHVerdict));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "read_file",
      { path: "/home/user/.ssh/id_rsa" },
    );

    expect(result.ok).toBe(true);
    expect(result.verdict!.action).toBe("block");
    expect(result.verdict!.findings).toHaveLength(2);
  });

  it("rejects missing tool name", async () => {
    const result = await inspectTool("defenseclaw-ollama", "");

    expect(result.ok).toBe(false);
    expect(result.error).toBe("tool is required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects unknown instance", async () => {
    const result = await inspectTool("defenseclaw-fake", "shell", {
      command: "ls",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown instance");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles DC unreachable", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "shell",
      { command: "ls" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("DefenseClaw unreachable");
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("includes X-DefenseClaw-Client header", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleAllowVerdict));

    await inspectTool(
      "defenseclaw-ollama",
      "shell",
      { command: "ls" },
      undefined,
      undefined,
      "sk-dc-test123abc",
    );

    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers["X-DefenseClaw-Client"]).toBe("sk-dc-test123abc");
  });
});

// ── Request formatting tests ───────────────────────────────────

describe("tool-inspect request formatting", () => {
  it("builds minimal request body with only tool name", () => {
    const body = buildInspectBody("shell");

    expect(body).toEqual({ tool: "shell" });
    expect(body).not.toHaveProperty("args");
    expect(body).not.toHaveProperty("content");
    expect(body).not.toHaveProperty("direction");
  });

  it("includes args when provided (OpenAI tool_call format)", () => {
    const body = buildInspectBody("shell", { command: "rm -rf /tmp/test" });

    expect(body.tool).toBe("shell");
    expect(body.args).toEqual({ command: "rm -rf /tmp/test" });
  });

  it("handles Anthropic tool_use format (nested input)", () => {
    // Anthropic sends tool_use blocks with { type, id, name, input }
    // The dashboard normalizes: tool = name, args = input
    const anthropicInput = {
      path: "/home/user/.ssh/id_rsa",
    };
    const body = buildInspectBody("read_file", anthropicInput);

    expect(body.tool).toBe("read_file");
    expect(body.args).toEqual({ path: "/home/user/.ssh/id_rsa" });
  });

  it("includes content and direction for message inspection", () => {
    const body = buildInspectBody(
      "message",
      undefined,
      "Here is the API key: sk-ant-api03-secret",
      "outbound",
    );

    expect(body.tool).toBe("message");
    expect(body.content).toBe("Here is the API key: sk-ant-api03-secret");
    expect(body.direction).toBe("outbound");
    expect(body).not.toHaveProperty("args");
  });

  it("handles write_file with file content (CodeGuard trigger)", () => {
    const body = buildInspectBody("write_file", {
      path: "/app/server.js",
      content: 'const key = "sk-ant-api03-REALKEY"; // oops',
    });

    expect(body.tool).toBe("write_file");
    expect((body.args as any).path).toBe("/app/server.js");
    expect((body.args as any).content).toContain("sk-ant-api03");
  });

  it("handles edit_file with new_string (CodeGuard trigger)", () => {
    const body = buildInspectBody("edit_file", {
      path: "/app/config.ts",
      old_string: "const token = '';",
      new_string: 'const token = "ghp_secret123456789012345678901234567890";',
    });

    expect(body.tool).toBe("edit_file");
    expect((body.args as any).new_string).toContain("ghp_");
  });
});

// ── Verdict classification tests ───────────────────────────────

describe("verdict classification", () => {
  it("classifies NONE severity as pass with green", () => {
    const result = classifyVerdict(sampleAllowVerdict);

    expect(result.label).toBe("pass");
    expect(result.color).toBe("#3fb950");
    expect(result.isBlocking).toBe(false);
  });

  it("classifies CRITICAL severity as blocking with red", () => {
    const result = classifyVerdict(sampleBlockVerdict);

    expect(result.label).toBe("CRITICAL");
    expect(result.color).toBe("#f85149");
    expect(result.isBlocking).toBe(true);
  });

  it("classifies LOW severity as non-blocking with yellow", () => {
    const result = classifyVerdict(sampleAlertVerdict);

    expect(result.label).toBe("LOW");
    expect(result.color).toBe("#d29922");
    expect(result.isBlocking).toBe(false);
  });

  it("classifies HIGH severity as blocking with red", () => {
    const result = classifyVerdict(sampleSSHVerdict);

    expect(result.label).toBe("HIGH");
    expect(result.color).toBe("#f85149");
    expect(result.isBlocking).toBe(true);
  });

  it("classifies MEDIUM severity as non-blocking with yellow", () => {
    const verdict: ToolInspectVerdict = {
      ...sampleAlertVerdict,
      severity: "MEDIUM",
    };
    const result = classifyVerdict(verdict);

    expect(result.label).toBe("MEDIUM");
    expect(result.color).toBe("#d29922");
    expect(result.isBlocking).toBe(false);
  });
});

// ── Audit event parsing tests ──────────────────────────────────

describe("audit event detail parsing", () => {
  it("parses full inspect-tool-block details", () => {
    const details =
      "severity=CRITICAL confidence=0.98 reason=matched: SEC-ANTHROPIC:Anthropic API key elapsed=144.834us mode=observe";
    const parsed = parseInspectDetails(details);

    expect(parsed.severity).toBe("CRITICAL");
    expect(parsed.confidence).toBe("0.98");
    expect(parsed.reason).toBe("matched: SEC-ANTHROPIC:Anthropic API key");
    expect(parsed.elapsed).toBe("144.834us");
    expect(parsed.mode).toBe("observe");
  });

  it("parses inspect-tool-allow details", () => {
    const details =
      "severity=NONE confidence=0.00 reason= elapsed=12.5us mode=observe";
    const parsed = parseInspectDetails(details);

    expect(parsed.severity).toBe("NONE");
    expect(parsed.confidence).toBe("0.00");
    expect(parsed.mode).toBe("observe");
  });

  it("parses details with multiple findings in reason", () => {
    const details =
      "severity=HIGH confidence=0.95 reason=matched: PATH-SSH-DIR:SSH directory access, PATH-SSH-KEY:SSH key file path elapsed=200us mode=action";
    const parsed = parseInspectDetails(details);

    expect(parsed.severity).toBe("HIGH");
    expect(parsed.reason).toContain("PATH-SSH-DIR");
    expect(parsed.reason).toContain("PATH-SSH-KEY");
    expect(parsed.mode).toBe("action");
  });

  it("handles empty details string", () => {
    const parsed = parseInspectDetails("");

    expect(parsed.severity).toBe("NONE");
    expect(parsed.confidence).toBe("0");
    expect(parsed.reason).toBe("");
    expect(parsed.elapsed).toBe("");
    expect(parsed.mode).toBe("observe");
  });

  it("handles partial details", () => {
    const details = "severity=MEDIUM";
    const parsed = parseInspectDetails(details);

    expect(parsed.severity).toBe("MEDIUM");
    expect(parsed.confidence).toBe("0");
  });
});

// ── Args summarization tests ───────────────────────────────────

describe("args summarization", () => {
  it("returns empty string for undefined args", () => {
    expect(summarizeArgs(undefined)).toBe("");
  });

  it("returns full JSON for short args", () => {
    const args = { command: "ls" };
    expect(summarizeArgs(args)).toBe('{"command":"ls"}');
  });

  it("truncates long args with ellipsis", () => {
    const args = { command: "a".repeat(100) };
    const result = summarizeArgs(args, 40);

    expect(result.length).toBe(43); // 40 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles nested args (Anthropic tool_use input)", () => {
    const args = {
      path: "/home/user/.ssh/id_rsa",
      content: "some content here",
    };
    const result = summarizeArgs(args);

    expect(result).toContain("path");
    expect(result).toContain(".ssh");
  });
});

// ── Response shape contract ────────────────────────────────────

describe("tool-inspect response contract", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("verdict has all required fields", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleBlockVerdict));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "shell",
      { command: "rm -rf /" },
    );

    const v = result.verdict!;
    expect(v).toHaveProperty("action");
    expect(v).toHaveProperty("severity");
    expect(v).toHaveProperty("confidence");
    expect(v).toHaveProperty("reason");
    expect(v).toHaveProperty("findings");
    expect(v).toHaveProperty("mode");
    expect(typeof v.action).toBe("string");
    expect(typeof v.severity).toBe("string");
    expect(typeof v.confidence).toBe("number");
    expect(Array.isArray(v.findings)).toBe(true);
  });

  it("detailed_findings entries have required fields", async () => {
    fetchSpy.mockResolvedValueOnce(mockJsonResponse(sampleSSHVerdict));

    const result = await inspectTool(
      "defenseclaw-ollama",
      "read_file",
      { path: "/home/user/.ssh/id_rsa" },
    );

    const df = result.verdict!.detailed_findings!;
    expect(df.length).toBeGreaterThan(0);

    for (const f of df) {
      expect(f).toHaveProperty("rule_id");
      expect(f).toHaveProperty("title");
      expect(f).toHaveProperty("severity");
      expect(f).toHaveProperty("confidence");
      expect(typeof f.rule_id).toBe("string");
      expect(typeof f.title).toBe("string");
      expect(typeof f.confidence).toBe("number");
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("action is one of allow/alert/block", async () => {
    for (const verdict of [sampleAllowVerdict, sampleAlertVerdict, sampleBlockVerdict]) {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse(verdict));

      const result = await inspectTool(
        "defenseclaw-ollama",
        "shell",
        { command: "test" },
      );

      expect(["allow", "alert", "block"]).toContain(result.verdict!.action);
    }
  });

  it("severity is one of NONE/LOW/MEDIUM/HIGH/CRITICAL", async () => {
    const validSeverities = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

    for (const verdict of [sampleAllowVerdict, sampleAlertVerdict, sampleBlockVerdict, sampleSSHVerdict]) {
      fetchSpy.mockResolvedValueOnce(mockJsonResponse(verdict));

      const result = await inspectTool(
        "defenseclaw-ollama",
        "shell",
        { command: "test" },
      );

      expect(validSeverities).toContain(result.verdict!.severity);
    }
  });
});
