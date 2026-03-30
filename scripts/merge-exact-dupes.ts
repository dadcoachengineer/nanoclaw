/**
 * One-time script to merge exact duplicate tasks (score >= 0.8).
 * Keeps the higher-priority task, marks the other as Done.
 */
import { HttpsProxyAgent } from "https-proxy-agent";
import { titleSimilarity } from "./lib/task-dedup.js";

const token = process.env.ONECLI_AGENT_TOKEN;
if (!token) throw new Error("ONECLI_AGENT_TOKEN required");

const proxy = new HttpsProxyAgent(`http://x:${token}@localhost:10255`);
const DB = "5b4e1d2d7259496ea237ef0525c3ce78";

async function notionPost(ep: string, body: unknown) {
  const nf = (await import("node-fetch")).default;
  const r = await nf(`https://api.notion.com/v1${ep}`, {
    method: "POST", agent: proxy,
    headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    body: JSON.stringify(body),
  } as any);
  return r.json();
}

async function notionPatch(id: string, body: unknown) {
  const nf = (await import("node-fetch")).default;
  await nf(`https://api.notion.com/v1/pages/${id}`, {
    method: "PATCH", agent: proxy,
    headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    body: JSON.stringify(body),
  } as any);
}

async function main() {
  let all: any[] = [], cursor: string | undefined;
  for (let p = 0; p < 10; p++) {
    const body: any = { filter: { property: "Status", status: { does_not_equal: "Done" } }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const d = (await notionPost(`/databases/${DB}/query`, body)) as any;
    all.push(...(d.results || []));
    console.log(`  Page ${p + 1}: ${d.results?.length || 0} (total: ${all.length})`);
    if (!d.has_more) break;
    cursor = d.next_cursor;
  }

  const tasks = all.map((t: any) => ({
    id: t.id,
    title: t.properties?.Task?.title?.map((x: any) => x.plain_text).join("") || "",
    source: t.properties?.Source?.select?.name || "",
    priority: t.properties?.Priority?.select?.name || "",
    project: t.properties?.Project?.select?.name || "",
  }));

  console.log(`\nScanning ${tasks.length} open tasks for exact dupes...\n`);

  let merged = 0;
  const removed = new Set<string>();

  for (let i = 0; i < tasks.length; i++) {
    if (removed.has(tasks[i].id)) continue;
    for (let j = i + 1; j < tasks.length; j++) {
      if (removed.has(tasks[j].id)) continue;
      let score = titleSimilarity(tasks[i].title, tasks[j].title);
      if (tasks[i].project === tasks[j].project && tasks[i].project) score += 0.1;
      if (score >= 0.8) {
        const aRank = parseInt((tasks[i].priority.match(/P(\d)/) || ["", "3"])[1]);
        const bRank = parseInt((tasks[j].priority.match(/P(\d)/) || ["", "3"])[1]);
        const removeIdx = aRank <= bRank ? j : i;
        try {
          await notionPatch(tasks[removeIdx].id, {
            properties: { Status: { status: { name: "Done" } } },
          });
          removed.add(tasks[removeIdx].id);
          merged++;
          if (merged % 20 === 0) console.log(`  Merged ${merged}...`);
        } catch (err) {
          console.error(`  Error merging ${tasks[removeIdx].id}: ${err}`);
        }
      }
    }
  }

  console.log(`\nDone. Merged ${merged} exact duplicates.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
