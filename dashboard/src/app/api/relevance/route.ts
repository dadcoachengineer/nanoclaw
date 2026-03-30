import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * POST /api/relevance — record an up/down vote
 *
 * Body: { context: string, itemType: string, itemId: string, vote: "up" | "down" }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    const delta = vote === "up" ? 1 : -1;

    const row = await sqlOne<{ score: number }>(
      `INSERT INTO relevance_scores (key, score, last_vote)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET score = relevance_scores.score + $2, last_vote = now()
       RETURNING score`,
      [key, delta],
    );

    return NextResponse.json({ ok: true, key, score: row!.score });
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
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
    const rows = await sql<{ key: string; score: number }>(
      "SELECT key, score FROM relevance_scores WHERE key LIKE $1",
      [`${prefix}%`],
    );

    const matched: Record<string, number> = {};
    for (const row of rows) {
      const suffix = row.key.slice(prefix.length);
      matched[suffix] = row.score;
    }

    return NextResponse.json({ scores: matched });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
