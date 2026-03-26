/**
 * Vector search helper — called by dashboard API route.
 * Usage: node scripts/vector-search.cjs <embedding_json> <limit> [source_filter]
 * Outputs JSON array of results to stdout.
 */
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const path = require("path");

const STORE_DIR = path.join(__dirname, "..", "store");
const vecJson = process.argv[2];
const limit = parseInt(process.argv[3] || "30", 10);
const sourceFilter = process.argv[4] || "";

const db = new Database(path.join(STORE_DIR, "vectors.db"), { readonly: true });
sqliteVec.load(db);

const vec = new Float32Array(JSON.parse(vecJson));

const rows = db
  .prepare(
    `SELECT v.id, v.distance, c.source, c.text, c.metadata
     FROM vec_chunks v
     JOIN chunks c ON c.id = v.id
     WHERE v.embedding MATCH ? AND k = ?
     ORDER BY v.distance`
  )
  .all(vec, limit);

db.close();

let results = rows.map((r) => ({
  id: r.id,
  source: r.source,
  text: r.text,
  metadata: JSON.parse(r.metadata),
  distance: r.distance,
}));

if (sourceFilter) {
  results = results.filter((r) => r.source === sourceFilter);
}

console.log(JSON.stringify(results));
