/**
 * Rebuild vector embeddings in PostgreSQL using nomic-embed-text on Mac Studio.
 * Reads text from vector_chunks, embeds in batches, writes embedding column.
 *
 * Usage: NODE_EXTRA_CA_CERTS=<ca> npx tsx scripts/rebuild-pg-embeddings.ts
 */
import pg from "pg";
import { ollamaEmbed } from './lib/ollama-client.js';

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";
const EMBED_MODEL = "nomic-embed-text";
const BATCH_SIZE = 20;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

async function main() {
  // Get chunks that need embeddings
  const { rows: chunks } = await pool.query(
    "SELECT id, LEFT(text, 2000) as text FROM vector_chunks WHERE embedding IS NULL ORDER BY id"
  );
  console.log(`${chunks.length} chunks need embeddings`);
  if (chunks.length === 0) { await pool.end(); return; }

  let embedded = 0;
  let errors = 0;
  const startTime = Date.now();

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c: any) => c.text.slice(0, 2000));

    try {
      const embeddings = await ollamaEmbed({ model: EMBED_MODEL, input: texts });

      for (let j = 0; j < batch.length; j++) {
        const vecStr = `[${embeddings[j].join(",")}]`;
        await pool.query(
          "UPDATE vector_chunks SET embedding = $1::vector WHERE id = $2",
          [vecStr, batch[j].id]
        );
        embedded++;
      }

      const pct = Math.round((embedded / chunks.length) * 100);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const rate = Math.round(embedded / (elapsed || 1) * 60);
      if (embedded % 100 === 0 || i + BATCH_SIZE >= chunks.length) {
        console.log(`${embedded}/${chunks.length} (${pct}%) — ${elapsed}s elapsed, ~${rate}/min`);
      }
    } catch (err: any) {
      console.error(`Batch ${i} error: ${err.message}`);
      errors++;
      if (errors > 5) { console.error("Too many errors, stopping"); break; }
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log(`\nDone: ${embedded} embedded, ${errors} errors, ${totalTime}s total`);

  // Verify
  const { rows: [{ count }] } = await pool.query(
    "SELECT COUNT(*) as count FROM vector_chunks WHERE embedding IS NOT NULL"
  );
  console.log(`PG embeddings: ${count}/${chunks.length}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
