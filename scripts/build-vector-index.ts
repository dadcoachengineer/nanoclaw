/**
 * Build vector embeddings for semantic search across all data sources.
 * Uses Ollama nomic-embed-text for local embeddings and SQLite-vec for storage.
 *
 * Chunks and embeds: transcript segments, Notion tasks, Webex messages.
 * Stores in store/vectors.db
 *
 * Usage: npx tsx scripts/build-vector-index.ts
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";

const STORE_DIR = path.join(process.cwd(), "store");
const VECTOR_DB_PATH = path.join(STORE_DIR, "vectors.db");
const PERSON_INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const TOPIC_INDEX_PATH = path.join(STORE_DIR, "topic-index.json");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = "nomic-embed-text";
const DIMENSIONS = 768;
const BATCH_SIZE = 20;

interface Chunk {
  id: string;
  source: string; // "transcript", "notion_task", "webex_message"
  text: string;
  metadata: Record<string, string>;
}

// --- Ollama embeddings ---

async function embed(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings;
}

// --- Database setup ---

function initDb(): Database.Database {
  const db = new Database(VECTOR_DB_PATH);
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata TEXT NOT NULL,
      embedded_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${DIMENSIONS}]
    );
  `);

  return db;
}

// --- Chunk generators ---

function chunksFromPersonIndex(): Chunk[] {
  const chunks: Chunk[] = [];
  if (!fs.existsSync(PERSON_INDEX_PATH)) return chunks;

  const index = JSON.parse(fs.readFileSync(PERSON_INDEX_PATH, "utf-8"));

  for (const [key, person] of Object.entries(index) as [string, any][]) {
    // Transcript snippets — each is a chunk
    for (const t of person.transcriptMentions || []) {
      for (const snippet of t.snippets || []) {
        const id = `trans:${t.recordingId}:${person.name}:${snippet.slice(0, 20)}`;
        chunks.push({
          id,
          source: "transcript",
          text: `${person.name} said in meeting "${t.topic}": ${snippet}`,
          metadata: {
            person: person.name,
            meeting: t.topic,
            date: t.date,
            recordingId: t.recordingId,
          },
        });
      }
    }

    // Messages — each is a chunk
    for (const m of (person.messageExcerpts || []).slice(0, 10)) {
      if (!m.text || m.text.length < 10) continue;
      const id = `msg:${person.name}:${m.date}`;
      chunks.push({
        id,
        source: "webex_message",
        text: `Webex message with ${person.name}: ${m.text}`,
        metadata: {
          person: person.name,
          date: m.date,
          room: m.roomTitle,
        },
      });
    }

    // Notion tasks mentioning this person
    for (const t of person.notionTasks || []) {
      const id = `task:${t.id}`;
      if (chunks.find((c) => c.id === id)) continue; // dedup
      chunks.push({
        id,
        source: "notion_task",
        text: `Task: ${t.title} (Status: ${t.status})`,
        metadata: {
          taskId: t.id,
          status: t.status,
          person: person.name,
        },
      });
    }
  }

  return chunks;
}

function chunksFromTopicIndex(): Chunk[] {
  const chunks: Chunk[] = [];
  if (!fs.existsSync(TOPIC_INDEX_PATH)) return chunks;

  const index = JSON.parse(fs.readFileSync(TOPIC_INDEX_PATH, "utf-8"));

  for (const [key, topic] of Object.entries(index) as [string, any][]) {
    // Transcript key lines
    for (const t of topic.transcriptSnippets || []) {
      for (const line of (t.keyLines || []).slice(0, 5)) {
        const id = `topic:${topic.name}:${t.date}:${line.slice(0, 20)}`;
        if (chunks.find((c) => c.id === id)) continue;
        chunks.push({
          id,
          source: "transcript",
          text: `Meeting "${t.topic}" about ${topic.name}: ${line}`,
          metadata: {
            topic: topic.name,
            meeting: t.topic,
            date: t.date,
            speakers: (t.speakers || []).join(", "),
          },
        });
      }
    }

    // Topic Notion tasks (dedup with person chunks)
    for (const t of (topic.notionTasks || []).slice(0, 20)) {
      const id = `task:${t.id}`;
      if (chunks.find((c) => c.id === id)) continue;
      chunks.push({
        id,
        source: "notion_task",
        text: `Task about ${topic.name}: ${t.title} (Status: ${t.status}, Source: ${t.source})`,
        metadata: {
          taskId: t.id,
          topic: topic.name,
          status: t.status,
          source: t.source,
        },
      });
    }
  }

  return chunks;
}

// --- Main ---

async function main() {
  console.log("Building vector index...\n");

  const db = initDb();

  // Get existing chunk IDs to skip
  const existingIds = new Set(
    (db.prepare("SELECT id FROM chunks").all() as { id: string }[]).map(
      (r) => r.id
    )
  );
  console.log(`Existing chunks: ${existingIds.size}`);

  // Generate chunks from all sources
  const personChunks = chunksFromPersonIndex();
  const topicChunks = chunksFromTopicIndex();
  const allChunks = [...personChunks, ...topicChunks];

  // Dedup by ID
  const uniqueChunks = new Map<string, Chunk>();
  for (const c of allChunks) {
    if (!existingIds.has(c.id)) {
      uniqueChunks.set(c.id, c);
    }
  }

  const newChunks = Array.from(uniqueChunks.values());
  console.log(
    `New chunks to embed: ${newChunks.length} (${personChunks.length} from people, ${topicChunks.length} from topics, ${allChunks.length - uniqueChunks.size} dupes skipped)`
  );

  if (newChunks.length === 0) {
    console.log("Nothing new to embed. Done.");
    db.close();
    return;
  }

  // Embed in batches
  const insertChunk = db.prepare(
    "INSERT OR REPLACE INTO chunks (id, source, text, metadata, embedded_at) VALUES (?, ?, ?, ?, ?)"
  );
  const insertVec = db.prepare(
    "INSERT OR REPLACE INTO vec_chunks (id, embedding) VALUES (?, ?)"
  );

  let embedded = 0;
  for (let i = 0; i < newChunks.length; i += BATCH_SIZE) {
    const batch = newChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    try {
      const embeddings = await embed(texts);

      const tx = db.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const vec = embeddings[j];

          insertChunk.run(
            chunk.id,
            chunk.source,
            chunk.text,
            JSON.stringify(chunk.metadata),
            new Date().toISOString()
          );

          // sqlite-vec expects a Float32Array as a blob
          insertVec.run(chunk.id, new Float32Array(vec));
          embedded++;
        }
      });
      tx();

      if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= newChunks.length) {
        console.log(
          `  Embedded ${Math.min(i + BATCH_SIZE, newChunks.length)}/${newChunks.length}`
        );
      }
    } catch (err) {
      console.error(`  Batch error at ${i}:`, err);
    }
  }

  // Summary
  const totalChunks = (
    db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }
  ).n;
  const sources = db
    .prepare(
      "SELECT source, COUNT(*) as n FROM chunks GROUP BY source ORDER BY n DESC"
    )
    .all() as { source: string; n: number }[];

  console.log(`\n=== Vector Index Summary ===`);
  console.log(`Total chunks: ${totalChunks}`);
  console.log(`New embedded: ${embedded}`);
  for (const s of sources) {
    console.log(`  ${s.source}: ${s.n}`);
  }

  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
