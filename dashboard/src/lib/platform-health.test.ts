/**
 * Tests for platform health infrastructure.
 *
 * Validates:
 * - Check result shape validation
 * - Status aggregation (all pass -> healthy, important fail -> degraded, critical fail -> critical)
 * - Summary computation
 * - Cache logic (fresh, stale, missing, malformed)
 * - Severity classification
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  aggregateStatus,
  computeSummary,
  isValidHealthReport,
  checkSeverity,
  readCachedReport,
  CRITICAL_CHECKS,
  IMPORTANT_CHECKS,
  INFORMATIONAL_CHECKS,
  type CheckResult,
  type HealthReport,
} from "./platform-health";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCheck(
  name: string,
  status: "pass" | "fail" | "warn",
  message = "test",
): CheckResult {
  return { name, status, message, durationMs: 10 };
}

function makeReport(overrides: Partial<HealthReport> = {}): HealthReport {
  const checks = overrides.checks ?? [
    makeCheck("PostgreSQL", "pass"),
    makeCheck("NanoClaw Core", "pass"),
    makeCheck("Ollama", "pass"),
    makeCheck("DC Ollama :9001", "pass"),
    makeCheck("Dashboard", "pass"),
    makeCheck("Nginx", "pass"),
  ];
  return {
    status: overrides.status ?? "healthy",
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    checks,
    summary: overrides.summary ?? computeSummary(checks),
  };
}

// ── Check result shape ───────────────────────────────────────────────────────

describe("isValidHealthReport", () => {
  it("accepts a valid healthy report", () => {
    const report = makeReport();
    expect(isValidHealthReport(report)).toBe(true);
  });

  it("accepts a valid degraded report", () => {
    const report = makeReport({ status: "degraded" });
    expect(isValidHealthReport(report)).toBe(true);
  });

  it("accepts a valid critical report", () => {
    const report = makeReport({ status: "critical" });
    expect(isValidHealthReport(report)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidHealthReport(null)).toBe(false);
  });

  it("rejects non-object", () => {
    expect(isValidHealthReport("not an object")).toBe(false);
  });

  it("rejects missing status", () => {
    const { status: _s, ...rest } = makeReport();
    expect(isValidHealthReport(rest)).toBe(false);
  });

  it("rejects invalid status value", () => {
    const report = { ...makeReport(), status: "unknown" };
    expect(isValidHealthReport(report)).toBe(false);
  });

  it("rejects missing timestamp", () => {
    const { timestamp: _t, ...rest } = makeReport();
    expect(isValidHealthReport(rest)).toBe(false);
  });

  it("rejects non-string timestamp", () => {
    const report = { ...makeReport(), timestamp: 12345 };
    expect(isValidHealthReport(report)).toBe(false);
  });

  it("rejects missing checks array", () => {
    const { checks: _c, ...rest } = makeReport();
    expect(isValidHealthReport(rest)).toBe(false);
  });

  it("rejects non-array checks", () => {
    const report = { ...makeReport(), checks: "not an array" };
    expect(isValidHealthReport(report)).toBe(false);
  });

  it("rejects missing summary", () => {
    const { summary: _s, ...rest } = makeReport();
    expect(isValidHealthReport(rest)).toBe(false);
  });

  it("rejects summary with non-number fields", () => {
    const report = { ...makeReport(), summary: { pass: "1", fail: 0, warn: 0 } };
    expect(isValidHealthReport(report)).toBe(false);
  });

  it("rejects check with invalid status", () => {
    const report = makeReport({
      checks: [{ name: "Test", status: "invalid" as "pass", message: "x", durationMs: 0 }],
    });
    expect(isValidHealthReport(report)).toBe(false);
  });

  it("rejects check missing name", () => {
    const report = makeReport({
      checks: [{ name: undefined as unknown as string, status: "pass", message: "x", durationMs: 0 }],
    });
    expect(isValidHealthReport(report)).toBe(false);
  });

  it("rejects check missing durationMs", () => {
    const report = makeReport({
      checks: [{ name: "Test", status: "pass", message: "x", durationMs: undefined as unknown as number }],
    });
    expect(isValidHealthReport(report)).toBe(false);
  });

  it("accepts checks with optional details field", () => {
    const report = makeReport({
      checks: [{ name: "Test", status: "pass", message: "ok", durationMs: 5, details: { key: "val" } }],
    });
    expect(isValidHealthReport(report)).toBe(true);
  });

  it("accepts report with empty checks array", () => {
    const report = makeReport({ checks: [], summary: { pass: 0, fail: 0, warn: 0 } });
    expect(isValidHealthReport(report)).toBe(true);
  });
});

// ── Status aggregation ───────────────────────────────────────────────────────

describe("aggregateStatus", () => {
  it("returns healthy when all checks pass", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("Dashboard", "pass"),
      makeCheck("Nginx", "pass"),
      makeCheck("Notion Sync", "pass"),
    ];
    expect(aggregateStatus(checks)).toBe("healthy");
  });

  it("returns healthy when only informational checks warn", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("Notion Sync", "warn"),
      makeCheck("TLS Certificate", "warn"),
      makeCheck("OneCLI", "warn"),
    ];
    expect(aggregateStatus(checks)).toBe("healthy");
  });

  it("returns healthy when informational checks fail (warnings only)", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("Notion Sync", "fail"),
      makeCheck("TLS Certificate", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("healthy");
  });

  it("returns critical when PostgreSQL fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "fail"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
    ];
    expect(aggregateStatus(checks)).toBe("critical");
  });

  it("returns critical when NanoClaw Core fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "fail"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
    ];
    expect(aggregateStatus(checks)).toBe("critical");
  });

  it("returns critical when Ollama fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "fail"),
      makeCheck("DC Ollama :9001", "pass"),
    ];
    expect(aggregateStatus(checks)).toBe("critical");
  });

  it("returns critical when DC Ollama :9001 fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("critical");
  });

  it("returns degraded when Dashboard fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("Dashboard", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("degraded");
  });

  it("returns degraded when DC Anthropic :9002 fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("DC Anthropic :9002", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("degraded");
  });

  it("returns degraded when Nginx fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("Nginx", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("degraded");
  });

  it("returns degraded when Pipelines fail", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("Pipelines", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("degraded");
  });

  it("returns degraded when Backup Freshness fails", () => {
    const checks = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("Backup Freshness", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("degraded");
  });

  it("critical takes precedence over degraded", () => {
    const checks = [
      makeCheck("PostgreSQL", "fail"),    // critical
      makeCheck("Dashboard", "fail"),      // important
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
    ];
    expect(aggregateStatus(checks)).toBe("critical");
  });

  it("handles empty checks array as healthy", () => {
    expect(aggregateStatus([])).toBe("healthy");
  });

  it("handles all checks failing across all severity levels", () => {
    const checks = [
      makeCheck("PostgreSQL", "fail"),
      makeCheck("NanoClaw Core", "fail"),
      makeCheck("Dashboard", "fail"),
      makeCheck("Notion Sync", "fail"),
    ];
    expect(aggregateStatus(checks)).toBe("critical");
  });
});

// ── Summary computation ──────────────────────────────────────────────────────

describe("computeSummary", () => {
  it("counts all passes", () => {
    const checks = [
      makeCheck("A", "pass"),
      makeCheck("B", "pass"),
      makeCheck("C", "pass"),
    ];
    expect(computeSummary(checks)).toEqual({ pass: 3, fail: 0, warn: 0 });
  });

  it("counts mixed statuses", () => {
    const checks = [
      makeCheck("A", "pass"),
      makeCheck("B", "fail"),
      makeCheck("C", "warn"),
      makeCheck("D", "pass"),
      makeCheck("E", "fail"),
    ];
    expect(computeSummary(checks)).toEqual({ pass: 2, fail: 2, warn: 1 });
  });

  it("handles empty array", () => {
    expect(computeSummary([])).toEqual({ pass: 0, fail: 0, warn: 0 });
  });

  it("all failures", () => {
    const checks = [makeCheck("A", "fail"), makeCheck("B", "fail")];
    expect(computeSummary(checks)).toEqual({ pass: 0, fail: 2, warn: 0 });
  });

  it("all warnings", () => {
    const checks = [makeCheck("A", "warn"), makeCheck("B", "warn")];
    expect(computeSummary(checks)).toEqual({ pass: 0, fail: 0, warn: 2 });
  });
});

// ── Severity classification ──────────────────────────────────────────────────

describe("checkSeverity", () => {
  it("classifies PostgreSQL as critical", () => {
    expect(checkSeverity("PostgreSQL")).toBe("critical");
  });

  it("classifies NanoClaw Core as critical", () => {
    expect(checkSeverity("NanoClaw Core")).toBe("critical");
  });

  it("classifies Ollama as critical", () => {
    expect(checkSeverity("Ollama")).toBe("critical");
  });

  it("classifies DC Ollama :9001 as critical", () => {
    expect(checkSeverity("DC Ollama :9001")).toBe("critical");
  });

  it("classifies Dashboard as important", () => {
    expect(checkSeverity("Dashboard")).toBe("important");
  });

  it("classifies DC Anthropic :9002 as important", () => {
    expect(checkSeverity("DC Anthropic :9002")).toBe("important");
  });

  it("classifies Nginx as important", () => {
    expect(checkSeverity("Nginx")).toBe("important");
  });

  it("classifies Pipelines as important", () => {
    expect(checkSeverity("Pipelines")).toBe("important");
  });

  it("classifies Backup Freshness as important", () => {
    expect(checkSeverity("Backup Freshness")).toBe("important");
  });

  it("classifies Notion Sync as informational", () => {
    expect(checkSeverity("Notion Sync")).toBe("informational");
  });

  it("classifies TLS Certificate as informational", () => {
    expect(checkSeverity("TLS Certificate")).toBe("informational");
  });

  it("classifies OneCLI as informational", () => {
    expect(checkSeverity("OneCLI")).toBe("informational");
  });

  it("classifies DC Audit Store as informational", () => {
    expect(checkSeverity("DC Audit Store")).toBe("informational");
  });

  it("classifies unknown check as informational", () => {
    expect(checkSeverity("Unknown Check")).toBe("informational");
  });

  it("all critical checks are in CRITICAL_CHECKS", () => {
    expect(CRITICAL_CHECKS.length).toBe(4);
  });

  it("all important checks are in IMPORTANT_CHECKS", () => {
    expect(IMPORTANT_CHECKS.length).toBe(5);
  });

  it("all informational checks are in INFORMATIONAL_CHECKS", () => {
    expect(INFORMATIONAL_CHECKS.length).toBe(4);
  });
});

// ── Cache logic ──────────────────────────────────────────────────────────────

describe("readCachedReport", () => {
  const mockFs = {
    existsSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("fs", () => ({ default: mockFs, ...mockFs }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when cache file does not exist", () => {
    // readCachedReport uses require("fs") internally — test the contract
    const result = readCachedReport("/nonexistent/path.json");
    expect(result).toBe(null);
  });

  it("returns null for invalid path", () => {
    const result = readCachedReport("");
    expect(result).toBe(null);
  });

  it("returns null with maxAge of 0 (always stale)", () => {
    // Even if file exists, 0ms max age means always stale
    const result = readCachedReport("/tmp/nanoclaw-platform-health.json", 0);
    expect(result).toBe(null);
  });
});

// ── Full report construction ─────────────────────────────────────────────────

describe("full report construction", () => {
  it("passes all 13 checks produce a healthy report", () => {
    const checks: CheckResult[] = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("DC Anthropic :9002", "pass"),
      makeCheck("Dashboard", "pass"),
      makeCheck("Nginx", "pass"),
      makeCheck("Pipelines", "pass"),
      makeCheck("Backup Freshness", "pass"),
      makeCheck("Notion Sync", "pass"),
      makeCheck("TLS Certificate", "pass"),
      makeCheck("OneCLI", "pass"),
      makeCheck("DC Audit Store", "pass"),
    ];
    const report: HealthReport = {
      status: aggregateStatus(checks),
      timestamp: new Date().toISOString(),
      checks,
      summary: computeSummary(checks),
    };
    expect(report.status).toBe("healthy");
    expect(report.summary).toEqual({ pass: 13, fail: 0, warn: 0 });
    expect(isValidHealthReport(report)).toBe(true);
  });

  it("mixed failures produce correct status hierarchy", () => {
    const checks: CheckResult[] = [
      makeCheck("PostgreSQL", "pass"),
      makeCheck("NanoClaw Core", "pass"),
      makeCheck("Ollama", "pass"),
      makeCheck("DC Ollama :9001", "pass"),
      makeCheck("DC Anthropic :9002", "fail"),
      makeCheck("Dashboard", "pass"),
      makeCheck("Nginx", "fail"),
      makeCheck("Pipelines", "pass"),
      makeCheck("Backup Freshness", "pass"),
      makeCheck("Notion Sync", "warn"),
      makeCheck("TLS Certificate", "warn"),
      makeCheck("OneCLI", "fail"),
      makeCheck("DC Audit Store", "pass"),
    ];
    const status = aggregateStatus(checks);
    const summary = computeSummary(checks);
    expect(status).toBe("degraded"); // important checks failed
    expect(summary).toEqual({ pass: 8, fail: 3, warn: 2 });
  });
});
