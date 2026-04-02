/**
 * Test Google API access through OneCLI proxy.
 */
import { HttpsProxyAgent } from "https-proxy-agent";

const AGENT_TOKEN = process.env.ONECLI_AGENT_TOKEN;
if (!AGENT_TOKEN) throw new Error("ONECLI_AGENT_TOKEN required");
const proxyAgent = new HttpsProxyAgent(`http://x:${AGENT_TOKEN}@localhost:10255`);

async function main() {
  const { default: fetch } = await import("node-fetch");

  console.log("=== Gmail via OneCLI ===");
  const gmail = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    agent: proxyAgent,
  } as any);
  const gd = await gmail.json() as any;
  console.log(`Status: ${gmail.status}, Email: ${gd.emailAddress || gd.error?.message || "?"}`);

  console.log("\n=== Calendar via OneCLI ===");
  const cal = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=3", {
    agent: proxyAgent,
  } as any);
  const cd = await cal.json() as any;
  console.log(`Status: ${cal.status}, Calendars: ${(cd.items || []).length}`);
  for (const item of (cd.items || []).slice(0, 3)) {
    console.log(`  - ${item.summary}`);
  }
}

main().catch(console.error);
