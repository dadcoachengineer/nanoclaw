/**
 * Validates data consistency between SQLite (messages.db) and PostgreSQL.
 * Compares row counts and spot-checks key records.
 */
import Database from "better-sqlite3";
import pg from "pg";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const DB_PATH = path.join(STORE_DIR, "messages.db");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

interface ValidationResult {
  table: string;
  sqliteCount: number;
  pgCount: number;
  match: boolean;
  details?: string;
}

async function main() {
  const sqlite = new Database(DB_PATH, { readonly: true });
  const pool = new pg.Pool({ connectionString: PG_URL });

  const results: ValidationResult[] = [];

  // Table mapping: SQLite name -> PG name (where different)
  const tables = [
    { sqlite: "chats", pg: "chats", key: "jid" },
    { sqlite: "messages", pg: "chat_messages", key: "id" },
    { sqlite: "scheduled_tasks", pg: "scheduled_tasks", key: "id" },
    { sqlite: "task_run_logs", pg: "task_run_logs", key: null },
    { sqlite: "router_state", pg: "router_state", key: "key" },
    { sqlite: "sessions", pg: "sessions", key: "group_folder" },
    { sqlite: "registered_groups", pg: "registered_groups", key: "jid" },
  ];

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       SQLite ↔ PostgreSQL Consistency Validation        ║");
  console.log("╠══════════════════════════════════════════════════════════╣");

  for (const t of tables) {
    const sqliteCount = (sqlite.prepare(`SELECT COUNT(*) as c FROM ${t.sqlite}`).get() as any).c;
    const pgResult = await pool.query(`SELECT COUNT(*) as c FROM ${t.pg}`);
    const pgCount = parseInt(pgResult.rows[0].c);
    const match = sqliteCount === pgCount;

    results.push({ table: t.sqlite, sqliteCount, pgCount, match });

    const icon = match ? "✓" : "✗";
    const color = match ? "\x1b[32m" : "\x1b[31m";
    console.log(`║ ${color}${icon}\x1b[0m  ${t.sqlite.padEnd(20)} SQLite: ${String(sqliteCount).padStart(5)}  PG: ${String(pgCount).padStart(5)}  ${match ? "MATCH" : "MISMATCH"}`);

    // Spot-check: compare a few records if key exists
    if (t.key && !match) {
      // Find records in SQLite not in PG
      const sqliteIds = sqlite.prepare(`SELECT ${t.key} FROM ${t.sqlite}`).all().map((r: any) => r[t.key]);
      const pgIds = (await pool.query(`SELECT ${t.key} FROM ${t.pg}`)).rows.map((r: any) => r[t.key]);
      const pgSet = new Set(pgIds);
      const missing = sqliteIds.filter((id: string) => !pgSet.has(id));
      if (missing.length > 0) {
        console.log(`║      Missing in PG: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` (+${missing.length - 3} more)` : ""}`);
        results[results.length - 1].details = `${missing.length} records missing in PG`;
      }
    }
  }

  // Spot-check: verify a recent scheduled task matches
  const recentTask = sqlite.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC LIMIT 1").get() as any;
  if (recentTask) {
    const pgTask = (await pool.query("SELECT * FROM scheduled_tasks WHERE id = $1", [recentTask.id])).rows[0];
    console.log("║");
    if (pgTask) {
      const fieldsMatch = pgTask.prompt === recentTask.prompt && pgTask.schedule_type === recentTask.schedule_type;
      console.log(`║ ${fieldsMatch ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  Spot-check task "${recentTask.id.slice(0, 20)}..." fields: ${fieldsMatch ? "MATCH" : "MISMATCH"}`);
    } else {
      console.log(`║ \x1b[31m✗\x1b[0m  Spot-check task "${recentTask.id.slice(0, 20)}..." NOT FOUND in PG`);
    }
  }

  // Spot-check: verify recent messages match
  const recentMsg = sqlite.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 1").get() as any;
  if (recentMsg) {
    const pgMsg = (await pool.query("SELECT * FROM chat_messages WHERE id = $1 AND chat_jid = $2", [recentMsg.id, recentMsg.chat_jid])).rows[0];
    if (pgMsg) {
      const contentMatch = pgMsg.content === recentMsg.content;
      console.log(`║ ${contentMatch ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  Spot-check latest message content: ${contentMatch ? "MATCH" : "MISMATCH"}`);
    } else {
      console.log(`║ \x1b[31m✗\x1b[0m  Spot-check latest message NOT FOUND in PG`);
    }
  }

  // Check for recent dual-write activity (records newer than backfill)
  const pgRecent = await pool.query(`
    SELECT
      (SELECT MAX(last_message_time) FROM chats WHERE last_message_time IS NOT NULL) as latest_chat,
      (SELECT MAX(timestamp) FROM chat_messages) as latest_msg,
      (SELECT MAX(run_at) FROM task_run_logs) as latest_run
  `);
  const r = pgRecent.rows[0];
  console.log("║");
  console.log(`║ Latest PG timestamps:`);
  console.log(`║   Chat activity:  ${r.latest_chat || "none"}`);
  console.log(`║   Message:        ${r.latest_msg || "none"}`);
  console.log(`║   Task run:       ${r.latest_run || "none"}`);

  console.log("╠══════════════════════════════════════════════════════════╣");

  const allMatch = results.every((r) => r.match);
  if (allMatch) {
    console.log("║  \x1b[32m ALL TABLES CONSISTENT — dual-write verified\x1b[0m");
  } else {
    const mismatches = results.filter((r) => !r.match);
    console.log(`║  \x1b[31m ${mismatches.length} TABLE(S) HAVE MISMATCHES\x1b[0m`);
    for (const m of mismatches) {
      console.log(`║    ${m.table}: SQLite=${m.sqliteCount} PG=${m.pgCount} ${m.details || ""}`);
    }
  }

  console.log("╚══════════════════════════════════════════════════════════╝");

  sqlite.close();
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
