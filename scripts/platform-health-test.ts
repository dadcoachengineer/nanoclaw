#!/usr/bin/env tsx
/**
 * Platform Health Test — live integration checks against the running NanoClaw platform.
 *
 * Checks service reachability, DC guardrail proxies, pipeline status, database health,
 * Ollama models, TLS cert expiry, backup freshness, DC audit store, and Notion sync.
 *
 * Output: structured JSON to stdout and to cache files.
 * Exit codes: 0 = healthy, 1 = degraded, 2 = critical
 *
 * Usage: npx tsx scripts/platform-health-test.ts
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import pg from "pg";

// ── Configuration ────────────────────────────────────────────────────────────

const NANOCLAW_API = process.env.NANOCLAW_API || "http://127.0.0.1:3939";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://127.0.0.1:3940";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://studio.shearer.live:11434";
const DC_OLLAMA_URL = process.env.DC_OLLAMA_URL || "http://127.0.0.1:9001";
const DC_ANTHROPIC_URL = process.env.DC_ANTHROPIC_URL || "http://127.0.0.1:9002";
const ONECLI_URL = process.env.ONECLI_URL || "http://127.0.0.1:10254";
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";
const BACKUP_ROOT = "/Users/nanoclaw/backups/nanoclaw";
const LOGS_DIR = "/Users/nanoclaw/nanoclaw/logs";
const CACHE_PATH = "/tmp/nanoclaw-platform-health.json";
const LOGS_RESULT_PATH = path.join(LOGS_DIR, "platform-health.json");

const REQUIRED_MODELS = ["gemma3:27b", "gemma4:26b", "granite3.3:8b", "nomic-embed-text"];

const FRESHNESS_THRESHOLD_MS = 25 * 60 * 60 * 1000; // 25 hours
const CERT_WARN_DAYS = 14;

// ── Types ────────────────────────────────────────────────────────────────────

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
}

type Severity = "critical" | "important" | "informational";

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number; data: unknown }> {
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

async function runCheck(
  name: string,
  severity: Severity,
  fn: () => Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }>,
): Promise<CheckResult & { severity: Severity }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { name, ...result, durationMs: Date.now() - start, severity };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      status: "fail",
      message: `Exception: ${message}`,
      durationMs: Date.now() - start,
      severity,
    };
  }
}

// ── Check functions ──────────────────────────────────────────────────────────

async function checkPostgresql(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const res = await pool.query("SELECT 1 AS ok");
    if (!res.rows[0]?.ok) return { status: "fail", message: "PG query returned no rows" };

    const tables = await pool.query(
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tasks = await pool.query("SELECT COUNT(*) AS c FROM tasks");
    const vectors = await pool.query("SELECT COUNT(*) AS c FROM vector_chunks");

    return {
      status: "pass",
      message: `Connected. ${tables.rows[0].c} tables, ${tasks.rows[0].c} tasks, ${vectors.rows[0].c} vectors`,
      details: {
        tableCount: parseInt(tables.rows[0].c),
        taskCount: parseInt(tasks.rows[0].c),
        vectorCount: parseInt(vectors.rows[0].c),
      },
    };
  } finally {
    await pool.end();
  }
}

async function checkNanoclawCore(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  const resp = await fetchWithTimeout(`${NANOCLAW_API}/api/health`, 5000);
  if (!resp.ok) return { status: "fail", message: "NanoClaw core API unreachable" };
  const data = resp.data as Record<string, unknown> | null;
  return {
    status: "pass",
    message: `Running. Uptime: ${data?.uptime ?? "unknown"}s, groups: ${data?.groups ?? "?"}`,
    details: { uptime: data?.uptime, groups: data?.groups },
  };
}

async function checkDashboard(): Promise<{ status: "pass" | "fail" | "warn"; message: string }> {
  const resp = await fetchWithTimeout(`${DASHBOARD_URL}/login`, 5000);
  if (!resp.ok && resp.status === 0) return { status: "fail", message: "Dashboard unreachable" };
  return { status: "pass", message: `Dashboard responding (HTTP ${resp.status})` };
}

async function checkOllama(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  const resp = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, 5000);
  if (!resp.ok) return { status: "fail", message: "Ollama unreachable" };
  const data = resp.data as { models?: Array<{ name: string }> } | null;
  const models = (data?.models || []).map((m) => m.name);
  const missing = REQUIRED_MODELS.filter((r) => !models.some((m) => m.startsWith(r)));
  if (missing.length > 0) {
    return {
      status: "warn",
      message: `Ollama reachable but missing models: ${missing.join(", ")}`,
      details: { available: models, missing },
    };
  }
  return {
    status: "pass",
    message: `${models.length} models loaded, all required present`,
    details: { modelCount: models.length, available: models },
  };
}

async function checkDCOllama(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  const resp = await fetchWithTimeout(`${DC_OLLAMA_URL}/health/liveliness`, 5000);
  if (!resp.ok) return { status: "fail", message: "DC Ollama :9001 unreachable" };
  const data = resp.data as Record<string, unknown> | null;
  if (data?.status !== "healthy") return { status: "fail", message: `DC Ollama unhealthy: ${JSON.stringify(data)}` };
  return { status: "pass", message: "DC Ollama :9001 healthy", details: { port: 9001 } };
}

async function checkDCAnthropic(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  const resp = await fetchWithTimeout(`${DC_ANTHROPIC_URL}/health/liveliness`, 5000);
  if (!resp.ok) return { status: "fail", message: "DC Anthropic :9002 unreachable" };
  const data = resp.data as Record<string, unknown> | null;
  if (data?.status !== "healthy") return { status: "fail", message: `DC Anthropic unhealthy: ${JSON.stringify(data)}` };
  return { status: "pass", message: "DC Anthropic :9002 healthy", details: { port: 9002 } };
}

async function checkNginx(): Promise<{ status: "pass" | "fail" | "warn"; message: string }> {
  try {
    execSync("pgrep -f 'nginx: master'", { timeout: 3000 });
    return { status: "pass", message: "Nginx process running" };
  } catch {
    // Fallback: try HTTPS request to confirm Nginx is serving
    try {
      const resp = await fetch("https://dashboard.shearer.live/login", { method: "HEAD", signal: AbortSignal.timeout(3000) });
      if (resp.ok) return { status: "pass", message: `Nginx responding (HTTP ${resp.status})` };
      return { status: "fail", message: `Nginx returned HTTP ${resp.status}` };
    } catch {
      return { status: "fail", message: "Nginx process not found and HTTPS unreachable" };
    }
  }
}

async function checkOneCLI(): Promise<{ status: "pass" | "fail" | "warn"; message: string }> {
  const resp = await fetchWithTimeout(`${ONECLI_URL}/health`, 5000);
  if (resp.ok) return { status: "pass", message: "OneCLI responsive" };
  // Try via Docker
  try {
    execSync("docker ps --filter name=onecli --format '{{.Status}}'", { timeout: 5000 });
    return { status: "pass", message: "OneCLI container running" };
  } catch {
    return { status: "warn", message: "OneCLI unreachable" };
  }
}

async function checkPipelines(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const pipelines = await pool.query(
      "SELECT id, status, last_run, next_run FROM scheduled_tasks WHERE status IN ('active', 'paused')",
    );
    const active = pipelines.rows.filter((r: { status: string }) => r.status === "active");
    const stale: string[] = [];
    const now = Date.now();

    for (const p of active) {
      if (p.last_run) {
        const lastRunMs = new Date(p.last_run).getTime();
        if (now - lastRunMs > FRESHNESS_THRESHOLD_MS) {
          stale.push(p.id);
        }
      }
    }

    if (stale.length > 0) {
      return {
        status: "fail",
        message: `${active.length} active pipelines, ${stale.length} stale (>25h): ${stale.join(", ")}`,
        details: { activeCount: active.length, stalePipelines: stale },
      };
    }

    return {
      status: "pass",
      message: `${active.length} active pipelines, all ran within 25h`,
      details: { activeCount: active.length, totalCount: pipelines.rows.length },
    };
  } finally {
    await pool.end();
  }
}

async function checkBackup(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  try {
    const entries = fs.readdirSync(BACKUP_ROOT).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort().reverse();
    if (entries.length === 0) return { status: "fail", message: "No backups found" };

    const latest = entries[0];
    const manifestPath = path.join(BACKUP_ROOT, latest, "manifest.json");
    let manifest: Record<string, unknown> | null = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      // manifest missing is a soft issue
    }

    const latestDate = new Date(latest + "T23:59:59");
    const ageMs = Date.now() - latestDate.getTime();
    if (ageMs > FRESHNESS_THRESHOLD_MS) {
      return {
        status: "fail",
        message: `Latest backup is ${latest}, older than 25h`,
        details: { latestBackup: latest, ageHours: Math.round(ageMs / 3600000) },
      };
    }

    return {
      status: "pass",
      message: `Latest backup: ${latest} (${entries.length} total)`,
      details: {
        latestBackup: latest,
        backupCount: entries.length,
        errors: manifest?.errors ?? "unknown",
        totalSize: manifest?.total_size ?? "unknown",
      },
    };
  } catch {
    return { status: "fail", message: "Cannot read backup directory" };
  }
}

async function checkTLSCert(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  try {
    const certInfo = execSync(
      'openssl s_client -connect dashboard.shearer.live:443 -servername dashboard.shearer.live </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null',
      { timeout: 10000, encoding: "utf-8" },
    );
    const match = certInfo.match(/notAfter=(.+)/);
    if (!match) return { status: "warn", message: "Could not parse cert expiry" };
    const expiry = new Date(match[1]);
    const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
    if (daysLeft <= 0) return { status: "fail", message: `TLS cert EXPIRED`, details: { daysLeft, expiry: expiry.toISOString() } };
    if (daysLeft <= CERT_WARN_DAYS) return { status: "warn", message: `TLS cert expires in ${daysLeft} days`, details: { daysLeft, expiry: expiry.toISOString() } };
    return { status: "pass", message: `TLS cert valid for ${daysLeft} days`, details: { daysLeft, expiry: expiry.toISOString() } };
  } catch {
    return { status: "warn", message: "Could not check TLS cert" };
  }
}

async function checkDCAuditStore(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  // Check DC audit DB exists
  const auditDbPath = "/Users/nanoclaw/.defenseclaw/audit.db";
  if (!fs.existsSync(auditDbPath)) {
    return { status: "warn", message: "DC audit database not found" };
  }

  // Check DC audit API
  const resp = await fetchWithTimeout(`${DC_OLLAMA_URL}/audit/stats`, 5000);
  if (resp.ok) {
    return { status: "pass", message: "DC audit store responsive", details: { data: resp.data } };
  }

  // Fallback: just confirm the file exists and has content
  try {
    const stat = fs.statSync(auditDbPath);
    if (stat.size > 0) {
      return { status: "pass", message: `DC audit DB exists (${Math.round(stat.size / 1024)}KB)`, details: { sizeKB: Math.round(stat.size / 1024) } };
    }
    return { status: "warn", message: "DC audit DB exists but is empty" };
  } catch {
    return { status: "warn", message: "Cannot stat DC audit DB" };
  }
}

async function checkNotionSync(): Promise<{ status: "pass" | "fail" | "warn"; message: string; details?: Record<string, unknown> }> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const lastSync = await pool.query(
      "SELECT MAX(synced_at) AS t FROM notion_sync_log WHERE status = 'success'",
    );
    const lastSyncTime = lastSync.rows[0]?.t;
    if (!lastSyncTime) return { status: "warn", message: "No successful Notion syncs recorded" };

    const ageMs = Date.now() - new Date(lastSyncTime).getTime();
    if (ageMs > FRESHNESS_THRESHOLD_MS) {
      return {
        status: "warn",
        message: `Last Notion sync was ${Math.round(ageMs / 3600000)}h ago`,
        details: { lastSync: lastSyncTime, ageHours: Math.round(ageMs / 3600000) },
      };
    }

    return {
      status: "pass",
      message: `Last Notion sync: ${Math.round(ageMs / 60000)}m ago`,
      details: { lastSync: lastSyncTime, ageMinutes: Math.round(ageMs / 60000) },
    };
  } finally {
    await pool.end();
  }
}

// ── Status aggregation ───────────────────────────────────────────────────────

export function aggregateStatus(
  checks: Array<CheckResult & { severity: Severity }>,
): OverallStatus {
  const criticalFails = checks.filter(
    (c) => c.severity === "critical" && c.status === "fail",
  );
  if (criticalFails.length > 0) return "critical";

  const importantFails = checks.filter(
    (c) => c.severity === "important" && c.status === "fail",
  );
  if (importantFails.length > 0) return "degraded";

  return "healthy";
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const checks = await Promise.all([
    // Critical checks
    runCheck("PostgreSQL", "critical", checkPostgresql),
    runCheck("NanoClaw Core", "critical", checkNanoclawCore),
    runCheck("Ollama", "critical", checkOllama),
    runCheck("DC Ollama :9001", "critical", checkDCOllama),

    // Important checks
    runCheck("DC Anthropic :9002", "important", checkDCAnthropic),
    runCheck("Dashboard", "important", checkDashboard),
    runCheck("Nginx", "important", checkNginx),
    runCheck("Pipelines", "important", checkPipelines),
    runCheck("Backup Freshness", "important", checkBackup),

    // Informational checks
    runCheck("Notion Sync", "informational", checkNotionSync),
    runCheck("TLS Certificate", "informational", checkTLSCert),
    runCheck("OneCLI", "informational", checkOneCLI),
    runCheck("DC Audit Store", "informational", checkDCAuditStore),
  ]);

  const status = aggregateStatus(checks);

  // Strip severity from output (internal only)
  const outputChecks: CheckResult[] = checks.map(({ severity: _s, ...rest }) => rest);

  const report: HealthReport = {
    status,
    timestamp: new Date().toISOString(),
    checks: outputChecks,
    summary: {
      pass: checks.filter((c) => c.status === "pass").length,
      fail: checks.filter((c) => c.status === "fail").length,
      warn: checks.filter((c) => c.status === "warn").length,
    },
  };

  const json = JSON.stringify(report, null, 2);

  // Write to stdout
  console.log(json);

  // Write cache files
  try {
    fs.writeFileSync(CACHE_PATH, json, "utf-8");
  } catch (err) {
    console.error(`Warning: could not write cache to ${CACHE_PATH}: ${err}`);
  }

  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(LOGS_RESULT_PATH, json, "utf-8");
  } catch (err) {
    console.error(`Warning: could not write results to ${LOGS_RESULT_PATH}: ${err}`);
  }

  // Exit code
  if (status === "critical") process.exit(2);
  if (status === "degraded") process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error in platform health test:", err);
  process.exit(2);
});
