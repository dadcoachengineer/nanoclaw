/**
 * Process Gmail inbox locally using Ollama (deepseek-r1:70b).
 *
 * Fetches unread inbox emails via Gmail API, filters noise, sends
 * actionable messages to a local Ollama instance for analysis, applies
 * corrections, and creates Notion tasks.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/process-gmail-local.ts
 */
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { findOrCreateTask, clearTaskCache } from './lib/task-dedup.js';

const STORE_DIR = path.join(process.cwd(), "store");
const STATE_PATH = path.join(STORE_DIR, "gmail-local-state.json");
const TOKEN_PATH = path.join(STORE_DIR, "google-oauth.json");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const OLLAMA_URL = "http://studio.shearer.live:11434";
const OLLAMA_MODEL = "deepseek-r1:70b";
const OLLAMA_TIMEOUT_MS = 180_000;
const MAX_PROCESSED_IDS = 500;

// OneCLI proxy for Notion
const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) {
  throw new Error("ONECLI_AGENT_TOKEN environment variable is required");
}
const proxyAgent = new HttpsProxyAgent(
  `http://x:${AGENT_TOKEN}@localhost:10255`
);

// --- Noise filter config ---

const NOISE_SENDERS = [
  "noreply@",
  "no-reply@",
  "notifications@",
  "mailer-daemon@",
  "postmaster@",
  "donotreply@",
  "do-not-reply@",
  "notify@",
  "alert@",
  "updates@",
];

const NOISE_DOMAINS = [
  // Dev/social
  "notifications.github.com", "noreply.github.com",
  "facebookmail.com", "linkedin.com", "twitter.com", "x.com",
  "instagram.com", "pinterest.com", "reddit.com",
  // Marketing/bulk email
  "marketing.", "promo.", "mailchimp.com", "sendgrid.net",
  "constantcontact.com", "hubspot.com", "mailgun.org", "amazonses.com",
  "sendinblue.com", "list-manage.com", "campaign-archive.com",
  // Political/fundraising
  "democrats.", "republicans.", "gop.", "dccc.", "dscc.",
  "actblue.com", "winred.com", "everyaction.com", "ngpvan.com",
  "senatemajority.", "housedemocrats.", "politicalemails.",
  // Retail/commerce
  "e.spotify.com", "info.nextdoor.com", "email.uber.com",
  "amazon.com", "ebay.com", "etsy.com", "walmart.com", "target.com",
  "bestbuy.com", "homedepot.com", "lowes.com",
  "doordash.com", "grubhub.com", "ubereats.com",
  // IoT/sensors
  "airgradient.com", "ifttt.com", "smartthings.com",
  // News/newsletters
  "substack.com", "medium.com", "nytimes.com", "washingtonpost.com",
  // Travel
  "united.com", "delta.com", "southwest.com", "marriott.com", "hilton.com",
];

// --- Types ---

interface GmailLocalState {
  lastCheckTimestamp: string;
  processedMessageIds: string[];
  metrics: {
    totalRuns: number;
    totalEmails: number;
    totalTasks: number;
    avgLatencyMs: number;
    errors: number;
  };
}

interface EmailAction {
  task: string;
  priority: string;
  context: string;
  person: string;
  email: string;
  reason: string;
}

interface RunMetrics {
  emailsFetched: number;
  emailsFiltered: number;
  emailsAnalyzed: number;
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

// --- Gmail API helpers ---

async function gmailGet(
  urlPath: string,
  token: string
): Promise<unknown> {
  const resp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me${urlPath}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!resp.ok) {
    throw new Error(`Gmail API ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
}

// --- Notion helpers ---

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

function inferProject(
  from: string,
  subject: string,
  snippet: string
): string {
  const combined = `${from} ${subject} ${snippet}`.toLowerCase();
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
    combined.includes("mortgage") ||
    combined.includes("hoa") ||
    combined.includes("insurance") ||
    combined.includes("utilities") ||
    combined.includes("repair") ||
    combined.includes("contractor")
  ) {
    return "Home";
  }
  return "Personal";
}

// --- State management ---

function loadState(): GmailLocalState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return {
    lastCheckTimestamp: new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString(),
    processedMessageIds: [],
    metrics: {
      totalRuns: 0,
      totalEmails: 0,
      totalTasks: 0,
      avgLatencyMs: 0,
      errors: 0,
    },
  };
}

function saveState(state: GmailLocalState): void {
  // Cap processed IDs
  if (state.processedMessageIds.length > MAX_PROCESSED_IDS) {
    state.processedMessageIds = state.processedMessageIds.slice(
      state.processedMessageIds.length - MAX_PROCESSED_IDS
    );
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Noise filter ---

function isNoiseSender(fromHeader: string): boolean {
  const lower = fromHeader.toLowerCase();

  // Check automated sender prefixes
  for (const prefix of NOISE_SENDERS) {
    if (lower.includes(prefix)) return true;
  }

  // Check noise domains
  for (const domain of NOISE_DOMAINS) {
    if (lower.includes(domain)) return true;
  }

  return false;
}

function hasListUnsubscribe(
  headers: { name: string; value: string }[]
): boolean {
  return headers.some(
    (h) => h.name.toLowerCase() === "list-unsubscribe"
  );
}

// --- Ollama interaction ---

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function analyzeEmails(
  emailSummaries: string
): Promise<{
  items: EmailAction[];
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  parseErrors: number;
  rawResponse?: string;
}> {
  const systemPrompt = `You analyze personal emails to identify items that need Jason's attention.
For each actionable email, output a JSON object on its own line:
{"task": "Reply to [Name] about [topic]", "priority": "P1", "context": "Quick Win", "person": "sender name", "email": "sender@email.com", "reason": "brief explanation"}

Rules:
- Only flag emails that need a RESPONSE or ACTION from Jason
- DO NOT flag: newsletters, automated notifications, marketing, social media alerts, order confirmations, shipping updates, password resets, verification codes
- Priority: P0 = urgent today, P1 = this week, P2 = can wait
- Context: "Quick Win" for simple replies, "Deep Work" for complex responses, "Research" for items needing investigation
- Task title should be actionable: "Reply to...", "Follow up with...", "Schedule...", "Review..."
- Base analysis ONLY on the email content provided. Do not invent or assume information.
- Each JSON object must reference a SPECIFIC email from the batch
- If no action is needed, output nothing (empty response is valid)
- Output ONLY JSON lines, no other text`;

  const userPrompt = `Recent inbox emails:\n\n${emailSummaries}`;

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
    const items: EmailAction[] = [];
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
      throw new Error(
        `Ollama timeout after ${OLLAMA_TIMEOUT_MS / 1000}s`
      );
    }
    throw err;
  }
}

// --- Notion task creation ---

async function createNotionTask(
  item: EmailAction,
  project: string
): Promise<string | null> {
  const priority = mapPriority(item.priority);
  const context = mapContext(item.context);
  const personInfo = item.email
    ? `${item.person} (${item.email})`
    : item.person;
  const notes = `From: ${personInfo}. ${item.reason}. Processed locally via ${OLLAMA_MODEL}`;

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
        select: { name: "Email" },
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
  console.log("Processing Gmail inbox locally...\n");

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

  clearTaskCache();

  const state = loadState();
  const corrections = loadCorrections();

  const metrics: RunMetrics = {
    emailsFetched: 0,
    emailsFiltered: 0,
    emailsAnalyzed: 0,
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
  console.log(`Last check: ${state.lastCheckTimestamp}`);
  console.log(`Current time: ${now.toISOString()}`);
  console.log(
    `Tracked message IDs: ${state.processedMessageIds.length}\n`
  );

  // ============================================================
  // PHASE 1: Fetch unread inbox messages
  // ============================================================
  console.log("--- Phase 1: Fetch Unread Inbox ---\n");

  let messageIds: string[] = [];

  try {
    const listData = (await gmailGet(
      "/messages?maxResults=30&q=is:inbox+is:unread+newer_than:1d+category:primary",
      token
    )) as { messages?: { id: string; threadId: string }[] };

    messageIds = (listData.messages || []).map((m) => m.id);
    metrics.emailsFetched = messageIds.length;
    console.log(`Found ${messageIds.length} unread inbox messages`);
  } catch (err) {
    console.error(
      `Gmail API error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  // Filter out already-processed messages
  const newMessageIds = messageIds.filter(
    (id) => !state.processedMessageIds.includes(id)
  );
  console.log(
    `New (unprocessed): ${newMessageIds.length}, skipping ${messageIds.length - newMessageIds.length} already seen\n`
  );

  if (newMessageIds.length === 0) {
    console.log("No new messages to process.");
    state.lastCheckTimestamp = now.toISOString();
    state.metrics.totalRuns++;
    saveState(state);
    printReport(metrics, state);
    return;
  }

  // ============================================================
  // PHASE 2: Fetch message details and filter noise
  // ============================================================
  console.log("--- Phase 2: Fetch Details & Filter Noise ---\n");

  interface EmailDetail {
    id: string;
    from: string;
    to: string;
    subject: string;
    date: string;
    snippet: string;
    isNoise: boolean;
    noiseReason?: string;
  }

  const emails: EmailDetail[] = [];

  for (const msgId of newMessageIds) {
    try {
      const msgData = (await gmailGet(
        `/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To&metadataHeaders=List-Unsubscribe`,
        token
      )) as {
        id: string;
        snippet?: string;
        payload?: {
          headers?: { name: string; value: string }[];
        };
      };

      const headers = msgData.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find(
          (h) => h.name.toLowerCase() === name.toLowerCase()
        )?.value || "";

      const from = getHeader("From");
      const subject = getHeader("Subject");
      const date = getHeader("Date");
      const to = getHeader("To");
      const snippet = msgData.snippet || "";

      let isNoise = false;
      let noiseReason: string | undefined;

      if (isNoiseSender(from)) {
        isNoise = true;
        noiseReason = "automated/noise sender";
      } else if (hasListUnsubscribe(headers)) {
        isNoise = true;
        noiseReason = "mailing list (List-Unsubscribe)";
      }

      emails.push({
        id: msgId,
        from,
        to,
        subject,
        date,
        snippet,
        isNoise,
        noiseReason,
      });

      // Mark as processed regardless of noise status
      state.processedMessageIds.push(msgId);
    } catch (err) {
      console.error(
        `  Error fetching message ${msgId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Rate limit Gmail API calls
    await new Promise((r) => setTimeout(r, 100));
  }

  const noiseEmails = emails.filter((e) => e.isNoise);
  const actionableEmails = emails.filter((e) => !e.isNoise);

  metrics.emailsFiltered = noiseEmails.length;
  metrics.emailsAnalyzed = actionableEmails.length;

  console.log(`Fetched ${emails.length} email details`);
  console.log(
    `Filtered ${noiseEmails.length} noise emails:`
  );
  for (const e of noiseEmails) {
    console.log(
      `  [SKIP] ${e.subject.slice(0, 60)} (${e.noiseReason})`
    );
  }
  console.log(`Actionable emails: ${actionableEmails.length}\n`);

  if (actionableEmails.length === 0) {
    console.log("No actionable emails after filtering.");
    state.lastCheckTimestamp = now.toISOString();
    state.metrics.totalRuns++;
    saveState(state);
    printReport(metrics, state);
    return;
  }

  // ============================================================
  // PHASE 3: Batch analyze with Ollama
  // ============================================================
  console.log("--- Phase 3: Ollama Analysis ---\n");

  // Format emails for LLM
  const emailSummaries = actionableEmails
    .map(
      (e, i) =>
        `--- Email ${i + 1} ---\nFrom: ${e.from}\nTo: ${e.to}\nDate: ${e.date}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
    )
    .join("\n\n");

  console.log(
    `Sending ${actionableEmails.length} emails to ${OLLAMA_MODEL} (${emailSummaries.length} chars)...`
  );

  let ollamaResult: Awaited<ReturnType<typeof analyzeEmails>>;
  try {
    ollamaResult = await analyzeEmails(emailSummaries);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Ollama error: ${msg}`);
    metrics.parseErrors++;
    state.lastCheckTimestamp = now.toISOString();
    state.metrics.totalRuns++;
    state.metrics.errors++;
    saveState(state);
    printReport(metrics, state);
    return;
  }

  metrics.ollamaLatencies.push(ollamaResult.latencyMs);
  metrics.ollamaTokensIn += ollamaResult.tokensIn;
  metrics.ollamaTokensOut += ollamaResult.tokensOut;
  metrics.parseErrors += ollamaResult.parseErrors;

  console.log(
    `Ollama: ${ollamaResult.items.length} action items in ${(ollamaResult.latencyMs / 1000).toFixed(1)}s (${ollamaResult.tokensIn} in / ${ollamaResult.tokensOut} out)`
  );

  if (ollamaResult.items.length === 0 && ollamaResult.parseErrors > 0) {
    console.warn("WARNING: No action items parsed. Raw response:");
    console.warn(
      `  ${(ollamaResult.rawResponse || "").slice(0, 500)}`
    );
  }

  metrics.tasksExtracted += ollamaResult.items.length;

  // ============================================================
  // PHASE 4: Apply corrections and create Notion tasks
  // ============================================================
  console.log("\n--- Phase 4: Create Notion Tasks ---\n");

  for (const item of ollamaResult.items) {
    // Apply corrections to task title
    const { text: correctedTask, applied: taskApplied } =
      applyCorrections(item.task, corrections);
    if (taskApplied > 0) {
      console.log(`  Corrected: "${item.task}" -> "${correctedTask}"`);
      metrics.correctionsApplied += taskApplied;
    }
    item.task = correctedTask;

    // Apply corrections to person name
    const { text: correctedPerson, applied: personApplied } =
      applyCorrections(item.person, corrections);
    if (personApplied > 0) {
      metrics.correctionsApplied += personApplied;
    }
    item.person = correctedPerson;

    // Infer project from email content
    const matchedEmail = actionableEmails.find(
      (e) =>
        e.from.toLowerCase().includes(item.email.toLowerCase()) ||
        e.from.toLowerCase().includes(item.person.toLowerCase())
    );
    const project = inferProject(
      matchedEmail?.from || item.email,
      matchedEmail?.subject || item.task,
      matchedEmail?.snippet || item.reason
    );

    try {
      const priority = mapPriority(item.priority);
      const context = mapContext(item.context);
      const personInfo = item.email
        ? `${item.person} (${item.email})`
        : item.person;
      const notes = `From: ${personInfo}. ${item.reason}. Processed locally via ${OLLAMA_MODEL}`;

      const dedupResult = await findOrCreateTask(
        {
          title: item.task,
          priority,
          context,
          source: "Email",
          project,
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
          `  Created task [${project}]: ${item.task.slice(0, 80)}${item.task.length > 80 ? "..." : ""}`
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

  // ============================================================
  // Update state and print report
  // ============================================================

  state.metrics.totalRuns++;
  state.metrics.totalEmails += metrics.emailsAnalyzed;
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
      state.metrics.avgLatencyMs = Math.round(
        state.metrics.avgLatencyMs * 0.7 + runAvg * 0.3
      );
    }
  }

  state.lastCheckTimestamp = now.toISOString();
  saveState(state);
  printReport(metrics, state);
}

function printReport(metrics: RunMetrics, state: GmailLocalState) {
  const avgLatency =
    metrics.ollamaLatencies.length > 0
      ? metrics.ollamaLatencies.reduce((a, b) => a + b, 0) /
        metrics.ollamaLatencies.length
      : 0;
  const totalLatency = metrics.ollamaLatencies.reduce(
    (a, b) => a + b,
    0
  );
  const costs = estimateCost(
    metrics.ollamaTokensIn,
    metrics.ollamaTokensOut
  );

  console.log("\n=== Gmail Processing (Local) ===");
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log(`Emails fetched: ${metrics.emailsFetched}`);
  console.log(`Noise filtered: ${metrics.emailsFiltered}`);
  console.log(`Emails analyzed: ${metrics.emailsAnalyzed}`);
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
    `State: ${state.processedMessageIds.length} message IDs tracked`
  );
  console.log(
    `Cumulative: ${state.metrics.totalRuns} runs, ${state.metrics.totalEmails} emails, ${state.metrics.totalTasks} tasks, avg latency ${(state.metrics.avgLatencyMs / 1000).toFixed(0)}s`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
