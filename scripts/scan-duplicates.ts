/**
 * One-time scan of all open Notion tasks to find duplicates.
 * Usage: NODE_EXTRA_CA_CERTS=<onecli-ca> npx tsx scripts/scan-duplicates.ts
 */
import { HttpsProxyAgent } from "https-proxy-agent";
import { titleSimilarity } from "./lib/task-dedup.js";

const AGENT_TOKEN = "aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a";
const proxyAgent = new HttpsProxyAgent(`http://x:${AGENT_TOKEN}@localhost:10255`);
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

async function notionPost(endpoint: string, body: unknown): Promise<unknown> {
  const nodeFetch = (await import("node-fetch")).default;
  const resp = await nodeFetch(`https://api.notion.com/v1${endpoint}`, {
    method: "POST",
    agent: proxyAgent,
    headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    body: JSON.stringify(body),
  } as any);
  return resp.json();
}

async function main() {
  // Fetch all open tasks (paginated)
  let allTasks: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const body: any = {
      filter: { property: "Status", status: { does_not_equal: "Done" } },
      sorts: [{ property: "Priority", direction: "ascending" }],
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const data = (await notionPost(`/databases/${NOTION_DB}/query`, body)) as any;
    allTasks.push(...(data.results || []));
    console.log(`  Fetched page ${page + 1}: ${data.results?.length || 0} tasks (total: ${allTasks.length})`);
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  console.log(`\nTotal open tasks: ${allTasks.length}\n`);

  // Extract title and metadata
  const tasks = allTasks.map((t: any) => ({
    id: t.id,
    title: t.properties?.Task?.title?.map((x: any) => x.plain_text).join("") || "",
    source: t.properties?.Source?.select?.name || "",
    project: t.properties?.Project?.select?.name || "",
    priority: t.properties?.Priority?.select?.name || "",
    url: t.url,
  }));

  // Find duplicate pairs
  const dupes: { a: typeof tasks[0]; b: typeof tasks[0]; titleScore: number; totalScore: number }[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const titleScore = titleSimilarity(tasks[i].title, tasks[j].title);
      if (titleScore < 0.30) continue;

      let totalScore = titleScore;
      if (tasks[i].project && tasks[i].project === tasks[j].project) totalScore += 0.1;

      if (totalScore >= 0.45) {
        dupes.push({ a: tasks[i], b: tasks[j], titleScore, totalScore });
      }
    }
  }

  // Sort by score descending
  dupes.sort((x, y) => y.totalScore - x.totalScore);

  console.log(`Duplicate pairs found: ${dupes.length}\n`);
  console.log(`${"Score".padEnd(6)} | ${"Source A".padEnd(25)} | ${"Task A"}`);
  console.log(`${"".padEnd(6)} | ${"Source B".padEnd(25)} | ${"Task B"}`);
  console.log("-".repeat(100));

  for (const d of dupes) {
    const action = d.totalScore >= 0.8 ? "SKIP" : d.totalScore >= 0.5 ? "MERGE" : "REVIEW";
    console.log(`${d.totalScore.toFixed(2).padEnd(6)} | ${d.a.source.slice(0, 25).padEnd(25)} | ${d.a.title.slice(0, 65)}`);
    console.log(`${action.padEnd(6)} | ${d.b.source.slice(0, 25).padEnd(25)} | ${d.b.title.slice(0, 65)}`);
    console.log("");
  }

  // Summary
  const merges = dupes.filter(d => d.totalScore >= 0.5 && d.totalScore < 0.8).length;
  const skips = dupes.filter(d => d.totalScore >= 0.8).length;
  const reviews = dupes.filter(d => d.totalScore < 0.5).length;
  console.log(`\nSummary: ${skips} exact dupes, ${merges} merge candidates, ${reviews} review needed`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
