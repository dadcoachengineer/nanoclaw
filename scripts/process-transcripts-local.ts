/**
 * Process Webex meeting transcripts locally using Ollama (deepseek-r1:70b).
 *
 * Fetches recordings from the last 24 hours, downloads VTT transcripts,
 * sends them to a local Ollama instance for action item extraction, applies
 * corrections, creates Notion tasks, and stores summaries for index builders.
 *
 * Replaces the mc-webex-transcripts scheduled agent for cost savings.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/process-transcripts-local.ts
 */
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { findOrCreateTask, clearTaskCache } from './lib/task-dedup.js';

const STORE_DIR = path.join(process.cwd(), "store");
const STATE_PATH = path.join(STORE_DIR, "transcript-local-state.json");
const SUMMARIES_PATH = path.join(STORE_DIR, "webex-summaries.json");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const MAX_PROCESSED_RECORDINGS = 500;
const OLLAMA_URL = "http://studio.shearer.live:11434";
const OLLAMA_MODEL = "deepseek-r1:70b";
const OLLAMA_TIMEOUT_MS = 180_000;

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

interface TranscriptLocalState {
  lastCheck: string;
  processedRecordings: string[];
  metrics: {
    totalRuns: number;
    totalRecordings: number;
    totalTasks: number;
    avgLatencyMs: number;
    errors: number;
  };
}

interface ActionItem {
  task: string;
  assignee: string | null;
  priority: string;
  context: string;
}

interface RunMetrics {
  recordingsProcessed: number;
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

interface MeetingSummaryEntry {
  title: string;
  date: string;
  host: string;
  summary: string;
  actionItems: string[];
  notionTaskIds: string[];
}

type SummariesStore = Record<string, MeetingSummaryEntry>;

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

async function webexGetText(urlPath: string): Promise<string> {
  const resp = await fetch(`https://webexapis.com/v1${urlPath}`, {
    headers: { Authorization: `Bearer ${WEBEX_TOKEN}` },
  });
  if (!resp.ok) {
    throw new Error(`Webex API ${resp.status}: ${resp.statusText}`);
  }
  return resp.text();
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

function inferProject(meetingTitle: string): string {
  const lower = meetingTitle.toLowerCase();
  if (
    lower.includes("cisco") ||
    lower.includes("spaces") ||
    lower.includes("fpw") ||
    lower.includes("webex") ||
    lower.includes("splunk") ||
    lower.includes("cadenas") ||
    lower.includes("cross arch")
  ) {
    return "Cisco";
  }
  if (lower.includes("momentumeq") || lower.includes("coaching")) {
    return "MomentumEQ";
  }
  if (lower.includes("ordinary epics") || lower.includes("adventure")) {
    return "Ordinary Epics";
  }
  if (lower.includes("real estate") || lower.includes("accelerator")) {
    return "Real Estate Accelerator";
  }
  return "Cisco";
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

function loadState(): TranscriptLocalState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return {
    lastCheck: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    processedRecordings: [],
    metrics: {
      totalRuns: 0,
      totalRecordings: 0,
      totalTasks: 0,
      avgLatencyMs: 0,
      errors: 0,
    },
  };
}

function saveState(state: TranscriptLocalState): void {
  if (state.processedRecordings.length > MAX_PROCESSED_RECORDINGS) {
    state.processedRecordings = state.processedRecordings.slice(
      state.processedRecordings.length - MAX_PROCESSED_RECORDINGS
    );
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadSummaries(): SummariesStore {
  if (fs.existsSync(SUMMARIES_PATH)) {
    return JSON.parse(fs.readFileSync(SUMMARIES_PATH, "utf-8"));
  }
  return {};
}

function saveSummaries(summaries: SummariesStore): void {
  fs.writeFileSync(SUMMARIES_PATH, JSON.stringify(summaries, null, 2));
}

// --- VTT parsing ---

function parseVttToSpeakerTurns(vtt: string): {
  text: string;
  speakers: string[];
} {
  const lines = vtt.split("\n");
  const turns: { speaker: string; text: string }[] = [];
  const speakerSet = new Set<string>();

  // Webex VTT uses <v Speaker Name>text format:
  //   <v Jason Shearer>Hey, how are you?
  const voiceTagRegex = /<v\s+([^>]+)>(.*)$/;

  let currentSpeaker = "";
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines, WEBVTT header, NOTE blocks
    if (!line || line === "WEBVTT" || line.startsWith("NOTE")) continue;
    // Skip timestamp lines
    if (line.includes("-->")) continue;
    // Skip bare sequence numbers
    if (/^\d+$/.test(line)) continue;

    // Check for <v Speaker>text format
    const voiceMatch = line.match(voiceTagRegex);
    if (voiceMatch) {
      const speaker = voiceMatch[1].trim();
      const text = voiceMatch[2].trim();

      if (speaker !== currentSpeaker) {
        // Flush previous speaker
        if (currentSpeaker && currentLines.length > 0) {
          turns.push({
            speaker: currentSpeaker,
            text: currentLines.join(" "),
          });
          currentLines = [];
        }
        currentSpeaker = speaker;
        speakerSet.add(speaker);
      }
      if (text) currentLines.push(text);
      continue;
    }

    // Plain text line (continuation of current speaker)
    if (currentSpeaker && line) {
      // Strip any closing </v> tags
      const clean = line.replace(/<\/v>/g, "").trim();
      if (clean) currentLines.push(clean);
    }
  }

  // Flush last speaker
  if (currentSpeaker && currentLines.length > 0) {
    turns.push({
      speaker: currentSpeaker,
      text: currentLines.join(" "),
    });
  }

  // Merge consecutive turns from the same speaker
  const merged: { speaker: string; text: string }[] = [];
  for (const turn of turns) {
    if (merged.length > 0 && merged[merged.length - 1].speaker === turn.speaker) {
      merged[merged.length - 1].text += " " + turn.text;
    } else {
      merged.push({ ...turn });
    }
  }

  const text = merged.map((t) => `${t.speaker}: ${t.text}`).join("\n");
  return { text, speakers: Array.from(speakerSet) };
}

// --- Ollama interaction ---

function stripThinkTags(text: string): string {
  // DeepSeek-R1 outputs <think>...</think> blocks before the actual response
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function extractActionItems(
  title: string,
  date: string,
  speakers: string[],
  transcriptText: string
): Promise<{
  items: ActionItem[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  parseErrors: number;
  rawResponse?: string;
}> {
  const systemPrompt = `You are a meeting transcript analyzer. Extract action items from the transcript. For each action item, output a JSON object on its own line with fields: task (string), assignee (string or null), priority (P0/P1/P2/P3), context (Quick Win/Deep Work/Research). Output ONLY the JSON lines, no other text.`;

  const userPrompt = `Meeting: ${title}\nDate: ${date}\nParticipants: ${speakers.join(", ")}\n\nTranscript:\n${transcriptText}`;

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
    const items: ActionItem[] = [];
    let parseErrors = 0;
    const jsonLines = cleaned.split("\n").filter((l) => l.trim());

    for (const line of jsonLines) {
      try {
        // Try to extract JSON from the line (handle markdown code fences, etc.)
        let jsonStr = line.trim();
        // Strip leading/trailing markdown code fence markers
        if (jsonStr.startsWith("```")) continue;
        // Strip leading list markers like "- " or "1. "
        jsonStr = jsonStr.replace(/^[\d]+\.\s*/, "").replace(/^-\s*/, "");

        const parsed = JSON.parse(jsonStr);
        if (parsed.task && typeof parsed.task === "string") {
          items.push({
            task: parsed.task,
            assignee: parsed.assignee || null,
            priority: parsed.priority || "P2",
            context: parsed.context || "Quick Win",
          });
        }
      } catch {
        parseErrors++;
      }
    }

    return { items, latencyMs, tokensIn, tokensOut, parseErrors, rawResponse: rawContent };
  } catch (err: unknown) {
    clearTimeout(timeout);
    const latencyMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes("abort")) {
      throw new Error(`Ollama timeout after ${OLLAMA_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
}

// --- Notion task creation ---

async function createNotionTask(
  item: ActionItem,
  meetingTitle: string,
  meetingDate: string,
  recordingId: string
): Promise<string | null> {
  const project = inferProject(meetingTitle);
  const priority = mapPriority(item.priority);
  const context = mapContext(item.context);
  const dateStr = new Date(meetingDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const assigneeNote = item.assignee ? ` Assignee: ${item.assignee}.` : "";
  const notes = `From meeting: ${meetingTitle} on ${dateStr}.${assigneeNote} Processed locally via ${OLLAMA_MODEL}`;

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
        select: { name: "Webex Transcript (Local)" },
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

function estimateCost(tokensIn: number, tokensOut: number): {
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

// --- Main ---

async function main() {
  console.log("Processing Webex transcripts locally...\n");

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

  clearTaskCache();

  const state = loadState();
  const summaries = loadSummaries();
  const corrections = loadCorrections();
  const processedSet = new Set(state.processedRecordings);

  const metrics: RunMetrics = {
    recordingsProcessed: 0,
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

  // Time window: last 24 hours
  const now = new Date();
  // Look back 7 days (transcripts take time to appear in the API)
  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log(`Time window: ${from.toISOString()} to ${now.toISOString()}`);
  console.log(`Previously processed: ${processedSet.size} recordings\n`);

  // 1. Fetch recent meeting transcripts (not recordings — different API)
  let transcripts: {
    id: string;
    meetingTopic: string;
    startTime?: string;
    status?: string;
  }[] = [];

  try {
    const data = (await webexGet(
      `/meetingTranscripts?from=${from.toISOString()}&to=${now.toISOString()}&max=50`
    )) as { items?: typeof transcripts };
    transcripts = data.items || [];
  } catch (err) {
    console.error(`Webex API error fetching transcripts: ${err}`);
    console.error("Exiting gracefully.");
    return;
  }

  console.log(`Found ${transcripts.length} transcripts in the last 24 hours`);

  // Filter out already-processed
  const newTranscripts = transcripts.filter((t) => !processedSet.has(t.id));
  console.log(`New transcripts to process: ${newTranscripts.length}\n`);

  for (const recording of newTranscripts) {
    const recDate = new Date(recording.startTime || Date.now()).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    console.log(`Processing: ${recording.meetingTopic} (${recDate})`);

    // 2. Download VTT transcript via the download endpoint
    let vttText: string;
    try {
      vttText = await webexGetText(`/meetingTranscripts/${recording.id}/download`);
    } catch (err) {
      console.log(`  Skipping (no transcript): ${err instanceof Error ? err.message : String(err)}`);
      state.processedRecordings.push(recording.id);
      continue;
    }

    if (!vttText || vttText.trim().length < 50) {
      console.log("  Skipping (transcript too short or empty)");
      state.processedRecordings.push(recording.id);
      continue;
    }

    // 3. Parse VTT into speaker turns
    const { text: transcriptText, speakers } = parseVttToSpeakerTurns(vttText);
    console.log(`  Speakers: ${speakers.join(", ")}`);
    console.log(`  Transcript length: ${transcriptText.length} chars`);

    // 4. Send to Ollama for action item extraction
    let ollamaResult: Awaited<ReturnType<typeof extractActionItems>>;
    try {
      ollamaResult = await extractActionItems(
        recording.meetingTopic,
        (recording.startTime || new Date().toISOString()),
        speakers,
        transcriptText
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Ollama error: ${msg}`);
      metrics.parseErrors++;
      state.processedRecordings.push(recording.id);
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

    // 5. Apply corrections and create Notion tasks
    const notionTaskIds: string[] = [];
    const actionItemTexts: string[] = [];

    for (const item of ollamaResult.items) {
      // Apply corrections glossary to task text
      const { text: correctedTask, applied } = applyCorrections(
        item.task,
        corrections
      );
      if (applied > 0) {
        console.log(`  Corrected: "${item.task}" -> "${correctedTask}"`);
        metrics.correctionsApplied += applied;
      }
      item.task = correctedTask;
      actionItemTexts.push(correctedTask);

      // Also apply corrections to assignee if present
      if (item.assignee) {
        const { text: correctedAssignee } = applyCorrections(
          item.assignee,
          corrections
        );
        item.assignee = correctedAssignee;
      }

      // Create or deduplicate Notion task
      try {
        const project = inferProject(recording.meetingTopic);
        const priority = mapPriority(item.priority);
        const context = mapContext(item.context);
        const dateStr = new Date(recording.startTime || Date.now()).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const assigneeNote = item.assignee ? ` Assignee: ${item.assignee}.` : "";
        const notes = `From meeting: ${recording.meetingTopic} on ${dateStr}.${assigneeNote} Processed locally via ${OLLAMA_MODEL}`;

        const dedupResult = await findOrCreateTask(
          {
            title: item.task,
            priority,
            context,
            source: "Webex Transcript (Local)",
            project,
            notes,
            assignee: item.assignee || undefined,
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
          notionTaskIds.push(dedupResult.taskId);
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

    // 6. Store transcript summary for person/topic index integration
    summaries[recording.id] = {
      title: recording.meetingTopic,
      date: (recording.startTime || new Date().toISOString()),
      host: recording.hostDisplayName || recording.hostEmail || "unknown",
      summary: transcriptText.slice(0, 2000),
      actionItems: actionItemTexts,
      notionTaskIds,
    };

    // 7. Mark as processed
    state.processedRecordings.push(recording.id);
    metrics.recordingsProcessed++;

    // Rate limit between recordings
    await new Promise((r) => setTimeout(r, 500));
  }

  // 8. Update cumulative metrics
  state.metrics.totalRuns++;
  state.metrics.totalRecordings += metrics.recordingsProcessed;
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

  // 9. Save state and summaries
  state.lastCheck = now.toISOString();
  saveState(state);
  saveSummaries(summaries);

  // 10. Print instrumentation report
  const avgLatency =
    metrics.ollamaLatencies.length > 0
      ? metrics.ollamaLatencies.reduce((a, b) => a + b, 0) /
        metrics.ollamaLatencies.length
      : 0;
  const totalLatency = metrics.ollamaLatencies.reduce((a, b) => a + b, 0);
  const costs = estimateCost(metrics.ollamaTokensIn, metrics.ollamaTokensOut);

  console.log("\n=== Transcript Processing (Local) ===");
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Recordings processed: ${metrics.recordingsProcessed}`);
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
    `State: ${state.processedRecordings.length} recordings tracked`
  );
  console.log(
    `Cumulative: ${state.metrics.totalRuns} runs, ${state.metrics.totalRecordings} recordings, ${state.metrics.totalTasks} tasks, avg latency ${(state.metrics.avgLatencyMs / 1000).toFixed(0)}s`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
