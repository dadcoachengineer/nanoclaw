/**
 * Platform health types and status aggregation logic.
 *
 * Shared between the dashboard API route and tests.
 * The actual health checks run in scripts/platform-health-test.ts.
 */

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export type OverallStatus = "healthy" | "degraded" | "critical";

export interface HealthReport {
  status: OverallStatus;
  timestamp: string;
  checks: CheckResult[];
  summary: { pass: number; fail: number; warn: number };
  cached?: boolean;
}

/**
 * Critical checks: failure makes the platform critical.
 */
export const CRITICAL_CHECKS = [
  "PostgreSQL",
  "NanoClaw Core",
  "Ollama",
  "DC Ollama :9001",
];

/**
 * Important checks: failure degrades the platform.
 */
export const IMPORTANT_CHECKS = [
  "DC Anthropic :9002",
  "Dashboard",
  "Nginx",
  "Pipelines",
  "Backup Freshness",
];

/**
 * Informational checks: failure produces a warning only.
 */
export const INFORMATIONAL_CHECKS = [
  "Notion Sync",
  "TLS Certificate",
  "OneCLI",
  "DC Audit Store",
];

/**
 * Derive severity of a check by name.
 */
export function checkSeverity(name: string): "critical" | "important" | "informational" {
  if (CRITICAL_CHECKS.includes(name)) return "critical";
  if (IMPORTANT_CHECKS.includes(name)) return "important";
  return "informational";
}

/**
 * Aggregate individual check results into an overall platform status.
 *
 * - Any critical check failing => "critical"
 * - Any important check failing => "degraded"
 * - Everything else => "healthy"
 */
export function aggregateStatus(checks: CheckResult[]): OverallStatus {
  for (const check of checks) {
    if (check.status === "fail" && CRITICAL_CHECKS.includes(check.name)) {
      return "critical";
    }
  }
  for (const check of checks) {
    if (check.status === "fail" && IMPORTANT_CHECKS.includes(check.name)) {
      return "degraded";
    }
  }
  return "healthy";
}

/**
 * Compute summary counts from check results.
 */
export function computeSummary(checks: CheckResult[]): { pass: number; fail: number; warn: number } {
  return {
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    warn: checks.filter((c) => c.status === "warn").length,
  };
}

/**
 * Validate that a HealthReport has the correct shape.
 */
export function isValidHealthReport(data: unknown): data is HealthReport {
  if (!data || typeof data !== "object") return false;
  const report = data as Record<string, unknown>;
  if (!["healthy", "degraded", "critical"].includes(report.status as string)) return false;
  if (typeof report.timestamp !== "string") return false;
  if (!Array.isArray(report.checks)) return false;
  if (!report.summary || typeof report.summary !== "object") return false;
  const summary = report.summary as Record<string, unknown>;
  if (typeof summary.pass !== "number" || typeof summary.fail !== "number" || typeof summary.warn !== "number") return false;
  // Validate each check
  for (const check of report.checks as unknown[]) {
    if (!check || typeof check !== "object") return false;
    const c = check as Record<string, unknown>;
    if (typeof c.name !== "string") return false;
    if (!["pass", "fail", "warn"].includes(c.status as string)) return false;
    if (typeof c.message !== "string") return false;
    if (typeof c.durationMs !== "number") return false;
  }
  return true;
}

const CACHE_PATH = "/tmp/nanoclaw-platform-health.json";
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Read cached health report from /tmp if it exists and is fresh (< 5 min).
 */
export function readCachedReport(
  cachePath = CACHE_PATH,
  maxAgeMs = CACHE_MAX_AGE_MS,
): HealthReport | null {
  try {
    // Dynamic import for fs so this module can be imported in test environments
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    if (!fs.existsSync(cachePath)) return null;
    const stat = fs.statSync(cachePath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > maxAgeMs) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    if (!isValidHealthReport(data)) return null;
    return data;
  } catch {
    return null;
  }
}
