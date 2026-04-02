import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";
import { execSync } from "child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const OLLAMA_URL = process.env.OLLAMA_URL || "http://studio.shearer.live:11434";

function exec(cmd: string, timeout = 5000): string {
  try { return execSync(cmd, { timeout, encoding: "utf-8" }).trim(); } catch { return ""; }
}

function parseNum(s: string): number { return parseFloat(s) || 0; }

// ── Host metrics (Mac Mini) ──────────────────────

function collectHostMetrics(): Record<string, unknown> {
  const loadAvg = exec("sysctl -n vm.loadavg").replace(/[{}]/g, "").trim().split(/\s+/).map(parseFloat);
  const memPages = exec("vm_stat");
  const pageSize = parseNum(exec("sysctl -n vm.pagesize")) || 16384;
  // vm_stat outputs "Pages free: 103882." — note trailing period
  const pgFree = parseNum((memPages.match(/Pages free:\s+(\d+)/)?.[1]) || "0");
  const pgActive = parseNum((memPages.match(/Pages active:\s+(\d+)/)?.[1]) || "0");
  const pgInactive = parseNum((memPages.match(/Pages inactive:\s+(\d+)/)?.[1]) || "0");
  const pgWired = parseNum((memPages.match(/Pages wired down:\s+(\d+)/)?.[1]) || "0");
  const free = (pgFree * pageSize) / (1024 ** 3);
  const active = (pgActive * pageSize) / (1024 ** 3);
  const inactive = (pgInactive * pageSize) / (1024 ** 3);
  const wired = (pgWired * pageSize) / (1024 ** 3);
  const totalMem = parseNum(exec("sysctl -n hw.memsize")) / (1024 ** 3);
  const usedMem = active + wired; // Used = active + wired (not total - free, which includes inactive)

  // Disk
  const dfLine = exec("df -g / | tail -1").split(/\s+/);
  const diskTotalGb = parseNum(dfLine[1]);
  const diskUsedGb = parseNum(dfLine[2]);
  const diskFreeGb = parseNum(dfLine[3]);

  // Uptime
  const bootTime = parseNum(exec("sysctl -n kern.boottime").match(/sec = (\d+)/)?.[1] || "0");
  const uptimeSeconds = Math.floor(Date.now() / 1000) - bootTime;

  return {
    load1: loadAvg[0] || 0, load5: loadAvg[1] || 0, load15: loadAvg[2] || 0,
    memTotalGb: Math.round(totalMem * 10) / 10,
    memUsedGb: Math.round(usedMem * 10) / 10,
    memFreeGb: Math.round(free * 10) / 10,
    memActiveGb: Math.round(active * 10) / 10,
    memWiredGb: Math.round(wired * 10) / 10,
    diskTotalGb, diskUsedGb, diskFreeGb,
    diskUsedPct: diskTotalGb > 0 ? Math.round((diskUsedGb / diskTotalGb) * 100) : 0,
    uptimeSeconds,
  };
}

// ── Docker metrics ──────────────────────

function collectDockerMetrics(): Record<string, unknown> {
  const ps = exec("docker ps --format '{{.Names}}\\t{{.Status}}\\t{{.Image}}' 2>/dev/null");
  const containers = ps ? ps.split("\n").filter(Boolean).map((line) => {
    const [name, status, image] = line.split("\t");
    return { name, status, image };
  }) : [];

  const images = exec("docker images --format '{{.Repository}}:{{.Tag}}\\t{{.Size}}' 2>/dev/null | head -10");
  const imageList = images ? images.split("\n").filter(Boolean).map((line) => {
    const [name, size] = line.split("\t");
    return { name, size };
  }) : [];

  const diskUsage = exec("docker system df --format '{{.Type}}\\t{{.TotalCount}}\\t{{.Size}}\\t{{.Reclaimable}}' 2>/dev/null");
  const diskRows = diskUsage ? diskUsage.split("\n").filter(Boolean).map((line) => {
    const [type, count, size, reclaimable] = line.split("\t");
    return { type, count, size, reclaimable };
  }) : [];

  return { containers, images: imageList, diskUsage: diskRows, running: containers.length };
}

// ── Nginx metrics ──────────────────────

function collectNginxMetrics(): Record<string, unknown> {
  // Check if nginx is running
  const pid = exec("pgrep nginx | head -1");
  if (!pid) return { running: false };

  // Cert info
  const certFile = exec("ls /opt/homebrew/etc/nginx/ssl/dashboard.shearer.live.crt 2>/dev/null || ls /etc/letsencrypt/live/dashboard.shearer.live/fullchain.pem 2>/dev/null");
  let certDaysLeft = -1;
  if (certFile) {
    const expiry = exec(`openssl x509 -enddate -noout -in "${certFile}" 2>/dev/null`).replace("notAfter=", "");
    if (expiry) {
      certDaysLeft = Math.floor((new Date(expiry).getTime() - Date.now()) / (86400 * 1000));
    }
  }

  // Try stub_status
  const stubStatus = exec("curl -s http://127.0.0.1:8080/nginx_status 2>/dev/null");
  let activeConnections = 0;
  let totalRequests = 0;
  if (stubStatus) {
    activeConnections = parseNum(stubStatus.match(/Active connections:\s*(\d+)/)?.[1] || "0");
    totalRequests = parseNum(stubStatus.match(/\s+(\d+)\s+\d+\s+\d+\s*$/m)?.[1] || "0");
  }

  return { running: true, pid: parseInt(pid), certDaysLeft, activeConnections, totalRequests };
}

// ── PostgreSQL metrics ──────────────────────

async function collectPgMetrics(): Promise<Record<string, unknown>> {
  const sizeResult = await sqlOne("SELECT pg_database_size(current_database()) as size_bytes");
  const connResult = await sqlOne("SELECT count(*) as total, count(*) filter (where state = 'active') as active FROM pg_stat_activity WHERE datname = current_database()");
  const tableStats = await sql("SELECT relname, n_tup_ins, n_tup_upd, n_tup_del, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10");
  const cacheResult = await sqlOne("SELECT sum(heap_blks_hit) as hits, sum(heap_blks_read) as reads FROM pg_statio_user_tables");
  const hits = parseInt(cacheResult?.hits || "0");
  const reads = parseInt(cacheResult?.reads || "0");
  const cacheHitRatio = hits + reads > 0 ? Math.round((hits / (hits + reads)) * 10000) / 100 : 100;

  // Check latency
  const start = Date.now();
  await sqlOne("SELECT 1");
  const latencyMs = Date.now() - start;

  return {
    sizeBytes: parseInt(sizeResult?.size_bytes || "0"),
    sizeMb: Math.round(parseInt(sizeResult?.size_bytes || "0") / (1024 * 1024)),
    connections: parseInt(connResult?.total || "0"),
    activeConnections: parseInt(connResult?.active || "0"),
    cacheHitRatio,
    latencyMs,
    topTables: tableStats.map((t: any) => ({
      name: t.relname,
      rows: parseInt(t.n_live_tup),
      inserts: parseInt(t.n_tup_ins),
      updates: parseInt(t.n_tup_upd),
      deletes: parseInt(t.n_tup_del),
    })),
  };
}

// ── Ollama metrics (both local and studio) ──────────────────────

async function collectOllamaInstance(url: string): Promise<Record<string, unknown>> {
  try {
    const start = Date.now();
    const tagsResp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - start;
    const tags = await tagsResp.json() as any;

    const psResp = await fetch(`${url}/api/ps`, { signal: AbortSignal.timeout(5000) });
    const ps = await psResp.json() as any;

    const models = (tags.models || []).map((m: any) => ({
      name: m.name, sizeGb: Math.round(m.size / (1024 ** 3) * 10) / 10,
    }));

    const loaded = (ps.models || []).map((m: any) => ({
      name: m.name,
      sizeGb: Math.round((m.size || 0) / (1024 ** 3) * 10) / 10,
      vramGb: Math.round((m.size_vram || 0) / (1024 ** 3) * 10) / 10,
      expires: m.expires_at,
    }));

    const totalVramGb = loaded.reduce((s: number, m: any) => s + m.vramGb, 0);

    return {
      reachable: true, latencyMs, modelCount: models.length,
      models, loaded, totalVramGb: Math.round(totalVramGb * 10) / 10,
    };
  } catch {
    return { reachable: false, latencyMs: -1, modelCount: 0, models: [], loaded: [], totalVramGb: 0 };
  }
}

// ── DefenseClaw status ──────────────────────

async function collectDefenseClawStatus(apiUrl: string): Promise<Record<string, unknown>> {
  try {
    const start = Date.now();
    const resp = await fetch(`${apiUrl}/status`, { signal: AbortSignal.timeout(3000) });
    const latencyMs = Date.now() - start;
    const data = await resp.json() as any;
    const health = data.health || {};
    const guardrail = health.guardrail || {};
    return {
      reachable: true,
      latencyMs,
      uptime: health.uptime_ms ? Math.round(health.uptime_ms / 1000) : 0,
      mode: guardrail.details?.mode || "unknown",
      port: guardrail.details?.port || 0,
      state: guardrail.state || "unknown",
    };
  } catch {
    return { reachable: false, latencyMs: -1, mode: "unknown", state: "down" };
  }
}

// ── Pipeline metrics (from existing data) ──────────────────────

async function collectPipelineMetrics(): Promise<Record<string, unknown>> {
  // Recent runs
  const recentRuns = await sql(`
    SELECT task_id, status, run_at::text, duration_ms
    FROM task_run_logs
    WHERE run_at > now() - interval '24 hours'
    ORDER BY run_at DESC
    LIMIT 50
  `);

  // Per-pipeline stats for last 7 days
  const pipelineStats = await sql(`
    SELECT task_id,
           COUNT(*) as runs,
           COUNT(*) filter (where status = 'success') as successes,
           COUNT(*) filter (where status = 'error') as errors,
           ROUND(AVG(duration_ms)) as avg_duration_ms,
           MAX(run_at)::text as last_run
    FROM task_run_logs
    WHERE run_at > now() - interval '7 days'
    GROUP BY task_id
    ORDER BY task_id
  `);

  // Tasks created per day (last 7 days)
  const tasksPerDay = await sql(`
    SELECT created_at::date::text as day, COUNT(*) as count
    FROM tasks
    WHERE created_at > now() - interval '7 days'
    GROUP BY created_at::date
    ORDER BY day
  `);

  // Triage stats
  const triageStats = await sqlOne(`
    SELECT
      COUNT(*) filter (where triage_status = 'inbox') as inbox,
      COUNT(*) filter (where triage_status = 'accepted') as accepted,
      COUNT(*) filter (where triage_status = 'dismissed') as dismissed
    FROM tasks WHERE created_at > now() - interval '7 days'
  `);

  // Notion sync stats
  const syncStats = await sqlOne(`
    SELECT
      COUNT(*) filter (where direction = 'to_notion' and status = 'success') as outbound_ok,
      COUNT(*) filter (where direction = 'to_notion' and status = 'error') as outbound_err,
      COUNT(*) filter (where direction = 'from_notion' and status = 'success') as inbound_ok
    FROM notion_sync_log WHERE synced_at > now() - interval '24 hours'
  `);

  return {
    recentRuns: recentRuns.map((r: any) => ({ ...r, duration_ms: parseInt(r.duration_ms) })),
    pipelineStats: pipelineStats.map((p: any) => ({
      id: p.task_id, runs: parseInt(p.runs), successes: parseInt(p.successes),
      errors: parseInt(p.errors), avgDurationMs: parseInt(p.avg_duration_ms), lastRun: p.last_run,
    })),
    tasksPerDay: tasksPerDay.map((d: any) => ({ day: d.day, count: parseInt(d.count) })),
    triage: {
      inbox: parseInt(triageStats?.inbox || "0"),
      accepted: parseInt(triageStats?.accepted || "0"),
      dismissed: parseInt(triageStats?.dismissed || "0"),
    },
    notionSync: {
      outboundOk: parseInt(syncStats?.outbound_ok || "0"),
      outboundErr: parseInt(syncStats?.outbound_err || "0"),
      inboundOk: parseInt(syncStats?.inbound_ok || "0"),
    },
  };
}

// ── Data flow stats (for Sankey) ──────────────────────

async function collectDataFlowStats(): Promise<Record<string, unknown>> {
  const sources = await sql(`
    SELECT source, COUNT(*) as count
    FROM tasks WHERE created_at > now() - interval '7 days'
    GROUP BY source ORDER BY count DESC
  `);

  const archiveSources = await sql(`
    SELECT source_type, COUNT(*) as count
    FROM archive_items WHERE archived_at > now() - interval '7 days'
    GROUP BY source_type ORDER BY count DESC
  `);

  return {
    tasksBySource: sources.map((s: any) => ({ source: s.source, count: parseInt(s.count) })),
    archiveBySource: archiveSources.map((s: any) => ({ source: s.source_type, count: parseInt(s.count) })),
  };
}

// ── Sparkline data (latency history per hop) ──────────────────────

async function collectSparklines(): Promise<Record<string, { time: string; value: number }[]>> {
  const rows = await sql(`
    SELECT hop_id, sampled_at::text as time,
           COALESCE(latency_ms, 0) as value
    FROM observability_samples
    WHERE sampled_at > now() - interval '24 hours'
    ORDER BY sampled_at ASC
  `);

  const byHop: Record<string, { time: string; value: number }[]> = {};
  for (const r of rows) {
    if (!byHop[r.hop_id]) byHop[r.hop_id] = [];
    byHop[r.hop_id].push({ time: r.time, value: parseInt(r.value) });
  }
  return byHop;
}

// ── Main handler ──────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sample = req.nextUrl.searchParams.get("sample") === "true";

  // Collect all metrics in parallel
  const [host, docker, nginx, pg, ollamaStudio, dcOllama, dcAnthropic, pipelines, dataFlow, sparklines] = await Promise.all([
    collectHostMetrics(),
    collectDockerMetrics(),
    collectNginxMetrics(),
    collectPgMetrics(),
    collectOllamaInstance(OLLAMA_URL),
    collectDefenseClawStatus("http://127.0.0.1:18790"),
    collectDefenseClawStatus("http://127.0.0.1:18792"),
    collectPipelineMetrics(),
    collectDataFlowStats(),
    collectSparklines(),
  ]);

  // Get hop registry
  const hops = await sql("SELECT * FROM observability_hops WHERE enabled = true ORDER BY position");

  // Build hop statuses — must match actual running services
  const hopStatus: Record<string, { status: string; latencyMs: number; metrics: any }> = {
    "browser": { status: "healthy", latencyMs: 0, metrics: {} },
    "nginx": { status: (nginx as any).running ? "healthy" : "down", latencyMs: 0, metrics: nginx },
    "dashboard": { status: "healthy", latencyMs: 0, metrics: {} },
    "nanoclaw-core": { status: "healthy", latencyMs: 0, metrics: host },
    // notion-sync is an in-process worker inside NanoClaw Core, not a separate service
    "postgresql": { status: "healthy", latencyMs: (pg as any).latencyMs, metrics: pg },
    "ollama-studio": { status: (ollamaStudio as any).reachable ? "healthy" : "down", latencyMs: (ollamaStudio as any).latencyMs, metrics: ollamaStudio },
    "defenseclaw-ollama": { status: (dcOllama as any).reachable ? "healthy" : "down", latencyMs: (dcOllama as any).latencyMs, metrics: dcOllama },
    "defenseclaw-anthropic": { status: (dcAnthropic as any).reachable ? "healthy" : "down", latencyMs: (dcAnthropic as any).latencyMs, metrics: dcAnthropic },
    "docker": { status: "healthy", latencyMs: 0, metrics: docker },
    "onecli": { status: "healthy", latencyMs: 0, metrics: {} },
  };

  // If sample=true, persist metrics for sparkline history
  if (sample) {
    for (const [hopId, data] of Object.entries(hopStatus)) {
      await sql(
        "INSERT INTO observability_samples (hop_id, latency_ms, status, metrics) VALUES ($1, $2, $3, $4)",
        [hopId, data.latencyMs, data.status, JSON.stringify(data.metrics)]
      ).catch(() => {});
    }
    // Cleanup old samples (keep 7 days)
    await sql("DELETE FROM observability_samples WHERE sampled_at < now() - interval '7 days'").catch(() => {});
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    hops: hops.map((h: any) => ({
      ...h,
      ...(hopStatus[h.id] || { status: "unknown", latencyMs: -1, metrics: {} }),
    })),
    host, docker, nginx, pg, ollamaStudio,
    pipelines, dataFlow, sparklines,
    config: {
      dataBackend: process.env.DATA_BACKEND || "sqlite",
      dataBackendDescription: "SQLite = message bus (chats, sessions, router state), PostgreSQL = application DB (tasks, people, initiatives, artifacts)",
    },
  });
}
