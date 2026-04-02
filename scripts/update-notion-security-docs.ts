/**
 * Append security audit findings to Infrastructure & Operations page.
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
  const search = await notionFetch("https://api.notion.com/v1/search", "POST", {
    query: "Infrastructure & Operations", page_size: 5,
  });
  const page = (search.results || []).find((r: any) =>
    (r.properties?.title?.title?.[0]?.text?.content || "").includes("Infrastructure")
  );
  if (!page) { console.error("Page not found"); return; }

  const blocks = [
    divider(),
    h2("Security Audit (2026-04-01)"),

    h3("Network Exposure"),
    bullet("Nginx listens on *:443 and *:80 (all interfaces) — required for LAN access"),
    bullet("Public IP (136.239.28.142) returns UDM Pro console, NOT NanoClaw — router does not port-forward 443"),
    bullet("Dashboard is LAN-only accessible (192.168.x.x network)"),
    bullet("TLS: Let's Encrypt cert valid until 2026-06-27, auto-renewed via certbot + Cloudflare DNS"),
    bullet("Security headers: HSTS, X-Frame-Options DENY, nosniff, strict CORS"),

    h3("Container Security"),
    bullet("nanoclaw-agent:latest — 2.43GB (1.09GB Chromium + deps, 370MB Node/npm, 1MB app code)"),
    bullet("Size is justified by browser automation (Claude Agent SDK uses headless Chromium)"),
    bullet("Containers are ephemeral — spawned per-task, destroyed after completion"),
    bullet("Only OneCLI containers run persistently (onecli-app-1 + onecli-postgres-1)"),
    bullet("Agent containers have read-only system mounts, read-write group folder only"),

    h3("Credential Management"),
    bullet("All API credentials managed by OneCLI — never in code, config files, or containers"),
    bullet("ONECLI_AGENT_TOKEN is the only secret in the environment"),
    bullet("OAuth tokens (Google, Webex) stored in store/ with restricted file permissions (600)"),
    bullet("Dashboard auth uses HMAC session cookies with expiry"),

    h3("Model Security"),
    bullet("All inference models are Cisco GREEN approved (audited 2026-03-30)"),
    bullet("Ollama runs on LAN (studio.shearer.live:11434) — no authentication, no WAN exposure"),
    bullet("Container agents access Anthropic API only through OneCLI proxy (credential injection)"),
  ];

  await notionFetch(`https://api.notion.com/v1/blocks/${page.id}/children`, "PATCH", { children: blocks });
  console.log("Updated with security audit findings");
}

main().catch(console.error);
