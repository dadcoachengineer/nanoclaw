/**
 * Phase 2b: Backfill initiatives to PostgreSQL.
 */
import pg from "pg";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  console.log("Phase 2b: Backfilling initiatives → PostgreSQL\n");

  const data = JSON.parse(fs.readFileSync(path.join(STORE_DIR, "initiatives.json"), "utf-8"));
  let initCount = 0;
  let pinnedTasks = 0;
  let pinnedPeople = 0;

  for (const [slug, ini] of Object.entries(data) as [string, any][]) {
    await pool.query(
      `INSERT INTO initiatives (slug, name, description, status, owner, notion_project, keywords, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (slug) DO UPDATE SET
         name = $2, description = $3, status = $4, keywords = $7`,
      [slug, ini.name, ini.description || "", ini.status || "active", ini.owner || "Jason",
       ini.notionProject || null, ini.keywords || [], ini.createdAt || "2026-03-01"]
    );
    initCount++;

    // Pinned tasks
    for (const taskId of ini.pinnedTaskIds || []) {
      try {
        await pool.query(
          `INSERT INTO initiative_pinned_tasks (initiative_slug, task_id) VALUES ($1, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [slug, taskId]
        );
        pinnedTasks++;
      } catch {
        // Task may not exist in tasks table yet (Phase 5)
      }
    }

    // Pinned people
    for (const person of ini.pinnedPeople || []) {
      await pool.query(
        `INSERT INTO initiative_pinned_people (initiative_slug, person_name) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [slug, person]
      );
      pinnedPeople++;
    }
  }

  console.log(`  initiatives: ${initCount}`);
  console.log(`  pinned_tasks: ${pinnedTasks} (some may fail due to missing tasks table)`);
  console.log(`  pinned_people: ${pinnedPeople}`);

  console.log("\nDone.");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
