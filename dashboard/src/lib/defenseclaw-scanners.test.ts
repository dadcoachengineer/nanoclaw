/**
 * DefenseClaw Skill & MCP Scanner tests
 *
 * Tests the skill list parsing, MCP list parsing, scan result formatting,
 * tool catalog shape, and severity color mapping from the scanners endpoint.
 */
import { describe, it, expect } from "vitest";

// ── Types (mirror the route types) ──────────────────────

interface Finding {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  description: string;
  location: string;
  remediation: string;
  scanner: string;
  tags?: string[];
}

interface ScanResult {
  scanner: string;
  target: string;
  timestamp: string;
  findings: Finding[];
  duration: number;
}

interface MCPServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: string;
}

interface SkillInfo {
  name: string;
  path: string;
  status?: string;
  lastScan?: ScanResult | null;
}

interface ScannerInstanceData {
  id: string;
  label: string;
  skills: SkillInfo[];
  mcpServers: MCPServerEntry[];
  toolCatalog: { count: number; error?: string };
  error?: string;
}

// ── Skill list parsing ──────────────────────

function parseSkillsList(data: unknown): SkillInfo[] {
  if (!Array.isArray(data)) return [];
  return data.map((s: any) => ({
    name: s.name || s.skill_key || "unknown",
    path: s.path || s.target || "",
    status: s.status || "discovered",
    lastScan: s.last_scan || s.lastScan || null,
  }));
}

describe("parseSkillsList", () => {
  it("parses a list of skills with standard fields", () => {
    const input = [
      { name: "browser", path: "/home/user/.openclaw/skills/browser", status: "scanned" },
      { name: "formatter", path: "/home/user/.openclaw/skills/formatter", status: "discovered" },
    ];
    const result = parseSkillsList(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: "browser",
      path: "/home/user/.openclaw/skills/browser",
      status: "scanned",
      lastScan: null,
    });
    expect(result[1].name).toBe("formatter");
    expect(result[1].status).toBe("discovered");
  });

  it("handles skill_key fallback field", () => {
    const input = [{ skill_key: "my-skill", target: "/skills/my-skill" }];
    const result = parseSkillsList(input);
    expect(result[0].name).toBe("my-skill");
    expect(result[0].path).toBe("/skills/my-skill");
  });

  it("returns empty array for non-array input", () => {
    expect(parseSkillsList(null)).toEqual([]);
    expect(parseSkillsList({ error: "not connected" })).toEqual([]);
    expect(parseSkillsList("string")).toEqual([]);
  });

  it("defaults status to 'discovered' when missing", () => {
    const input = [{ name: "test" }];
    const result = parseSkillsList(input);
    expect(result[0].status).toBe("discovered");
  });

  it("includes lastScan when present", () => {
    const scan: ScanResult = {
      scanner: "skill-scanner",
      target: "/skills/test",
      timestamp: "2026-04-01T10:00:00Z",
      findings: [],
      duration: 1500000000,
    };
    const input = [{ name: "test", path: "/skills/test", lastScan: scan }];
    const result = parseSkillsList(input);
    expect(result[0].lastScan).toBeDefined();
    expect(result[0].lastScan?.scanner).toBe("skill-scanner");
    expect(result[0].lastScan?.findings).toEqual([]);
  });
});

// ── MCP server list parsing ──────────────────────

function parseMCPList(data: unknown): MCPServerEntry[] {
  if (!Array.isArray(data)) return [];
  return data.map((m: any) => ({
    name: m.name,
    command: m.command,
    args: m.args,
    env: m.env,
    url: m.url,
    transport: m.transport,
  }));
}

describe("parseMCPList", () => {
  it("parses command-based MCP servers", () => {
    const input = [
      {
        name: "home-assistant",
        command: "npx",
        args: ["-y", "@anthropic/mcp-ha"],
        transport: "stdio",
      },
    ];
    const result = parseMCPList(input);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("home-assistant");
    expect(result[0].command).toBe("npx");
    expect(result[0].args).toEqual(["-y", "@anthropic/mcp-ha"]);
    expect(result[0].transport).toBe("stdio");
  });

  it("parses URL-based MCP servers", () => {
    const input = [
      {
        name: "remote-mcp",
        url: "https://mcp.example.com/v1",
        transport: "sse",
      },
    ];
    const result = parseMCPList(input);
    expect(result[0].name).toBe("remote-mcp");
    expect(result[0].url).toBe("https://mcp.example.com/v1");
    expect(result[0].command).toBeUndefined();
  });

  it("handles empty array", () => {
    expect(parseMCPList([])).toEqual([]);
  });

  it("returns empty for non-array input", () => {
    expect(parseMCPList(null)).toEqual([]);
    expect(parseMCPList(undefined)).toEqual([]);
    expect(parseMCPList({ error: "something" })).toEqual([]);
  });

  it("preserves env map when present", () => {
    const input = [
      {
        name: "sentry",
        command: "npx",
        args: ["-y", "@sentry/mcp-server"],
        env: { SENTRY_AUTH_TOKEN: "secret" },
      },
    ];
    const result = parseMCPList(input);
    expect(result[0].env).toEqual({ SENTRY_AUTH_TOKEN: "secret" });
  });
});

// ── Scan result formatting ──────────────────────

function severityColor(severity: string): string {
  switch (severity.toUpperCase()) {
    case "CRITICAL": return "#f85149";
    case "HIGH": return "#f85149";
    case "MEDIUM": return "#d29922";
    case "LOW": return "#d2a822";
    case "INFO": return "#3fb950";
    default: return "#8b949e";
  }
}

function maxSeverity(findings: Finding[]): string {
  if (findings.length === 0) return "CLEAN";
  const rank: Record<string, number> = {
    CRITICAL: 5,
    HIGH: 4,
    MEDIUM: 3,
    LOW: 2,
    INFO: 1,
  };
  let max = "INFO";
  for (const f of findings) {
    if ((rank[f.severity] || 0) > (rank[max] || 0)) {
      max = f.severity;
    }
  }
  return max;
}

function formatScanDuration(durationNs: number): string {
  const ms = durationNs / 1_000_000;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function findingCountBySeverity(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
  }
  return counts;
}

describe("severityColor", () => {
  it("returns red for CRITICAL and HIGH", () => {
    expect(severityColor("CRITICAL")).toBe("#f85149");
    expect(severityColor("HIGH")).toBe("#f85149");
  });

  it("returns yellow for MEDIUM", () => {
    expect(severityColor("MEDIUM")).toBe("#d29922");
  });

  it("returns green for INFO", () => {
    expect(severityColor("INFO")).toBe("#3fb950");
  });

  it("returns grey for unknown", () => {
    expect(severityColor("UNKNOWN")).toBe("#8b949e");
    expect(severityColor("")).toBe("#8b949e");
  });

  it("is case-insensitive", () => {
    expect(severityColor("critical")).toBe("#f85149");
    expect(severityColor("medium")).toBe("#d29922");
  });
});

describe("maxSeverity", () => {
  it("returns CLEAN for empty findings", () => {
    expect(maxSeverity([])).toBe("CLEAN");
  });

  it("returns the highest severity", () => {
    const findings: Finding[] = [
      { id: "1", severity: "LOW", title: "test", description: "", location: "", remediation: "", scanner: "s" },
      { id: "2", severity: "HIGH", title: "test", description: "", location: "", remediation: "", scanner: "s" },
      { id: "3", severity: "MEDIUM", title: "test", description: "", location: "", remediation: "", scanner: "s" },
    ];
    expect(maxSeverity(findings)).toBe("HIGH");
  });

  it("detects CRITICAL as highest", () => {
    const findings: Finding[] = [
      { id: "1", severity: "HIGH", title: "t", description: "", location: "", remediation: "", scanner: "s" },
      { id: "2", severity: "CRITICAL", title: "t", description: "", location: "", remediation: "", scanner: "s" },
    ];
    expect(maxSeverity(findings)).toBe("CRITICAL");
  });

  it("returns INFO when only INFO findings", () => {
    const findings: Finding[] = [
      { id: "1", severity: "INFO", title: "t", description: "", location: "", remediation: "", scanner: "s" },
    ];
    expect(maxSeverity(findings)).toBe("INFO");
  });
});

describe("formatScanDuration", () => {
  it("formats sub-second durations in ms", () => {
    expect(formatScanDuration(500_000_000)).toBe("500ms");
    expect(formatScanDuration(50_000_000)).toBe("50ms");
  });

  it("formats multi-second durations in seconds", () => {
    expect(formatScanDuration(1_500_000_000)).toBe("1.5s");
    expect(formatScanDuration(10_000_000_000)).toBe("10.0s");
  });

  it("handles zero duration", () => {
    expect(formatScanDuration(0)).toBe("0ms");
  });
});

describe("findingCountBySeverity", () => {
  it("counts findings grouped by severity", () => {
    const findings: Finding[] = [
      { id: "1", severity: "HIGH", title: "t", description: "", location: "", remediation: "", scanner: "s" },
      { id: "2", severity: "HIGH", title: "t", description: "", location: "", remediation: "", scanner: "s" },
      { id: "3", severity: "MEDIUM", title: "t", description: "", location: "", remediation: "", scanner: "s" },
      { id: "4", severity: "LOW", title: "t", description: "", location: "", remediation: "", scanner: "s" },
    ];
    const counts = findingCountBySeverity(findings);
    expect(counts).toEqual({ HIGH: 2, MEDIUM: 1, LOW: 1 });
  });

  it("returns empty object for no findings", () => {
    expect(findingCountBySeverity([])).toEqual({});
  });
});

// ── Tool catalog shape ──────────────────────

function parseToolCatalog(data: unknown): { count: number; error?: string } {
  if (!data || typeof data !== "object") return { count: 0 };
  const obj = data as Record<string, unknown>;
  if (obj.error) return { count: 0, error: String(obj.error) };
  if (Array.isArray(data)) return { count: data.length };
  const tools = (obj.tools || obj.catalog || []) as unknown[];
  return { count: Array.isArray(tools) ? tools.length : 0 };
}

describe("parseToolCatalog", () => {
  it("parses array of tools", () => {
    const data = [{ name: "tool1" }, { name: "tool2" }];
    expect(parseToolCatalog(data)).toEqual({ count: 2 });
  });

  it("parses object with tools array", () => {
    const data = { tools: [{ name: "t1" }, { name: "t2" }, { name: "t3" }] };
    expect(parseToolCatalog(data)).toEqual({ count: 3 });
  });

  it("handles error response", () => {
    const data = { error: "gateway: not connected" };
    const result = parseToolCatalog(data);
    expect(result.count).toBe(0);
    expect(result.error).toBe("gateway: not connected");
  });

  it("handles null / undefined", () => {
    expect(parseToolCatalog(null)).toEqual({ count: 0 });
    expect(parseToolCatalog(undefined)).toEqual({ count: 0 });
  });

  it("handles empty object", () => {
    expect(parseToolCatalog({})).toEqual({ count: 0 });
  });
});

// ── Response shape validation ──────────────────────

describe("ScannersResponse shape", () => {
  it("validates a full response structure", () => {
    const response = {
      instances: [
        {
          id: "defenseclaw-ollama",
          label: "DefenseClaw Ollama",
          skills: [
            { name: "browser", path: "/skills/browser", status: "scanned", lastScan: null },
          ],
          mcpServers: [
            { name: "home-assistant", command: "npx", args: ["-y", "@ha/mcp"], transport: "stdio" },
          ],
          toolCatalog: { count: 15 },
        },
        {
          id: "defenseclaw-anthropic",
          label: "DefenseClaw Anthropic",
          skills: [],
          mcpServers: [],
          toolCatalog: { count: 0, error: "gateway: not connected" },
          error: "gateway: not connected",
        },
      ],
      containerSkills: [
        { name: "agent-browser", path: "/home/user/nanoclaw/container/skills/agent-browser" },
        { name: "status", path: "/home/user/nanoclaw/container/skills/status" },
      ],
      notes: [
        "No MCP servers registered with DefenseClaw.",
      ],
    };

    // Validate structure
    expect(response.instances).toHaveLength(2);
    expect(response.instances[0].id).toBe("defenseclaw-ollama");
    expect(response.instances[0].skills).toHaveLength(1);
    expect(response.instances[0].mcpServers).toHaveLength(1);
    expect(response.instances[0].toolCatalog.count).toBe(15);
    expect(response.instances[1].error).toBeDefined();
    expect(response.containerSkills).toHaveLength(2);
    expect(response.notes).toHaveLength(1);
  });

  it("validates scan result within a skill", () => {
    const skill: SkillInfo = {
      name: "malicious-skill",
      path: "/skills/malicious-skill",
      status: "scanned",
      lastScan: {
        scanner: "skill-scanner",
        target: "/skills/malicious-skill",
        timestamp: "2026-04-01T10:00:00Z",
        findings: [
          {
            id: "INJ-001",
            severity: "CRITICAL",
            title: "Prompt Injection",
            description: "Skill contains instructions that override user intent",
            location: "SKILL.md:15",
            remediation: "Remove override directives from skill instructions",
            scanner: "skill-scanner",
          },
          {
            id: "FILE-002",
            severity: "HIGH",
            title: "Unsafe File Access",
            description: "Skill reads /etc/shadow",
            location: "index.ts:42",
            remediation: "Restrict file access to skill directory",
            scanner: "skill-scanner",
          },
        ],
        duration: 2_300_000_000,
      },
    };

    expect(skill.lastScan).toBeDefined();
    expect(skill.lastScan!.findings).toHaveLength(2);
    expect(maxSeverity(skill.lastScan!.findings)).toBe("CRITICAL");
    expect(formatScanDuration(skill.lastScan!.duration)).toBe("2.3s");

    const counts = findingCountBySeverity(skill.lastScan!.findings);
    expect(counts.CRITICAL).toBe(1);
    expect(counts.HIGH).toBe(1);
  });
});
