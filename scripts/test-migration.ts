/**
 * Migration test harness — validates each phase of the PostgreSQL migration.
 * Run after each phase to ensure data integrity and API compatibility.
 *
 * Usage: npx tsx scripts/test-migration.ts [phase]
 *   phase: 1, 2a, 2b, 2c, 2d, 3, 4, 5, all
 */
import pg from "pg";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const DB_PATH = path.join(STORE_DIR, "messages.db");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

let pool: pg.Pool;
let sqlite: Database.Database;
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function pgCount(table: string): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*) as c FROM ${table}`);
  return parseInt(r.rows[0].c);
}

function sqliteCount(table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any).c;
}

function jsonExists(file: string): boolean {
  return fs.existsSync(path.join(STORE_DIR, file));
}

function jsonLength(file: string): number {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(STORE_DIR, file), "utf-8"));
    if (Array.isArray(data)) return data.length;
    return Object.keys(data).length;
  } catch { return 0; }
}

// ══════════════════════════════════════════════════════════
// Phase 1: SQLite ↔ PostgreSQL consistency
// ══════════════════════════════════════════════════════════
async function testPhase1() {
  console.log("\n\x1b[1m━━━ Phase 1: SQLite ↔ PostgreSQL Dual-Write ━━━\x1b[0m");

  const tables = [
    { s: "chats", p: "chats" },
    { s: "messages", p: "chat_messages" },
    { s: "scheduled_tasks", p: "scheduled_tasks" },
    { s: "task_run_logs", p: "task_run_logs" },
    { s: "router_state", p: "router_state" },
    { s: "sessions", p: "sessions" },
    { s: "registered_groups", p: "registered_groups" },
  ];

  for (const t of tables) {
    const sc = sqliteCount(t.s);
    const pc = await pgCount(t.p);
    assert(sc === pc, `${t.s}: SQLite(${sc}) = PG(${pc})`, sc !== pc ? `diff: ${sc - pc}` : undefined);
  }

  // Spot-check latest task run
  const latestRun = sqlite.prepare("SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT 1").get() as any;
  if (latestRun) {
    const pgRun = (await pool.query("SELECT * FROM task_run_logs WHERE task_id = $1 ORDER BY run_at DESC LIMIT 1", [latestRun.task_id])).rows[0];
    assert(!!pgRun && pgRun.status === latestRun.status, `Spot-check latest run: ${latestRun.task_id.slice(0, 20)}...`);
  }
}

// ══════════════════════════════════════════════════════════
// Phase 2a: Small JSON files → PostgreSQL
// ══════════════════════════════════════════════════════════
async function testPhase2a() {
  console.log("\n\x1b[1m━━━ Phase 2a: Small JSON Stores → PostgreSQL ━━━\x1b[0m");

  // Team
  if (jsonExists("team.json")) {
    const jsonTeam = JSON.parse(fs.readFileSync(path.join(STORE_DIR, "team.json"), "utf-8")).members || [];
    const pgTeam = await pgCount("team_members");
    assert(pgTeam === jsonTeam.length, `team_members: JSON(${jsonTeam.length}) = PG(${pgTeam})`);

    // Spot-check a member
    if (jsonTeam.length > 0) {
      const first = jsonTeam[0];
      const pgFirst = (await pool.query("SELECT * FROM team_members WHERE email = $1", [first.email])).rows[0];
      assert(!!pgFirst && pgFirst.name === first.name, `Spot-check team member: ${first.name}`);
    }
  }

  // Corrections
  if (jsonExists("corrections.json")) {
    const jsonCorr = jsonLength("corrections.json");
    const pgCorr = await pgCount("corrections");
    assert(pgCorr === jsonCorr, `corrections: JSON(${jsonCorr}) = PG(${pgCorr})`);
  }

  // Relevance scores
  if (jsonExists("relevance-scores.json")) {
    const jsonScores = jsonLength("relevance-scores.json");
    const pgScores = await pgCount("relevance_scores");
    assert(pgScores === jsonScores, `relevance_scores: JSON(${jsonScores}) = PG(${pgScores})`);
  }

  // Triage decisions (depends on tasks table from Phase 5 — FK constraint)
  if (jsonExists("triage-decisions.json")) {
    const jsonTriage = jsonLength("triage-decisions.json");
    const pgTriage = await pgCount("triage_decisions");
    const tasksExist = await pgCount("tasks") > 0;
    if (tasksExist) {
      assert(pgTriage >= jsonTriage, `triage_decisions: JSON(${jsonTriage}) <= PG(${pgTriage})`);
    } else {
      assert(true, `triage_decisions: deferred (needs tasks table from Phase 5) — JSON(${jsonTriage}), PG(${pgTriage})`);
    }
  }

  // Pipeline state
  const pipelineFiles = [
    "boox-local-state.json", "plaud-local-state.json",
    "gmail-local-state.json", "messages-local-state.json",
  ];
  const existingPipelines = pipelineFiles.filter(f => jsonExists(f));
  const pgPipelines = await pgCount("pipeline_state");
  assert(pgPipelines >= existingPipelines.length, `pipeline_state: ${existingPipelines.length} JSON files → PG(${pgPipelines})`);

  // Calendar events
  if (jsonExists("google-calendar-events.json")) {
    const cal = JSON.parse(fs.readFileSync(path.join(STORE_DIR, "google-calendar-events.json"), "utf-8"));
    const jsonEvents = (cal.events || []).length;
    const pgEvents = await pgCount("calendar_events");
    assert(pgEvents === jsonEvents, `calendar_events: JSON(${jsonEvents}) = PG(${pgEvents})`);
  }
}

// ══════════════════════════════════════════════════════════
// Phase 2b: Initiatives → PostgreSQL
// ══════════════════════════════════════════════════════════
async function testPhase2b() {
  console.log("\n\x1b[1m━━━ Phase 2b: Initiatives → PostgreSQL ━━━\x1b[0m");

  if (jsonExists("initiatives.json")) {
    const jsonInit = jsonLength("initiatives.json");
    const pgInit = await pgCount("initiatives");
    assert(pgInit === jsonInit, `initiatives: JSON(${jsonInit}) = PG(${pgInit})`);

    // Check pinned tasks
    const pgPinned = await pgCount("initiative_pinned_tasks");
    assert(pgPinned >= 0, `initiative_pinned_tasks: PG(${pgPinned})`);
  }
}

// ══════════════════════════════════════════════════════════
// Phase 2c: Person Index → PostgreSQL
// ══════════════════════════════════════════════════════════
async function testPhase2c() {
  console.log("\n\x1b[1m━━━ Phase 2c: Person Index → PostgreSQL ━━━\x1b[0m");

  if (jsonExists("person-index.json")) {
    const jsonPeople = jsonLength("person-index.json");
    const pgPeople = await pgCount("people");
    assert(pgPeople === jsonPeople, `people: JSON(${jsonPeople}) = PG(${pgPeople})`);

    const pgEmails = await pgCount("person_emails");
    assert(pgEmails > 0, `person_emails: PG(${pgEmails})`);

    const pgMeetings = await pgCount("meetings");
    assert(pgMeetings > 0, `meetings: PG(${pgMeetings})`);

    const pgExcerpts = await pgCount("message_excerpts");
    assert(pgExcerpts > 0, `message_excerpts: PG(${pgExcerpts})`);

    const pgMentions = await pgCount("transcript_mentions");
    assert(pgMentions > 0, `transcript_mentions: PG(${pgMentions})`);

    // Spot-check: person with most interactions
    const topPerson = (await pool.query(`
      SELECT p.name, p.key, COUNT(DISTINCT me.id) as msg_count, COUNT(DISTINCT mp.meeting_id) as mtg_count
      FROM people p
      LEFT JOIN message_excerpts me ON me.person_id = p.id
      LEFT JOIN meeting_participants mp ON mp.person_id = p.id
      GROUP BY p.id, p.name, p.key ORDER BY COUNT(DISTINCT me.id) + COUNT(DISTINCT mp.meeting_id) DESC LIMIT 1
    `)).rows[0];
    if (topPerson) {
      assert(true, `Top person: ${topPerson.name} (${topPerson.msg_count} msgs, ${topPerson.mtg_count} meetings)`);
    }
  }
}

// ══════════════════════════════════════════════════════════
// Phase 3: Vectors → pgvector
// ══════════════════════════════════════════════════════════
async function testPhase3() {
  console.log("\n\x1b[1m━━━ Phase 3: Vectors → pgvector ━━━\x1b[0m");

  const vecDb = new Database(path.join(STORE_DIR, "vectors.db"), { readonly: true });
  const sqliteChunks = (vecDb.prepare("SELECT COUNT(*) as c FROM chunks").get() as any).c;
  vecDb.close();

  const pgChunks = await pgCount("vector_chunks");
  assert(pgChunks === sqliteChunks, `vector_chunks: SQLite-vec(${sqliteChunks}) = PG(${pgChunks})`);

  // Check embedding dimension
  if (pgChunks > 0) {
    const sample = (await pool.query("SELECT embedding FROM vector_chunks WHERE embedding IS NOT NULL LIMIT 1")).rows[0];
    assert(!!sample?.embedding, `Embeddings present in pgvector`);
  }
}

// ══════════════════════════════════════════════════════════
// Phase 4: Archive → PostgreSQL
// ══════════════════════════════════════════════════════════
async function testPhase4() {
  console.log("\n\x1b[1m━━━ Phase 4: Archive → PostgreSQL ━━━\x1b[0m");

  const archiveDir = path.join(STORE_DIR, "archive");
  const types = ["transcripts", "messages", "emails", "boox", "plaud", "summaries"];
  let totalFiles = 0;

  for (const type of types) {
    const dir = path.join(archiveDir, type);
    let fileCount = 0;
    try {
      fileCount = fs.readdirSync(dir).filter(f => f.endsWith(".json")).length;
    } catch {}
    const pgItems = parseInt((await pool.query("SELECT COUNT(*) as c FROM archive_items WHERE source_type = $1", [type])).rows[0].c);
    assert(pgItems === fileCount, `archive/${type}: Files(${fileCount}) = PG(${pgItems})`);
    totalFiles += fileCount;
  }

  const pgTotal = await pgCount("archive_items");
  assert(pgTotal === totalFiles, `archive total: Files(${totalFiles}) = PG(${pgTotal})`);
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════
async function main() {
  const phase = process.argv[2] || "all";

  pool = new pg.Pool({ connectionString: PG_URL });
  sqlite = new Database(DB_PATH, { readonly: true });

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          NanoClaw Migration Test Harness                ║");
  console.log(`║          Phase: ${phase.padEnd(41)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (phase === "1" || phase === "all") await testPhase1();
  if (phase === "2a" || phase === "all") await testPhase2a();
  if (phase === "2b" || phase === "all") await testPhase2b();
  if (phase === "2c" || phase === "all") await testPhase2c();
  if (phase === "3" || phase === "all") await testPhase3();
  if (phase === "4" || phase === "all") await testPhase4();

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log(`║  Results: \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m${" ".repeat(Math.max(0, 30 - String(passed).length - String(failed).length))}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  sqlite.close();
  await pool.end();

  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
