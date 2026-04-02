import { HttpsProxyAgent } from "https-proxy-agent";

const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) throw new Error("ONECLI_AGENT_TOKEN required");
const agent = new HttpsProxyAgent(`http://x:${AGENT_TOKEN}@localhost:10255`);

async function main() {
  const { default: fetch } = await import("node-fetch");
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    agent: agent as any,
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", messages: [{ role: "user", content: "say ok" }], max_tokens: 5 }),
  });
  console.log("Status:", resp.status);
  const d = await resp.json() as any;
  console.log("Output:", d.content?.[0]?.text || JSON.stringify(d).slice(0, 200));
}
main();
