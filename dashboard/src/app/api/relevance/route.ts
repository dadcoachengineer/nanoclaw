import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const STORE_DIR =
  process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const SCORES_PATH = path.join(STORE_DIR, "relevance-scores.json");

type ScoreEntry = { score: number; lastVote: string };

function loadScores(): Record<string, ScoreEntry> {
  try {
    return JSON.parse(fs.readFileSync(SCORES_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveScores(scores: Record<string, ScoreEntry>): void {
  fs.writeFileSync(SCORES_PATH, JSON.stringify(scores, null, 2));
}

/**
 * POST /api/relevance — record an up/down vote
 *
 * Body: { context: string, itemType: string, itemId: string, vote: "up" | "down" }
 */
export async function POST(req: NextRequest) {
  try {
    const { context, itemType, itemId, vote } = await req.json();

    if (!context || !itemType || !itemId || !vote) {
      return NextResponse.json(
        { error: "context, itemType, itemId, and vote are required" },
        { status: 400 },
      );
    }

    if (vote !== "up" && vote !== "down") {
      return NextResponse.json(
        { error: 'vote must be "up" or "down"' },
        { status: 400 },
      );
    }

    const key = `${context}:${itemType}:${itemId}`;
    const scores = loadScores();
    const existing = scores[key]?.score ?? 0;
    const newScore = existing + (vote === "up" ? 1 : -1);

    scores[key] = { score: newScore, lastVote: new Date().toISOString() };
    saveScores(scores);

    return NextResponse.json({ ok: true, key, score: newScore });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * GET /api/relevance?context=prep:Jeff & Jason 1:1
 *
 * Returns all scores matching the context prefix, with the prefix stripped from keys.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const context = searchParams.get("context");

    if (!context) {
      return NextResponse.json(
        { error: "context query param is required" },
        { status: 400 },
      );
    }

    const prefix = `${context}:`;
    const allScores = loadScores();
    const matched: Record<string, number> = {};

    for (const [key, entry] of Object.entries(allScores)) {
      if (key.startsWith(prefix)) {
        const suffix = key.slice(prefix.length);
        matched[suffix] = entry.score;
      }
    }

    return NextResponse.json({ scores: matched });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
