import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");

let cache: { data: unknown; loadedAt: number } | null = null;

function loadIndex() {
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache.data;
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    cache = { data, loadedAt: Date.now() };
    return data;
  } catch {
    return {};
  }
}

/**
 * GET /api/people — list all people with stats
 * GET /api/people?name=Tara+Clark — get detail for one person
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const name = searchParams.get("name");
  const index = loadIndex() as Record<string, any>;

  if (name) {
    // Find by name (fuzzy)
    const lower = name.toLowerCase();
    const key = lower.replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    let person = index[key];

    if (!person) {
      // Try partial match
      for (const [k, entry] of Object.entries(index) as [string, any][]) {
        if (
          entry.name.toLowerCase().includes(lower) ||
          lower.includes(entry.name.toLowerCase())
        ) {
          person = entry;
          break;
        }
      }
    }

    if (!person) return NextResponse.json({ error: "Person not found" }, { status: 404 });
    return NextResponse.json(person);
  }

  // Return summary of all people sorted by interaction volume
  const summary = Object.entries(index).map(([key, p]: [string, any]) => ({
    key,
    name: p.name,
    emails: p.emails || [],
    avatar: p.avatar || null,
    meetings: (p.meetings || []).length,
    transcripts: (p.transcriptMentions || []).length,
    messages: (p.messageExcerpts || []).length,
    tasks: (p.notionTasks || []).length,
    total:
      (p.meetings || []).length +
      (p.transcriptMentions || []).length +
      (p.messageExcerpts || []).length +
      (p.notionTasks || []).length,
  }));

  // Filter out low-signal entries (device names, bots, etc.)
  const filtered = summary.filter((p) => p.total > 1 || p.emails.length > 0);
  filtered.sort((a, b) => b.total - a.total);

  return NextResponse.json(filtered);
}
