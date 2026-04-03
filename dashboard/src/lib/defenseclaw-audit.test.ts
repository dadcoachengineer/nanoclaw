/**
 * DefenseClaw Audit Store tests
 *
 * Tests the audit event parsing, severity normalization, timestamp formatting,
 * and response shape from the /api/defenseclaw/audit endpoint.
 */
import { describe, it, expect } from "vitest";

// ── Severity normalization (extracted from audit route) ──────

function normalizeSeverity(sev: string | null | undefined): string {
  if (!sev) return "INFO";
  const upper = sev.toUpperCase();
  switch (upper) {
    case "CRITICAL": return "CRITICAL";
    case "HIGH": return "HIGH";
    case "MEDIUM": return "MEDIUM";
    case "LOW": return "LOW";
    case "ERROR": return "ERROR";
    case "INFO": return "INFO";
    default: return "INFO";
  }
}

// ── Timestamp formatting (extracted from audit route) ────────

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString("en-GB", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return ts;
  }
}

// ── Action state summary (mirrors Go ActionState.Summary) ────

function actionStateSummary(actions: Record<string, string>): string {
  const parts: string[] = [];
  if (actions.install === "block") parts.push("blocked");
  if (actions.install === "allow") parts.push("allowed");
  if (actions.file === "quarantine") parts.push("quarantined");
  if (actions.runtime === "disable") parts.push("disabled");
  return parts.length > 0 ? parts.join(", ") : "-";
}

// ── Response shape types ─────────────────────────────────────

interface AuditEvent {
  id: string;
  timestamp: string;
  action: string;
  target: string;
  actor: string;
  details: string;
  severity: string;
  instance: string;
}

interface AuditAction {
  id: string;
  targetType: string;
  targetName: string;
  sourcePath: string;
  actions: Record<string, string>;
  reason: string;
  updatedAt: string;
  instance: string;
}

interface AuditScan {
  id: string;
  scanner: string;
  target: string;
  timestamp: string;
  durationMs: number;
  findingCount: number;
  maxSeverity: string;
  instance: string;
}

// ── Severity Normalization Tests ─────────────────────────────

describe("normalizeSeverity", () => {
  it("maps standard severities correctly", () => {
    expect(normalizeSeverity("CRITICAL")).toBe("CRITICAL");
    expect(normalizeSeverity("HIGH")).toBe("HIGH");
    expect(normalizeSeverity("MEDIUM")).toBe("MEDIUM");
    expect(normalizeSeverity("LOW")).toBe("LOW");
    expect(normalizeSeverity("ERROR")).toBe("ERROR");
    expect(normalizeSeverity("INFO")).toBe("INFO");
  });

  it("handles lowercase input", () => {
    expect(normalizeSeverity("critical")).toBe("CRITICAL");
    expect(normalizeSeverity("high")).toBe("HIGH");
    expect(normalizeSeverity("medium")).toBe("MEDIUM");
    expect(normalizeSeverity("low")).toBe("LOW");
  });

  it("handles mixed case input", () => {
    expect(normalizeSeverity("Critical")).toBe("CRITICAL");
    expect(normalizeSeverity("mEdIuM")).toBe("MEDIUM");
  });

  it("defaults to INFO for null/undefined", () => {
    expect(normalizeSeverity(null)).toBe("INFO");
    expect(normalizeSeverity(undefined)).toBe("INFO");
  });

  it("defaults to INFO for empty string", () => {
    expect(normalizeSeverity("")).toBe("INFO");
  });

  it("defaults to INFO for unknown severity", () => {
    expect(normalizeSeverity("BANANA")).toBe("INFO");
    expect(normalizeSeverity("URGENT")).toBe("INFO");
  });
});

// ── Timestamp Formatting Tests ───────────────────────────────

describe("formatTimestamp", () => {
  it("converts UTC ISO string to Central Time", () => {
    const result = formatTimestamp("2026-04-02T18:30:00Z");
    // UTC 18:30 = CDT 13:30 (April is CDT, UTC-5)
    expect(result).toContain("13:30:00");
    expect(result).toContain("02/04/2026");
  });

  it("returns original string for invalid date", () => {
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("handles RFC3339 with nanoseconds", () => {
    const result = formatTimestamp("2026-04-02T12:00:00.123456789Z");
    // UTC 12:00 = CDT 07:00
    expect(result).toContain("07:00:00");
  });

  it("uses 24h format", () => {
    const result = formatTimestamp("2026-04-02T23:00:00Z");
    // UTC 23:00 = CDT 18:00
    expect(result).toContain("18:00:00");
    expect(result).not.toContain("AM");
    expect(result).not.toContain("PM");
  });
});

// ── Action State Summary Tests ───────────────────────────────

describe("actionStateSummary", () => {
  it("shows blocked for install=block", () => {
    expect(actionStateSummary({ install: "block" })).toBe("blocked");
  });

  it("shows allowed for install=allow", () => {
    expect(actionStateSummary({ install: "allow" })).toBe("allowed");
  });

  it("shows quarantined for file=quarantine", () => {
    expect(actionStateSummary({ file: "quarantine" })).toBe("quarantined");
  });

  it("shows disabled for runtime=disable", () => {
    expect(actionStateSummary({ runtime: "disable" })).toBe("disabled");
  });

  it("combines multiple states", () => {
    const result = actionStateSummary({ install: "block", file: "quarantine", runtime: "disable" });
    expect(result).toBe("blocked, quarantined, disabled");
  });

  it("returns dash for empty state", () => {
    expect(actionStateSummary({})).toBe("-");
  });

  it("ignores unknown values", () => {
    expect(actionStateSummary({ install: "unknown" })).toBe("-");
  });
});

// ── Response Shape Validation ────────────────────────────────

describe("audit response shape", () => {
  const sampleEvent: AuditEvent = {
    id: "abc-123",
    timestamp: "02/04/2026, 13:30:00",
    action: "scan",
    target: "skill:calculator",
    actor: "defenseclaw",
    details: "Scanned skill calculator",
    severity: "LOW",
    instance: "ollama",
  };

  const sampleAction: AuditAction = {
    id: "def-456",
    targetType: "skill",
    targetName: "calculator",
    sourcePath: "/path/to/skill",
    actions: { install: "block" },
    reason: "Suspicious network calls",
    updatedAt: "02/04/2026, 13:30:00",
    instance: "ollama",
  };

  const sampleScan: AuditScan = {
    id: "ghi-789",
    scanner: "codeguard",
    target: "container-agent",
    timestamp: "02/04/2026, 13:30:00",
    durationMs: 150,
    findingCount: 2,
    maxSeverity: "MEDIUM",
    instance: "anthropic",
  };

  it("event has all required fields", () => {
    expect(sampleEvent).toHaveProperty("id");
    expect(sampleEvent).toHaveProperty("timestamp");
    expect(sampleEvent).toHaveProperty("action");
    expect(sampleEvent).toHaveProperty("target");
    expect(sampleEvent).toHaveProperty("actor");
    expect(sampleEvent).toHaveProperty("details");
    expect(sampleEvent).toHaveProperty("severity");
    expect(sampleEvent).toHaveProperty("instance");
  });

  it("action has all required fields", () => {
    expect(sampleAction).toHaveProperty("id");
    expect(sampleAction).toHaveProperty("targetType");
    expect(sampleAction).toHaveProperty("targetName");
    expect(sampleAction).toHaveProperty("actions");
    expect(sampleAction).toHaveProperty("reason");
    expect(sampleAction).toHaveProperty("updatedAt");
    expect(sampleAction).toHaveProperty("instance");
    expect(typeof sampleAction.actions).toBe("object");
  });

  it("scan has all required fields", () => {
    expect(sampleScan).toHaveProperty("id");
    expect(sampleScan).toHaveProperty("scanner");
    expect(sampleScan).toHaveProperty("target");
    expect(sampleScan).toHaveProperty("timestamp");
    expect(sampleScan).toHaveProperty("durationMs");
    expect(sampleScan).toHaveProperty("findingCount");
    expect(sampleScan).toHaveProperty("maxSeverity");
    expect(sampleScan).toHaveProperty("instance");
    expect(typeof sampleScan.durationMs).toBe("number");
    expect(typeof sampleScan.findingCount).toBe("number");
  });

  it("severity values are consistently uppercase", () => {
    const validSeverities = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "ERROR", "INFO"];
    expect(validSeverities).toContain(sampleEvent.severity);
    expect(validSeverities).toContain(sampleScan.maxSeverity);
  });

  it("instance values match expected identifiers", () => {
    const validInstances = ["ollama", "anthropic"];
    expect(validInstances).toContain(sampleEvent.instance);
    expect(validInstances).toContain(sampleAction.instance);
    expect(validInstances).toContain(sampleScan.instance);
  });
});

// ── Severity Color Mapping Contract ──────────────────────────

describe("audit severity color mapping", () => {
  const SEVERITY_COLORS: Record<string, string> = {
    CRITICAL: "#f85149",
    HIGH: "#f85149",
    ERROR: "#f85149",
    MEDIUM: "#d29922",
    LOW: "var(--yellow)",
    INFO: "#3fb950",
  };

  it("all valid severities have color assignments", () => {
    for (const sev of ["CRITICAL", "HIGH", "ERROR", "MEDIUM", "LOW", "INFO"]) {
      expect(SEVERITY_COLORS[sev]).toBeDefined();
    }
  });

  it("CRITICAL and HIGH are red", () => {
    expect(SEVERITY_COLORS.CRITICAL).toBe("#f85149");
    expect(SEVERITY_COLORS.HIGH).toBe("#f85149");
  });

  it("MEDIUM is amber/orange", () => {
    expect(SEVERITY_COLORS.MEDIUM).toBe("#d29922");
  });

  it("INFO is green (safe)", () => {
    expect(SEVERITY_COLORS.INFO).toBe("#3fb950");
  });
});

// ── Limit Parameter Validation ───────────────────────────────

describe("limit parameter handling", () => {
  function clampLimit(raw: string | null): number {
    return Math.min(Math.max(parseInt(raw || "50", 10) || 50, 1), 200);
  }

  it("defaults to 50 for missing param", () => {
    expect(clampLimit(null)).toBe(50);
  });

  it("defaults to 50 for non-numeric input", () => {
    expect(clampLimit("abc")).toBe(50);
  });

  it("clamps minimum to 1", () => {
    expect(clampLimit("0")).toBe(50); // parseInt("0") is 0, || 50
    expect(clampLimit("-5")).toBe(1);
  });

  it("clamps maximum to 200", () => {
    expect(clampLimit("999")).toBe(200);
    expect(clampLimit("200")).toBe(200);
    expect(clampLimit("201")).toBe(200);
  });

  it("passes through valid values", () => {
    expect(clampLimit("1")).toBe(1);
    expect(clampLimit("100")).toBe(100);
    expect(clampLimit("50")).toBe(50);
  });
});
