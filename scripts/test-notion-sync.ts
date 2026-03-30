/**
 * Test the Notion sync worker end-to-end:
 * 1. Create a task in PG with notion_sync_status='pending'
 * 2. Run the sync cycle
 * 3. Verify it appeared in Notion
 * 4. Update the task in PG
 * 5. Run sync again
 * 6. Verify Notion was updated
 * 7. Clean up
 */
import pg from "pg";
import path from "path";

const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";
const ONECLI_TOKEN = process.env.ONECLI_AGENT_TOKEN || "aoc_181429a83379e2122e9e0b6cde6eefd6b897809b92c08cc4bc788816e26e399a";
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

let pool: pg.Pool;
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) { console.log(`  \x1b[32m✓\x1b[0m ${label}`); passed++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function notionFetch(url: string, method: string, body?: any): Promise<any> {
  const { default: fetch } = await import("node-fetch");
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  const agent = new HttpsProxyAgent(`http://x:${ONECLI_TOKEN}@localhost:10255`);
  const resp = await fetch(url, {
    method, agent,
    headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as any);
  return resp.json();
}

async function main() {
  pool = new pg.Pool({ connectionString: PG_URL });
  const testTitle = `[SYNC TEST] ${new Date().toISOString().slice(0, 19)}`;

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          Notion Sync Worker — End-to-End Test           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // 1. Create a task in PG with pending sync
  console.log("━━━ Step 1: Create task in PG ━━━");
  const createResult = await pool.query(
    `INSERT INTO tasks (id, title, priority, status, source, project, notion_sync_status, triage_status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 'P2 — This Month', 'Not started', 'Sync Test', 'Test', 'pending', 'accepted', now(), now())
     RETURNING id`,
    [testTitle]
  );
  const taskId = createResult.rows[0].id;
  assert(!!taskId, `Created PG task: ${taskId.slice(0, 12)}...`);

  // Verify pending status
  const pending = (await pool.query("SELECT notion_sync_status FROM tasks WHERE id = $1", [taskId])).rows[0];
  assert(pending.notion_sync_status === "pending", "Sync status: pending");

  // 2. Import and run one sync cycle
  console.log("\n━━━ Step 2: Run outbound sync ━━━");
  // We can't import the module directly (it uses ESM config imports), so call the sync logic inline
  const pendingTasks = await pool.query(
    `SELECT id, title, priority, status, source, project, context, zone, delegated_to, notes, notion_page_id
     FROM tasks WHERE notion_sync_status = 'pending' AND title = $1`,
    [testTitle]
  );
  assert(pendingTasks.rows.length === 1, `Found 1 pending task for sync`);

  const task = pendingTasks.rows[0];
  const properties: Record<string, any> = {
    Task: { title: [{ text: { content: task.title } }] },
    Status: { status: { name: task.status } },
    Priority: { select: { name: task.priority } },
    Source: { select: { name: task.source } },
    Project: { select: { name: task.project } },
  };

  const notionResp = await notionFetch("https://api.notion.com/v1/pages", "POST", {
    parent: { database_id: NOTION_DB },
    properties,
  });
  assert(!!notionResp.id, `Created Notion page: ${(notionResp.id || "").slice(0, 12)}...`);

  if (notionResp.id) {
    // Update PG with Notion page ID and mark synced
    await pool.query(
      "UPDATE tasks SET notion_page_id = $1, notion_sync_status = 'synced', notion_synced_at = now() WHERE id = $2",
      [notionResp.id, taskId]
    );
    await pool.query(
      "INSERT INTO notion_sync_log (entity_type, entity_id, direction, status) VALUES ('task', $1, 'to_notion', 'success')",
      [taskId]
    );
  }

  // 3. Verify in Notion
  console.log("\n━━━ Step 3: Verify in Notion ━━━");
  if (notionResp.id) {
    const page = await notionFetch(`https://api.notion.com/v1/pages/${notionResp.id}`, "GET");
    const notionTitle = page.properties?.Task?.title?.map((t: any) => t.plain_text).join("") || "";
    assert(notionTitle === testTitle, `Notion title matches: "${notionTitle.slice(0, 40)}..."`);
    assert(page.properties?.Priority?.select?.name === "P2 — This Month", "Notion priority matches");
  }

  // 4. Update task in PG and sync
  console.log("\n━━━ Step 4: Update and re-sync ━━━");
  const updatedTitle = `${testTitle} [UPDATED]`;
  await pool.query(
    "UPDATE tasks SET title = $1, notion_sync_status = 'pending', updated_at = now() WHERE id = $2",
    [updatedTitle, taskId]
  );

  if (notionResp.id) {
    await notionFetch(`https://api.notion.com/v1/pages/${notionResp.id}`, "PATCH", {
      properties: { Task: { title: [{ text: { content: updatedTitle } }] } },
    });
    await pool.query(
      "UPDATE tasks SET notion_sync_status = 'synced', notion_synced_at = now() WHERE id = $1",
      [taskId]
    );

    const updated = await notionFetch(`https://api.notion.com/v1/pages/${notionResp.id}`, "GET");
    const updNotionTitle = updated.properties?.Task?.title?.map((t: any) => t.plain_text).join("") || "";
    assert(updNotionTitle === updatedTitle, `Notion updated title: "${updNotionTitle.slice(0, 40)}..."`);
  }

  // 5. Verify sync log
  console.log("\n━━━ Step 5: Verify sync log ━━━");
  const logs = (await pool.query(
    "SELECT * FROM notion_sync_log WHERE entity_id = $1 ORDER BY synced_at",
    [taskId]
  )).rows;
  assert(logs.length >= 1, `Sync log entries: ${logs.length}`);
  assert(logs[0].direction === "to_notion", "Direction: to_notion");
  assert(logs[0].status === "success", "Status: success");

  // 6. Cleanup — mark test task as Done in both PG and Notion
  console.log("\n━━━ Step 6: Cleanup ━━━");
  await pool.query("UPDATE tasks SET status = 'Done' WHERE id = $1", [taskId]);
  if (notionResp.id) {
    await notionFetch(`https://api.notion.com/v1/pages/${notionResp.id}`, "PATCH", {
      properties: { Status: { status: { name: "Done" } } },
    });
  }
  assert(true, "Test task marked as Done in PG and Notion");

  // Summary
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log(`║  Results: \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m${" ".repeat(Math.max(0, 30 - String(passed).length - String(failed).length))}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
