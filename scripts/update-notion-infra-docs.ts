/**
 * Update Notion Infrastructure & Operations page with store cleanup info.
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
function h3(text: string) { return { object: "block", type: "heading_3", heading_3: { rich_text: [{ text: { content: text } }] } }; }
function p(text: string) { return { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text } }] } }; }
function bullet(text: string) { return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: text } }] } }; }
function divider() { return { object: "block", type: "divider", divider: {} }; }

async function main() {
  // Find the Infrastructure page
  const search = await notionFetch("https://api.notion.com/v1/search", "POST", {
    query: "Infrastructure & Operations", page_size: 5,
  });
  const page = (search.results || []).find((r: any) =>
    (r.properties?.title?.title?.[0]?.text?.content || "").includes("Infrastructure")
  );
  if (!page) { console.error("Page not found"); return; }
  console.log(`Found: ${page.id}`);

  // Append new section (don't clear — just add at the end)
  const blocks = [
    divider(),
    h2("Store Directory (updated 2026-04-01)"),
    p("The store/ directory contains pipeline state, credentials, and the SQLite message bus. Legacy JSON files migrated to PG have been archived."),

    h3("Active Files"),
    bullet("messages.db — SQLite message bus (NanoClaw's native DB)"),
    bullet("corrections.json — transcription correction glossary (read by all 6 pipelines)"),
    bullet("*-local-state.json (5 files) — pipeline cursor/checkpoint state"),
    bullet("plaud-summaries.json — Plaud AI summary cache"),
    bullet("webex-summaries.json + webex-summaries-state.json — transcript summary cache"),
    bullet("google-calendar-events.json — calendar data for briefing agent"),
    bullet("google-oauth.json — Google OAuth tokens (CREDENTIAL)"),
    bullet("webex-oauth.json — Webex OAuth tokens (CREDENTIAL)"),
    bullet("auth.json — dashboard authentication (CREDENTIAL)"),

    h3("Archived (store/archive-legacy/)"),
    p("Migrated to PostgreSQL. Kept as backup, not actively read or written."),
    bullet("person-index.json (554K) → people table"),
    bullet("topic-index.json (1.2M) → topics table"),
    bullet("initiatives.json → initiatives table"),
    bullet("triage-accepted.json + triage-decisions.json → triage_decisions table"),
    bullet("relevance-scores.json → relevance_scores table"),
    bullet("team.json → team_members table"),
    bullet("vectors.db (17MB) → vector_chunks table in PG + pgvector"),

    divider(),
    h2("Optimization History (2026-04-01)"),
    bullet("Consolidated two Ollama instances → single Mac Studio instance (4 models, 31.7GB)"),
    bullet("Removed 9 stale models from Mac Studio (~121GB reclaimed)"),
    bullet("DATA_BACKEND set to 'dual' — SQLite = message bus, PG = application DB"),
    bullet("Archived 7 legacy JSON files + vectors.db to store/archive-legacy/"),
    bullet("Stopped local Ollama on Mac Mini (brew services stop ollama)"),
    bullet("Removed Ollama Shim from service topology (dead code, never used in production)"),
  ];

  await notionFetch(`https://api.notion.com/v1/blocks/${page.id}/children`, "PATCH", { children: blocks });
  console.log("Updated Infrastructure & Operations page");
}

main().catch(console.error);
