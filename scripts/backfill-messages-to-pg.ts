/**
 * One-time backfill: copy all data from messages.db (SQLite) to PostgreSQL.
 * Idempotent — safe to run multiple times (uses ON CONFLICT).
 */
import Database from "better-sqlite3";
import pg from "pg";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const DB_PATH = path.join(STORE_DIR, "messages.db");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

async function main() {
  const sqlite = new Database(DB_PATH, { readonly: true });
  const pool = new pg.Pool({ connectionString: PG_URL });

  console.log("Backfilling messages.db → PostgreSQL...\n");

  // 1. Chats
  const chats = sqlite.prepare("SELECT * FROM chats").all() as any[];
  let chatCount = 0;
  for (const c of chats) {
    await pool.query(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (jid) DO UPDATE SET
         name = COALESCE($2, chats.name),
         last_message_time = GREATEST(chats.last_message_time, $3)`,
      [c.jid, c.name, c.last_message_time, c.channel || null, c.is_group === 1]
    );
    chatCount++;
  }
  console.log(`  Chats: ${chatCount}`);

  // 2. Messages
  const messages = sqlite.prepare("SELECT * FROM messages").all() as any[];
  let msgCount = 0;
  for (const m of messages) {
    await pool.query(
      `INSERT INTO chat_messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id, chat_jid) DO NOTHING`,
      [m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp, m.is_from_me === 1, m.is_bot_message === 1]
    );
    msgCount++;
  }
  console.log(`  Messages: ${msgCount}`);

  // 3. Scheduled tasks
  const tasks = sqlite.prepare("SELECT * FROM scheduled_tasks").all() as any[];
  let taskCount = 0;
  for (const t of tasks) {
    await pool.query(
      `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, model, next_run, last_run, last_result, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO NOTHING`,
      [t.id, t.group_folder, t.chat_jid, t.prompt, t.schedule_type, t.schedule_value, t.context_mode || "isolated", t.model || null, t.next_run, t.last_run, t.last_result, t.status, t.created_at]
    );
    taskCount++;
  }
  console.log(`  Scheduled tasks: ${taskCount}`);

  // 4. Task run logs
  const logs = sqlite.prepare("SELECT * FROM task_run_logs").all() as any[];
  let logCount = 0;
  for (const l of logs) {
    await pool.query(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [l.task_id, l.run_at, l.duration_ms, l.status, l.result, l.error]
    );
    logCount++;
  }
  console.log(`  Task run logs: ${logCount}`);

  // 5. Router state
  const state = sqlite.prepare("SELECT * FROM router_state").all() as any[];
  for (const s of state) {
    await pool.query(
      "INSERT INTO router_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [s.key, s.value]
    );
  }
  console.log(`  Router state: ${state.length}`);

  // 6. Sessions
  const sessions = sqlite.prepare("SELECT * FROM sessions").all() as any[];
  for (const s of sessions) {
    await pool.query(
      "INSERT INTO sessions (group_folder, session_id) VALUES ($1, $2) ON CONFLICT (group_folder) DO UPDATE SET session_id = $2",
      [s.group_folder, s.session_id]
    );
  }
  console.log(`  Sessions: ${sessions.length}`);

  // 7. Registered groups
  const groups = sqlite.prepare("SELECT * FROM registered_groups").all() as any[];
  for (const g of groups) {
    await pool.query(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (jid) DO NOTHING`,
      [g.jid, g.name, g.folder, g.trigger_pattern, g.added_at, g.container_config, g.requires_trigger === 1, g.is_main === 1]
    );
  }
  console.log(`  Registered groups: ${groups.length}`);

  // Verify
  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM chats) as chats,
      (SELECT COUNT(*) FROM chat_messages) as messages,
      (SELECT COUNT(*) FROM scheduled_tasks) as tasks,
      (SELECT COUNT(*) FROM task_run_logs) as logs,
      (SELECT COUNT(*) FROM registered_groups) as groups
  `);
  console.log("\nPostgreSQL counts:", counts.rows[0]);

  sqlite.close();
  await pool.end();
  console.log("\nBackfill complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
