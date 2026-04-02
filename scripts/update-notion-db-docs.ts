/**
 * Update the Database Architecture Notion page to reflect the dual-database design.
 */
import { HttpsProxyAgent } from "https-proxy-agent";

const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) throw new Error("ONECLI_AGENT_TOKEN required");
const proxyAgent = new HttpsProxyAgent(`http://x:${AGENT_TOKEN}@localhost:10255`);

async function notionFetch(url: string, method: string, body?: unknown): Promise<any> {
  const { default: fetch } = await import("node-fetch");
  const resp = await fetch(url, {
    method, agent: proxyAgent,
    headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as any);
  return resp.json();
}

function h2(text: string) { return { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: text } }] } }; }
function p(text: string) { return { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text } }] } }; }
function bullet(text: string) { return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: text } }] } }; }
function code(text: string, lang = "plain text") { return { object: "block", type: "code", code: { rich_text: [{ text: { content: text } }], language: lang } }; }
function divider() { return { object: "block", type: "divider", divider: {} }; }
function callout(text: string, icon = "💡") { return { object: "block", type: "callout", callout: { rich_text: [{ text: { content: text } }], icon: { type: "emoji", emoji: icon } } }; }

async function main() {
  // Find the Database Architecture page
  const search = await notionFetch("https://api.notion.com/v1/search", "POST", {
    query: "Database Architecture", page_size: 5,
  });

  const page = (search.results || []).find((r: any) => {
    const title = r.properties?.title?.title?.[0]?.text?.content || "";
    return title === "Database Architecture";
  });

  if (!page) { console.error("Database Architecture page not found"); return; }
  console.log(`Found page: ${page.id}`);

  // Delete existing blocks
  const existingBlocks = await notionFetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, "GET");
  for (const block of (existingBlocks.results || [])) {
    await notionFetch(`https://api.notion.com/v1/blocks/${block.id}`, "DELETE");
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Cleared ${(existingBlocks.results || []).length} blocks`);

  // Write updated content
  const blocks = [
    callout("Updated 2026-04-01: Dual-database architecture — SQLite (message bus) + PostgreSQL (application DB). This is the permanent design, not a migration state.", "🏗️"),
    divider(),

    h2("Architecture: Two Databases, Two Roles"),
    code(`
┌─────────────────────────────────────────────────────────────────┐
│                    NanoClaw Core Process                        │
│                                                                 │
│  ┌──────────────────────────┐  ┌────────────────────────────┐  │
│  │  SQLite (messages.db)    │  │  PostgreSQL                │  │
│  │  ─── Message Bus ───     │  │  ─── Application DB ───    │  │
│  │                          │  │                            │  │
│  │  • Chats & messages      │  │  • Tasks (1,363)           │  │
│  │  • Sessions              │  │  • People (254)            │  │
│  │  • Registered groups     │  │  • Initiatives & phases    │  │
│  │  • Router state          │  │  • Artifacts               │  │
│  │  • Scheduled tasks       │──│  • Scheduled tasks  ←DUAL  │  │
│  │  • Task run logs         │──│  • Task run logs    ←DUAL  │  │
│  │                          │  │  • Archive items           │  │
│  │  Sync, embedded, fast    │  │  • Vector chunks (3,182)   │  │
│  │  Core reads & writes     │  │  • Notion sync log         │  │
│  └──────────────────────────┘  │  • Triage, corrections     │  │
│                                │  • Chat messages            │  │
│                                │  • Observability samples    │  │
│                                │                            │  │
│                                │  Dashboard reads from here │  │
│                                └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
`, "plain text"),

    h2("SQLite: Message Bus (messages.db)"),
    p("NanoClaw's native database layer. Synchronous, embedded, fast for real-time message polling every 2 seconds."),
    bullet("chats — chat metadata for group discovery"),
    bullet("chat_messages — incoming messages from all channels"),
    bullet("sessions — active session IDs per group"),
    bullet("registered_groups — group configuration and trigger patterns"),
    bullet("router_state — last processed timestamp, agent timestamps"),
    bullet("scheduled_tasks — pipeline definitions with cron schedules (DUAL-WRITE to PG)"),
    bullet("task_run_logs — execution history (DUAL-WRITE to PG)"),

    h2("PostgreSQL: Application Database"),
    p("Mission Control's system of record. Connection: postgresql://nanoclaw@localhost:5432/nanoclaw"),
    bullet("tasks (1,363 rows) — every action item from every source"),
    bullet("people (254 rows) — contact index with emails, meetings, messages"),
    bullet("initiatives + initiative_phases + initiative_pinned_tasks — project tracking with phase bars"),
    bullet("artifacts — saved research briefs, chat outputs, draft content"),
    bullet("vector_chunks (3,182 rows) — semantic search embeddings (nomic-embed-text, 768 dims)"),
    bullet("archive_items (236 rows) — original source content for provenance"),
    bullet("task_chat_messages + initiative_chat_messages — LLM chat history"),
    bullet("observability_hops + observability_samples — O11y metrics"),
    bullet("notion_sync_log — bidirectional PG ↔ Notion sync audit trail"),
    bullet("corrections — transcription correction glossary"),
    bullet("triage_decisions — RLHF decision log"),
    bullet("40 tables total"),

    h2("The Bridge: Dual-Write Zone"),
    p("Two tables are written to BOTH databases simultaneously:"),
    bullet("scheduled_tasks — SQLite for core's internal cron scheduling, PG for dashboard visibility"),
    bullet("task_run_logs — SQLite for core's execution tracking, PG for dashboard pipeline monitoring"),
    p("Writes go to SQLite first (synchronous, never fails), then fire-and-forget to PG. If PG write fails, it's logged but doesn't block the core process."),

    h2("Who Reads What"),
    bullet("NanoClaw Core → reads from SQLite (message bus, sessions, groups, router state)"),
    bullet("Dashboard (Next.js) → reads from PostgreSQL (all application data)"),
    bullet("Pipeline scripts → write to PG directly via scripts/lib/task-dedup.ts"),
    bullet("Notion sync worker → reads/writes PG, pushes to Notion API"),

    h2("Configuration"),
    code("DATA_BACKEND=dual  # Permanent architecture, not a migration state", "bash"),
    p("Set in both ~/Library/LaunchAgents/com.nanoclaw.plist and com.nanoclaw.dashboard.plist."),

    divider(),
    h2("Ollama Configuration (updated 2026-04-01)"),
    p("Single Ollama instance on Mac Studio (studio.shearer.live:11434). Local Ollama on Mac Mini removed."),
    bullet("gemma3:27b (17.4GB) — primary analysis, chat"),
    bullet("phi4:14b (9.1GB) — synthesis, triage"),
    bullet("granite3.3:8b (4.9GB) — calendar"),
    bullet("nomic-embed-text (0.3GB) — embeddings"),
    p("All Cisco GREEN approved. Total: 31.7GB across 4 models."),
  ];

  await notionFetch(`https://api.notion.com/v1/blocks/${page.id}/children`, "PATCH", { children: blocks });
  console.log("Updated Database Architecture page with dual-database design");
}

main().catch(console.error);
