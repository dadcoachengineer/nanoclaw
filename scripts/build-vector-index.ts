/**
 * Build vector embeddings for semantic search across all data sources.
 * Uses Ollama nomic-embed-text for local embeddings and SQLite-vec for storage.
 *
 * Sources:
 * - Full Webex meeting transcripts (chunked by speaker turns with overlap)
 * - Notion tasks
 * - Webex messages
 * - Person index context
 *
 * Stores in store/vectors.db
 *
 * Usage: npx tsx scripts/build-vector-index.ts
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";
import { ollamaEmbed } from './lib/ollama-client.js';

const STORE_DIR = path.join(process.cwd(), "store");
const VECTOR_DB_PATH = path.join(STORE_DIR, "vectors.db");
const PERSON_INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const TOPIC_INDEX_PATH = path.join(STORE_DIR, "topic-index.json");
const WEBEX_OAUTH_PATH = path.join(STORE_DIR, "webex-oauth.json");
const EMBED_MODEL = "nomic-embed-text";
const DIMENSIONS = 768;
const BATCH_SIZE = 20;

// Chunking config for transcripts
const CHUNK_TURNS = 6; // group N speaker turns per chunk
const CHUNK_OVERLAP = 2; // overlap N turns between chunks
const MAX_CHUNK_CHARS = 1500;

interface Chunk {
  id: string;
  source: string;
  text: string;
  metadata: Record<string, string>;
}

// --- Ollama embeddings (via shared client) ---

async function embed(texts: string[]): Promise<number[][]> {
  return ollamaEmbed({ model: EMBED_MODEL, input: texts });
}

// --- Webex helpers ---

function getWebexToken(): string {
  const config = JSON.parse(fs.readFileSync(WEBEX_OAUTH_PATH, "utf-8"));
  return config.access_token;
}

async function webexGet(path: string): Promise<unknown> {
  const resp = await fetch(`https://webexapis.com/v1${path}`, {
    headers: { Authorization: `Bearer ${getWebexToken()}` },
  });
  return resp.json();
}

// --- VTT parser ---

interface TranscriptTurn {
  speaker: string;
  text: string;
  timestamp: string;
}

function parseVTT(vtt: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const lines = vtt.split("\n");
  let currentSpeaker = "";
  let currentTimestamp = "";
  let currentText = "";

  const speakerRegex = /^\d+\s+"([^"]+)"\s+\(\d+\)\s*$/;
  const timeRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->/;

  for (const line of lines) {
    const speakerMatch = line.match(speakerRegex);
    if (speakerMatch) {
      // Save previous turn
      if (currentSpeaker && currentText.trim()) {
        turns.push({ speaker: currentSpeaker, text: currentText.trim(), timestamp: currentTimestamp });
      }
      currentSpeaker = speakerMatch[1];
      currentText = "";
      continue;
    }

    const timeMatch = line.match(timeRegex);
    if (timeMatch) {
      currentTimestamp = timeMatch[1];
      continue;
    }

    if (line.trim() && line !== "WEBVTT" && !line.match(/^\d+$/)) {
      currentText += " " + line.trim();
    }
  }

  // Last turn
  if (currentSpeaker && currentText.trim()) {
    turns.push({ speaker: currentSpeaker, text: currentText.trim(), timestamp: currentTimestamp });
  }

  return turns;
}

function chunkTranscript(
  turns: TranscriptTurn[],
  recordingId: string,
  topic: string,
  date: string
): Chunk[] {
  const chunks: Chunk[] = [];

  for (let i = 0; i < turns.length; i += CHUNK_TURNS - CHUNK_OVERLAP) {
    const window = turns.slice(i, i + CHUNK_TURNS);
    if (window.length === 0) break;

    let text = window
      .map((t) => `${t.speaker}: ${t.text}`)
      .join("\n");

    // Truncate if too long
    if (text.length > MAX_CHUNK_CHARS) {
      text = text.slice(0, MAX_CHUNK_CHARS) + "...";
    }

    const speakers = [...new Set(window.map((t) => t.speaker))];
    const id = `ftrans:${recordingId}:${i}`;

    chunks.push({
      id,
      source: "transcript",
      text: `Meeting "${topic}" (${date.slice(0, 10)}):\n${text}`,
      metadata: {
        recordingId,
        meeting: topic,
        date,
        speakers: speakers.join(", "),
        startTimestamp: window[0].timestamp,
        turnIndex: String(i),
      },
    });
  }

  return chunks;
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
    CREATE TABLE IF NOT EXISTS index_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

function getState(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM index_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value || null;
}

function setState(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO index_state (key, value) VALUES (?, ?)").run(key, value);
}

// --- Chunk generators ---

async function chunksFromFullTranscripts(db: Database.Database): Promise<Chunk[]> {
  console.log("Downloading full transcripts from Webex...");

  const processedIds = new Set(
    (getState(db, "processed_recordings") || "").split(",").filter(Boolean)
  );

  // Fetch all recordings going back 6 months
  const allRecordings: { id: string; topic: string; createTime: string }[] = [];
  const now = new Date();

  for (let monthsBack = 0; monthsBack <= 6; monthsBack++) {
    const from = new Date(now);
    from.setMonth(from.getMonth() - monthsBack - 1);
    from.setDate(1);
    const to = new Date(now);
    to.setMonth(to.getMonth() - monthsBack);
    to.setDate(0);
    if (to > now) to.setTime(now.getTime());

    try {
      const data = (await webexGet(
        `/recordings?from=${from.toISOString()}&to=${to.toISOString()}&max=50`
      )) as { items?: typeof allRecordings };
      allRecordings.push(...(data.items || []));
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  // Current month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  try {
    const data = (await webexGet(
      `/recordings?from=${monthStart.toISOString()}&to=${now.toISOString()}&max=50`
    )) as { items?: typeof allRecordings };
    allRecordings.push(...(data.items || []));
  } catch {}

  // Dedup
  const seen = new Set<string>();
  const unique = allRecordings.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  const newRecordings = unique.filter((r) => !processedIds.has(r.id));
  console.log(`  ${unique.length} recordings total, ${newRecordings.length} new to process`);

  const allChunks: Chunk[] = [];
  const newlyProcessed: string[] = [];

  for (const rec of newRecordings) {
    try {
      const detail = (await webexGet(`/recordings/${rec.id}`)) as {
        temporaryDirectDownloadLinks?: { transcriptDownloadLink?: string };
      };
      const url = detail.temporaryDirectDownloadLinks?.transcriptDownloadLink;
      if (!url) continue;

      const resp = await fetch(url);
      const vtt = await resp.text();
      const turns = parseVTT(vtt);

      if (turns.length === 0) continue;

      const chunks = chunkTranscript(turns, rec.id, rec.topic, rec.createTime);
      allChunks.push(...chunks);
      newlyProcessed.push(rec.id);

      console.log(
        `  ${rec.topic.slice(0, 50)} — ${turns.length} turns → ${chunks.length} chunks`
      );
    } catch {
      // Transcript not available
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Save processed IDs
  if (newlyProcessed.length > 0) {
    const all = [...processedIds, ...newlyProcessed];
    setState(db, "processed_recordings", all.join(","));
  }

  return allChunks;
}

function chunksFromPersonIndex(): Chunk[] {
  const chunks: Chunk[] = [];
  if (!fs.existsSync(PERSON_INDEX_PATH)) return chunks;
  const index = JSON.parse(fs.readFileSync(PERSON_INDEX_PATH, "utf-8"));

  for (const [key, person] of Object.entries(index) as [string, any][]) {
    // Messages
    for (const m of (person.messageExcerpts || []).slice(0, 10)) {
      if (!m.text || m.text.length < 10) continue;
      const id = `msg:${person.name}:${m.date}`;
      if (chunks.find((c) => c.id === id)) continue;
      chunks.push({
        id,
        source: "webex_message",
        text: `Webex message with ${person.name}: ${m.text}`,
        metadata: { person: person.name, date: m.date, room: m.roomTitle },
      });
    }

    // Notion tasks
    for (const t of person.notionTasks || []) {
      const id = `task:${t.id}`;
      if (chunks.find((c) => c.id === id)) continue;
      chunks.push({
        id,
        source: "notion_task",
        text: `Task: ${t.title} (Status: ${t.status})`,
        metadata: { taskId: t.id, status: t.status, person: person.name },
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
    for (const t of (topic.notionTasks || []).slice(0, 20)) {
      const id = `task:${t.id}`;
      if (chunks.find((c) => c.id === id)) continue;
      chunks.push({
        id,
        source: "notion_task",
        text: `Task about ${topic.name}: ${t.title} (Status: ${t.status}, Source: ${t.source})`,
        metadata: { taskId: t.id, topic: topic.name, status: t.status, source: t.source },
      });
    }
  }

  return chunks;
}

// --- Main ---

async function main() {
  console.log("Building vector index...\n");

  const db = initDb();

  const existingIds = new Set(
    (db.prepare("SELECT id FROM chunks").all() as { id: string }[]).map((r) => r.id)
  );
  console.log(`Existing chunks: ${existingIds.size}`);

  // Full transcript chunks (the big new addition)
  const transcriptChunks = await chunksFromFullTranscripts(db);
  const personChunks = chunksFromPersonIndex();
  const topicChunks = chunksFromTopicIndex();

  const allChunks = [...transcriptChunks, ...personChunks, ...topicChunks];

  // Dedup
  const uniqueChunks = new Map<string, Chunk>();
  for (const c of allChunks) {
    if (!existingIds.has(c.id)) {
      uniqueChunks.set(c.id, c);
    }
  }

  const newChunks = Array.from(uniqueChunks.values());
  console.log(
    `\nNew chunks to embed: ${newChunks.length} (${transcriptChunks.length} transcript, ${personChunks.length} person, ${topicChunks.length} topic)`
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
          insertChunk.run(
            batch[j].id,
            batch[j].source,
            batch[j].text,
            JSON.stringify(batch[j].metadata),
            new Date().toISOString()
          );
          insertVec.run(batch[j].id, new Float32Array(embeddings[j]));
          embedded++;
        }
      });
      tx();

      if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= newChunks.length) {
        console.log(`  Embedded ${Math.min(i + BATCH_SIZE, newChunks.length)}/${newChunks.length}`);
      }
    } catch (err) {
      console.error(`  Batch error at ${i}:`, err);
    }
  }

  // Summary
  const totalChunks = (db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }).n;
  const sources = db.prepare("SELECT source, COUNT(*) as n FROM chunks GROUP BY source ORDER BY n DESC").all() as { source: string; n: number }[];

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
