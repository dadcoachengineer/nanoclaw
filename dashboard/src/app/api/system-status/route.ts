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
    model: "claude-sonnet-4-20250514",
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
  }

  let pipelines: {
    id: string;
    name: string;
    schedule: string;
    lastRun: string | null;
    lastStatus: string;
    nextRun: string | null;
    status: string;
  }[] = [];

  const db = openDb();
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT id, prompt, schedule_type, schedule_value, status, last_run, last_result, next_run FROM scheduled_tasks WHERE status = 'active' OR status = 'paused' ORDER BY next_run"
        )
        .all() as PipelineRow[];

      // Get last run status for each task from run logs
      const lastStatusStmt = db.prepare(
        "SELECT status FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 1"
      );

      pipelines = rows.map((row) => {
        const lastRunLog = lastStatusStmt.get(row.id) as
          | { status: string }
          | undefined;
        const schedule =
          row.schedule_type === "cron"
            ? cronToHuman(row.schedule_value)
            : row.schedule_type === "interval"
              ? `Every ${Math.round(parseInt(row.schedule_value, 10) / 60000)}m`
              : row.schedule_value;

        return {
          id: row.id,
          name: pipelineName(row.id),
          schedule,
          lastRun: row.last_run,
          lastStatus: lastRunLog?.status || "never",
          nextRun: row.next_run,
          status: row.status,
        };
      });
    } catch {}
  }

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

// --- Utility ---

function safeFileMtime(filePath: string): string | null {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}
