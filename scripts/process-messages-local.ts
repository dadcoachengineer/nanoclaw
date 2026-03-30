/**
 * Process Webex messages locally using Ollama (deepseek-r1:70b).
 *
 * Scans DM rooms for actionable messages and group rooms for @mentions,
 * sends them to a local Ollama instance for analysis, applies corrections,
 * and creates Notion tasks.
 *
 * Replaces the mc-webex-messages scheduled agent for cost savings.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/process-messages-local.ts
 */
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { findOrCreateTask, clearTaskCache } from './lib/task-dedup.js';

const STORE_DIR = path.join(process.cwd(), "store");
const STATE_PATH = path.join(STORE_DIR, "messages-local-state.json");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const MAX_PROCESSED_ROOMS = 500;
const OLLAMA_URL = "http://studio.shearer.live:11434";
const OLLAMA_MODEL = "deepseek-r1:70b";
const OLLAMA_TIMEOUT_MS = 180_000;
const MY_EMAIL = "jasheare@cisco.com";

// OneCLI proxy for Notion
const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) {
  throw new Error("ONECLI_AGENT_TOKEN environment variable is required");
}
const proxyAgent = new HttpsProxyAgent(
  `http://x:${AGENT_TOKEN}@localhost:10255`
);

// Webex token (direct, not proxied)
const webexConfig = JSON.parse(
  fs.readFileSync(path.join(STORE_DIR, "webex-oauth.json"), "utf-8")
);
const WEBEX_TOKEN = webexConfig.access_token;

// --- State types ---

interface MessagesLocalState {
  lastCheck: string;
  processedRoomTimestamps: Record<string, string>;
  metrics: {
    totalRuns: number;
    totalRooms: number;
    totalTasks: number;
    avgLatencyMs: number;
    errors: number;
  };
}

interface MessageAction {
  task: string;
  priority: string;
  context: string;
  person: string;
  email: string;
  reason: string;
}

interface RunMetrics {
  roomsProcessed: number;
  tasksExtracted: number;
  tasksCreated: number;
  tasksMerged: number;
  tasksSkipped: number;
  correctionsApplied: number;
  ollamaLatencies: number[];
  ollamaTokensIn: number;
  ollamaTokensOut: number;
  parseErrors: number;
  notionErrors: number;
}

// --- Fetch helpers ---

async function webexGet(urlPath: string): Promise<unknown> {
  const resp = await fetch(`https://webexapis.com/v1${urlPath}`, {
    headers: { Authorization: `Bearer ${WEBEX_TOKEN}` },
  });
  if (!resp.ok) {
    throw new Error(`Webex API ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

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

async function notionPatchPages(pageId: string, body: Record<string, unknown>): Promise<void> {
  const nodeFetch = (await import("node-fetch")).default;
  await nodeFetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    agent: proxyAgent,
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  } as any);
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

// --- State management ---

function loadState(): MessagesLocalState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return {
    lastCheck: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    processedRoomTimestamps: {},
    metrics: {
      totalRuns: 0,
      totalRooms: 0,
      totalTasks: 0,
      avgLatencyMs: 0,
      errors: 0,
    },
  };
}

function saveState(state: MessagesLocalState): void {
  // Cap room entries at MAX_PROCESSED_ROOMS by evicting oldest
  const entries = Object.entries(state.processedRoomTimestamps);
  if (entries.length > MAX_PROCESSED_ROOMS) {
    entries.sort(
      (a, b) => new Date(a[1]).getTime() - new Date(b[1]).getTime()
    );
    state.processedRoomTimestamps = Object.fromEntries(
      entries.slice(entries.length - MAX_PROCESSED_ROOMS)
    );
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Ollama interaction ---

function stripThinkTags(text: string): string {
  // DeepSeek-R1 outputs <think>...</think> blocks before the actual response
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function analyzeMessages(
  roomTitle: string,
  messagesText: string
): Promise<{
  items: MessageAction[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  parseErrors: number;
  rawResponse?: string;
}> {
  const systemPrompt = `You analyze Webex messages to identify follow-up actions for Jason Shearer (jasheare@cisco.com).
For each conversation that needs action, output a JSON object on its own line:
{"task": "Reply to [Name] about [topic]", "priority": "P1", "context": "Quick Win", "person": "Name", "email": "email@cisco.com", "reason": "brief explanation"}

Rules:
- Base your analysis ONLY on the messages provided. Do not invent or assume information.
- Only flag messages that need Jason's ACTION (reply, follow-up, scheduling)
- DO NOT flag: FYI messages, automated notifications, messages Jason already replied to
- Priority: P0 = urgent/time-sensitive today, P1 = this week, P2 = can wait
- Context: "Quick Win" for simple replies, "Deep Work" for complex responses
- Task title should be actionable: "Reply to...", "Follow up with...", "Schedule..."
- Include the specific context of what's being asked
- Each JSON object must reference a SPECIFIC message from the conversation
- If no action is needed, output nothing (empty response is valid)
- Output ONLY JSON lines, no other text`;

  const userPrompt = `Room: ${roomTitle}\n\nMessages:\n${messagesText}`;

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
        options: { num_ctx: 16384, temperature: 0.3 },
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

    // Strip <think> tags from DeepSeek-R1 output
    const cleaned = stripThinkTags(rawContent);

    // Parse JSON lines
    const items: MessageAction[] = [];
    let parseErrors = 0;
    const jsonLines = cleaned.split("\n").filter((l) => l.trim());

    for (const line of jsonLines) {
      try {
        let jsonStr = line.trim();
        // Skip markdown code fences
        if (jsonStr.startsWith("```")) continue;
        // Strip leading list markers like "- " or "1. "
        jsonStr = jsonStr.replace(/^[\d]+\.\s*/, "").replace(/^-\s*/, "");

        const parsed = JSON.parse(jsonStr);
        if (parsed.task && typeof parsed.task === "string") {
          items.push({
            task: parsed.task,
            priority: parsed.priority || "P2",
            context: parsed.context || "Quick Win",
            person: parsed.person || "Unknown",
            email: parsed.email || "",
            reason: parsed.reason || "",
          });
        }
      } catch {
        parseErrors++;
      }
    }

    return {
      items,
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
      throw new Error(`Ollama timeout after ${OLLAMA_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

// --- Notion task creation ---

async function createNotionTask(
  item: MessageAction,
  roomTitle: string,
  roomId: string
): Promise<string | null> {
  const priority = mapPriority(item.priority);
  const context = mapContext(item.context);
  const personInfo = item.email
    ? `${item.person} (${item.email})`
    : item.person;
  const notes = `From: ${personInfo} in ${roomTitle}. ${item.reason}. webex_room:${roomId}. Processed locally via ${OLLAMA_MODEL}`;

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
        select: { name: "Webex Message (Local)" },
      },
      Project: {
        select: { name: "Cisco" },
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
  // Haiku: $0.25/1M input, $1.25/1M output
  const haikuCost =
    (tokensIn / 1_000_000) * 0.25 + (tokensOut / 1_000_000) * 1.25;
  // Sonnet: $3/1M input, $15/1M output
  const sonnetCost =
    (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15;
  return {
    haiku: `~$${haikuCost.toFixed(2)}`,
    sonnet: `~$${sonnetCost.toFixed(2)}`,
  };
}

// --- Message formatting ---

function formatMessagesForAnalysis(
  messages: {
    personEmail?: string;
    personId?: string;
    text?: string;
    created?: string;
    html?: string;
  }[],
  senderNames: Record<string, string>
): string {
  return messages
    .map((msg) => {
      const name =
        senderNames[msg.personEmail || ""] ||
        senderNames[msg.personId || ""] ||
        msg.personEmail ||
        "Unknown";
      const time = msg.created
        ? new Date(msg.created).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "";
      // Prefer plain text, fall back to stripping HTML
      const content =
        msg.text ||
        (msg.html || "").replace(/<[^>]+>/g, "").trim() ||
        "(no content)";
      return `[${time}] ${name}: ${content}`;
    })
    .join("\n");
}

// --- Main ---

async function main() {
  console.log("Processing Webex messages locally...\n");

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
    console.warn(`  ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Resolve my own person ID for filtering
  let myPersonId = "";
  try {
    const me = (await webexGet("/people/me")) as { id?: string };
    myPersonId = me.id || "";
  } catch (err) {
    console.warn(
      `WARNING: Could not resolve person ID: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  clearTaskCache();

  const state = loadState();
  const corrections = loadCorrections();
  const lastCheckTime = new Date(state.lastCheck).getTime();

  const metrics: RunMetrics = {
    roomsProcessed: 0,
    tasksExtracted: 0,
    tasksCreated: 0,
    tasksMerged: 0,
    tasksSkipped: 0,
    correctionsApplied: 0,
    ollamaLatencies: [],
    ollamaTokensIn: 0,
    ollamaTokensOut: 0,
    parseErrors: 0,
    notionErrors: 0,
  };

  const now = new Date();
  console.log(`Last check: ${state.lastCheck}`);
  console.log(`Current time: ${now.toISOString()}`);
  console.log(
    `Tracked rooms: ${Object.keys(state.processedRoomTimestamps).length}\n`
  );

  // Cache sender names: email/personId -> display name
  const senderNames: Record<string, string> = {};
  const resolvedPersonIds = new Set<string>();

  async function resolveSenderName(
    personEmail?: string,
    personId?: string
  ): Promise<void> {
    if (personEmail && senderNames[personEmail]) return;
    if (personId && senderNames[personId]) return;
    if (personId && resolvedPersonIds.has(personId)) return;

    if (personId) {
      resolvedPersonIds.add(personId);
      try {
        const person = (await webexGet(`/people/${personId}`)) as {
          displayName?: string;
          emails?: string[];
        };
        if (person.displayName) {
          senderNames[personId] = person.displayName;
          if (person.emails?.[0]) {
            senderNames[person.emails[0]] = person.displayName;
          }
          if (personEmail) {
            senderNames[personEmail] = person.displayName;
          }
        }
      } catch {
        // Silently skip -- will fall back to email
      }
    }
  }

  // ============================================================
  // PHASE 1: DM rooms
  // ============================================================
  console.log("--- Phase 1: DM Rooms ---\n");

  let dmRooms: {
    id: string;
    title?: string;
    lastActivity?: string;
    type?: string;
  }[] = [];

  try {
    const data = (await webexGet(
      "/rooms?type=direct&sortBy=lastactivity&max=50"
    )) as { items?: typeof dmRooms };
    dmRooms = data.items || [];
  } catch (err) {
    console.error(`Webex API error fetching DM rooms: ${err}`);
    console.error("Skipping DM phase.");
    dmRooms = [];
  }

  // Filter to rooms with activity after lastCheck
  const activeDmRooms = dmRooms.filter((room) => {
    if (!room.lastActivity) return false;
    return new Date(room.lastActivity).getTime() > lastCheckTime;
  });

  console.log(
    `Found ${dmRooms.length} DM rooms, ${activeDmRooms.length} with new activity\n`
  );

  for (const room of activeDmRooms) {
    const roomLabel = room.title || room.id.slice(0, 12);
    console.log(`Processing DM: ${roomLabel}`);

    // Fetch recent messages
    let messages: {
      id: string;
      personEmail?: string;
      personId?: string;
      text?: string;
      html?: string;
      created?: string;
    }[] = [];

    try {
      const data = (await webexGet(
        `/messages?roomId=${room.id}&max=10`
      )) as { items?: typeof messages };
      messages = data.items || [];
    } catch (err) {
      console.error(
        `  Error fetching messages: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    // Filter to messages after lastCheck and not from Jason
    const newMessages = messages.filter((msg) => {
      if (!msg.created) return false;
      if (new Date(msg.created).getTime() <= lastCheckTime) return false;
      if (msg.personEmail === MY_EMAIL) return false;
      return true;
    });

    if (newMessages.length === 0) {
      console.log("  No new messages from others, skipping");
      continue;
    }

    console.log(`  ${newMessages.length} new messages from others`);

    // Resolve sender names for display
    for (const msg of newMessages) {
      await resolveSenderName(msg.personEmail, msg.personId);
    }

    // Also include Jason's recent messages for context (so Ollama can see replies)
    const contextMessages = messages.filter((msg) => {
      if (!msg.created) return false;
      if (new Date(msg.created).getTime() <= lastCheckTime) return false;
      return true;
    });

    const messagesText = formatMessagesForAnalysis(
      contextMessages.reverse(),
      senderNames
    );
    console.log(`  Context: ${contextMessages.length} messages, ${messagesText.length} chars`);

    // Archive the conversation
    try {
      const archiveDir = path.join(STORE_DIR, "archive", "messages");
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      const archiveId = `${room.id.slice(-12)}-${new Date().toISOString().slice(0, 10)}`;
      fs.writeFileSync(path.join(archiveDir, `${archiveId}.json`), JSON.stringify({
        id: archiveId,
        title: `DM: ${roomLabel}`,
        roomId: room.id,
        roomTitle: roomLabel,
        date: new Date().toISOString(),
        messageCount: contextMessages.length,
        content: messagesText,
        archivedAt: new Date().toISOString(),
      }, null, 2));
    } catch { /* archive is best-effort */ }

    // Send to Ollama for analysis
    let ollamaResult: Awaited<ReturnType<typeof analyzeMessages>>;
    try {
      ollamaResult = await analyzeMessages(roomLabel, messagesText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Ollama error: ${msg}`);
      metrics.parseErrors++;
      continue;
    }

    metrics.ollamaLatencies.push(ollamaResult.latencyMs);
    metrics.ollamaTokensIn += ollamaResult.tokensIn;
    metrics.ollamaTokensOut += ollamaResult.tokensOut;
    metrics.parseErrors += ollamaResult.parseErrors;

    console.log(
      `  Ollama: ${ollamaResult.items.length} action items in ${(ollamaResult.latencyMs / 1000).toFixed(1)}s (${ollamaResult.tokensIn} in / ${ollamaResult.tokensOut} out)`
    );

    if (ollamaResult.items.length === 0 && ollamaResult.parseErrors > 0) {
      console.warn("  WARNING: No action items parsed. Raw response:");
      console.warn(
        `  ${(ollamaResult.rawResponse || "").slice(0, 500)}`
      );
    }

    metrics.tasksExtracted += ollamaResult.items.length;

    // Apply corrections and create Notion tasks
    for (const item of ollamaResult.items) {
      const { text: correctedTask, applied: taskApplied } = applyCorrections(
        item.task,
        corrections
      );
      if (taskApplied > 0) {
        console.log(`  Corrected: "${item.task}" -> "${correctedTask}"`);
        metrics.correctionsApplied += taskApplied;
      }
      item.task = correctedTask;

      const { text: correctedPerson, applied: personApplied } =
        applyCorrections(item.person, corrections);
      if (personApplied > 0) {
        metrics.correctionsApplied += personApplied;
      }
      item.person = correctedPerson;

      try {
        const priority = mapPriority(item.priority);
        const context = mapContext(item.context);
        const personInfo = item.email
          ? `${item.person} (${item.email})`
          : item.person;
        const notes = `From: ${personInfo} in ${roomLabel}. ${item.reason}. webex_room:${room.id}. Processed locally via ${OLLAMA_MODEL}`;

        const dedupResult = await findOrCreateTask(
          {
            title: item.task,
            priority,
            context,
            source: "Webex Message (Local)",
            project: "Cisco",
            notes,
            assignee: item.person || undefined,
          },
          {
            notionDbId: NOTION_DB,
            notionPost,
            notionPatch: async (pageId, properties, appendNote) => {
              const body: Record<string, unknown> = {};
              if (Object.keys(properties).length > 0) body.properties = properties;
              if (appendNote) {
                try {
                  const nodeFetch = (await import("node-fetch")).default;
                  const resp = await nodeFetch(`https://api.notion.com/v1/pages/${pageId}`, {
                    agent: proxyAgent,
                    headers: { "Notion-Version": "2022-06-28" },
                  } as any);
                  const pageData = (await resp.json()) as any;
                  const currentNotes = pageData.properties?.Notes?.rich_text?.map((t: any) => t.plain_text).join("") || "";
                  body.properties = {
                    ...(body.properties as Record<string, unknown> || {}),
                    Notes: { rich_text: [{ type: "text", text: { content: (currentNotes + "\n\n" + appendNote).slice(0, 2000) } }] },
                  };
                } catch (err) {
                  console.error(`  Note append error: ${err}`);
                }
              }
              await notionPatchPages(pageId, body);
            },
          }
        );

        if (dedupResult.action === 'created') {
          metrics.tasksCreated++;
          console.log(
            `  Created task: ${item.task.slice(0, 80)}${item.task.length > 80 ? "..." : ""}`
          );
        } else if (dedupResult.action === 'merged') {
          metrics.tasksMerged++;
          console.log(`  Merged with: ${dedupResult.mergedWith?.slice(0, 60)}`);
        } else {
          metrics.tasksSkipped++;
          console.log(`  Skipped (duplicate)`);
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

    // Update room timestamp
    state.processedRoomTimestamps[room.id] =
      room.lastActivity || now.toISOString();
    metrics.roomsProcessed++;

    // Rate limit between rooms
    await new Promise((r) => setTimeout(r, 500));
  }

  // ============================================================
  // PHASE 2: Group rooms (@mentions)
  // ============================================================
  console.log("\n--- Phase 2: Group Room @Mentions ---\n");

  let groupRooms: {
    id: string;
    title?: string;
    lastActivity?: string;
    type?: string;
  }[] = [];

  try {
    const data = (await webexGet(
      "/rooms?type=group&sortBy=lastactivity&max=30"
    )) as { items?: typeof groupRooms };
    groupRooms = data.items || [];
  } catch (err) {
    console.error(`Webex API error fetching group rooms: ${err}`);
    console.error("Skipping group phase.");
    groupRooms = [];
  }

  // Filter to rooms with activity after lastCheck
  const activeGroupRooms = groupRooms.filter((room) => {
    if (!room.lastActivity) return false;
    return new Date(room.lastActivity).getTime() > lastCheckTime;
  });

  console.log(
    `Found ${groupRooms.length} group rooms, ${activeGroupRooms.length} with new activity\n`
  );

  for (const room of activeGroupRooms) {
    const roomLabel = room.title || room.id.slice(0, 12);

    // Fetch @mentions of me
    let mentions: {
      id: string;
      personEmail?: string;
      personId?: string;
      text?: string;
      html?: string;
      created?: string;
    }[] = [];

    try {
      const mentionParam = myPersonId ? myPersonId : "me";
      const data = (await webexGet(
        `/messages?roomId=${room.id}&mentionedPeople=${mentionParam}&max=5`
      )) as { items?: typeof mentions };
      mentions = data.items || [];
    } catch (err) {
      // 404 or access errors are common for group rooms
      continue;
    }

    // Filter to mentions after lastCheck and not from Jason
    const newMentions = mentions.filter((msg) => {
      if (!msg.created) return false;
      if (new Date(msg.created).getTime() <= lastCheckTime) return false;
      if (msg.personEmail === MY_EMAIL) return false;
      return true;
    });

    if (newMentions.length === 0) continue;

    console.log(
      `Processing group: ${roomLabel} (${newMentions.length} new @mentions)`
    );

    // Resolve sender names
    for (const msg of newMentions) {
      await resolveSenderName(msg.personEmail, msg.personId);
    }

    const messagesText = formatMessagesForAnalysis(
      newMentions.reverse(),
      senderNames
    );
    console.log(`  Context: ${newMentions.length} @mentions, ${messagesText.length} chars`);

    // Send to Ollama for analysis
    let ollamaResult: Awaited<ReturnType<typeof analyzeMessages>>;
    try {
      ollamaResult = await analyzeMessages(
        `${roomLabel} (group)`,
        messagesText
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Ollama error: ${msg}`);
      metrics.parseErrors++;
      continue;
    }

    metrics.ollamaLatencies.push(ollamaResult.latencyMs);
    metrics.ollamaTokensIn += ollamaResult.tokensIn;
    metrics.ollamaTokensOut += ollamaResult.tokensOut;
    metrics.parseErrors += ollamaResult.parseErrors;

    console.log(
      `  Ollama: ${ollamaResult.items.length} action items in ${(ollamaResult.latencyMs / 1000).toFixed(1)}s (${ollamaResult.tokensIn} in / ${ollamaResult.tokensOut} out)`
    );

    if (ollamaResult.items.length === 0 && ollamaResult.parseErrors > 0) {
      console.warn("  WARNING: No action items parsed. Raw response:");
      console.warn(
        `  ${(ollamaResult.rawResponse || "").slice(0, 500)}`
      );
    }

    metrics.tasksExtracted += ollamaResult.items.length;

    // Apply corrections and create Notion tasks
    for (const item of ollamaResult.items) {
      const { text: correctedTask, applied: taskApplied } = applyCorrections(
        item.task,
        corrections
      );
      if (taskApplied > 0) {
        console.log(`  Corrected: "${item.task}" -> "${correctedTask}"`);
        metrics.correctionsApplied += taskApplied;
      }
      item.task = correctedTask;

      const { text: correctedPerson, applied: personApplied } =
        applyCorrections(item.person, corrections);
      if (personApplied > 0) {
        metrics.correctionsApplied += personApplied;
      }
      item.person = correctedPerson;

      try {
        const priority = mapPriority(item.priority);
        const context = mapContext(item.context);
        const personInfo = item.email
          ? `${item.person} (${item.email})`
          : item.person;
        const notes = `From: ${personInfo} in ${roomLabel}. ${item.reason}. webex_room:${room.id}. Processed locally via ${OLLAMA_MODEL}`;

        const dedupResult = await findOrCreateTask(
          {
            title: item.task,
            priority,
            context,
            source: "Webex Message (Local)",
            project: "Cisco",
            notes,
            assignee: item.person || undefined,
          },
          {
            notionDbId: NOTION_DB,
            notionPost,
            notionPatch: async (pageId, properties, appendNote) => {
              const body: Record<string, unknown> = {};
              if (Object.keys(properties).length > 0) body.properties = properties;
              if (appendNote) {
                try {
                  const nodeFetch = (await import("node-fetch")).default;
                  const resp = await nodeFetch(`https://api.notion.com/v1/pages/${pageId}`, {
                    agent: proxyAgent,
                    headers: { "Notion-Version": "2022-06-28" },
                  } as any);
                  const pageData = (await resp.json()) as any;
                  const currentNotes = pageData.properties?.Notes?.rich_text?.map((t: any) => t.plain_text).join("") || "";
                  body.properties = {
                    ...(body.properties as Record<string, unknown> || {}),
                    Notes: { rich_text: [{ type: "text", text: { content: (currentNotes + "\n\n" + appendNote).slice(0, 2000) } }] },
                  };
                } catch (err) {
                  console.error(`  Note append error: ${err}`);
                }
              }
              await notionPatchPages(pageId, body);
            },
          }
        );

        if (dedupResult.action === 'created') {
          metrics.tasksCreated++;
          console.log(
            `  Created task: ${item.task.slice(0, 80)}${item.task.length > 80 ? "..." : ""}`
          );
        } else if (dedupResult.action === 'merged') {
          metrics.tasksMerged++;
          console.log(`  Merged with: ${dedupResult.mergedWith?.slice(0, 60)}`);
        } else {
          metrics.tasksSkipped++;
          console.log(`  Skipped (duplicate)`);
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

    // Update room timestamp
    state.processedRoomTimestamps[room.id] =
      room.lastActivity || now.toISOString();
    metrics.roomsProcessed++;

    // Rate limit between rooms
    await new Promise((r) => setTimeout(r, 500));
  }

  // ============================================================
  // Update state and print report
  // ============================================================

  // Update cumulative metrics
  state.metrics.totalRuns++;
  state.metrics.totalRooms += metrics.roomsProcessed;
  state.metrics.totalTasks += metrics.tasksCreated;
  state.metrics.errors += metrics.parseErrors + metrics.notionErrors;

  // Rolling average latency
  if (metrics.ollamaLatencies.length > 0) {
    const runAvg =
      metrics.ollamaLatencies.reduce((a, b) => a + b, 0) /
      metrics.ollamaLatencies.length;
    if (state.metrics.avgLatencyMs === 0) {
      state.metrics.avgLatencyMs = Math.round(runAvg);
    } else {
      // Weighted average: 70% historical, 30% current run
      state.metrics.avgLatencyMs = Math.round(
        state.metrics.avgLatencyMs * 0.7 + runAvg * 0.3
      );
    }
  }

  // Save state
  state.lastCheck = now.toISOString();
  saveState(state);

  // Print instrumentation report
  const avgLatency =
    metrics.ollamaLatencies.length > 0
      ? metrics.ollamaLatencies.reduce((a, b) => a + b, 0) /
        metrics.ollamaLatencies.length
      : 0;
  const totalLatency = metrics.ollamaLatencies.reduce((a, b) => a + b, 0);
  const costs = estimateCost(metrics.ollamaTokensIn, metrics.ollamaTokensOut);

  console.log("\n=== Message Processing (Local) ===");
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Rooms processed: ${metrics.roomsProcessed}`);
  console.log(`Action items extracted: ${metrics.tasksExtracted}`);
  console.log(`Notion tasks created: ${metrics.tasksCreated}`);
  console.log(`Tasks merged (dedup): ${metrics.tasksMerged}`);
  console.log(`Tasks skipped (dedup): ${metrics.tasksSkipped}`);
  if (metrics.ollamaLatencies.length > 0) {
    console.log(
      `Ollama latency: avg ${(avgLatency / 1000).toFixed(0)}s, total ${(totalLatency / 1000).toFixed(0)}s`
    );
  }
  console.log(`API cost: $0.00 (local inference)`);
  console.log(`Equivalent Haiku cost: ${costs.haiku}`);
  console.log(`Equivalent Sonnet cost: ${costs.sonnet}`);
  console.log(`Corrections applied: ${metrics.correctionsApplied}`);
  console.log(`Parse errors: ${metrics.parseErrors}`);
  console.log(`Notion errors: ${metrics.notionErrors}`);
  console.log(
    `State: ${Object.keys(state.processedRoomTimestamps).length} rooms tracked`
  );
  console.log(
    `Cumulative: ${state.metrics.totalRuns} runs, ${state.metrics.totalRooms} rooms, ${state.metrics.totalTasks} tasks, avg latency ${(state.metrics.avgLatencyMs / 1000).toFixed(0)}s`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
