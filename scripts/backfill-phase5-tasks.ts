/**
 * Phase 5: Backfill all Notion tasks to PostgreSQL tasks table.
 * Preserves Notion page IDs as primary keys for bidirectional sync.
 * Idempotent — safe to run multiple times.
 */
import pg from "pg";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

// OneCLI proxy for Notion API
const ONECLI_TOKEN = process.env.ONECLI_AGENT_TOKEN || "aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a";
const CA_PATH = path.join(process.cwd(), "certs", "onecli-ca.pem");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

async function notionQuery(body: any): Promise<any> {
  const { default: fetch } = await import("node-fetch");
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  const agent = new HttpsProxyAgent(`http://x:${ONECLI_TOKEN}@localhost:10255`);

  const resp = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB}/query`, {
    method: "POST",
    agent,
    headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    body: JSON.stringify(body),
  } as any);
  return resp.json();
}

function extractProp(page: any, name: string): string {
  const prop = page.properties?.[name];
  if (!prop) return "";
  if (prop.title) return prop.title.map((t: any) => t.plain_text).join("");
  if (prop.rich_text) return prop.rich_text.map((t: any) => t.plain_text).join("");
  if (prop.select) return prop.select?.name || "";
  if (prop.status) return prop.status?.name || "";
  if (prop.date) return prop.date?.start || "";
  return "";
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  console.log("Phase 5: Backfilling Notion tasks → PostgreSQL\n");

  // Load triage accepted list
  let acceptedSet = new Set<string>();
  try {
    const accepted = JSON.parse(fs.readFileSync(path.join(STORE_DIR, "triage-accepted.json"), "utf-8"));
    acceptedSet = new Set(accepted);
  } catch {}

  // Paginate through ALL Notion tasks (including Done)
  let allPages: any[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < 20; page++) {
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const data = await notionQuery(body);
    const results = data.results || [];
    allPages.push(...results);
    console.log(`  Notion page ${page + 1}: ${results.length} tasks (total: ${allPages.length})`);

    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  console.log(`\n  Total Notion tasks: ${allPages.length}`);

  // Insert into PostgreSQL
  let inserted = 0;
  let updated = 0;

  for (const page of allPages) {
    const id = page.id;
    const title = extractProp(page, "Task") || extractProp(page, "Name");
    const priority = extractProp(page, "Priority");
    const status = extractProp(page, "Status");
    const source = extractProp(page, "Source");
    const project = extractProp(page, "Project");
    const context = extractProp(page, "Context");
    const zone = extractProp(page, "Zone");
    const delegatedTo = extractProp(page, "Delegated To");
    const energy = extractProp(page, "Energy");
    const dueDate = extractProp(page, "Due Date") || null;
    const notes = extractProp(page, "Notes");
    const triageStatus = acceptedSet.has(id) ? "accepted" : (status === "Done" ? "accepted" : "inbox");

    const result = await pool.query(
      `INSERT INTO tasks (id, title, priority, status, source, project, context, zone, delegated_to, energy, due_date, notes, notion_page_id, notion_synced_at, notion_sync_status, triage_status, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12, $13, now(), 'synced', $14, $15, now())
       ON CONFLICT (id) DO UPDATE SET
         title = $2, priority = $3, status = $4, source = $5, project = $6,
         context = $7, zone = $8, delegated_to = $9, energy = $10,
         notes = $12, notion_synced_at = now(), updated_at = now()
       RETURNING (xmax = 0) as is_insert`,
      [id, title, priority || null, status || "Not started", source || null, project || null,
       context || null, zone || null, delegatedTo || null, energy || null, dueDate,
       notes || null, id, triageStatus,
       page.created_time || new Date().toISOString()]
    );

    if (result.rows[0]?.is_insert) inserted++;
    else updated++;

    // Extract [People: ...] from notes and create task_people links
    const peopleMatch = notes?.match(/\[People:\s*([^\]]+)\]/);
    if (peopleMatch) {
      const names = peopleMatch[1].split(",").map((n: string) => n.trim()).filter(Boolean);
      for (const name of names) {
        const personKey = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
        const personResult = await pool.query("SELECT id FROM people WHERE key = $1", [personKey]);
        if (personResult.rows[0]) {
          await pool.query(
            "INSERT INTO task_people (task_id, person_id, relationship) VALUES ($1, $2, 'tagged') ON CONFLICT DO NOTHING",
            [id, personResult.rows[0].id]
          );
        }
      }
    }
  }

  // Now backfill triage decisions that were deferred in Phase 2a
  try {
    const decisions = JSON.parse(fs.readFileSync(path.join(STORE_DIR, "triage-decisions.json"), "utf-8"));
    let triageCount = 0;
    for (const d of decisions) {
      try {
        await pool.query(
          `INSERT INTO triage_decisions (task_id, title, source, project, action, priority, delegated_to, decided_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [d.taskId, d.title || "", d.source || "", d.project || "", d.action, d.priority || null, d.delegatedTo || null, d.timestamp || new Date().toISOString()]
        );
        triageCount++;
      } catch {}
    }
    console.log(`  Triage decisions backfilled: ${triageCount}`);
  } catch {}

  console.log(`\n  Inserted: ${inserted}`);
  console.log(`  Updated: ${updated}`);

  const pgCount = (await pool.query("SELECT COUNT(*) as c FROM tasks")).rows[0].c;
  const pgOpen = (await pool.query("SELECT COUNT(*) as c FROM tasks WHERE status != 'Done'")).rows[0].c;
  console.log(`  Total in PG: ${pgCount} (${pgOpen} open)`);

  await pool.end();
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
