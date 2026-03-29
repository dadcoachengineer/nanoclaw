/**
 * Fetch Webex AI meeting summaries and create Notion tasks from action items.
 *
 * Lists ended meetings from the last 24 hours, fetches AI-generated summaries,
 * creates Notion tasks from action items, and stores summary data for the
 * person/topic index builders.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/fetch-webex-summaries.ts
 */
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";

const STORE_DIR = path.join(process.cwd(), "store");
const STATE_PATH = path.join(STORE_DIR, "webex-summaries-state.json");
const SUMMARIES_PATH = path.join(STORE_DIR, "webex-summaries.json");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const MAX_PROCESSED_MEETINGS = 500;

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

interface SummaryState {
  lastCheck: string;
  processedMeetings: string[];
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

// --- Utility helpers ---

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function loadCorrections(): Record<string, string> {
  if (fs.existsSync(CORRECTIONS_PATH)) {
    return JSON.parse(fs.readFileSync(CORRECTIONS_PATH, "utf-8"));
  }
  return {};
}

function applyCorrections(
  text: string,
  corrections: Record<string, string>
): string {
  let result = text;
  for (const [wrong, right] of Object.entries(corrections)) {
    // Word-boundary-aware replacement (case-insensitive)
    const pattern = new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    result = result.replace(pattern, right);
  }
  return result;
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
  // Default
  return "Cisco";
}

function inferContext(actionItem: string): string {
  const lower = actionItem.toLowerCase();
  // Deep Work indicators: multi-step, research, design, build, review, analyze, strategy
  const deepWorkPatterns = [
    "research",
    "analyze",
    "design",
    "build",
    "create a plan",
    "develop",
    "strategy",
    "architecture",
    "implement",
    "investigate",
    "evaluate",
    "proposal",
    "document",
    "prepare presentation",
    "write up",
    "deep dive",
    "review and",
    "draft",
  ];
  if (deepWorkPatterns.some((p) => lower.includes(p))) {
    return "Deep Work";
  }
  return "Quick Win";
}

function loadState(): SummaryState {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  }
  return {
    lastCheck: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    processedMeetings: [],
  };
}

function saveState(state: SummaryState): void {
  // Cap processedMeetings at MAX_PROCESSED_MEETINGS (trim oldest)
  if (state.processedMeetings.length > MAX_PROCESSED_MEETINGS) {
    state.processedMeetings = state.processedMeetings.slice(
      state.processedMeetings.length - MAX_PROCESSED_MEETINGS
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

// --- Notion task creation ---

async function createNotionTask(
  taskText: string,
  meetingTitle: string,
  meetingDate: string,
  meetingId: string
): Promise<string | null> {
  const project = inferProject(meetingTitle);
  const context = inferContext(taskText);
  const dateStr = new Date(meetingDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const notes = `From meeting: ${meetingTitle} on ${dateStr}. webex_meeting:${meetingId}`;

  const body = {
    parent: { database_id: NOTION_DB },
    properties: {
      Task: {
        title: [{ text: { content: taskText } }],
      },
      Priority: {
        select: { name: "P2 \u2014 This Month" },
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
        select: { name: "Webex AI Summary" },
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

// --- Main ---

async function main() {
  console.log("Fetching Webex AI meeting summaries...\n");

  const state = loadState();
  const summaries = loadSummaries();
  const corrections = loadCorrections();
  const processedSet = new Set(state.processedMeetings);

  // Time window: last 24 hours
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  console.log(
    `Time window: ${from.toISOString()} to ${now.toISOString()}`
  );
  console.log(
    `Previously processed: ${processedSet.size} meetings\n`
  );

  // 1. List ended meeting instances from the last 24 hours
  const meetingsData = (await webexGet(
    `/meetings?meetingType=meeting&state=ended&from=${from.toISOString()}&to=${now.toISOString()}&max=50`
  )) as {
    items?: {
      id: string;
      title: string;
      start: string;
      end: string;
      hostEmail?: string;
      hostDisplayName?: string;
    }[];
  };

  const meetings = meetingsData.items || [];
  console.log(`Found ${meetings.length} ended meetings in the last 24 hours`);

  // Filter out already-processed meetings
  const newMeetings = meetings.filter((m) => !processedSet.has(m.id));
  console.log(`New meetings to process: ${newMeetings.length}\n`);

  let meetingsProcessed = 0;
  let totalActionItems = 0;

  for (const meeting of newMeetings) {
    console.log(
      `Processing: ${meeting.title} (${new Date(meeting.start).toLocaleDateString()})`
    );

    // 2. Fetch AI summary for this meeting
    let summaryData: {
      items?: {
        id: string;
        meetingId: string;
        notes?: { content: string };
        actionItems?: { content: string }[];
        status?: string;
      }[];
    };

    try {
      summaryData = (await webexGet(
        `/meetingSummaries?meetingId=${meeting.id}`
      )) as typeof summaryData;
    } catch (err) {
      console.log(`  Skipping (API error): ${err}`);
      // Mark as processed so we don't retry failures forever
      state.processedMeetings.push(meeting.id);
      continue;
    }

    const summaryItems = summaryData?.items || [];
    if (summaryItems.length === 0) {
      console.log("  No AI summary available");
      state.processedMeetings.push(meeting.id);
      continue;
    }

    const summary = summaryItems[0];
    const notesHtml = summary.notes?.content || "";
    const plainSummary = stripHtml(notesHtml);
    const actionItems = (summary.actionItems || []).map((ai) => ai.content);

    console.log(
      `  Summary: ${plainSummary.slice(0, 100)}${plainSummary.length > 100 ? "..." : ""}`
    );
    console.log(`  Action items: ${actionItems.length}`);

    // 3. Create Notion tasks from action items
    const notionTaskIds: string[] = [];

    for (const rawItem of actionItems) {
      // Apply corrections glossary
      const item = applyCorrections(rawItem, corrections);
      if (item !== rawItem) {
        console.log(`  Corrected: "${rawItem}" -> "${item}"`);
      }

      const taskId = await createNotionTask(
        item,
        meeting.title,
        meeting.start,
        meeting.id
      );
      if (taskId) {
        notionTaskIds.push(taskId);
        totalActionItems++;
        console.log(
          `  Created task: ${item.slice(0, 80)}${item.length > 80 ? "..." : ""}`
        );
      }

      // Rate limit protection
      await new Promise((r) => setTimeout(r, 300));
    }

    // 4. Enrich person index with meeting participant emails
    try {
      const inviteeData = (await webexGet(
        `/meetingInvitees?meetingId=${meeting.id}&max=50`
      )) as { items?: { displayName?: string; email?: string }[] };
      const personIndexPath = path.join(STORE_DIR, "person-index.json");
      if (inviteeData.items?.length && fs.existsSync(personIndexPath)) {
        const personIndex = JSON.parse(fs.readFileSync(personIndexPath, "utf-8"));
        for (const inv of inviteeData.items) {
          if (!inv.displayName || !inv.email) continue;
          const key = inv.displayName.toLowerCase().trim();
          // Find by exact key or name match
          const entry = personIndex[key] ||
            Object.values(personIndex).find((p: any) =>
              p.name?.toLowerCase() === key ||
              inv.displayName!.toLowerCase().includes(p.name?.toLowerCase().split(" ").pop() || "???")
            ) as any;
          if (entry && !entry.emails.includes(inv.email)) {
            entry.emails.push(inv.email);
          }
        }
        fs.writeFileSync(personIndexPath, JSON.stringify(personIndex, null, 2));
        console.log(`  Enriched person index with ${inviteeData.items.length} participant emails`);
      }
    } catch { /* best-effort enrichment */ }

    // 5. Store summary data for index builders
    summaries[meeting.id] = {
      title: meeting.title,
      date: meeting.start,
      host: meeting.hostDisplayName || meeting.hostEmail || "unknown",
      summary: plainSummary,
      actionItems,
      notionTaskIds,
    };

    // 6. Mark as processed
    state.processedMeetings.push(meeting.id);
    meetingsProcessed++;

    // Rate limit between meetings
    await new Promise((r) => setTimeout(r, 500));
  }

  // 7. Save state and summaries
  state.lastCheck = now.toISOString();
  saveState(state);
  saveSummaries(summaries);

  // 8. Print summary
  console.log("\n=== Summary ===");
  console.log(`Meetings processed: ${meetingsProcessed}`);
  console.log(`Action items created as Notion tasks: ${totalActionItems}`);
  console.log(`Total meetings in history: ${Object.keys(summaries).length}`);
  console.log(
    `Processed meetings tracked: ${state.processedMeetings.length}`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
