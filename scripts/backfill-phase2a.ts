/**
 * Phase 2a: Backfill small JSON stores to PostgreSQL.
 * Idempotent — safe to run multiple times.
 *
 * Migrates: team, corrections, relevance scores, triage decisions,
 *           pipeline state, calendar events
 */
import pg from "pg";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

function loadJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(STORE_DIR, file), "utf-8")); } catch { return null; }
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  console.log("Phase 2a: Backfilling small JSON stores → PostgreSQL\n");

  // 1. Team members
  const team = loadJson("team.json");
  if (team?.members) {
    let count = 0;
    for (const m of team.members) {
      await pool.query(
        `INSERT INTO team_members (name, role, email) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [m.name, m.role, m.email]
      );
      count++;
    }
    // Handle duplicates - delete and re-insert cleanly
    await pool.query("DELETE FROM team_members");
    for (const m of team.members) {
      await pool.query(
        `INSERT INTO team_members (name, role, email) VALUES ($1, $2, $3)`,
        [m.name, m.role, m.email]
      );
    }
    console.log(`  team_members: ${team.members.length}`);
  }

  // 2. Corrections glossary
  const corrections = loadJson("corrections.json");
  if (corrections && typeof corrections === "object") {
    let count = 0;
    for (const [wrong, correct] of Object.entries(corrections)) {
      await pool.query(
        "INSERT INTO corrections (wrong, correct) VALUES ($1, $2) ON CONFLICT (wrong) DO UPDATE SET correct = $2",
        [wrong, correct as string]
      );
      count++;
    }
    console.log(`  corrections: ${count}`);
  }

  // 3. Relevance scores
  const scores = loadJson("relevance-scores.json");
  if (scores && typeof scores === "object") {
    let count = 0;
    for (const [key, val] of Object.entries(scores)) {
      const scoreVal = typeof val === "object" && val !== null ? (val as any).score || 0 : val as number;
      const lastVote = typeof val === "object" && val !== null ? (val as any).lastVote : null;
      await pool.query(
        "INSERT INTO relevance_scores (key, score, last_vote) VALUES ($1, $2, COALESCE($3::timestamptz, now())) ON CONFLICT (key) DO UPDATE SET score = $2, last_vote = COALESCE($3::timestamptz, relevance_scores.last_vote)",
        [key, scoreVal, lastVote]
      );
      count++;
    }
    console.log(`  relevance_scores: ${count}`);
  }

  // 4. Triage decisions
  const triageDecisions = loadJson("triage-decisions.json");
  if (Array.isArray(triageDecisions)) {
    // We need task UUIDs for FK — triage_decisions references tasks table.
    // For now, insert without FK (tasks table will be populated in Phase 5).
    // Drop the FK constraint temporarily or just skip the reference.
    let count = 0;
    for (const d of triageDecisions) {
      // Check if task exists in tasks table — if not, skip FK
      try {
        await pool.query(
          `INSERT INTO triage_decisions (task_id, title, source, project, action, priority, delegated_to, decided_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [d.taskId, d.title || "", d.source || "", d.project || "", d.action, d.priority || null, d.delegatedTo || null, d.timestamp || new Date().toISOString()]
        );
        count++;
      } catch (err: any) {
        // FK violation — task doesn't exist in tasks table yet (expected, Phase 5)
        if (err.code === "23503") continue;
        throw err;
      }
    }
    console.log(`  triage_decisions: ${count} (of ${triageDecisions.length} — rest need tasks table from Phase 5)`);
  }

  // 5. Pipeline state
  const pipelines = [
    { file: "boox-local-state.json", name: "boox" },
    { file: "plaud-local-state.json", name: "plaud" },
    { file: "gmail-local-state.json", name: "gmail" },
    { file: "messages-local-state.json", name: "messages" },
  ];
  let pipeCount = 0;
  for (const p of pipelines) {
    const state = loadJson(p.file);
    if (state) {
      await pool.query(
        `INSERT INTO pipeline_state (pipeline, state, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (pipeline) DO UPDATE SET state = $2, updated_at = now()`,
        [p.name, JSON.stringify(state)]
      );
      pipeCount++;
    }
  }
  console.log(`  pipeline_state: ${pipeCount}`);

  // 6. Calendar events
  const cal = loadJson("google-calendar-events.json");
  if (cal?.events) {
    let count = 0;
    for (const e of cal.events) {
      await pool.query(
        `INSERT INTO calendar_events (id, title, start_time, end_time, location, description, calendar, attendees, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'google')
         ON CONFLICT (id) DO UPDATE SET title = $2, start_time = $3, end_time = $4`,
        [e.id, e.summary || e.title, e.start, e.end, e.location || null, e.description || null, e.calendar || null, JSON.stringify(e.attendees || [])]
      );
      count++;
    }
    console.log(`  calendar_events: ${count}`);
  }

  console.log("\nDone.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
