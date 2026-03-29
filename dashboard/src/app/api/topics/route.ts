import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const TOPIC_INDEX_PATH = path.join(STORE_DIR, "topic-index.json");

let cache: { data: unknown; loadedAt: number } | null = null;

function loadIndex() {
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache.data;
  try {
    const data = JSON.parse(fs.readFileSync(TOPIC_INDEX_PATH, "utf-8"));
    cache = { data, loadedAt: Date.now() };
    return data;
  } catch {
    return {};
  }
}

/**
 * GET /api/topics — list all topics with stats
 * GET /api/topics?name=Cisco+Spaces — get detail for one topic
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const name = searchParams.get("name");
  const index = loadIndex() as Record<string, unknown>;

  if (name) {
    const key = name.toLowerCase();
    const topic = index[key];
    if (!topic) return NextResponse.json({ error: "Topic not found" }, { status: 404 });
    return NextResponse.json(topic);
  }

  // Return summary of all topics
  const summary = Object.entries(index).map(([key, t]: [string, any]) => ({
    key,
    name: t.name,
    meetings: t.meetings?.length || 0,
    transcripts: t.transcriptSnippets?.length || 0,
    tasks: t.notionTasks?.length || 0,
    rooms: t.webexRooms?.length || 0,
    people: t.people?.length || 0,
  }));

  return NextResponse.json(summary);
}
