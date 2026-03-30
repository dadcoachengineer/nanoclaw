import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

const NANOCLAW_API = process.env.NANOCLAW_API || "http://127.0.0.1:3939";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://studio.shearer.live:11434";

async function fetchWithTimeout(url: string, timeoutMs = 3000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: resp.ok, status: resp.status, data: await resp.json().catch(() => null) };
  } catch {
    clearTimeout(timer);
    return { ok: false, status: 0, data: null };
  }
}

/**
 * GET /api/health — comprehensive platform health check
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const checks: Record<string, any> = {};

  // 1. PostgreSQL
  try {
    const start = Date.now();
    const pgOk = await sqlOne("SELECT 1 as ok");
    const latency = Date.now() - start;
    const size = await sqlOne("SELECT pg_size_pretty(pg_database_size('nanoclaw')) as size");
    const conns = await sqlOne("SELECT count(*) as c FROM pg_stat_activity WHERE datname = 'nanoclaw'");
    const taskStats = await sqlOne(`
      SELECT
        (SELECT COUNT(*) FROM tasks) as total_tasks,
        (SELECT COUNT(*) FROM tasks WHERE status != 'Done') as open_tasks,
        (SELECT COUNT(*) FROM tasks WHERE triage_status = 'inbox') as triage_inbox,
        (SELECT COUNT(*) FROM tasks WHERE notion_sync_status = 'pending') as sync_pending,
        (SELECT COUNT(*) FROM tasks WHERE notion_sync_status = 'error') as sync_errors,
        (SELECT COUNT(*) FROM tasks WHERE notion_sync_status = 'synced') as sync_ok,
        (SELECT COUNT(*) FROM people) as people,
        (SELECT COUNT(*) FROM vector_chunks) as vectors,
        (SELECT COUNT(*) FROM archive_items) as archive
    `);
    checks.postgresql = {
      status: "healthy", latencyMs: latency, size: size?.size,
      connections: parseInt(conns?.c || "0"), dataBackend: process.env.DATA_BACKEND || "sqlite",
      ...Object.fromEntries(Object.entries(taskStats || {}).map(([k, v]) => [k, parseInt(v as string)])),
    };
  } catch (err: any) {
    checks.postgresql = { status: "error", error: err.message };
  }

  // 2. NanoClaw core
  const coreResp = await fetchWithTimeout(`${NANOCLAW_API}/api/health`);
  if (coreResp.ok && coreResp.data) {
    checks.nanoclaw = {
      status: "healthy",
      uptime: coreResp.data.uptime,
      groups: coreResp.data.groups,
      containers: coreResp.data.containers,
    };
  } else {
    checks.nanoclaw = { status: "error", error: "API unreachable" };
  }

  // 3. Ollama (Mac Studio)
  const ollamaResp = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`);
  if (ollamaResp.ok && ollamaResp.data) {
    const models = (ollamaResp.data.models || []).map((m: any) => ({
      name: m.name, sizeGb: Math.round((m.size || 0) / 1024 / 1024 / 1024),
    }));
    checks.ollama = { status: "healthy", models, modelCount: models.length, url: OLLAMA_URL };
  } else {
    checks.ollama = { status: "unreachable", url: OLLAMA_URL };
  }

  // 4. Nginx / TLS cert
  try {
    const resp = await fetch("https://dashboard.shearer.live/login", { method: "HEAD" });
    checks.nginx = { status: resp.ok ? "healthy" : "error", httpStatus: resp.status };
  } catch {
    checks.nginx = { status: "error" };
  }
  // Cert expiry from certbot
  try {
    const { execSync } = await import("child_process");
    const certInfo = execSync(
      "openssl s_client -connect dashboard.shearer.live:443 -servername dashboard.shearer.live </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null",
      { timeout: 5000, encoding: "utf-8" }
    );
    const match = certInfo.match(/notAfter=(.+)/);
    if (match) {
      const expiry = new Date(match[1]);
      const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
      checks.nginx.certExpiry = expiry.toISOString();
      checks.nginx.certDaysLeft = daysLeft;
      checks.nginx.certStatus = daysLeft > 14 ? "valid" : daysLeft > 0 ? "expiring" : "expired";
    }
  } catch {}

  // 5. Notion sync health
  try {
    const syncLog = await sql(
      `SELECT status, COUNT(*) as c FROM notion_sync_log
       WHERE synced_at > now() - interval '24 hours'
       GROUP BY status`
    );
    const lastSync = await sqlOne("SELECT MAX(synced_at) as t FROM notion_sync_log WHERE status = 'success'");
    checks.notionSync = {
      status: "active",
      last24h: Object.fromEntries(syncLog.map((r: any) => [r.status, parseInt(r.c)])),
      lastSuccess: lastSync?.t || null,
    };
  } catch {
    checks.notionSync = { status: "unknown" };
  }

  // 6. Pipelines
  try {
    const pipelines = await sql(
      `SELECT id, status, last_run, next_run,
              (SELECT status FROM task_run_logs WHERE task_id = st.id ORDER BY run_at DESC LIMIT 1) as last_status,
              (SELECT duration_ms FROM task_run_logs WHERE task_id = st.id ORDER BY run_at DESC LIMIT 1) as last_duration
       FROM scheduled_tasks st WHERE status = 'active' ORDER BY next_run`
    );
    checks.pipelines = pipelines.map((p: any) => ({
      id: p.id, status: p.status,
      lastRun: p.last_run, nextRun: p.next_run,
      lastStatus: p.last_status, lastDurationMs: p.last_duration,
    }));
  } catch {
    checks.pipelines = [];
  }

  // Overall status
  const allHealthy = checks.postgresql?.status === "healthy" &&
    checks.nanoclaw?.status === "healthy" &&
    checks.ollama?.status === "healthy";

  return NextResponse.json({
    status: allHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    checks,
  });
}
