/**
 * Task deduplication and correlation engine.
 *
 * Prevents duplicate Notion tasks across ingestion pipelines (Plaud, Webex
 * transcripts, Webex messages, Boox, Gmail) by scoring new tasks against
 * recent open tasks and merging when a match is found.
 *
 * Usage:
 *   import { findOrCreateTask, clearTaskCache } from './lib/task-dedup.js';
 *   clearTaskCache();
 *   const result = await findOrCreateTask(task, options);
 */

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
  notionPost: (endpoint: string, body: unknown) => Promise<unknown>;
  notionPatch?: (
    pageId: string,
    properties: Record<string, unknown>,
    appendNote?: string
  ) => Promise<void>;
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
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "for",
  "with",
  "in",
  "on",
  "of",
  "from",
  "about",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "can",
  "may",
  "might",
  "shall",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
]);

/** Priority ranks for upgrade comparison (lower number = higher priority). */
const PRIORITY_RANK: Record<string, number> = {
  "P0 \u2014 Today": 0,
  "P1 \u2014 This Week": 1,
  "P2 \u2014 This Month": 2,
  "P3 \u2014 This Quarter": 3,
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Strip common task action prefixes before tokenizing
    .replace(/^(reply to|follow up with|respond to|schedule|connect with|check with|email|call|message|send)\s+/i, "")
    // Strip person names that appear after "to/with" — these inflate similarity
    // We keep them if they're the ONLY content (e.g., just a name)
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function titleSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const overlap = [...setA].filter((w) => setB.has(w)).length;

  return overlap / Math.max(setA.size, setB.size);
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

/**
 * Extract a plain-text string from a Notion rich_text property array.
 */
function richTextToPlain(
  richText: { plain_text?: string }[] | undefined
): string {
  if (!richText || !Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text || "").join("");
}

/**
 * Extract the task title from a Notion title property.
 */
function titleToPlain(
  titleProp: { plain_text?: string }[] | undefined
): string {
  return richTextToPlain(titleProp);
}

/**
 * Extract the select name from a Notion select property.
 */
function selectName(
  selectProp: { name?: string } | undefined | null
): string {
  return selectProp?.name || "";
}

/**
 * Fetch recent open tasks from Notion and populate the cache.
 */
async function fetchRecentOpenTasks(
  notionDbId: string,
  notionPost: (endpoint: string, body: unknown) => Promise<unknown>
): Promise<CachedTask[]> {
  const body = {
    filter: {
      and: [
        {
          property: "Status",
          status: { does_not_equal: "Done" },
        },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 100,
  };

  const result = (await notionPost(
    `/databases/${notionDbId}/query`,
    body
  )) as {
    results?: {
      id: string;
      created_time: string;
      properties: {
        Task?: { title?: { plain_text?: string }[] };
        Priority?: { select?: { name?: string } | null };
        Project?: { select?: { name?: string } | null };
        Notes?: { rich_text?: { plain_text?: string }[] };
        Source?: { select?: { name?: string } | null };
      };
    }[];
  };

  const tasks: CachedTask[] = (result.results || []).map((page) => ({
    id: page.id,
    title: titleToPlain(page.properties.Task?.title),
    priority: selectName(page.properties.Priority?.select),
    project: selectName(page.properties.Project?.select),
    notes: richTextToPlain(page.properties.Notes?.rich_text),
    source: selectName(page.properties.Source?.select),
    createdTime: page.created_time,
  }));

  return tasks;
}

/**
 * Retrieve the cached task list, refreshing if stale.
 */
async function getRecentTasks(
  notionDbId: string,
  notionPost: (endpoint: string, body: unknown) => Promise<unknown>
): Promise<CachedTask[]> {
  const now = Date.now();
  if (cachedTasks && now - cacheTime < CACHE_TTL_MS) {
    return cachedTasks;
  }

  console.log("[dedup] Refreshing Notion task cache...");
  cachedTasks = await fetchRecentOpenTasks(notionDbId, notionPost);
  cacheTime = now;
  console.log(`[dedup] Cached ${cachedTasks.length} open tasks`);
  return cachedTasks;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface MatchCandidate {
  task: CachedTask;
  score: number;
  titleScore: number;
}

function scoreTask(newTask: TaskInput, existing: CachedTask): MatchCandidate {
  // Title similarity (core signal)
  const titleScore = titleSimilarity(newTask.title, existing.title);
  let score = titleScore;

  // Only apply bonuses if title meets the minimum threshold
  if (titleScore >= TITLE_SIMILARITY_THRESHOLD) {
    // Person match: check if same assignee or person name appears in notes
    if (newTask.assignee) {
      const assigneeLower = newTask.assignee.toLowerCase();
      if (existing.notes.toLowerCase().includes(assigneeLower)) {
        score += 0.2;
      }
    }

    // Project match
    if (
      newTask.project &&
      existing.project &&
      newTask.project.toLowerCase() === existing.project.toLowerCase()
    ) {
      score += 0.1;
    }

    // Time proximity: created within last 7 days
    const ageMs = Date.now() - new Date(existing.createdTime).getTime();
    if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      score += 0.1;
    }
  }

  return { task: existing, score, titleScore };
}

// ---------------------------------------------------------------------------
// Core: findOrCreateTask
// ---------------------------------------------------------------------------

export async function findOrCreateTask(
  task: TaskInput,
  options: FindOrCreateOptions
): Promise<FindOrCreateResult> {
  const { notionDbId, notionPost, notionPatch } = options;

  // 1. Get recent open tasks
  const recentTasks = await getRecentTasks(notionDbId, notionPost);

  // 2. Score every existing task against the incoming one
  let bestMatch: MatchCandidate | null = null;

  for (const existing of recentTasks) {
    const candidate = scoreTask(task, existing);

    // Only consider if title similarity itself meets the base threshold
    if (
      candidate.titleScore >= TITLE_SIMILARITY_THRESHOLD &&
      candidate.score >= MATCH_THRESHOLD
    ) {
      if (!bestMatch || candidate.score > bestMatch.score) {
        bestMatch = candidate;
      }
    }
  }

  // 3. Decide: skip / merge / create
  if (bestMatch) {
    const { task: existing, score, titleScore } = bestMatch;

    // 3a. Very high match AND same source => exact duplicate, skip
    if (score >= SKIP_THRESHOLD && existing.source === task.source) {
      console.log(
        `[dedup] SKIP (score=${score.toFixed(2)}, title=${titleScore.toFixed(2)}, same source="${task.source}")`
      );
      console.log(`[dedup]   New:      "${task.title}"`);
      console.log(`[dedup]   Existing: "${existing.title}"`);
      return { action: "skipped", taskId: existing.id };
    }

    // 3b. Match found => merge
    console.log(
      `[dedup] MERGE (score=${score.toFixed(2)}, title=${titleScore.toFixed(2)})`
    );
    console.log(`[dedup]   New:      "${task.title}" [${task.source}]`);
    console.log(
      `[dedup]   Existing: "${existing.title}" [${existing.source}]`
    );

    // Build corroboration note
    const dateStr = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const corroborationNote = `[Corroborated] Also found in ${task.source} on ${dateStr}: "${task.title}"`;

    // Determine if priority upgrade is needed
    const existingRank = PRIORITY_RANK[existing.priority] ?? 2;
    const newRank = PRIORITY_RANK[task.priority] ?? 2;
    const upgradePriority = newRank < existingRank;

    if (notionPatch) {
      // Use the provided notionPatch to update properties + append note
      const properties: Record<string, unknown> = {};
      if (upgradePriority) {
        properties.Priority = { select: { name: task.priority } };
        console.log(
          `[dedup]   Upgrading priority: ${existing.priority} -> ${task.priority}`
        );
      }
      await notionPatch(existing.id, properties, corroborationNote);
    } else {
      // Fallback: use notionPost to GET the page, then PATCH via a raw fetch
      // Since we only have notionPost, we do a read-modify-write via the
      // Notion pages endpoint. notionPost calls POST, but Notion's pages
      // endpoint doesn't support POST for updates. We'll append the note
      // to the cached notes and use notionPost to create a comment-style
      // append as a new block instead. Best-effort: log and continue.
      console.log(
        `[dedup]   WARNING: No notionPatch provided. Corroboration note logged but not written to Notion.`
      );
      console.log(`[dedup]   Note: ${corroborationNote}`);
    }

    // Update cache so subsequent tasks in this run see the merge
    existing.notes = existing.notes
      ? `${existing.notes}\n\n${corroborationNote}`
      : corroborationNote;
    if (upgradePriority) {
      existing.priority = task.priority;
    }

    return {
      action: "merged",
      taskId: existing.id,
      mergedWith: existing.title,
    };
  }

  // 4. No match => create new task
  console.log(`[dedup] CREATE "${task.title}" [${task.source}]`);

  const body = {
    parent: { database_id: notionDbId },
    properties: {
      Task: {
        title: [{ text: { content: task.title } }],
      },
      Priority: {
        select: { name: task.priority },
      },
      Status: {
        status: { name: "Not started" },
      },
      Context: {
        select: { name: task.context },
      },
      Zone: {
        select: { name: "Open" },
      },
      Source: {
        select: { name: task.source },
      },
      Project: {
        select: { name: task.project },
      },
      Notes: {
        rich_text: [{ text: { content: task.notes } }],
      },
    },
  };

  const result = (await notionPost("/pages", body)) as {
    id?: string;
    object?: string;
    status?: number;
    message?: string;
  };

  if (result.id) {
    // Add to cache so subsequent tasks in this run can match against it
    if (cachedTasks) {
      cachedTasks.unshift({
        id: result.id,
        title: task.title,
        priority: task.priority,
        project: task.project,
        notes: task.notes,
        source: task.source,
        createdTime: new Date().toISOString(),
      });
    }

    return { action: "created", taskId: result.id };
  }

  // Creation failed — throw so the caller can handle it
  const errMsg = result.message || JSON.stringify(result);
  throw new Error(`Notion task creation failed: ${errMsg}`);
}

export { type TaskInput, type FindOrCreateOptions, type FindOrCreateResult };
