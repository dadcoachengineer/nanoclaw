/**
 * Phase 4: Backfill archive files to PostgreSQL.
 * Reads all JSON files from store/archive/{type}/ and inserts into archive_items table.
 */
import pg from "pg";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const ARCHIVE_DIR = path.join(STORE_DIR, "archive");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL });
  console.log("Phase 4: Backfilling archive → PostgreSQL\n");

  const types = ["transcripts", "messages", "emails", "boox", "plaud", "summaries"];
  let total = 0;

  for (const type of types) {
    const dir = path.join(ARCHIVE_DIR, type);
    if (!fs.existsSync(dir)) { console.log(`  ${type}: 0 (directory missing)`); continue; }

    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    let count = 0;

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        const id = file.replace(".json", "");
        const content = data.content || data.text || data.body || JSON.stringify(data);

        await pool.query(
          `INSERT INTO archive_items (id, source_type, title, date, content, metadata, archived_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (id, source_type) DO UPDATE SET
             title = COALESCE($3, archive_items.title),
             content = COALESCE($5, archive_items.content)`,
          [
            id, type,
            data.title || data.meeting || data.subject || file,
            data.date || data.timestamp || data.archivedAt || null,
            content,
            JSON.stringify({
              speakers: data.speakers,
              charCount: data.charCount || content.length,
              source: data.source,
              roomId: data.roomId,
              page: data.page,
              from: data.from,
              to: data.to,
            }),
            data.archivedAt || new Date().toISOString(),
          ]
        );
        count++;
      } catch (err: any) {
        console.error(`  Error on ${type}/${file}: ${err.message}`);
      }
    }

    console.log(`  ${type}: ${count} items`);
    total += count;
  }

  // Also backfill artifacts
  const artifactsDir = path.join(STORE_DIR, "artifacts");
  if (fs.existsSync(path.join(artifactsDir, "index.json"))) {
    const index = JSON.parse(fs.readFileSync(path.join(artifactsDir, "index.json"), "utf-8"));
    let artCount = 0;
    for (const a of index) {
      try {
        const fpath = path.join(artifactsDir, a.filename);
        const content = fs.existsSync(fpath) ? fs.readFileSync(fpath, "utf-8") : "";
        await pool.query(
          `INSERT INTO artifacts (id, title, intent, task_title, project, sources, mentioned_people, content, char_count, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (id) DO NOTHING`,
          [a.id, a.title, a.intent, a.taskTitle || null, a.project || null,
           a.sources || [], a.mentionedPeople || [], content, content.length,
           a.createdAt || new Date().toISOString()]
        );
        artCount++;
      } catch {}
    }
    console.log(`  artifacts: ${artCount}`);
  }

  const pgTotal = (await pool.query("SELECT COUNT(*) as c FROM archive_items")).rows[0].c;
  console.log(`\n  Total archive_items in PG: ${pgTotal}`);

  await pool.end();
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
