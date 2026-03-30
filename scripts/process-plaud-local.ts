/**
 * Process Plaud NotePin recordings locally using Ollama (deepseek-r1:70b).
 *
 * Fetches recordings from the Plaud API (via OneCLI proxy for auth),
 * extracts action items from pre-transcribed text using local Ollama,
 * applies corrections, creates Notion tasks, and stores a summary page.
 *
 * Replaces the mc-plaud-processor scheduled agent for cost savings.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/process-plaud-local.ts
 */
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { findOrCreateTask, clearTaskCache } from './lib/task-dedup.js';

const STORE_DIR = path.join(process.cwd(), "store");
const STATE_PATH = path.join(STORE_DIR, "plaud-local-state.json");
const SUMMARIES_PATH = path.join(STORE_DIR, "plaud-summaries.json");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const MAX_PROCESSED_RECORDINGS = 500;
const OLLAMA_URL = "http://studio.shearer.live:11434";
const OLLAMA_MODEL = "deepseek-r1:70b";
const OLLAMA_TIMEOUT_MS = 180_000;

// Plaud API
const PLAUD_API_BASE = "https://api.plaud.ai";

// OneCLI proxy — injects Bearer tokens based on hostPattern
const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) {
  throw new Error("ONECLI_AGENT_TOKEN environment variable is required");
}
const proxyAgent = new HttpsProxyAgent(
  `http://x:${AGENT_TOKEN}@localhost:10255`
);

// Folder-to-project mapping (from Plaud memory reference)
const FOLDER_PROJECT_MAP: Record<string, { project: string; zone: string }> = {
  "cisco team": { project: "Cisco", zone: "Open" },
  hsbc: { project: "Cisco", zone: "Open" },
  ntt: { project: "Cisco", zone: "Open" },
  momentumeq: { project: "MomentumEQ", zone: "Open" },
  "ak & jason": { project: "Personal", zone: "Open" },
  ccf: { project: "Personal", zone: "Open" },
};

// --- State types ---

interface PlaudLocalState {
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
  summariesCreated: number;
  correctionsApplied: number;
  ollamaLatencies: number[];
  ollamaTokensIn: number;
  ollamaTokensOut: number;
  parseErrors: number;
  notionErrors: number;
}

interface PlaudSummaryEntry {
  title: string;
  date: string;
  folder: string;
  summary: string;
  actionItems: string[];
  notionTaskIds: string[];
  notionSummaryPageId: string | null;
}

type PlaudSummariesStore = Record<string, PlaudSummaryEntry>;

// --- Plaud API types ---

interface PlaudFile {
  id: string;
  filename: string; // Plaud uses "filename" not "title"
  start_time: number; // Unix MILLISECONDS
  duration: number;
  is_trans: boolean;
  is_summary: boolean;
  filetag_id_list?: string[];
  content_list?: PlaudContentItem[];
}

// Helper to get the display title
function plaudTitle(f: PlaudFile | PlaudFileDetail): string {
  return (f as any).filename || (f as any).title || "Untitled Recording";
}

interface PlaudContentItem {
  type: string; // "auto_sum_note", "transcript", etc.
  data_link?: string;
  ai_content?: string;
  content?: string;
}

interface PlaudFileDetail {
  id: string;
  title?: string;
  filename?: string;
  start_time: number;
  duration: number;
  is_trans: boolean;
  is_summary: boolean;
  tag_id?: string;
  tag_name?: string;
  content_list?: PlaudContentItem[];
}

interface PlaudTag {
  id: string;
  name: string;
}

// --- Fetch helpers ---

async function plaudGet(urlPath: string): Promise<unknown> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(`${PLAUD_API_BASE}${urlPath}`, {
    agent: proxyAgent,
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`Plaud API ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

async function plaudGetText(url: string): Promise<string> {
  // For S3 data_link URLs (no proxy needed, they are pre-signed)
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Plaud S3 ${resp.status}: ${resp.statusText}`);
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

function inferProjectFromFolder(folderName: string): { project: string; zone: string } {
  const lower = folderName.toLowerCase().trim();
  for (const [key, mapping] of Object.entries(FOLDER_PROJECT_MAP)) {
    if (lower.includes(key)) {
      return mapping;
    }
  }
  return { project: "Personal", zone: "Open" };
}

function inferProjectFromTitle(title: string): string {
  const lower = title.toLowerCase();
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
  return "Personal";
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

function formatDate(unixMs: number): string {
  return new Date(unixMs).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatISODate(unixMs: number): string {
  return new Date(unixMs).toISOString();
}

// --- State management ---

function loadState(): PlaudLocalState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return {
    lastCheck: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
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

function saveState(state: PlaudLocalState): void {
  if (state.processedRecordings.length > MAX_PROCESSED_RECORDINGS) {
    state.processedRecordings = state.processedRecordings.slice(
      state.processedRecordings.length - MAX_PROCESSED_RECORDINGS
    );
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadSummaries(): PlaudSummariesStore {
  if (fs.existsSync(SUMMARIES_PATH)) {
    return JSON.parse(fs.readFileSync(SUMMARIES_PATH, "utf-8"));
  }
  return {};
}

function saveSummaries(summaries: PlaudSummariesStore): void {
  fs.writeFileSync(SUMMARIES_PATH, JSON.stringify(summaries, null, 2));
}

// --- Ollama interaction ---

function stripThinkTags(text: string): string {
  // DeepSeek-R1 outputs <think>...</think> blocks before the actual response
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function extractActionItems(
  title: string,
  date: string,
  transcriptText: string
): Promise<{
  items: ActionItem[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  parseErrors: number;
  rawResponse?: string;
}> {
  const systemPrompt = `You analyze meeting recordings to extract action items. For each action item, output a JSON object on its own line:
{"task": "actionable verb phrase", "assignee": "person name or null", "priority": "P0/P1/P2/P3", "context": "Quick Win/Deep Work/Research"}

Rules:
- Base analysis ONLY on the transcript text provided
- Do NOT invent tasks or information not in the transcript
- Extract concrete, actionable tasks — not summaries or observations
- Priority: P0 = must do today, P1 = this week, P2 = this month, P3 = backlog
- Assignee should be the person responsible (if mentioned)
- Task should start with an action verb
- Each task must reference specific content from the transcript
- If no clear action items exist, output nothing
- Output ONLY JSON lines, no other text`;

  const userPrompt = `Recording: ${title}\nDate: ${date}\n\nTranscript:\n${transcriptText}`;

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
        // Skip leading/trailing markdown code fence markers
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
  recordingTitle: string,
  recordingDate: string,
  project: string
): Promise<string | null> {
  const priority = mapPriority(item.priority);
  const context = mapContext(item.context);
  const dateStr = new Date(recordingDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const assigneeNote = item.assignee ? ` Assignee: ${item.assignee}.` : "";
  const notes = `From recording: ${recordingTitle} on ${dateStr}.${assigneeNote} Processed locally via ${OLLAMA_MODEL}`;

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
        select: { name: "PLAUD Recording (Local)" },
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

// --- Notion summary page (Done task with full summary) ---

async function createNotionSummaryPage(
  recordingTitle: string,
  recordingDate: string,
  project: string,
  summaryText: string,
  actionItems: string[]
): Promise<string | null> {
  const dateStr = new Date(recordingDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // Build summary notes: Plaud AI summary + extracted action items
  const actionListText = actionItems.length > 0
    ? `\n\nExtracted action items (${actionItems.length}):\n${actionItems.map((a, i) => `${i + 1}. ${a}`).join("\n")}`
    : "";

  // Notion rich_text has a 2000-char limit per block
  const notesContent = `${summaryText.slice(0, 1800)}${actionListText}`.slice(0, 2000);

  const body = {
    parent: { database_id: NOTION_DB },
    properties: {
      Task: {
        title: [{ text: { content: `Plaud summary: ${recordingTitle} (${dateStr})` } }],
      },
      Priority: {
        select: { name: "P3 \u2014 This Quarter" },
      },
      Status: {
        status: { name: "Done" },
      },
      Context: {
        select: { name: "Quick Win" },
      },
      Zone: {
        select: { name: "Open" },
      },
      Source: {
        select: { name: "PLAUD Recording (Local)" },
      },
      Project: {
        select: { name: project },
      },
      Notes: {
        rich_text: [{ text: { content: notesContent } }],
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
    `  Failed to create Notion summary page: ${result.message || JSON.stringify(result)}`
  );
  return null;
}

// --- Plaud transcript extraction ---

async function getTranscriptText(fileDetail: PlaudFileDetail): Promise<string | null> {
  // Look for transcript content in content_list
  if (!fileDetail.content_list || fileDetail.content_list.length === 0) {
    return null;
  }

  // Try to find a transcript-type entry
  for (const item of fileDetail.content_list) {
    // Direct ai_content or content field
    if (item.ai_content && item.ai_content.trim().length > 50) {
      return item.ai_content;
    }
    if (item.content && item.content.trim().length > 50) {
      return item.content;
    }

    // Follow S3 data_link to get content
    if (item.data_link) {
      try {
        const text = await plaudGetText(item.data_link);
        if (text && text.trim().length > 50) {
          // Parse markdown ai_content if the response is JSON
          try {
            const parsed = JSON.parse(text);
            if (parsed.ai_content) return parsed.ai_content;
            if (parsed.content) return parsed.content;
            if (parsed.text) return parsed.text;
          } catch {
            // Not JSON — use raw text
            return text;
          }
        }
      } catch (err) {
        console.log(`  Could not fetch data_link: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return null;
}

async function getSummaryText(fileDetail: PlaudFileDetail): Promise<string | null> {
  if (!fileDetail.content_list || fileDetail.content_list.length === 0) {
    return null;
  }

  // Look for the auto_sum_note type specifically
  for (const item of fileDetail.content_list) {
    if (item.type === "auto_sum_note") {
      if (item.ai_content && item.ai_content.trim().length > 10) {
        return item.ai_content;
      }
      if (item.data_link) {
        try {
          const text = await plaudGetText(item.data_link);
          if (text && text.trim().length > 10) {
            try {
              const parsed = JSON.parse(text);
              if (parsed.ai_content) return parsed.ai_content;
              if (parsed.content) return parsed.content;
            } catch {
              return text;
            }
          }
        } catch {
          // Skip
        }
      }
    }
  }

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
  console.log("Processing Plaud recordings locally...\n");

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
    summariesCreated: 0,
    correctionsApplied: 0,
    ollamaLatencies: [],
    ollamaTokensIn: 0,
    ollamaTokensOut: 0,
    parseErrors: 0,
    notionErrors: 0,
  };

  console.log(`Previously processed: ${processedSet.size} recordings\n`);

  // 1. Fetch folder tags for project mapping
  let folderTags: PlaudTag[] = [];
  try {
    const tagData = (await plaudGet("/filetag/")) as {
      data?: PlaudTag[];
      items?: PlaudTag[];
    } | PlaudTag[];
    if (Array.isArray(tagData)) {
      folderTags = tagData;
    } else if (tagData.data) {
      folderTags = tagData.data;
    } else if (tagData.items) {
      folderTags = tagData.items;
    }
    console.log(`Folder tags: ${folderTags.map((t) => t.name).join(", ") || "(none)"}`);
  } catch (err) {
    console.warn(`Could not fetch folder tags: ${err instanceof Error ? err.message : String(err)}`);
  }

  const tagNameById: Record<string, string> = {};
  for (const tag of folderTags) {
    tagNameById[tag.id] = tag.name;
  }

  // 2. Fetch recent recordings from Plaud API
  let files: PlaudFile[] = [];
  try {
    const data = (await plaudGet(
      "/file/simple/web?skip=0&limit=50&is_trash=2&sort_by=start_time&is_desc=true"
    )) as { data_file_list?: PlaudFile[]; data?: PlaudFile[]; items?: PlaudFile[] } | PlaudFile[];

    if (Array.isArray(data)) {
      files = data;
    } else if ((data as any).data_file_list) {
      files = (data as any).data_file_list;
    } else if ((data as any).data) {
      files = (data as any).data;
    } else if ((data as any).items) {
      files = (data as any).items;
    }
  } catch (err) {
    console.error(`Plaud API error fetching recordings: ${err}`);
    console.error("Exiting gracefully.");
    return;
  }

  console.log(`Found ${files.length} recordings from Plaud API`);

  // Filter: transcription must be complete, not already processed
  const transcribedFiles = files.filter((f) => f.is_trans && !processedSet.has(f.id));
  console.log(`New transcribed recordings to process: ${transcribedFiles.length}\n`);

  for (const file of transcribedFiles) {
    const recDate = formatDate(file.start_time);
    const tagId = (file as any).filetag_id_list?.[0] || (file as any).tag_id;
    const folderName = (file as any).tag_name || (tagId ? tagNameById[tagId] : "") || "(no folder)";
    console.log(`Processing: ${plaudTitle(file)} (${recDate}) [${folderName}]`);

    // 3. Get file detail with content_list
    let fileDetail: PlaudFileDetail;
    try {
      const detailData = (await plaudGet(`/file/detail/${file.id}`)) as
        | { data?: PlaudFileDetail }
        | PlaudFileDetail;
      fileDetail = (detailData as { data?: PlaudFileDetail }).data || (detailData as PlaudFileDetail);
    } catch (err) {
      console.log(`  Skipping (could not fetch detail): ${err instanceof Error ? err.message : String(err)}`);
      state.processedRecordings.push(file.id);
      continue;
    }

    // 4. Extract transcript text
    let transcriptText: string | null;
    try {
      transcriptText = await getTranscriptText(fileDetail);
    } catch (err) {
      console.log(`  Skipping (transcript fetch error): ${err instanceof Error ? err.message : String(err)}`);
      state.processedRecordings.push(file.id);
      continue;
    }

    if (!transcriptText || transcriptText.trim().length < 50) {
      console.log("  Skipping (transcript too short or empty)");
      state.processedRecordings.push(file.id);
      continue;
    }

    console.log(`  Transcript length: ${transcriptText.length} chars`);

    // Archive the original recording transcript
    try {
      const archiveDir = path.join(STORE_DIR, "archive", "plaud");
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, `${file.id}.json`), JSON.stringify({
        id: file.id,
        title: plaudTitle(file),
        meeting: plaudTitle(file),
        date: recDate,
        folder: folderName,
        content: transcriptText,
        charCount: transcriptText.length,
        archivedAt: new Date().toISOString(),
      }, null, 2));
    } catch { /* archive is best-effort */ }

    // 5. Get Plaud AI summary (if available)
    let summaryText: string | null = null;
    if (file.is_summary) {
      try {
        summaryText = await getSummaryText(fileDetail);
        if (summaryText) {
          console.log(`  Plaud AI summary: ${summaryText.length} chars`);
        }
      } catch {
        // Summary is optional
      }
    }

    // 6. Determine project from folder, falling back to title
    const folderMapping = inferProjectFromFolder(folderName);
    const project = folderMapping.project !== "Personal"
      ? folderMapping.project
      : inferProjectFromTitle(plaudTitle(file));

    // 7. Send transcript to Ollama for action item extraction
    let ollamaResult: Awaited<ReturnType<typeof extractActionItems>>;
    try {
      ollamaResult = await extractActionItems(
        plaudTitle(file),
        formatISODate(file.start_time),
        transcriptText
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Ollama error: ${msg}`);
      metrics.parseErrors++;
      state.processedRecordings.push(file.id);
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

    // 8. Apply corrections and create Notion tasks
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
        const priority = mapPriority(item.priority);
        const context = mapContext(item.context);
        const dateStr = new Date(formatISODate(file.start_time)).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const assigneeNote = item.assignee ? ` Assignee: ${item.assignee}.` : "";
        const notes = `From recording: ${plaudTitle(file)} on ${dateStr}.${assigneeNote} Processed locally via ${OLLAMA_MODEL}`;

        const dedupResult = await findOrCreateTask(
          {
            title: item.task,
            priority,
            context,
            source: "PLAUD Recording (Local)",
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

    // 9. Create summary page in Notion (Done task with the full summary)
    let summaryPageId: string | null = null;
    const summaryForNotion = summaryText || transcriptText.slice(0, 1800);
    try {
      summaryPageId = await createNotionSummaryPage(
        plaudTitle(file),
        formatISODate(file.start_time),
        project,
        summaryForNotion,
        actionItemTexts
      );
      if (summaryPageId) {
        metrics.summariesCreated++;
        console.log(`  Created summary page in Notion`);
      } else {
        metrics.notionErrors++;
      }
    } catch (err) {
      console.error(
        `  Notion summary error: ${err instanceof Error ? err.message : String(err)}`
      );
      metrics.notionErrors++;
    }

    // 10. Store recording summary for index builders
    summaries[file.id] = {
      title: plaudTitle(file),
      date: formatISODate(file.start_time),
      folder: folderName,
      summary: summaryForNotion.slice(0, 2000),
      actionItems: actionItemTexts,
      notionTaskIds,
      notionSummaryPageId: summaryPageId,
    };

    // 11. Mark as processed
    state.processedRecordings.push(file.id);
    metrics.recordingsProcessed++;

    // Rate limit between recordings
    await new Promise((r) => setTimeout(r, 500));
  }

  // 12. Update cumulative metrics
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

  // 13. Save state and summaries
  state.lastCheck = new Date().toISOString();
  saveState(state);
  saveSummaries(summaries);

  // 14. Print instrumentation report
  const avgLatency =
    metrics.ollamaLatencies.length > 0
      ? metrics.ollamaLatencies.reduce((a, b) => a + b, 0) /
        metrics.ollamaLatencies.length
      : 0;
  const totalLatency = metrics.ollamaLatencies.reduce((a, b) => a + b, 0);
  const costs = estimateCost(metrics.ollamaTokensIn, metrics.ollamaTokensOut);

  console.log("\n=== Plaud Recording Processing (Local) ===");
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Recordings processed: ${metrics.recordingsProcessed}`);
  console.log(`Action items extracted: ${metrics.tasksExtracted}`);
  console.log(`Notion tasks created: ${metrics.tasksCreated}`);
  console.log(`Tasks merged (dedup): ${metrics.tasksMerged}`);
  console.log(`Tasks skipped (dedup): ${metrics.tasksSkipped}`);
  console.log(`Notion summaries created: ${metrics.summariesCreated}`);
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
