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
  const search = await notionFetch("https://api.notion.com/v1/search", "POST", {
    query: "Infrastructure", page_size: 10,
  });
  // Find by checking both title formats (sub-page vs database entry)
  const page = (search.results || []).find((r: any) => {
    const t1 = r.properties?.title?.title?.[0]?.text?.content || "";
    const t2 = r.properties?.Task?.title?.[0]?.text?.content || "";
    return t1.includes("Infrastructure") || t2.includes("Infrastructure");
  });
  if (!page) { console.error("Page not found in search results"); return; }
  console.log(`Found: ${page.id}`);

  const blocks = [
    divider(),
    h2("Network Architecture: Single Front Door"),
    callout("Nginx is the ONLY entry point. All backend services are localhost-bound. No direct LAN or WAN access to any service except through Nginx :443.", "🔒"),

    code(`
Internet / LAN
      │
      ▼
┌──────────────────────────────────┐
│  Nginx :443 (LAN-accessible)    │  ← ONLY entry point
│  TLS termination + reverse proxy│
│  HSTS, X-Frame-Options, CORS   │
│  Auth: HMAC session + TOTP      │
└──────────┬───────────────────────┘
           │ HTTP (internal only)
           ▼
┌──────────────────────────────────┐
│  All services bound to 127.0.0.1│
│                                  │
│  Dashboard      :3940  (lo)     │
│  NanoClaw Core  :3939  (lo)     │
│  PostgreSQL     :5432  (lo)     │
│  OneCLI Proxy   :10255 (lo)     │
│  OneCLI API     :10254 (lo)     │
│  Nginx stub     :8080  (lo)     │
└──────────────────────────────────┘

Ollama Studio :11434 — LAN-accessible (no auth, Mac Studio)
  Not exposed to WAN (no port forwarding)
`, "plain text"),

    h2("Port Binding Matrix (verified 2026-04-01)"),
    bullet("Nginx :443, :80 — *:443/*:80 (all interfaces) — LAN-accessible, sole entry point"),
    bullet("Dashboard :3940 — 127.0.0.1 only — behind Nginx"),
    bullet("NanoClaw Core :3939 — 127.0.0.1 only — behind Nginx"),
    bullet("PostgreSQL :5432 — ::1 only — localhost connections"),
    bullet("OneCLI Proxy :10255 — 127.0.0.1 only — Docker internal"),
    bullet("OneCLI API :10254 — 127.0.0.1 only — Docker internal"),
    bullet("Nginx stub_status :8080 — 127.0.0.1 only — monitoring"),
    bullet("Ollama Studio :11434 — studio.shearer.live (LAN) — no auth, no WAN exposure"),
    p("WAN verification: public IP :443 returns UDM Pro console, not NanoClaw. Router does not port-forward to Mac Mini."),
  ];

  await notionFetch(`https://api.notion.com/v1/blocks/${page.id}/children`, "PATCH", { children: blocks });
  console.log("Updated with network architecture");
}

main().catch(console.error);
