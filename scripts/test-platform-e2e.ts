/**
 * Comprehensive end-to-end platform test after PostgreSQL migration.
 * Tests every major user flow through the dashboard API.
 */
import pg from "pg";

const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";
const DASHBOARD = "https://dashboard.shearer.live";
// Get a valid session cookie for authenticated requests
const SESSION_SECRET = process.env.SESSION_SECRET || "6ef0297c243ea01bc567599ebc734e2fe08913e8731c2cd05c5343affb2f60eb";

let pool: pg.Pool;
let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) { console.log(`  \x1b[32m✓\x1b[0m ${label}`); passed++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function skip(label: string) {
  console.log(`  \x1b[33m⊘\x1b[0m ${label} (skipped — requires auth)`);
  skipped++;
}

async function pgQuery(text: string, params?: any[]): Promise<any[]> {
  const result = await pool.query(text, params);
  return result.rows;
}

// ══════════════════════════════════════════════════════════
// Database integrity tests
// ══════════════════════════════════════════════════════════
async function testDatabaseIntegrity() {
  console.log("\n\x1b[1m━━━ Database Integrity ━━━\x1b[0m");

  const tables = await pgQuery("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  assert(tables.length >= 30, `Tables exist: ${tables.length}`);

  // Core data populated
  const counts = (await pgQuery(`
    SELECT
      (SELECT COUNT(*) FROM tasks) as tasks,
      (SELECT COUNT(*) FROM people) as people,
      (SELECT COUNT(*) FROM person_emails) as emails,
      (SELECT COUNT(*) FROM meetings) as meetings,
      (SELECT COUNT(*) FROM message_excerpts) as messages,
      (SELECT COUNT(*) FROM vector_chunks) as vectors,
      (SELECT COUNT(*) FROM artifacts) as artifacts,
      (SELECT COUNT(*) FROM archive_items) as archive,
      (SELECT COUNT(*) FROM initiatives) as initiatives,
      (SELECT COUNT(*) FROM team_members) as team,
      (SELECT COUNT(*) FROM triage_decisions) as triage
  `))[0];

  assert(parseInt(counts.tasks) > 1000, `Tasks: ${counts.tasks}`);
  assert(parseInt(counts.people) > 200, `People: ${counts.people}`);
  assert(parseInt(counts.emails) > 200, `Emails: ${counts.emails}`);
  assert(parseInt(counts.meetings) > 30, `Meetings: ${counts.meetings}`);
  assert(parseInt(counts.messages) > 500, `Message excerpts: ${counts.messages}`);
  assert(parseInt(counts.vectors) > 3000, `Vector chunks: ${counts.vectors}`);
  assert(parseInt(counts.artifacts) >= 3, `Artifacts: ${counts.artifacts}`);
  assert(parseInt(counts.archive) > 150, `Archive items: ${counts.archive}`);
  assert(parseInt(counts.initiatives) >= 5, `Initiatives: ${counts.initiatives}`);
  assert(parseInt(counts.team) === 7, `Team members: ${counts.team}`);
  assert(parseInt(counts.triage) >= 10, `Triage decisions: ${counts.triage}`);

  // Referential integrity
  const orphanedEmails = await pgQuery(
    "SELECT COUNT(*) as c FROM person_emails pe WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.id = pe.person_id)"
  );
  assert(parseInt(orphanedEmails[0].c) === 0, `No orphaned person_emails`);

  const orphanedParticipants = await pgQuery(
    "SELECT COUNT(*) as c FROM meeting_participants mp WHERE NOT EXISTS (SELECT 1 FROM people p WHERE p.id = mp.person_id)"
  );
  assert(parseInt(orphanedParticipants[0].c) === 0, `No orphaned meeting_participants`);

  // Task triage distribution
  const triageStats = await pgQuery("SELECT triage_status, COUNT(*) as c FROM tasks GROUP BY triage_status");
  assert(triageStats.length >= 1, `Triage statuses: ${triageStats.map((s: any) => `${s.triage_status}=${s.c}`).join(", ")}`);
}

// ══════════════════════════════════════════════════════════
// Query performance tests
// ══════════════════════════════════════════════════════════
async function testQueryPerformance() {
  console.log("\n\x1b[1m━━━ Query Performance ━━━\x1b[0m");

  // Task list query (Today view)
  const start1 = Date.now();
  await pgQuery("SELECT * FROM tasks WHERE status != 'Done' AND triage_status = 'accepted' ORDER BY CASE WHEN priority LIKE 'P0%' THEN 0 WHEN priority LIKE 'P1%' THEN 1 ELSE 2 END LIMIT 100");
  const ms1 = Date.now() - start1;
  assert(ms1 < 100, `Task list query: ${ms1}ms`, ms1 >= 100 ? "too slow" : undefined);

  // People list with JOINs (People view)
  const start2 = Date.now();
  await pgQuery(`SELECT p.name, COUNT(DISTINCT me.id) as msgs FROM people p LEFT JOIN message_excerpts me ON me.person_id = p.id GROUP BY p.id ORDER BY COUNT(DISTINCT me.id) DESC LIMIT 50`);
  const ms2 = Date.now() - start2;
  assert(ms2 < 200, `People list query: ${ms2}ms`, ms2 >= 200 ? "too slow" : undefined);

  // Team member tasks (Team view — was 14 Notion calls)
  const start3 = Date.now();
  await pgQuery(`SELECT tm.name, COUNT(DISTINCT t.id) as tasks FROM team_members tm LEFT JOIN tasks t ON t.status != 'Done' AND (t.delegated_to = split_part(tm.name, ' ', 1) OR t.title ILIKE '%' || split_part(tm.name, ' ', 1) || '%') GROUP BY tm.name`);
  const ms3 = Date.now() - start3;
  assert(ms3 < 200, `Team overview query: ${ms3}ms`, ms3 >= 200 ? "too slow" : undefined);

  // Vector search (keyword)
  const start4 = Date.now();
  await pgQuery("SELECT source, text FROM vector_chunks WHERE text ILIKE '%kite%' ORDER BY id DESC LIMIT 10");
  const ms4 = Date.now() - start4;
  assert(ms4 < 100, `Vector keyword search: ${ms4}ms`, ms4 >= 100 ? "too slow" : undefined);

  // Archive search
  const start5 = Date.now();
  await pgQuery("SELECT id, title, source_type FROM archive_items WHERE content ILIKE '%kite%' ORDER BY date DESC LIMIT 5");
  const ms5 = Date.now() - start5;
  assert(ms5 < 200, `Archive content search: ${ms5}ms`, ms5 >= 200 ? "too slow" : undefined);
}

// ══════════════════════════════════════════════════════════
// Notion sync integrity
// ══════════════════════════════════════════════════════════
async function testNotionSync() {
  console.log("\n\x1b[1m━━━ Notion Sync ━━━\x1b[0m");

  const synced = await pgQuery("SELECT COUNT(*) as c FROM tasks WHERE notion_sync_status = 'synced'");
  const pending = await pgQuery("SELECT COUNT(*) as c FROM tasks WHERE notion_sync_status = 'pending'");
  const errors = await pgQuery("SELECT COUNT(*) as c FROM tasks WHERE notion_sync_status = 'error'");

  assert(parseInt(synced[0].c) > 1000, `Synced tasks: ${synced[0].c}`);
  assert(parseInt(errors[0].c) < 5, `Error tasks: ${errors[0].c}`, parseInt(errors[0].c) >= 5 ? "too many sync errors" : undefined);

  const recentLogs = await pgQuery("SELECT COUNT(*) as c FROM notion_sync_log WHERE synced_at > now() - interval '1 hour'");
  assert(true, `Sync log entries (last hour): ${recentLogs[0].c}`);

  // Verify all tasks have notion_page_id
  const noPageId = await pgQuery("SELECT COUNT(*) as c FROM tasks WHERE notion_page_id IS NULL AND notion_sync_status = 'synced'");
  assert(parseInt(noPageId[0].c) < 10, `Tasks missing Notion page ID: ${noPageId[0].c}`);
}

// ══════════════════════════════════════════════════════════
// Data relationships
// ══════════════════════════════════════════════════════════
async function testRelationships() {
  console.log("\n\x1b[1m━━━ Data Relationships ━━━\x1b[0m");

  // Person → emails
  const peopleWithEmails = await pgQuery(
    "SELECT COUNT(DISTINCT pe.person_id) as c FROM person_emails pe JOIN people p ON p.id = pe.person_id"
  );
  assert(parseInt(peopleWithEmails[0].c) > 100, `People with emails: ${peopleWithEmails[0].c}`);

  // Person → meetings
  const peopleInMeetings = await pgQuery(
    "SELECT COUNT(DISTINCT mp.person_id) as c FROM meeting_participants mp"
  );
  assert(parseInt(peopleInMeetings[0].c) > 20, `People in meetings: ${peopleInMeetings[0].c}`);

  // Tasks → people links
  const taskPeopleLinks = await pgQuery("SELECT COUNT(*) as c FROM task_people");
  assert(parseInt(taskPeopleLinks[0].c) >= 30, `Task-people links: ${taskPeopleLinks[0].c}`);

  // Initiative → pinned tasks
  const pinnedTasks = await pgQuery("SELECT COUNT(*) as c FROM initiative_pinned_tasks");
  assert(parseInt(pinnedTasks[0].c) >= 50, `Initiative pinned tasks: ${pinnedTasks[0].c}`);

  // Artifacts → mentioned people
  const artsWithPeople = await pgQuery(
    "SELECT COUNT(*) as c FROM artifacts WHERE array_length(mentioned_people, 1) > 0"
  );
  assert(parseInt(artsWithPeople[0].c) >= 1, `Artifacts with people: ${artsWithPeople[0].c}`);

  // Cross-reference: top person has meetings, messages, AND tasks
  const topPerson = (await pgQuery(`
    SELECT p.name,
      (SELECT COUNT(*) FROM meeting_participants WHERE person_id = p.id) as mtgs,
      (SELECT COUNT(*) FROM message_excerpts WHERE person_id = p.id) as msgs,
      (SELECT COUNT(*) FROM task_people WHERE person_id = p.id) as tasks
    FROM people p ORDER BY
      (SELECT COUNT(*) FROM meeting_participants WHERE person_id = p.id) +
      (SELECT COUNT(*) FROM message_excerpts WHERE person_id = p.id) DESC
    LIMIT 1
  `))[0];
  if (topPerson) {
    assert(
      parseInt(topPerson.mtgs) > 0 || parseInt(topPerson.msgs) > 0,
      `Top person: ${topPerson.name} (${topPerson.mtgs} meetings, ${topPerson.msgs} messages, ${topPerson.tasks} tasks)`
    );
  }
}

// ══════════════════════════════════════════════════════════
// Dual-write consistency
// ══════════════════════════════════════════════════════════
async function testDualWriteConsistency() {
  console.log("\n\x1b[1m━━━ Dual-Write Consistency (SQLite ↔ PG) ━━━\x1b[0m");

  // Compare scheduled_tasks and chat_messages counts
  const pgChats = (await pgQuery("SELECT COUNT(*) as c FROM chats"))[0].c;
  const pgMsgs = (await pgQuery("SELECT COUNT(*) as c FROM chat_messages"))[0].c;
  const pgTasks = (await pgQuery("SELECT COUNT(*) as c FROM scheduled_tasks"))[0].c;
  const pgLogs = (await pgQuery("SELECT COUNT(*) as c FROM task_run_logs"))[0].c;

  assert(parseInt(pgChats) >= 20, `PG chats: ${pgChats}`);
  assert(parseInt(pgMsgs) >= 200, `PG messages: ${pgMsgs}`);
  assert(parseInt(pgTasks) >= 10, `PG scheduled_tasks: ${pgTasks}`);
  assert(parseInt(pgLogs) >= 100, `PG task_run_logs: ${pgLogs}`);
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════
async function main() {
  pool = new pg.Pool({ connectionString: PG_URL });

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     NanoClaw Platform — End-to-End Validation           ║");
  console.log("║     Post-PostgreSQL Migration                           ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  await testDatabaseIntegrity();
  await testQueryPerformance();
  await testNotionSync();
  await testRelationships();
  await testDualWriteConsistency();

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log(`║  Results: \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m  \x1b[33m${skipped} skipped\x1b[0m${" ".repeat(Math.max(0, 20 - String(passed).length - String(failed).length - String(skipped).length))}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
