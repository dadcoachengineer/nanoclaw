import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const STORE_DIR =
  process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const SYSTEM_API = process.env.NANOCLAW_API || "http://127.0.0.1:3939";
const OLLAMA_URL =
  process.env.OLLAMA_BASE_URL || "http://studio.shearer.live:11434";
const SHIM_PORT = parseInt(process.env.SHIM_PORT || "8089", 10);

const DEFAULT_MODEL = "claude-sonnet-4-20250514";

// --- Model cost table ---
// Pricing per million tokens
const MODEL_COSTS: Record<string, { inputPerM: number; outputPerM: number; label: string }> = {
  "claude-sonnet-4-20250514": { inputPerM: 3, outputPerM: 15, label: "Sonnet" },
  "claude-haiku-4-5-20251001": { inputPerM: 0.25, outputPerM: 1.25, label: "Haiku" },
  "local:deepseek-r1:70b": { inputPerM: 0, outputPerM: 0, label: "Local (DeepSeek)" },
  "local:gemma3:27b": { inputPerM: 0, outputPerM: 0, label: "Local (Gemma)" },
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
  if (!model) return "Sonnet";
  return MODEL_COSTS[model]?.label || model.split("-")[0] || "Unknown";
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
  // Fetch all data sources in parallel
  const [healthResult, statsResult, runsResult, ollamaResult, shimResult] =
    await Promise.allSettled([
      fetchWithTimeout(`${SYSTEM_API}/api/health`, 3000).then((r) => r.json()),
      fetchWithTimeout(`${SYSTEM_API}/api/stats`, 3000).then((r) => r.json()),
      fetchWithTimeout(`${SYSTEM_API}/api/runs/recent?limit=20`, 3000).then(
        (r) => r.json()
      ),
      fetchWithTimeout(`${OLLAMA_URL}/api/tags`, 3000).then((r) => r.json()),
      fetchWithTimeout(`http://127.0.0.1:${SHIM_PORT}/health`, 1000).then(
        (r) => r.json()
      ),
    ]);

  const health =
    healthResult.status === "fulfilled" ? healthResult.value : null;
  const stats = statsResult.status === "fulfilled" ? statsResult.value : null;
  const recentRunsRaw =
    runsResult.status === "fulfilled" ? runsResult.value : [];
  const ollamaData =
    ollamaResult.status === "fulfilled" ? ollamaResult.value : null;
  const shimReachable = shimResult.status === "fulfilled";

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
      uptime: health?.uptime ?? null,
    },
    {
      name: "Dashboard",
      status: "running",
      port: 3940,
      uptime: null,
    },
    {
      name: "Nginx",
      status: "running", // If the dashboard is reachable, Nginx is serving
      port: 443,
      uptime: null,
    },
    {
      name: "OneCLI Proxy",
      status: "running", // Presence implied by dashboard working
      port: 10255,
      uptime: null,
    },
    {
      name: "Ollama",
      status: ollamaData ? "running" : "stopped",
      port: 11434,
      uptime: null,
    },
    {
      name: "Ollama Shim",
      status: shimReachable ? "running" : "stopped",
      port: SHIM_PORT,
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
      const rows = db
        .prepare(
          "SELECT id, prompt, schedule_type, schedule_value, status, last_run, last_result, next_run, model FROM scheduled_tasks WHERE status = 'active' OR status = 'paused' ORDER BY next_run"
        )
        .all() as PipelineRow[];

      // Get last run status for each task from run logs
      const lastStatusStmt = db.prepare(
        "SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 1"
      );

      // Get average duration from last 10 runs
      const avgDurationStmt = db.prepare(
        "SELECT AVG(duration_ms) as avg_ms FROM (SELECT duration_ms FROM task_run_logs WHERE task_id = ? AND status = 'success' ORDER BY run_at DESC LIMIT 10)"
      );

      // Get total runs count for cost estimation
      const totalRunsStmt = db.prepare(
        "SELECT COUNT(*) as cnt FROM task_run_logs WHERE task_id = ? AND status = 'success'"
      );

      pipelines = rows.map((row) => {
        const lastRunLog = lastStatusStmt.get(row.id) as
          | { status: string }
          | undefined;
        const avgRow = avgDurationStmt.get(row.id) as
          | { avg_ms: number | null }
          | undefined;
        const totalRow = totalRunsStmt.get(row.id) as
          | { cnt: number }
          | undefined;

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
      });
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

  // Indexes
  const personData = safeJsonParse(path.join(STORE_DIR, "person-index.json"));
  const topicData = safeJsonParse(path.join(STORE_DIR, "topic-index.json"));
  const correctionsData = safeJsonParse(
    path.join(STORE_DIR, "corrections.json")
  );
  const relevanceData = safeJsonParse(
    path.join(STORE_DIR, "relevance-scores.json")
  );
  const summariesData = safeJsonParse(
    path.join(STORE_DIR, "webex-summaries.json")
  );
  const initiativesData = safeJsonParse(
    path.join(STORE_DIR, "initiatives.json")
  );

  // Vector index: use SQLite page count for chunk estimate
  let vectorChunks = 0;
  try {
    const vecDb = new Database(path.join(STORE_DIR, "vectors.db"), {
      readonly: true,
    });
    const row = vecDb.prepare("SELECT COUNT(*) as cnt FROM vec_chunks").get() as
      | { cnt: number }
      | undefined;
    vectorChunks = row?.cnt ?? 0;
    vecDb.close();
  } catch {
    // Table might not exist or DB might be empty
  }

  const indexes = {
    personIndex: {
      count: jsonEntryCount(personData),
      lastBuilt: safeFileMtime(path.join(STORE_DIR, "person-index.json")),
      sizeKb: fileSizeKb(path.join(STORE_DIR, "person-index.json")),
    },
    topicIndex: {
      count: jsonEntryCount(topicData),
      lastBuilt: safeFileMtime(path.join(STORE_DIR, "topic-index.json")),
      sizeKb: fileSizeKb(path.join(STORE_DIR, "topic-index.json")),
    },
    vectorIndex: {
      chunks: vectorChunks,
      lastBuilt: safeFileMtime(path.join(STORE_DIR, "vectors.db")),
      sizeKb: fileSizeKb(path.join(STORE_DIR, "vectors.db")),
    },
    webexSummaries: {
      count: jsonEntryCount(summariesData),
      lastBuilt: safeFileMtime(path.join(STORE_DIR, "webex-summaries.json")),
      sizeKb: fileSizeKb(path.join(STORE_DIR, "webex-summaries.json")),
    },
    corrections: {
      entries: jsonEntryCount(correctionsData),
      lastBuilt: safeFileMtime(path.join(STORE_DIR, "corrections.json")),
      sizeKb: fileSizeKb(path.join(STORE_DIR, "corrections.json")),
    },
    relevanceScores: {
      entries: jsonEntryCount(relevanceData),
      lastBuilt: safeFileMtime(path.join(STORE_DIR, "relevance-scores.json")),
      sizeKb: fileSizeKb(path.join(STORE_DIR, "relevance-scores.json")),
    },
    initiatives: {
      count: jsonEntryCount(initiativesData),
      lastBuilt: safeFileMtime(path.join(STORE_DIR, "initiatives.json")),
      sizeKb: fileSizeKb(path.join(STORE_DIR, "initiatives.json")),
    },
  };

  // Containers
  const containers = {
    active: health?.containers?.active ?? stats?.containers?.active ?? 0,
    waiting: health?.containers?.waiting ?? stats?.containers?.waiting ?? 0,
    imageSize: "350MB",
  };

  if (db) db.close();

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
  });
}

// --- POST handler: trigger a pipeline ---

export async function POST(req: NextRequest) {
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
      // Open writable for updates
      const writableDb = new Database(path.join(STORE_DIR, "messages.db"));
      const now = new Date().toISOString();
      writableDb
        .prepare("UPDATE scheduled_tasks SET next_run = ? WHERE id = ?")
        .run(now, id);
      writableDb.close();
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
