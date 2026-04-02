/**
 * Create comprehensive NanoClaw platform documentation in Notion.
 * Creates a parent page and sub-pages with rich block content.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/create-notion-docs.ts
 */
import { HttpsProxyAgent } from "https-proxy-agent";

const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) throw new Error("ONECLI_AGENT_TOKEN required");

const proxyAgent = new HttpsProxyAgent(`http://x:${AGENT_TOKEN}@localhost:10255`);

async function notionFetch(url: string, method: string, body?: unknown): Promise<any> {
  const { default: fetch } = await import("node-fetch");
  const resp = await fetch(url, {
    method,
    agent: proxyAgent,
    headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as any);
  const data = await resp.json();
  if (!resp.ok) console.error("Notion error:", JSON.stringify(data).slice(0, 300));
  return data;
}

function h1(text: string) { return { object: "block", type: "heading_1", heading_1: { rich_text: [{ text: { content: text } }] } }; }
function h2(text: string) { return { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: text } }] } }; }
function h3(text: string) { return { object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: text } }] } }; }
function p(text: string) { return { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text } }] } }; }
function bullet(text: string) { return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: text } }] } }; }
function code(text: string, lang = "plain text") { return { object: "block", type: "code", code: { rich_text: [{ text: { content: text } }], language: lang } }; }
function divider() { return { object: "block", type: "divider", divider: {} }; }
function callout(text: string, icon = "💡") { return { object: "block", type: "callout", callout: { rich_text: [{ text: { content: text } }], icon: { type: "emoji", emoji: icon } } }; }

async function createPage(parentId: string, title: string, icon: string, blocks: any[]): Promise<string> {
  // Notion API limits to 100 blocks per request
  const firstBatch = blocks.slice(0, 100);
  const resp = await notionFetch("https://api.notion.com/v1/pages", "POST", {
    parent: { page_id: parentId },
    icon: { type: "emoji", emoji: icon },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: firstBatch,
  });

  if (!resp.id) { console.error(`Failed to create "${title}":`, resp.message); return ""; }
  console.log(`  Created: ${icon} ${title} (${resp.id.slice(0, 8)})`);

  // Append remaining blocks in batches
  for (let i = 100; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    await notionFetch(`https://api.notion.com/v1/blocks/${resp.id}/children`, "PATCH", { children: batch });
    await new Promise((r) => setTimeout(r, 350));
  }

  await new Promise((r) => setTimeout(r, 350));
  return resp.id;
}

async function main() {
  console.log("Creating NanoClaw Platform Documentation in Notion...\n");

  // Create root documentation page in the database
  const rootResp = await notionFetch("https://api.notion.com/v1/pages", "POST", {
    parent: { database_id: NOTION_DB },
    icon: { type: "emoji", emoji: "🚀" },
    properties: {
      Task: { title: [{ text: { content: "NanoClaw Platform Documentation" } }] },
      Status: { status: { name: "In progress" } },
      Priority: { select: { name: "P1 \u2014 This Week" } },
      Source: { select: { name: "Documentation" } },
      Project: { select: { name: "NanoClaw" } },
    },
    children: [
      h1("NanoClaw Platform Documentation"),
      callout("Comprehensive technical documentation for the NanoClaw Mission Control platform. Last updated: 2026-03-31.", "📋"),
      divider(),
      h2("Quick Reference"),
      bullet("Version: 1.2.25"),
      bullet("Runtime: Node.js 20+ single process"),
      bullet("Database: PostgreSQL 17 + pgvector (primary), SQLite (legacy)"),
      bullet("AI Models: Cisco GREEN approved — Gemma 3 27B, Phi 4 14B, Granite 3.3 8B"),
      bullet("Infrastructure: Mac Mini (orchestrator) + Mac Studio 96GB (Ollama inference)"),
      bullet("Dashboard: Next.js 16 at dashboard.shearer.live"),
      divider(),
      h2("Documentation Pages"),
      p("See sub-pages below for detailed documentation on each component."),
    ],
  });

  if (!rootResp.id) { console.error("Failed to create root page"); return; }
  const rootId = rootResp.id;
  console.log(`Root page: ${rootId}\n`);

  // ═══════════════════════════════════════════
  // 1. System Architecture
  // ═══════════════════════════════════════════
  await createPage(rootId, "System Architecture", "🏗️", [
    h1("System Architecture"),
    callout("NanoClaw is a single Node.js process that orchestrates isolated container-based AI agents, local model inference, and a Next.js dashboard.", "🏗️"),
    divider(),

    h2("High-Level Architecture"),
    code(`
┌─────────────────────────────────────────────────────────┐
│                    Mac Mini (Orchestrator)               │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  NanoClaw    │  │  Dashboard   │  │  Ollama Shim  │  │
│  │  Core        │  │  (Next.js)   │  │  (port 8089)  │  │
│  │  (index.ts)  │  │  (port 3940) │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
│  ┌──────┴─────────────────┴───────────────────┘          │
│  │  PostgreSQL 17 + pgvector (port 5432)                │
│  └──────────────────────────────────────────────────────┘│
│         │                                                │
│  ┌──────┴───────────────────┐                            │
│  │  Docker Containers       │                            │
│  │  (Agent execution)       │                            │
│  └──────────────────────────┘                            │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP
┌────────────────────┴────────────────────────────────────┐
│              Mac Studio 96GB (Inference)                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Ollama 0.18.0 (port 11434)                      │   │
│  │  Models: gemma3:27b, phi4:14b, granite3.3:8b     │   │
│  │          nomic-embed-text (embeddings)            │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
`, "plain text"),

    h2("Core Components"),

    h3("1. NanoClaw Core (src/index.ts)"),
    p("Single Node.js process that initializes all services on startup:"),
    bullet("Channel registry — self-registering message channels (WhatsApp, Telegram, etc.)"),
    bullet("Group queue — prevents concurrent container execution per group"),
    bullet("Task scheduler — cron-based scheduled task execution (polls every 60s)"),
    bullet("Notion sync worker — bidirectional PG ↔ Notion sync (runs every 30s)"),
    bullet("IPC watcher — inter-process communication for container agents"),
    bullet("Ollama shim — Anthropic-to-Ollama translation server"),

    h3("2. Container Runner (src/container-runner.ts)"),
    p("Spawns Claude Agent SDK agents in isolated Docker containers:"),
    bullet("Image: nanoclaw-agent:latest"),
    bullet("Group-specific folders mounted read-write, system paths read-only"),
    bullet("IPC via sentinel markers (---NANOCLAW_OUTPUT_START/END---)"),
    bullet("Timeout: 30 minutes, max output: 10MB"),
    bullet("Max concurrent containers: 5"),

    h3("3. Anthropic-Ollama Shim (src/anthropic-ollama-shim.ts)"),
    p("HTTP server on port 8089 translating Anthropic Messages API to Ollama /api/chat:"),
    bullet("Bidirectional format translation (request + response)"),
    bullet("XML tool call parsing for local models"),
    bullet("Malformed JSON repair layer"),
    bullet("SSE streaming translation"),
    bullet("Claude identity replacement in system prompts"),

    h3("4. Dashboard (dashboard/)"),
    p("Next.js 16 application providing the Mission Control web interface:"),
    bullet("10 views: Today, Week Ahead, Week in Review, Check-in, My Team, Initiatives, People, Topics, System"),
    bullet("PostgreSQL-native queries (replaced Notion API)"),
    bullet("Task chat and initiative chat (Gemma 27B via Ollama)"),
    bullet("Action engine with research workspace"),
    bullet("Triage inbox with RLHF learning"),

    h3("5. OneCLI Proxy"),
    p("All external API calls (Notion, Webex, Plaud, Gmail) route through OneCLI:"),
    bullet("Secret injection at request time — no keys in containers or config files"),
    bullet("Host-pattern matching for automatic token injection"),
    bullet("HTTPS proxy agent on localhost:10255"),

    divider(),
    h2("Data Flow"),
    p("1. Data enters via channels (Webex, Gmail, Plaud, Boox, Calendar) through scheduled pipelines"),
    p("2. Pipeline scripts extract action items using local Ollama models (Gemma 27B)"),
    p("3. Tasks created in PostgreSQL with triage_status='inbox'"),
    p("4. Notion sync worker pushes new tasks to Notion asynchronously"),
    p("5. Dashboard reads from PostgreSQL for all views"),
    p("6. User triages, acts, and tracks via dashboard"),
    p("7. Task chat and initiative chat provide AI-assisted reasoning"),
  ]);

  // ═══════════════════════════════════════════
  // 2. AI Models
  // ═══════════════════════════════════════════
  await createPage(rootId, "AI Models & Routing", "🤖", [
    h1("AI Models & Routing"),
    callout("All local models are Cisco GREEN policy approved (validated 2026-03-30). DeepSeek R1 and Qwen3 replaced.", "✅"),
    divider(),

    h2("Local Models (Ollama on Mac Studio 96GB)"),
    h3("Gemma 3 27B — Primary Analysis Model"),
    bullet("Vendor: Google (Cisco GREEN approved)"),
    bullet("Size: 16.2 GB on disk"),
    bullet("Role: Message analysis, transcript extraction, task generation, chat reasoning"),
    bullet("Used by: Webex messages, Webex transcripts, Gmail, Plaud, Boox, task chat, initiative chat"),
    bullet("Requires JSON enforcement suffix for structured output tasks"),
    bullet("A/B tested: 5/5 pass rate, avg 9s latency"),

    h3("Phi 4 14B — Synthesis Model"),
    bullet("Vendor: Microsoft (Cisco GREEN approved)"),
    bullet("Size: 8.4 GB on disk"),
    bullet("Role: Triage suggestions, merge synthesis, shim default for container agents"),
    bullet("Used by: Triage inbox, /api/synthesize, default shim model"),
    bullet("A/B tested: 5/5 pass rate, avg 7s latency"),

    h3("Granite 3.3 8B — Fast Lightweight Model"),
    bullet("Vendor: IBM (Cisco GREEN approved)"),
    bullet("Size: 4.6 GB on disk"),
    bullet("Role: Calendar analysis, fast classification tasks"),
    bullet("Used by: Calendar sync pipeline"),
    bullet("A/B tested: 5/5 pass rate, avg 5s latency (fastest)"),

    h3("nomic-embed-text — Embedding Model"),
    bullet("Vendor: Nomic AI (137M params, F16)"),
    bullet("Dimensions: 768, context: 2048 tokens"),
    bullet("Role: Text embedding for vector search (semantic RAG)"),
    bullet("Not listed in Cisco policy (non-generative, under review)"),
    bullet("HuggingFace: https://huggingface.co/nomic-ai/nomic-embed-text-v1"),

    divider(),
    h2("Cloud Models (Anthropic API)"),
    bullet("Claude Sonnet 4 — Default for container agent tasks"),
    bullet("Claude Haiku 4.5 — Action suggestions, lightweight API tasks"),
    bullet("Claude Opus 4.6 — Research briefs (via dashboard action engine)"),

    divider(),
    h2("Model Routing Architecture"),
    code(`
Pipeline Scripts → Ollama Direct (gemma3:27b / granite3.3:8b)
Dashboard APIs  → Ollama Direct (gemma3:27b for chat, phi4:14b for synthesis)
Container Agents → Shim (port 8089) → Ollama (phi4:14b default)
                   OR → Anthropic API (Claude Sonnet/Opus/Haiku)
`, "plain text"),
    p("Per-group model selection via groups/*/model.json. Groups without model.json default to Anthropic API."),

    divider(),
    h2("Prompt Tuning Notes"),
    bullet("Gemma 3 27B requires explicit JSON enforcement in system prompts for structured output"),
    bullet("Gemma task titles need who/what/context steering with good/bad examples"),
    bullet("Boox OCR prompts need anti-echo instructions (Gemma echoes example placeholders)"),
    bullet("All local model prompts should avoid markdown formatting instructions"),
    bullet("Chat prompts instruct: plain text only, no markdown headers/bold, under 300 words"),
  ]);

  // ═══════════════════════════════════════════
  // 3. Data Pipelines
  // ═══════════════════════════════════════════
  await createPage(rootId, "Data Pipelines", "🔄", [
    h1("Data Pipelines"),
    callout("11 scheduled pipelines process data from 6 sources. All run via cron in the task scheduler.", "🔄"),
    divider(),

    h2("Pipeline Overview"),
    code(`
Pipeline              Model              Schedule                    Purpose
─────────────────────────────────────────────────────────────────────────────
mc-webex-messages     gemma3:27b         :47 past, 9am-6pm M-F     Scan DMs & @mentions
mc-webex-transcripts  gemma3:27b         :07 past, 9am-6pm M-F     Extract action items from recordings
mc-gmail-local        gemma3:27b         9:42am M-F                 Process inbox emails
mc-plaud-processor    gemma3:27b         :23 past, every 2hr M-F   Process NotePin recordings
mc-boox-processor     gemma3:27b         :37 past, 9am-6pm M-F     OCR handwritten notes
mc-calendar-sync      granite3.3:8b      6am, noon, 6pm M-F        Calendar conflicts & prep
mc-morning-briefing   Claude (container)  7:03am daily              Daily standup briefing
mc-meeting-prep       Claude (container)  6:00am M-F               Meeting prep briefs
mc-research-queue     Claude (container)  every 4hr                 Process research/draft queue
mc-weekly-checkin     Claude (container)  6:30am Mondays            Weekly check-in report
mc-weekly-review      Claude (container)  4:07pm Fridays            Week in review
`, "plain text"),

    h2("Local Pipeline Architecture"),
    p("The 6 local pipelines (scripts/process-*-local.ts) follow an identical pattern:"),
    bullet("1. Fetch new data from source API (via OneCLI proxy for auth)"),
    bullet("2. Filter noise (newsletters, automated notifications, already-processed items)"),
    bullet("3. Send to Ollama for analysis (JSON lines output format)"),
    bullet("4. Apply corrections glossary (store/corrections.json)"),
    bullet("5. Deduplicate via scripts/lib/task-dedup.ts (PG-native)"),
    bullet("6. Create tasks in PostgreSQL (notion_sync_status='pending')"),
    bullet("7. Archive original content to PG archive_items table"),
    bullet("8. Log run result to task_run_logs"),

    h3("Corrections Glossary"),
    p("Transcription correction system that fixes common errors (e.g., Bossa → Voss):"),
    bullet("Stored in store/corrections.json AND PG corrections table"),
    bullet("Safety: rejects corrections where either word is a stop word (or/and/to/with/etc.)"),
    bullet("Safety: rejects corrections where either word <= 3 characters"),
    bullet("Learning: /api/corrections PATCH endpoint learns from manual title edits"),

    h3("Task Deduplication (scripts/lib/task-dedup.ts)"),
    p("Prevents duplicate tasks across pipelines:"),
    bullet("Scores new tasks against recent open tasks in PG"),
    bullet("Title similarity via word overlap scoring"),
    bullet("If match found: creates corroboration record instead of duplicate"),
    bullet("New tasks created with triage_status='inbox', notion_sync_status='pending'"),

    divider(),
    h2("Container Pipeline Architecture"),
    p("The 5 container pipelines run full Claude agents with tool access:"),
    bullet("Spawned in Docker containers with group-specific mounts"),
    bullet("Can use Notion API, Webex API, bash tools via Claude Agent SDK"),
    bullet("Output captured via IPC sentinels"),
    bullet("Morning briefing creates rich Notion pages (synced to PG via inbound sync)"),

    divider(),
    h2("Data Sources"),
    h3("Webex (Messages + Transcripts)"),
    bullet("OAuth via OneCLI proxy — auto-injected bearer tokens"),
    bullet("Messages: scans DM rooms + group @mentions"),
    bullet("Transcripts: downloads VTT from recordings, extracts action items"),

    h3("Gmail"),
    bullet("Google OAuth tokens stored in store/google-oauth.json"),
    bullet("Filters: no newsletters, marketing, order confirmations, password resets"),

    h3("Plaud NotePin"),
    bullet("API: api.plaud.ai via OneCLI proxy"),
    bullet("Folder-to-project mapping for automatic project assignment"),
    bullet("Pre-transcribed text analyzed for action items"),

    h3("Boox NoteAir2P"),
    bullet("Nextcloud WebDAV → Gemma vision OCR"),
    bullet("Jason's notation: boxed text = action item, circled = P1"),
    bullet("Quality gate filters prompt leaks and generic headings"),

    h3("Google Calendar"),
    bullet("Personal + family calendars, next 7 days"),
    bullet("Conflict detection and prep item identification"),
  ]);

  // ═══════════════════════════════════════════
  // 4. Database Architecture
  // ═══════════════════════════════════════════
  await createPage(rootId, "Database Architecture", "🗄️", [
    h1("Database Architecture"),
    callout("PostgreSQL 17 + pgvector 0.8.2 is the system of record. 40 tables, ~5,000 records.", "🗄️"),
    divider(),

    h2("Connection"),
    code("postgresql://nanoclaw@localhost:5432/nanoclaw", "plain text"),
    bullet("Main process: src/pg.ts (connection pool, max 5)"),
    bullet("Dashboard: dashboard/src/lib/pg.ts (separate pool)"),
    bullet("Pipeline scripts: scripts/lib/task-dedup.ts (shared pool, max 3)"),

    h2("Core Tables"),
    h3("tasks (1,363 records)"),
    p("Central task table — every action item from every source."),
    bullet("id UUID PRIMARY KEY"),
    bullet("title, priority, status, source, project, context, zone"),
    bullet("delegated_to, energy, due_date, notes"),
    bullet("notion_page_id — link to Notion page (for block content)"),
    bullet("notion_sync_status — 'pending' | 'synced' | 'error'"),
    bullet("triage_status — 'inbox' | 'accepted' | 'dismissed'"),
    bullet("created_at, updated_at"),

    h3("people (254 records)"),
    p("Person index built from Webex contacts, meeting participants, manual additions."),
    bullet("id UUID, key TEXT (slug), name TEXT"),
    bullet("company, job_title, avatar, linkedin_url"),
    bullet("Related: person_emails, person_webex_rooms"),

    h3("vector_chunks (3,182 records)"),
    p("Semantic search index for RAG — text chunks from transcripts, messages, people profiles."),
    bullet("id TEXT, source TEXT, text TEXT, metadata JSONB"),
    bullet("embedding vector(768) — populated by nomic-embed-text"),

    h3("archive_items (236 records)"),
    p("Original source content preserved for provenance."),
    bullet("id TEXT, source_type TEXT (plaud/transcripts/messages/emails/summaries)"),
    bullet("title, date, content (full text), metadata JSONB"),
    bullet("Used by 'View Source' in task detail"),

    divider(),
    h2("Initiative Tables"),
    bullet("initiatives — slug PK, name, description, status, target_date, keywords[]"),
    bullet("initiative_phases — phases with sort_order, start/end dates"),
    bullet("initiative_pinned_tasks — task-to-initiative mapping with phase_id"),
    bullet("initiative_pinned_people — person-to-initiative mapping"),

    h2("Chat Tables"),
    bullet("task_chat_messages — per-task LLM chat history (role: user/assistant)"),
    bullet("initiative_chat_messages — per-initiative LLM chat history"),

    h2("Sync Tables"),
    bullet("notion_sync_log — audit trail of PG ↔ Notion sync operations"),
    bullet("scheduled_tasks — pipeline definitions with cron schedules"),
    bullet("task_run_logs — execution history per pipeline run"),

    h2("Meeting & Calendar"),
    bullet("meetings, meeting_participants — Webex meeting records"),
    bullet("calendar_events — Google Calendar events"),
    bullet("ai_summaries — AI-generated meeting summaries"),
    bullet("transcript_mentions — people mentioned in transcripts"),

    divider(),
    h2("Notion Sync Architecture"),
    p("Bidirectional sync running every 30 seconds:"),
    bullet("Outbound: PG tasks with notion_sync_status='pending' → create/update Notion pages"),
    bullet("Inbound: Query Notion for pages created in last 24h not in PG → import"),
    bullet("Agent-created pages (briefings, meeting prep) are imported via inbound sync"),
    bullet("Rate limited at 350ms between Notion API calls"),
  ]);

  // ═══════════════════════════════════════════
  // 5. OneCLI & Proxy Architecture
  // ═══════════════════════════════════════════
  await createPage(rootId, "OneCLI & Proxy Architecture", "🔐", [
    h1("OneCLI & Proxy Architecture"),
    callout("OneCLI is the secrets manager and API proxy. No API keys or tokens are ever stored in code, config files, or passed to containers.", "🔐"),
    divider(),

    h2("How It Works"),
    p("OneCLI runs as a local HTTPS proxy (localhost:10255) that intercepts outbound API requests and injects authentication:"),
    bullet("1. Pipeline scripts configure HttpsProxyAgent pointing to localhost:10255"),
    bullet("2. OneCLI matches the target hostname against stored host patterns"),
    bullet("3. If matched, injects the appropriate bearer token or API key"),
    bullet("4. Request forwards to the actual API with credentials injected"),
    bullet("5. No credentials ever touch the application code or containers"),

    h2("Proxy Configuration"),
    code(`
const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
const proxyAgent = new HttpsProxyAgent(
  \`http://x:\${AGENT_TOKEN}@localhost:10255\`
);

// Then use proxyAgent in fetch calls:
const resp = await fetch("https://api.notion.com/v1/...", {
  agent: proxyAgent,
  headers: { "Notion-Version": "2022-06-28" },
});
`, "typescript"),

    h2("Proxied Services"),
    bullet("Notion API (api.notion.com) — database queries, page creation, block content"),
    bullet("Webex API (webexapis.com) — messages, meetings, recordings, transcripts"),
    bullet("Plaud API (api.plaud.ai) — recording list, transcripts, AI summaries"),
    bullet("Gmail API (gmail.googleapis.com) — inbox messages, thread reading"),
    bullet("Google Calendar API (googleapis.com/calendar) — event listing"),
    bullet("Cloudflare API — DNS certificate management"),

    h2("Dashboard Proxy (dashboard/src/lib/onecli.ts)"),
    p("The Next.js dashboard uses the same OneCLI proxy pattern for server-side API calls:"),
    bullet("proxiedFetch() wrapper function handles agent setup"),
    bullet("Used by: /api/notion/blocks, /api/webex/meetings, /api/webex/invitees"),

    h2("Security Model"),
    bullet("ONECLI_AGENT_TOKEN is the only secret in the environment"),
    bullet("All other API keys are managed within OneCLI's encrypted store"),
    bullet("Container agents never receive API keys — they use the proxy"),
    bullet("Token rotation happens in OneCLI, not in application code"),
  ]);

  // ═══════════════════════════════════════════
  // 6. Dashboard Features
  // ═══════════════════════════════════════════
  await createPage(rootId, "Dashboard Features", "📊", [
    h1("Dashboard Features"),
    callout("Next.js 16 dashboard at dashboard.shearer.live. All data from PostgreSQL. LLM features via Gemma 27B.", "📊"),
    divider(),

    h2("Views"),
    h3("Today"),
    bullet("Daily briefing (agent-generated, Notion blocks rendered)"),
    bullet("Triage inbox with AI suggestions (RLHF learning)"),
    bullet("Action items sorted by priority with infinite scroll"),
    bullet("Today's calendar (Webex + Google Calendar merged, conflict detection)"),

    h3("Week Ahead"),
    bullet("P0 and P1 tasks for the upcoming week"),
    bullet("Meeting prep artifacts surfaced"),

    h3("Week in Review"),
    bullet("Completed tasks from the past week"),
    bullet("Open P0/P1 tasks still pending"),

    h3("Check-in"),
    bullet("Weekly self-assessment with strengths, outstanding value, manager connect"),
    bullet("Meeting engagement: loved/loathed ratings"),
    bullet("Evidence sourced from PG task and meeting data"),

    h3("My Team"),
    bullet("Team roster with delegated, tagged, and mentioned task tiers"),
    bullet("Artifact count per member"),
    bullet("Member detail with task breakdown"),

    h3("Initiatives"),
    bullet("Phase bar with progress tracking per phase"),
    bullet("Target dates, inline task completion"),
    bullet("Plan & artifacts section (artifact content rendered directly)"),
    bullet("People strip with Webex deep links"),
    bullet("Initiative chat (Gemma 27B with full context)"),

    h3("People"),
    bullet("CRM view of all contacts (254 people)"),
    bullet("Enrichment tools (LinkedIn, Webex lookup)"),
    bullet("Message history, meeting overlap, task correlation"),

    h3("Topics"),
    bullet("Auto-detected topic clusters from meetings and tasks"),
    bullet("Topic-to-people and topic-to-task relationships"),

    h3("System"),
    bullet("Interactive SVG digital twin of platform architecture"),
    bullet("Pipeline status with expandable run history"),
    bullet("PostgreSQL health metrics"),
    bullet("Data index sizes and last-built timestamps"),

    divider(),
    h2("Key Dashboard Features"),
    h3("Task Chat"),
    p("Embedded Gemma 27B chat in every task detail modal. Context includes:"),
    bullet("Task title, priority, status, notes, people"),
    bullet("Source archive content (transcripts, messages)"),
    bullet("Linked artifacts"),
    bullet("Related conversations from vector search"),
    bullet("Full conversation history for multi-turn reasoning"),
    bullet("Save as Note or Save as Artifact with one click"),

    h3("Action Engine"),
    p("Suggested actions for each task:"),
    bullet("Research & Enrich — gather context, upload docs, generate briefs"),
    bullet("Document drafts — org announcements, emails"),
    bullet("Webex messages — with verified email deep links"),
    bullet("Sub-task creation"),
    bullet("Person index for context-aware suggestions"),

    h3("Triage Inbox"),
    p("Preprocessing queue for new tasks:"),
    bullet("AI suggestions (accept/delegate/dismiss) from Phi 4 14B"),
    bullet("RLHF decision logging for learning"),
    bullet("Clickable titles for inline review"),
    bullet("Done button for quick dismissal"),
  ]);

  // ═══════════════════════════════════════════
  // 7. Infrastructure & Operations
  // ═══════════════════════════════════════════
  await createPage(rootId, "Infrastructure & Operations", "⚙️", [
    h1("Infrastructure & Operations"),
    divider(),

    h2("Hardware"),
    bullet("Mac Mini M2 — NanoClaw orchestrator, PostgreSQL, Docker, Nginx"),
    bullet("Mac Studio M2 Ultra 96GB — Ollama inference server (studio.shearer.live)"),

    h2("Services (launchd)"),
    code(`
# NanoClaw core
~/Library/LaunchAgents/com.nanoclaw.plist
  → /opt/homebrew/bin/node dist/index.js

# Dashboard
~/Library/LaunchAgents/com.nanoclaw.dashboard.plist
  → next dev -H 127.0.0.1 -p 3940

# Service management
launchctl kickstart -k gui/$(id -u)/com.nanoclaw       # restart core
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard  # restart dashboard
`, "bash"),

    h2("Nginx"),
    p("Reverse proxy for dashboard.shearer.live (LAN access):"),
    bullet("TLS with Let's Encrypt certs via Cloudflare DNS"),
    bullet("Proxies to localhost:3940 (Next.js dashboard)"),
    bullet("client_max_body_size 50m (for document uploads)"),

    h2("Logs"),
    bullet("NanoClaw core: logs/nanoclaw.log, logs/nanoclaw.error.log"),
    bullet("Dashboard: logs/dashboard.log, logs/dashboard.error.log"),
    bullet("Pipeline runs: task_run_logs table in PostgreSQL"),
    bullet("Notion sync: notion_sync_log table in PostgreSQL"),

    h2("Key Commands"),
    code(`
npm run dev          # Development mode with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container image

# Database
psql postgresql://nanoclaw@localhost:5432/nanoclaw

# Ollama
curl http://studio.shearer.live:11434/api/tags   # list models
curl http://studio.shearer.live:11434/api/ps      # loaded models
`, "bash"),

    h2("Monitoring"),
    bullet("Dashboard System tab: real-time health checks for PG, Ollama, Nginx, Notion sync"),
    bullet("Digital twin SVG with animated data flow visualization"),
    bullet("Pipeline run history with expandable output logs"),
    bullet("Automatic pipeline status detection (running/success/error)"),
  ]);

  console.log("\nDone! All documentation pages created under the root page.");
  console.log(`Root page ID: ${rootId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
