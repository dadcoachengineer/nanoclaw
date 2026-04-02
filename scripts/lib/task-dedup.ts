/**
 * Task deduplication and correlation engine — PostgreSQL native.
 *
 * Prevents duplicate tasks across ingestion pipelines by scoring new tasks
 * against recent open tasks in PG and merging when a match is found.
 * New tasks are created in PG with notion_sync_status='pending' for
 * the sync worker to push to Notion.
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";
let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
  return _pool;
}

async function query(text: string, params?: any[]): Promise<any[]> {
  return (await getPool().query(text, params)).rows;
}

async function queryOne(text: string, params?: any[]): Promise<any> {
  const rows = await query(text, params);
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskInput {
  title: string;
  priority: string;
  context: string;
  source: string;
  project: string;
  notes: string;
  assignee?: string;
}

interface FindOrCreateOptions {
  notionDbId: string;
  // Legacy — these are no longer used but kept for API compat with callers
  notionPost: (endpoint: string, body: unknown) => Promise<unknown>;
  notionPatch?: (pageId: string, properties: Record<string, unknown>, appendNote?: string) => Promise<void>;
}

interface FindOrCreateResult {
  action: "created" | "merged" | "skipped";
  taskId: string;
  mergedWith?: string;
}

interface CachedTask {
  id: string;
  title: string;
  priority: string;
  project: string;
  notes: string;
  source: string;
  createdTime: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a","an","the","and","or","to","for","with","in","on","of","from","about",
  "is","are","was","were","be","been","being","have","has","had","do","does",
  "did","will","would","should","could","can","may","might","shall","that",
  "this","these","those","it","its",
]);

const PRIORITY_RANK: Record<string, number> = {
  "P0 \u2014 Today": 0, "P1 \u2014 This Week": 1,
  "P2 \u2014 This Month": 2, "P3 \u2014 This Quarter": 3,
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const MATCH_THRESHOLD = 0.5;
const SKIP_THRESHOLD = 0.8;
const TITLE_SIMILARITY_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedTasks: CachedTask[] | null = null;
let cacheTime = 0;

export function clearTaskCache(): void {
  cachedTasks = null;
  cacheTime = 0;
}

/**
 * Log a pipeline run to task_run_logs so the dashboard shows current status.
 * Maps local script IDs to their scheduled_task counterparts.
 */
export async function logPipelineRun(opts: {
  taskId: string;
  durationMs: number;
  status: "success" | "error";
  result?: string;
  error?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
       VALUES ($1, now(), $2, $3, $4, $5)`,
      [opts.taskId, opts.durationMs, opts.status, opts.result || null, opts.error || null]
    );
    // Also update last_run on the scheduled task
    await query(
      `UPDATE scheduled_tasks SET last_run = now(), last_result = $1 WHERE id = $2`,
      [opts.status === "success" ? opts.result?.slice(0, 500) || "success" : opts.error?.slice(0, 500) || "error", opts.taskId]
    );
  } catch { /* best-effort */ }
}

/**
 * Upsert an archive item into PG for provenance linking.
 * Best-effort — errors are swallowed so pipelines aren't blocked.
 */
export async function archiveToPg(item: {
  id: string;
  sourceType: string;
  title: string;
  date: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO archive_items (id, source_type, title, date, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id, source_type) DO UPDATE SET
         title = EXCLUDED.title, content = EXCLUDED.content,
         metadata = EXCLUDED.metadata, archived_at = now()`,
      [item.id, item.sourceType, item.title, item.date, item.content, JSON.stringify(item.metadata || {})]
    );
  } catch { /* best-effort — don't break pipeline */ }
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/^(reply to|follow up with|respond to|schedule|connect with|check with|email|call|message|send)\s+/i, "")
    .replace(/[^a-z0-9\s]/g, "").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function titleSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  return [...setA].filter((w) => setB.has(w)).length / Math.max(setA.size, setB.size);
}

// ---------------------------------------------------------------------------
// PG task cache
// ---------------------------------------------------------------------------

async function getRecentTasks(): Promise<CachedTask[]> {
  const now = Date.now();
  if (cachedTasks && now - cacheTime < CACHE_TTL_MS) return cachedTasks;

  console.log("[dedup] Refreshing PG task cache...");
  const rows = await query(
    `SELECT id, title, priority, project, notes, source, created_at
     FROM tasks WHERE status != 'Done'
     ORDER BY created_at DESC LIMIT 200`
  );
  cachedTasks = rows.map((r: any) => ({
    id: r.id, title: r.title || "", priority: r.priority || "",
    project: r.project || "", notes: r.notes || "", source: r.source || "",
    createdTime: r.created_at?.toISOString?.() || r.created_at || "",
  }));
  cacheTime = now;
  console.log(`[dedup] Cached ${cachedTasks.length} open tasks from PG`);
  return cachedTasks;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreTask(newTask: TaskInput, existing: CachedTask) {
  const titleScore = titleSimilarity(newTask.title, existing.title);
  let score = titleScore;
  if (titleScore >= TITLE_SIMILARITY_THRESHOLD) {
    if (newTask.assignee) {
      if (existing.notes.toLowerCase().includes(newTask.assignee.toLowerCase())) score += 0.2;
    }
    if (newTask.project && existing.project && newTask.project.toLowerCase() === existing.project.toLowerCase()) score += 0.1;
    const ageMs = Date.now() - new Date(existing.createdTime).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) score += 0.1;
  }
  return { task: existing, score, titleScore };
}

// ---------------------------------------------------------------------------
// Core: findOrCreateTask — PG native
// ---------------------------------------------------------------------------

export async function findOrCreateTask(
  task: TaskInput,
  options: FindOrCreateOptions
): Promise<FindOrCreateResult> {
  // 1. Get recent open tasks from PG
  const recentTasks = await getRecentTasks();

  // 2. Score every existing task
  let bestMatch: { task: CachedTask; score: number; titleScore: number } | null = null;
  for (const existing of recentTasks) {
    const candidate = scoreTask(task, existing);
    if (candidate.titleScore >= TITLE_SIMILARITY_THRESHOLD && candidate.score >= MATCH_THRESHOLD) {
      if (!bestMatch || candidate.score > bestMatch.score) bestMatch = candidate;
    }
  }

  // 3. Decide: skip / merge / create
  if (bestMatch) {
    const { task: existing, score, titleScore } = bestMatch;

    // 3a. Very high match + same source → exact duplicate, skip
    if (score >= SKIP_THRESHOLD && existing.source === task.source) {
      console.log(`[dedup] SKIP (score=${score.toFixed(2)}, title=${titleScore.toFixed(2)}, same source="${task.source}")`);
      console.log(`[dedup]   New:      "${task.title}"`);
      console.log(`[dedup]   Existing: "${existing.title}"`);
      return { action: "skipped", taskId: existing.id };
    }

    // 3b. Match found → merge into existing
    console.log(`[dedup] MERGE (score=${score.toFixed(2)}, title=${titleScore.toFixed(2)})`);
    console.log(`[dedup]   New:      "${task.title}" [${task.source}]`);
    console.log(`[dedup]   Existing: "${existing.title}" [${existing.source}]`);

    const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const corroborationNote = `[Corroborated] Also found in ${task.source} on ${dateStr}: "${task.title}"`;

    // Upgrade priority if new task is higher
    const existingRank = PRIORITY_RANK[existing.priority] ?? 2;
    const newRank = PRIORITY_RANK[task.priority] ?? 2;

    const updates: string[] = [
      "notes = COALESCE(notes, '') || E'\\n' || $1",
      "notion_sync_status = 'pending'",
      "updated_at = now()",
    ];
    const values: any[] = [corroborationNote];
    let idx = 2;

    if (newRank < existingRank) {
      updates.push(`priority = $${idx}`);
      values.push(task.priority);
      idx++;
      console.log(`[dedup]   Upgrading priority: ${existing.priority} -> ${task.priority}`);
    }

    values.push(existing.id);
    await query(`UPDATE tasks SET ${updates.join(", ")} WHERE id = $${idx}::uuid`, values);

    // Log corroboration
    await query(
      `INSERT INTO task_corroborations (task_id, source, original_title) VALUES ($1::uuid, $2, $3)`,
      [existing.id, task.source, task.title]
    );

    // Update cache
    if (cachedTasks) {
      const cached = cachedTasks.find((t) => t.id === existing.id);
      if (cached) cached.notes += "\n" + corroborationNote;
    }

    return { action: "merged", taskId: existing.id, mergedWith: task.title };
  }

  // 4. No match — create new task in PG
  console.log(`[dedup] CREATE "${task.title}" [${task.source}]`);

  const result = await queryOne(
    `INSERT INTO tasks (id, title, priority, status, source, project, context, delegated_to, notes,
       notion_sync_status, triage_status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'Not started', $3, $4, $5, $6, $7,
       'pending', 'inbox', now(), now())
     RETURNING id`,
    [task.title, task.priority, task.source, task.project, task.context, task.assignee || null, task.notes]
  );

  const newId = result.id;

  // Update cache
  if (cachedTasks) {
    cachedTasks.unshift({
      id: newId, title: task.title, priority: task.priority,
      project: task.project, notes: task.notes, source: task.source,
      createdTime: new Date().toISOString(),
    });
  }

  return { action: "created", taskId: newId };
}
