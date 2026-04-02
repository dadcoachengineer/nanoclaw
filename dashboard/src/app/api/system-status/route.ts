import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { requireAuth } from "@/lib/require-auth";
import { sql as pgSql, sqlOne as pgSqlOne } from "@/lib/pg";

const STORE_DIR =
  process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const SYSTEM_API = process.env.NANOCLAW_API || "http://127.0.0.1:3939";
const OLLAMA_URL =
  process.env.OLLAMA_BASE_URL || "http://studio.shearer.live:11434";

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

// --- Model cost table ---
// Pricing per million tokens
const MODEL_COSTS: Record<string, { inputPerM: number; outputPerM: number; label: string }> = {
  "claude-sonnet-4-20250514": { inputPerM: 3, outputPerM: 15, label: "Sonnet" },
  "claude-haiku-4-5-20251001": { inputPerM: 0.25, outputPerM: 1.25, label: "Haiku" },
  "local:gemma3:27b": { inputPerM: 0, outputPerM: 0, label: "Local (Gemma 27B)" },
  "local:phi4:14b": { inputPerM: 0, outputPerM: 0, label: "Local (Phi 4 14B)" },
  "local:granite3.3:8b": { inputPerM: 0, outputPerM: 0, label: "Local (Granite 8B)" },
};

// --- Helpers ---

function fetchWithTimeout(
  url: string,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

function fileSizeKb(filePath: string): number {
  try {
    return Math.round(fs.statSync(filePath).size / 1024);
  } catch {
    return 0;
  }
}

function safeJsonParse(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function jsonEntryCount(data: unknown): number {
  if (!data) return 0;
  if (Array.isArray(data)) return data.length;
  if (typeof data === "object") return Object.keys(data!).length;
  return 0;
}

/** Parse a cron expression into a human-readable schedule string */
function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return cron;

  const [minute, hour, _dom, _month, dow] = parts;
  const minPad = minute.padStart(2, "0");

  // "3 7 * * *" -> "Daily 7:03 AM"
  if (_dom === "*" && _month === "*" && dow === "*" && !hour.includes("-") && !hour.includes(",") && !hour.includes("/")) {
    const h = parseInt(hour, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `Daily ${h12}:${minPad} ${ampm}`;
  }

  // "30 6 * * 1" -> "Mondays 6:30 AM"
  const dayNames: Record<string, string> = {
    "0": "Sundays",
    "1": "Mondays",
    "2": "Tuesdays",
    "3": "Wednesdays",
    "4": "Thursdays",
    "5": "Fridays",
    "6": "Saturdays",
  };
  if (
    _dom === "*" &&
    _month === "*" &&
    /^\d$/.test(dow) &&
    !hour.includes("-") &&
    !hour.includes("/")
  ) {
    const h = parseInt(hour, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${dayNames[dow] || `Day ${dow}`} ${h12}:${minPad} ${ampm}`;
  }

  // "47 9-18 * * 1-5" -> "Hourly :47 (9AM-6PM weekdays)"
  if (_dom === "*" && _month === "*" && hour.includes("-")) {
    const [hStart, hEnd] = hour.split("-").map((h) => parseInt(h, 10));
    const fmtH = (h: number) => {
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}${ampm}`;
    };
    let dayLabel = "";
    if (dow === "1-5") dayLabel = " weekdays";
    else if (dow === "0-6" || dow === "*") dayLabel = "";
    else dayLabel = ` (${dow})`;
    return `Hourly :${minPad} (${fmtH(hStart)}-${fmtH(hEnd)}${dayLabel})`;
  }

  // "*/30 * * * *" -> "Every 30m"
  if (minute.startsWith("*/") && hour === "*") {
    return `Every ${minute.slice(2)}m`;
  }

  return cron;
}

/** Get pipeline display name from task ID */
function pipelineName(id: string): string {
  return id
    .replace(/^mc-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Estimate cost per run based on avg duration and model pricing */
function estimateCostPerRun(avgDurationMs: number, model: string): number {
  const costs = MODEL_COSTS[model] || MODEL_COSTS[DEFAULT_MODEL];
  // Estimate: ~10K input tokens per 30s turn, ~30 tokens/sec output
  const turns = Math.max(1, avgDurationMs / 30000);
  const inputTokens = turns * 10000;
  const outputTokens = turns * 30 * 30; // 30 tokens/sec * 30s
  return (inputTokens / 1_000_000) * costs.inputPerM +
    (outputTokens / 1_000_000) * costs.outputPerM;
}

/** Compute runs per day from cron/interval schedule */
function runsPerDay(scheduleType: string, scheduleValue: string): number {
  if (scheduleType === "interval") {
    const ms = parseInt(scheduleValue, 10);
    if (!ms || ms <= 0) return 1;
    return (24 * 60 * 60 * 1000) / ms;
  }
  if (scheduleType === "cron") {
    const parts = scheduleValue.trim().split(/\s+/);
    if (parts.length < 5) return 1;
    const [minute, hour, _dom, _month, dow] = parts;

    // "*/N * * * *" -> every N minutes
    if (minute.startsWith("*/") && hour === "*") {
      const n = parseInt(minute.slice(2), 10);
      return (24 * 60) / n;
    }

    // Hourly range: "M H1-H2 * * DOW"
    if (hour.includes("-")) {
      const [hStart, hEnd] = hour.split("-").map((h) => parseInt(h, 10));
      const hoursPerDay = hEnd - hStart + 1;
      let daysPerWeek = 7;
      if (dow === "1-5") daysPerWeek = 5;
      else if (/^\d$/.test(dow)) daysPerWeek = 1;
      return (hoursPerDay * daysPerWeek) / 7;
    }

    // Weekly: specific DOW
    if (dow !== "*" && /^\d$/.test(dow)) return 1 / 7;

    // Daily
    return 1;
  }
  return 0; // once
}

/** Recommend model based on pipeline name and avg duration */
function recommendModel(id: string, avgDurationMs: number): string {
  const lower = id.toLowerCase();
  // Keep Sonnet for complex reasoning tasks
  if (/briefing|prep|review|checkin/.test(lower)) return "KEEP SONNET";
  // Haiku is vision-capable, good for OCR/image tasks
  if (/vision|ocr|boox|plaud/.test(lower)) return "HAIKU";
  // Message/transcript processing doesn't need deep reasoning
  if (/messages|transcripts/.test(lower)) return "HAIKU";
  // Very short runs might be better as scripts
  if (avgDurationMs > 0 && avgDurationMs < 60000) return "HAIKU or SCRIPT";
  return "KEEP SONNET";
}

function modelLabel(model: string | null): string {
  if (!model) return "Sonnet (default)";
  if (MODEL_COSTS[model]) return MODEL_COSTS[model].label;
  if (model.startsWith("local:")) return `Local (${model.replace("local:", "").split(":")[0]})`;
  return model.split("-")[0] || "Unknown";
}

// --- Database access ---

function openDb(): Database.Database | null {
  try {
    const dbPath = path.join(STORE_DIR, "messages.db");
    if (!fs.existsSync(dbPath)) return null;
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function openWritableDb(): Database.Database | null {
  try {
    const dbPath = path.join(STORE_DIR, "messages.db");
    if (!fs.existsSync(dbPath)) return null;
    return new Database(dbPath);
  } catch {
    return null;
  }
}

/** Ensure the model column exists (migration for dashboard-side reads) */
function ensureModelColumn(db: Database.Database): void {
  try {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN model TEXT DEFAULT NULL");
  } catch {
    /* column already exists */
  }
}

// --- GET handler ---

export async function GET() {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Fetch all data sources in parallel
  const [healthResult, statsResult, runsResult, ollamaResult] =
    await Promise.allSettled([
      fetchWithTimeout(`${SYSTEM_API}/api/health`, 3000).then((r) => r.json()),
      fetchWithTimeout(`${SYSTEM_API}/api/stats`, 3000).then((r) => r.json()),
      fetchWithTimeout(`${SYSTEM_API}/api/runs/recent?limit=20`, 3000).then(
        (r) => r.json()
      ),
      fetchWithTimeout(`${OLLAMA_URL}/api/tags`, 3000).then((r) => r.json()),
    ]);

  const health =
    healthResult.status === "fulfilled" ? healthResult.value : null;
  const stats = statsResult.status === "fulfilled" ? statsResult.value : null;
  const recentRunsRaw =
    runsResult.status === "fulfilled" ? runsResult.value : [];
  const ollamaData =
    ollamaResult.status === "fulfilled" ? ollamaResult.value : null;

  // Read package.json for version
  let version = "unknown";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "..", "package.json"), "utf-8")
    );
    version = pkg.version || "unknown";
  } catch {}

  // Platform
  const platform = {
    status: health ? "ok" : "unreachable",
    uptime: health?.uptime ?? 0,
    timezone: health?.timezone ?? "unknown",
    version,
  };

  // Services
  const nanoclawRunning = !!health;
  const services = [
    {
      name: "NanoClaw",
      status: nanoclawRunning ? "running" : "stopped",
      port: 3939,
      binding: "localhost",
      uptime: health?.uptime ?? null,
    },
    {
      name: "Dashboard",
      status: "running",
      port: 3940,
      binding: "localhost",
      uptime: null,
    },
    {
      name: "Nginx",
      status: "running",
      port: 443,
      binding: "LAN",
      uptime: null,
    },
    {
      name: "OneCLI Proxy",
      status: "running",
      port: 10255,
      binding: "localhost",
      uptime: null,
    },
    {
      name: "Ollama Studio",
      status: ollamaData ? "running" : "stopped",
      port: 11434,
      binding: "LAN",
      uptime: null,
    },
  ];

  // Ollama
  const ollamaModels: string[] = [];
  if (ollamaData?.models) {
    for (const m of ollamaData.models) {
      ollamaModels.push(m.name || m.model || "unknown");
    }
  }
  const ollama = {
    url: OLLAMA_URL,
    reachable: !!ollamaData,
    models: ollamaModels,
  };

  // LLM
  const llm = {
    backend: "api",
    model: DEFAULT_MODEL,
    localAvailable: !!ollamaData,
  };

  // Pipelines from SQLite
  interface PipelineRow {
    id: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    last_run: string | null;
    last_result: string | null;
    next_run: string | null;
    model: string | null;
  }

  let pipelines: {
    id: string;
    name: string;
    schedule: string;
    lastRun: string | null;
    lastStatus: string;
    nextRun: string | null;
    status: string;
    model: string | null;
    modelLabel: string;
    estimatedCostPerRun: number;
    totalEstimatedCost: number;
    avgDurationMs: number;
    runsPerDay: number;
    recommendation: string;
  }[] = [];

  const db = openDb();
  if (db) {
    // Run migration if needed (uses writable connection)
    const wdb = openWritableDb();
    if (wdb) {
      ensureModelColumn(wdb);
      wdb.close();
    }

    try {
      // Read pipeline data from PostgreSQL (system of record)
      const rows = (await pgSql(
        "SELECT id, prompt, schedule_type, schedule_value, status, last_run::text as last_run, last_result, next_run::text as next_run, model FROM scheduled_tasks WHERE status IN ('active', 'paused') ORDER BY next_run NULLS LAST"
      )) as PipelineRow[];

      pipelines = await Promise.all(rows.map(async (row) => {
        // Get last run status from PG task_run_logs
        const lastRunLog = await pgSqlOne(
          "SELECT status FROM task_run_logs WHERE task_id = $1 ORDER BY run_at DESC LIMIT 1",
          [row.id]
        ) as { status: string } | null;

        // Get average duration from last 10 successful runs
        const avgRow = await pgSqlOne(
          "SELECT AVG(duration_ms)::int as avg_ms FROM (SELECT duration_ms FROM task_run_logs WHERE task_id = $1 AND status = 'success' ORDER BY run_at DESC LIMIT 10) sub",
          [row.id]
        ) as { avg_ms: number | null } | null;

        // Get total successful runs count
        const totalRow = await pgSqlOne(
          "SELECT COUNT(*)::int as cnt FROM task_run_logs WHERE task_id = $1 AND status = 'success'",
          [row.id]
        ) as { cnt: number } | null;

        const schedule =
          row.schedule_type === "cron"
            ? cronToHuman(row.schedule_value)
            : row.schedule_type === "interval"
              ? `Every ${Math.round(parseInt(row.schedule_value, 10) / 60000)}m`
              : row.schedule_value;

        const effectiveModel = row.model || DEFAULT_MODEL;
        const avgMs = avgRow?.avg_ms ?? 120000; // default 2 min if no data
        const costPerRun = estimateCostPerRun(avgMs, effectiveModel);
        const totalRuns = totalRow?.cnt ?? 0;
        const totalCost = costPerRun * totalRuns;
        const rpd = runsPerDay(row.schedule_type, row.schedule_value);

        return {
          id: row.id,
          name: pipelineName(row.id),
          schedule,
          lastRun: row.last_run,
          lastStatus: lastRunLog?.status || "never",
          nextRun: row.next_run,
          status: row.status === "paused" && row.model?.startsWith("local:") ? "local" : row.status,
          model: row.model,
          modelLabel: modelLabel(row.model),
          estimatedCostPerRun: Math.round(costPerRun * 1000) / 1000,
          totalEstimatedCost: Math.round(totalCost * 100) / 100,
          avgDurationMs: Math.round(avgMs),
          runsPerDay: Math.round(rpd * 100) / 100,
          recommendation: recommendModel(row.id, avgMs),
        };
      }));
    } catch {}
  }

  // Cost summary
  let costPerDay = 0;
  let optimizedCostPerDay = 0;
  for (const p of pipelines) {
    if (p.status !== "active") continue;
    costPerDay += p.estimatedCostPerRun * p.runsPerDay;
    // Calculate optimized cost: if recommendation says HAIKU, use haiku pricing
    const optimizedModel = p.recommendation.includes("HAIKU")
      ? "claude-haiku-4-5-20251001"
      : (p.model || DEFAULT_MODEL);
    optimizedCostPerDay += estimateCostPerRun(p.avgDurationMs, optimizedModel) * p.runsPerDay;
  }
  const costSummary = {
    estimatedPerDay: Math.round(costPerDay * 100) / 100,
    optimizedPerDay: Math.round(optimizedCostPerDay * 100) / 100,
    potentialSavingsPercent: costPerDay > 0
      ? Math.round(((costPerDay - optimizedCostPerDay) / costPerDay) * 100)
      : 0,
  };

  // Available models for the UI selector
  const ollamaReachable = !!ollamaData;
  const availableModels = Object.entries(MODEL_COSTS).map(([id, info]) => ({
    id,
    label: info.label,
    inputPerM: info.inputPerM,
    outputPerM: info.outputPerM,
    active: id.startsWith("local:") ? ollamaReachable : true,
  }));

  // Recent runs
  const recentRuns = (Array.isArray(recentRunsRaw) ? recentRunsRaw : []).map(
    (r: {
      task_id: string;
      status: string;
      run_at: string;
      duration_ms: number;
      error: string | null;
    }) => ({
      taskId: r.task_id,
      name: pipelineName(r.task_id),
      status: r.status,
      runAt: r.run_at,
      durationMs: r.duration_ms,
      error: r.error,
    })
  );

  // Indexes — from PostgreSQL with table sizes
  let pgCounts: any = {};
  let pgSizes: any = {};
  let pgDates: any = {};
  try {
    const counts = await pgSql(`
      SELECT
        (SELECT COUNT(*) FROM people) as people,
        (SELECT COUNT(*) FROM topics) as topics,
        (SELECT COUNT(*) FROM vector_chunks) as vectors,
        (SELECT COUNT(*) FROM ai_summaries) as summaries,
        (SELECT COUNT(*) FROM corrections) as corrections,
        (SELECT COUNT(*) FROM relevance_scores) as scores,
        (SELECT COUNT(*) FROM initiatives) as initiatives,
        (SELECT COUNT(*) FROM tasks) as tasks,
        (SELECT COUNT(*) FROM archive_items) as archive
    `);
    pgCounts = counts[0] || {};

    const sizes = await pgSql(`
      SELECT
        pg_total_relation_size('people') / 1024 as people_kb,
        pg_total_relation_size('topics') / 1024 as topics_kb,
        pg_total_relation_size('vector_chunks') / 1024 as vectors_kb,
        pg_total_relation_size('ai_summaries') / 1024 as summaries_kb,
        pg_total_relation_size('corrections') / 1024 as corrections_kb,
        pg_total_relation_size('relevance_scores') / 1024 as scores_kb,
        pg_total_relation_size('initiatives') / 1024 as initiatives_kb
    `);
    pgSizes = sizes[0] || {};

    const dates = await pgSql(`
      SELECT
        (SELECT MAX(updated_at) FROM people) as people_last,
        (SELECT MAX(created_at) FROM topics) as topics_last,
        (SELECT MAX(embedded_at) FROM vector_chunks) as vectors_last,
        (SELECT MAX(created_at) FROM ai_summaries) as summaries_last,
        (SELECT MAX(created_at) FROM initiatives) as initiatives_last
    `);
    pgDates = dates[0] || {};
  } catch {}

  const indexes = {
    personIndex: {
      count: parseInt(pgCounts.people || "0"),
      lastBuilt: pgDates.people_last || null,
      sizeKb: parseInt(pgSizes.people_kb || "0"),
    },
    topicIndex: {
      count: parseInt(pgCounts.topics || "0"),
      lastBuilt: pgDates.topics_last || null,
      sizeKb: parseInt(pgSizes.topics_kb || "0"),
    },
    vectorIndex: {
      chunks: parseInt(pgCounts.vectors || "0"),
      lastBuilt: pgDates.vectors_last || null,
      sizeKb: parseInt(pgSizes.vectors_kb || "0"),
    },
    webexSummaries: {
      count: parseInt(pgCounts.summaries || "0"),
      lastBuilt: pgDates.summaries_last || null,
      sizeKb: parseInt(pgSizes.summaries_kb || "0"),
    },
    corrections: {
      entries: parseInt(pgCounts.corrections || "0"),
      lastBuilt: null,
      sizeKb: parseInt(pgSizes.corrections_kb || "0"),
    },
    relevanceScores: {
      entries: parseInt(pgCounts.scores || "0"),
      lastBuilt: null,
      sizeKb: parseInt(pgSizes.scores_kb || "0"),
    },
    initiatives: {
      count: parseInt(pgCounts.initiatives || "0"),
      lastBuilt: pgDates.initiatives_last || null,
      sizeKb: parseInt(pgSizes.initiatives_kb || "0"),
    },
  };

  // Containers
  const containers = {
    active: health?.containers?.active ?? stats?.containers?.active ?? 0,
    waiting: health?.containers?.waiting ?? stats?.containers?.waiting ?? 0,
    imageSize: "350MB",
  };

  if (db) db.close();

  // PostgreSQL status
  let postgres: any = { status: "unknown" };
  try {
    const pgHealth = await pgSql("SELECT 1 as ok");
    const pgSize = await pgSqlOne("SELECT pg_size_pretty(pg_database_size('nanoclaw')) as size");
    const pgConns = await pgSqlOne("SELECT count(*) as c FROM pg_stat_activity WHERE datname = 'nanoclaw'");
    const pgSync = await pgSqlOne(`
      SELECT
        (SELECT COUNT(*) FROM tasks WHERE notion_sync_status = 'synced') as synced,
        (SELECT COUNT(*) FROM tasks WHERE notion_sync_status = 'pending') as pending,
        (SELECT COUNT(*) FROM tasks WHERE notion_sync_status = 'error') as errors,
        (SELECT COUNT(*) FROM tasks WHERE triage_status = 'inbox') as triage_inbox,
        (SELECT MAX(synced_at) FROM notion_sync_log) as last_sync,
        (SELECT COUNT(*) FROM notion_sync_log WHERE synced_at > now() - interval '1 hour') as sync_last_hour
    `);
    postgres = {
      status: pgHealth.length > 0 ? "connected" : "error",
      size: pgSize?.size || "?",
      connections: parseInt(pgConns?.c || "0"),
      dataBackend: process.env.DATA_BACKEND || "sqlite",
      notionSync: {
        synced: parseInt(pgSync?.synced || "0"),
        pending: parseInt(pgSync?.pending || "0"),
        errors: parseInt(pgSync?.errors || "0"),
        lastSync: pgSync?.last_sync || null,
        syncLastHour: parseInt(pgSync?.sync_last_hour || "0"),
      },
      triageInbox: parseInt(pgSync?.triage_inbox || "0"),
    };
  } catch (err: any) {
    postgres = { status: "error", error: err.message };
  }

  return NextResponse.json({
    platform,
    services,
    ollama,
    llm,
    pipelines,
    recentRuns,
    indexes,
    containers,
    costSummary,
    availableModels,
    postgres,
  });
}

// --- POST handler: trigger a pipeline ---

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const action = searchParams.get("action");
  const id = searchParams.get("id");

  if (action === "trigger" && id) {
    const db = openDb();
    if (!db) {
      return NextResponse.json(
        { error: "Database not available" },
        { status: 503 }
      );
    }
    try {
      // Update both SQLite and PG so scheduler picks it up
      const now = new Date().toISOString();
      try {
        const writableDb = new Database(path.join(STORE_DIR, "messages.db"));
        writableDb.prepare("UPDATE scheduled_tasks SET next_run = ? WHERE id = ?").run(now, id);
        writableDb.close();
      } catch {}
      // Also update PG
      try {
        await pgSql("UPDATE scheduled_tasks SET next_run = $1 WHERE id = $2", [now, id]);
      } catch {}
      db.close();
      return NextResponse.json({ ok: true, message: `Triggered ${id}` });
    } catch (err) {
      db.close();
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// --- PATCH handler: update pipeline model ---

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { action?: string; id?: string; model?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.action === "setModel" && body.id) {
    // Validate model value
    const validModels = Object.keys(MODEL_COSTS);
    if (body.model !== null && body.model !== undefined && !validModels.includes(body.model)) {
      return NextResponse.json(
        { error: `Invalid model. Valid options: ${validModels.join(", ")}` },
        { status: 400 }
      );
    }

    const writableDb = openWritableDb();
    if (!writableDb) {
      return NextResponse.json(
        { error: "Database not available" },
        { status: 503 }
      );
    }

    try {
      ensureModelColumn(writableDb);
      const modelValue = body.model || null;
      const isLocal = typeof modelValue === "string" && modelValue.startsWith("local:");

      // Mapping of pipelines that have local script replacements
      const localScripts: Record<string, string> = {
        "mc-webex-transcripts": "com.nanoclaw.transcripts-local",
        "mc-webex-messages": "com.nanoclaw.messages-local",
        "mc-plaud-processor": "com.nanoclaw.plaud-local",
        "mc-boox-processor": "com.nanoclaw.boox-local",
        "mc-gmail-scanner": "com.nanoclaw.gmail-local",
      };

      const hasLocalScript = body.id in localScripts;

      if (isLocal && hasLocalScript) {
        // Pause the scheduled agent, activate local launchd job
        writableDb
          .prepare("UPDATE scheduled_tasks SET model = ?, status = 'paused' WHERE id = ?")
          .run(modelValue, body.id);
        // Activate launchd job
        const { execSync } = await import("child_process");
        try {
          execSync(`launchctl load ~/Library/LaunchAgents/${localScripts[body.id]}.plist 2>/dev/null || true`);
        } catch { /* may already be loaded */ }
      } else if (!isLocal) {
        // Resume the scheduled agent, deactivate local launchd job if exists
        writableDb
          .prepare("UPDATE scheduled_tasks SET model = ?, status = 'active' WHERE id = ?")
          .run(modelValue, body.id);
        if (hasLocalScript) {
          const { execSync } = await import("child_process");
          try {
            execSync(`launchctl unload ~/Library/LaunchAgents/${localScripts[body.id]}.plist 2>/dev/null || true`);
          } catch { /* may not be loaded */ }
        }
      } else {
        // Local selected but no script available — just update the model
        const result = writableDb
          .prepare("UPDATE scheduled_tasks SET model = ? WHERE id = ?")
          .run(modelValue, body.id);
        if (result.changes === 0) {
          writableDb.close();
          return NextResponse.json(
            { error: `Pipeline not found: ${body.id}` },
            { status: 404 }
          );
        }
      }

      writableDb.close();

      // Sync model change to PG
      try {
        await pgSql("UPDATE scheduled_tasks SET model = $1 WHERE id = $2", [body.model || null, body.id]);
      } catch {}

      const action = isLocal && hasLocalScript ? "Switched to local script" :
                     !isLocal && hasLocalScript ? "Resumed on API, stopped local script" :
                     `Updated model to ${modelValue || DEFAULT_MODEL}`;

      return NextResponse.json({
        ok: true,
        message: `${body.id}: ${action}`,
      });
    } catch (err) {
      writableDb.close();
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// --- Utility ---

function safeFileMtime(filePath: string): string | null {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}
