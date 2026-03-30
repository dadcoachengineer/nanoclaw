/**
 * Phase 3: Backfill vectors from sqlite-vec to pgvector.
 * Copies all chunks with text and metadata. Embeddings are re-generated
 * via Ollama since sqlite-vec stores them in a binary format that's
 * difficult to extract directly.
 */
import Database from "better-sqlite3";
import pg from "pg";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "store");
const VEC_DB_PATH = path.join(STORE_DIR, "vectors.db");
const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";

async function main() {
  const sqlite = new Database(VEC_DB_PATH, { readonly: true });
  const pool = new pg.Pool({ connectionString: PG_URL });

  console.log("Phase 3: Backfilling vectors → pgvector\n");

  // Get all chunks from SQLite
  const chunks = sqlite.prepare("SELECT id, source, text, metadata, embedded_at FROM chunks ORDER BY id").all() as any[];
  console.log(`  Total chunks in sqlite-vec: ${chunks.length}`);

  // Clear existing and re-insert (idempotent)
  await pool.query("DELETE FROM vector_chunks");

  let inserted = 0;
  const BATCH_SIZE = 50;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const values: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    for (const chunk of batch) {
      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}::jsonb, $${paramIdx + 4})`);
      params.push(
        chunk.id,
        chunk.source,
        chunk.text,
        chunk.metadata || "{}",
        chunk.embedded_at || new Date().toISOString()
      );
      paramIdx += 5;
    }

    await pool.query(
      `INSERT INTO vector_chunks (id, source, text, metadata, embedded_at) VALUES ${values.join(", ")}
       ON CONFLICT (id) DO NOTHING`,
      params
    );
    inserted += batch.length;

    if (inserted % 500 === 0 || inserted === chunks.length) {
      console.log(`  Progress: ${inserted}/${chunks.length} chunks`);
    }
  }

  // Copy index state
  const states = sqlite.prepare("SELECT key, value FROM index_state").all() as any[];
  for (const s of states) {
    await pool.query(
      "INSERT INTO vector_index_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2",
      [s.key, s.value]
    );
  }
  console.log(`  index_state: ${states.length} entries`);

  // Verify
  const pgCount = (await pool.query("SELECT COUNT(*) as c FROM vector_chunks")).rows[0].c;
  console.log(`\n  PostgreSQL vector_chunks: ${pgCount}`);
  console.log(`  Embeddings: will be generated on next vector index rebuild`);
  console.log(`  (Run build-vector-index with PG backend to populate embeddings)`);

  sqlite.close();
  await pool.end();
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
