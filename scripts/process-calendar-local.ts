/**
 * Process Google Calendar locally using Ollama (qwen3:8b).
 *
 * Fetches events for the next 7 days from personal and family calendars,
 * saves them for briefing/meeting prep agents, identifies conflicts and
 * prep items, and creates Notion tasks for actionable items.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/process-calendar-local.ts
 */
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";

const STORE_DIR = path.join(process.cwd(), "store");
const TOKEN_PATH = path.join(STORE_DIR, "google-oauth.json");
const EVENTS_PATH = path.join(STORE_DIR, "google-calendar-events.json");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const OLLAMA_URL = "http://studio.shearer.live:11434";
const OLLAMA_MODEL = "qwen3:8b";
const OLLAMA_TIMEOUT_MS = 120_000;

// OneCLI proxy for Notion
const AGENT_TOKEN =
  "aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a";
const proxyAgent = new HttpsProxyAgent(
  `http://x:${AGENT_TOKEN}@localhost:10255`
);

// Calendars to fetch
const CALENDARS = [
  {
    id: "jshearer78@gmail.com",
    label: "personal",
  },
  {
    id: "2hunkshkrvep35741fln8cju8o@group.calendar.google.com",
    label: "family",
  },
];

// --- Types ---

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  description: string;
  calendar: string;
  attendees: string[];
}

interface CalendarEventsStore {
  fetchedAt: string;
  events: CalendarEvent[];
}

interface PrepItem {
  task: string;
  priority: string;
  context: string;
  reason: string;
}

interface RunMetrics {
  eventsFetched: number;
  conflictsFound: number;
  prepItemsFound: number;
  tasksCreated: number;
  correctionsApplied: number;
  ollamaLatencyMs: number;
  ollamaTokensIn: number;
  ollamaTokensOut: number;
  parseErrors: number;
  notionErrors: number;
}

// --- Google token management ---

async function ensureGoogleToken(): Promise<string> {
  const tokenData = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  if (new Date(tokenData.token_expiry) > new Date()) {
    return tokenData.access_token;
  }

  console.log("Google token expired, refreshing...");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: tokenData.client_id,
      client_secret: tokenData.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const tokens = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (tokens.error) {
    throw new Error(
      `Token refresh failed: ${tokens.error} - ${tokens.error_description || ""}`
    );
  }

  tokenData.access_token = tokens.access_token;
  tokenData.token_expiry = new Date(
    Date.now() + (tokens.expires_in || 3600) * 1000
  ).toISOString();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokenData, null, 2));
  console.log(`Token refreshed. Expires: ${tokenData.token_expiry}`);
  return tokenData.access_token;
}

// --- Google Calendar API helpers ---

async function calendarGet(
  urlPath: string,
  token: string
): Promise<unknown> {
  const resp = await fetch(
    `https://www.googleapis.com/calendar/v3${urlPath}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!resp.ok) {
    throw new Error(`Calendar API ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

// --- Notion helpers ---

async function notionPost(
  endpoint: string,
  body: unknown
): Promise<unknown> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(`https://api.notion.com/v1${endpoint}`, {
    method: "POST",
    agent: proxyAgent,
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

// --- Utility helpers ---

function loadCorrections(): Record<string, string> {
  if (fs.existsSync(CORRECTIONS_PATH)) {
    return JSON.parse(fs.readFileSync(CORRECTIONS_PATH, "utf-8"));
  }
  return {};
}

function applyCorrections(
  text: string,
  corrections: Record<string, string>
): { text: string; applied: number } {
  let result = text;
  let applied = 0;
  for (const [wrong, right] of Object.entries(corrections)) {
    const pattern = new RegExp(
      `\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi"
    );
    const before = result;
    result = result.replace(pattern, right);
    if (result !== before) applied++;
  }
  return { text: result, applied };
}

function mapPriority(raw: string): string {
  const normalized = raw.toUpperCase().trim();
  if (normalized === "P0") return "P0 \u2014 Today";
  if (normalized === "P1") return "P1 \u2014 This Week";
  if (normalized === "P2") return "P2 \u2014 This Month";
  if (normalized === "P3") return "P3 \u2014 This Quarter";
  return "P2 \u2014 This Month";
}

function mapContext(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower === "quick win") return "Quick Win";
  if (lower === "deep work") return "Deep Work";
  if (lower === "research") return "Research";
  return "Quick Win";
}

function inferProject(eventSummary: string, description: string): string {
  const combined = `${eventSummary} ${description}`.toLowerCase();
  if (
    combined.includes("momentumeq") ||
    combined.includes("momentum eq") ||
    combined.includes("coaching") ||
    combined.includes("ipec")
  ) {
    return "MomentumEQ";
  }
  if (
    combined.includes("ordinary epics") ||
    combined.includes("ordinaryepics")
  ) {
    return "Ordinary Epics";
  }
  if (
    combined.includes("home") ||
    combined.includes("repair") ||
    combined.includes("contractor") ||
    combined.includes("plumber") ||
    combined.includes("electrician")
  ) {
    return "Home";
  }
  return "Personal";
}

// --- Ollama interaction ---

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function analyzeCalendar(
  eventsText: string
): Promise<{
  conflicts: string[];
  prepItems: PrepItem[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  parseErrors: number;
  rawResponse?: string;
}> {
  const systemPrompt = `You analyze a week of calendar events to identify scheduling issues and prep needs for Jason.
Output a single JSON object with two arrays:
{
  "conflicts": ["Description of conflict or double-booking"],
  "prep_items": [{"task": "actionable prep task", "priority": "P1", "context": "Quick Win", "reason": "why this needs prep"}]
}

Rules:
- conflicts: list any overlapping events, double-bookings, or back-to-back meetings with no buffer
- prep_items: items Jason needs to DO before an event (e.g., "Pack for Atlanta trip", "Buy birthday gift for Sarah", "Prepare slides for presentation", "Book restaurant for dinner")
- DO NOT create prep items for routine meetings that need no preparation
- DO NOT flag standard recurring events as conflicts
- Priority: P0 = today, P1 = this week, P2 = can wait
- Context: "Quick Win" for simple tasks, "Deep Work" for tasks needing focus time
- Base analysis ONLY on the events provided. Do not invent or assume information.
- If nothing notable, use empty arrays: {"conflicts": [], "prep_items": []}
- Output ONLY the JSON object, no other text`;

  const userPrompt = `Calendar events for the next 7 days:\n\n${eventsText}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  const startMs = Date.now();

  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        stream: false,
        options: { num_ctx: 8192, temperature: 0.2 },
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startMs;
    clearTimeout(timeout);

    if (!resp.ok) {
      throw new Error(`Ollama ${resp.status}: ${resp.statusText}`);
    }

    const data = (await resp.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    const rawContent = data.message?.content || "";
    const tokensIn = data.prompt_eval_count || 0;
    const tokensOut = data.eval_count || 0;

    // Strip <think> tags (some models include reasoning blocks)
    const cleaned = stripThinkTags(rawContent);

    // Extract JSON from response (may be wrapped in code fences)
    let jsonStr = cleaned;
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    let conflicts: string[] = [];
    let prepItems: PrepItem[] = [];
    let parseErrors = 0;

    try {
      const parsed = JSON.parse(jsonStr) as {
        conflicts?: string[];
        prep_items?: {
          task: string;
          priority?: string;
          context?: string;
          reason?: string;
        }[];
      };

      conflicts = parsed.conflicts || [];
      prepItems = (parsed.prep_items || []).map((p) => ({
        task: p.task,
        priority: p.priority || "P1",
        context: p.context || "Quick Win",
        reason: p.reason || "",
      }));
    } catch {
      parseErrors++;
    }

    return {
      conflicts,
      prepItems,
      latencyMs,
      tokensIn,
      tokensOut,
      parseErrors,
      rawResponse: rawContent,
    };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("abort")) {
      throw new Error(
        `Ollama timeout after ${OLLAMA_TIMEOUT_MS / 1000}s`
      );
    }
    throw err;
  }
}

// --- Notion task creation ---

async function createNotionTask(
  item: PrepItem,
  project: string
): Promise<string | null> {
  const priority = mapPriority(item.priority);
  const context = mapContext(item.context);
  const notes = `${item.reason}. Processed locally via ${OLLAMA_MODEL}`;

  const body = {
    parent: { database_id: NOTION_DB },
    properties: {
      Task: {
        title: [{ text: { content: item.task } }],
      },
      Priority: {
        select: { name: priority },
      },
      Status: {
        status: { name: "Not started" },
      },
      Context: {
        select: { name: context },
      },
      Zone: {
        select: { name: "Open" },
      },
      Source: {
        select: { name: "Calendar" },
      },
      Project: {
        select: { name: project },
      },
      Notes: {
        rich_text: [{ text: { content: notes } }],
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
    return result.id;
  }
  console.error(
    `  Failed to create Notion task: ${result.message || JSON.stringify(result)}`
  );
  return null;
}

// --- Cost estimation ---

function estimateCost(
  tokensIn: number,
  tokensOut: number
): {
  haiku: string;
  sonnet: string;
} {
  const haikuCost =
    (tokensIn / 1_000_000) * 0.25 + (tokensOut / 1_000_000) * 1.25;
  const sonnetCost =
    (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15;
  return {
    haiku: `~$${haikuCost.toFixed(2)}`,
    sonnet: `~$${sonnetCost.toFixed(2)}`,
  };
}

// --- Main ---

async function main() {
  console.log("Processing Google Calendar locally...\n");

  // Check Ollama connectivity first
  try {
    const healthResp = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthResp.ok) {
      console.warn(
        `WARNING: Ollama returned ${healthResp.status}. Exiting gracefully.`
      );
      return;
    }
  } catch (err) {
    console.warn(
      `WARNING: Ollama unreachable at ${OLLAMA_URL}. Exiting gracefully.`
    );
    console.warn(
      `  ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Ensure valid Google token
  let token: string;
  try {
    token = await ensureGoogleToken();
  } catch (err) {
    console.error(
      `Google auth error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  const corrections = loadCorrections();

  const metrics: RunMetrics = {
    eventsFetched: 0,
    conflictsFound: 0,
    prepItemsFound: 0,
    tasksCreated: 0,
    correctionsApplied: 0,
    ollamaLatencyMs: 0,
    ollamaTokensIn: 0,
    ollamaTokensOut: 0,
    parseErrors: 0,
    notionErrors: 0,
  };

  const now = new Date();
  const sevenDaysFromNow = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000
  );

  console.log(`Current time: ${now.toISOString()}`);
  console.log(`Fetching events through: ${sevenDaysFromNow.toISOString()}\n`);

  // ============================================================
  // PHASE 1: Fetch events from all calendars
  // ============================================================
  console.log("--- Phase 1: Fetch Calendar Events ---\n");

  const allEvents: CalendarEvent[] = [];

  for (const cal of CALENDARS) {
    console.log(`Fetching: ${cal.label} (${cal.id})`);

    try {
      const params = new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: sevenDaysFromNow.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "50",
      });

      const data = (await calendarGet(
        `/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
        token
      )) as {
        items?: {
          id: string;
          summary?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          location?: string;
          description?: string;
          attendees?: { email?: string; displayName?: string }[];
        }[];
      };

      const events = (data.items || []).map((e) => ({
        id: e.id,
        summary: e.summary || "(No title)",
        start: e.start?.dateTime || e.start?.date || "",
        end: e.end?.dateTime || e.end?.date || "",
        location: e.location || "",
        description: e.description || "",
        calendar: cal.label,
        attendees: (e.attendees || []).map(
          (a) => a.displayName || a.email || ""
        ),
      }));

      allEvents.push(...events);
      console.log(`  Found ${events.length} events`);
    } catch (err) {
      console.error(
        `  Error fetching ${cal.label}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  metrics.eventsFetched = allEvents.length;

  // Sort all events by start time
  allEvents.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  console.log(`\nTotal events: ${allEvents.length}\n`);

  // ============================================================
  // PHASE 2: Save events for other agents
  // ============================================================
  console.log("--- Phase 2: Save Events ---\n");

  const eventsStore: CalendarEventsStore = {
    fetchedAt: now.toISOString(),
    events: allEvents,
  };

  fs.writeFileSync(EVENTS_PATH, JSON.stringify(eventsStore, null, 2));
  console.log(`Saved ${allEvents.length} events to ${EVENTS_PATH}`);

  // Print event summary
  for (const e of allEvents) {
    const startDate = new Date(e.start);
    const dateStr = startDate.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const timeStr = e.start.includes("T")
      ? startDate.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })
      : "all-day";
    const calTag = e.calendar === "family" ? " [family]" : "";
    console.log(`  ${dateStr} ${timeStr}: ${e.summary}${calTag}`);
  }
  console.log();

  if (allEvents.length === 0) {
    console.log("No events found for the next 7 days.");
    printReport(metrics);
    return;
  }

  // ============================================================
  // PHASE 3: Analyze with Ollama
  // ============================================================
  console.log("--- Phase 3: Ollama Analysis ---\n");

  // Format events for LLM
  const eventsText = allEvents
    .map((e) => {
      const startDate = new Date(e.start);
      const endDate = new Date(e.end);
      const dateStr = startDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
      const isAllDay = !e.start.includes("T");
      const timeRange = isAllDay
        ? "All day"
        : `${startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} - ${endDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
      const loc = e.location ? `\n  Location: ${e.location}` : "";
      const desc = e.description
        ? `\n  Description: ${e.description.slice(0, 200)}`
        : "";
      const cal = `\n  Calendar: ${e.calendar}`;
      const attendees =
        e.attendees.length > 0
          ? `\n  Attendees: ${e.attendees.slice(0, 10).join(", ")}`
          : "";
      return `- ${dateStr}, ${timeRange}: ${e.summary}${cal}${loc}${desc}${attendees}`;
    })
    .join("\n\n");

  console.log(
    `Sending ${allEvents.length} events to ${OLLAMA_MODEL} (${eventsText.length} chars)...`
  );

  let ollamaResult: Awaited<ReturnType<typeof analyzeCalendar>>;
  try {
    ollamaResult = await analyzeCalendar(eventsText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Ollama error: ${msg}`);
    metrics.parseErrors++;
    printReport(metrics);
    return;
  }

  metrics.ollamaLatencyMs = ollamaResult.latencyMs;
  metrics.ollamaTokensIn = ollamaResult.tokensIn;
  metrics.ollamaTokensOut = ollamaResult.tokensOut;
  metrics.parseErrors += ollamaResult.parseErrors;
  metrics.conflictsFound = ollamaResult.conflicts.length;
  metrics.prepItemsFound = ollamaResult.prepItems.length;

  console.log(
    `Ollama: ${ollamaResult.conflicts.length} conflicts, ${ollamaResult.prepItems.length} prep items in ${(ollamaResult.latencyMs / 1000).toFixed(1)}s (${ollamaResult.tokensIn} in / ${ollamaResult.tokensOut} out)`
  );

  if (ollamaResult.parseErrors > 0) {
    console.warn("WARNING: Parse error in Ollama response. Raw:");
    console.warn(
      `  ${(ollamaResult.rawResponse || "").slice(0, 500)}`
    );
  }

  // Print conflicts
  if (ollamaResult.conflicts.length > 0) {
    console.log("\nScheduling conflicts:");
    for (const c of ollamaResult.conflicts) {
      console.log(`  - ${c}`);
    }
  }

  // Print prep items
  if (ollamaResult.prepItems.length > 0) {
    console.log("\nPrep items:");
    for (const p of ollamaResult.prepItems) {
      console.log(`  - [${p.priority}] ${p.task}`);
    }
  }

  // ============================================================
  // PHASE 4: Create Notion tasks for prep items
  // ============================================================
  if (ollamaResult.prepItems.length > 0) {
    console.log("\n--- Phase 4: Create Notion Tasks ---\n");

    for (const item of ollamaResult.prepItems) {
      // Apply corrections
      const { text: correctedTask, applied: taskApplied } =
        applyCorrections(item.task, corrections);
      if (taskApplied > 0) {
        console.log(
          `  Corrected: "${item.task}" -> "${correctedTask}"`
        );
        metrics.correctionsApplied += taskApplied;
      }
      item.task = correctedTask;

      // Infer project from task content
      const project = inferProject(item.task, item.reason);

      try {
        const taskId = await createNotionTask(item, project);
        if (taskId) {
          metrics.tasksCreated++;
          console.log(
            `  Created task [${project}]: ${item.task.slice(0, 80)}${item.task.length > 80 ? "..." : ""}`
          );
        } else {
          metrics.notionErrors++;
        }
      } catch (err) {
        console.error(
          `  Notion error: ${err instanceof Error ? err.message : String(err)}`
        );
        metrics.notionErrors++;
      }

      // Rate limit protection
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // ============================================================
  // Print report
  // ============================================================
  printReport(metrics);
}

function printReport(metrics: RunMetrics) {
  const costs = estimateCost(
    metrics.ollamaTokensIn,
    metrics.ollamaTokensOut
  );

  console.log("\n=== Calendar Processing (Local) ===");
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Events fetched: ${metrics.eventsFetched}`);
  console.log(`Conflicts found: ${metrics.conflictsFound}`);
  console.log(`Prep items found: ${metrics.prepItemsFound}`);
  console.log(`Notion tasks created: ${metrics.tasksCreated}`);
  if (metrics.ollamaLatencyMs > 0) {
    console.log(
      `Ollama latency: ${(metrics.ollamaLatencyMs / 1000).toFixed(1)}s`
    );
  }
  console.log(`API cost: $0.00 (local inference)`);
  console.log(`Equivalent Haiku cost: ${costs.haiku}`);
  console.log(`Equivalent Sonnet cost: ${costs.sonnet}`);
  console.log(`Corrections applied: ${metrics.correctionsApplied}`);
  console.log(`Parse errors: ${metrics.parseErrors}`);
  console.log(`Notion errors: ${metrics.notionErrors}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
