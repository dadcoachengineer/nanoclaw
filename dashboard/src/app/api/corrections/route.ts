import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "with",
  "for",
  "to",
  "on",
  "in",
  "of",
  "at",
  "by",
  "from",
  "about",
  "into",
  "that",
  "this",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "can",
  "not",
  "but",
  "if",
  "we",
  "our",
  "my",
]);

/** Simple edit-distance (Levenshtein) for short strings. */
function editDistance(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  const dp: number[][] = Array.from({ length: la + 1 }, () =>
    Array(lb + 1).fill(0)
  );
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[la][lb];
}

/** Check whether two words are "close" enough to be a transcription correction. */
function areClose(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return false;

  // Similar length (within 2 chars)
  if (Math.abs(a.length - b.length) <= 2) return true;

  // One contains the other
  if (al.includes(bl) || bl.includes(al)) return true;

  // Low edit distance
  if (editDistance(al, bl) < 3) return true;

  return false;
}

/**
 * PATCH /api/corrections
 *
 * Updates a task title in PG and learns word-level corrections
 * from the diff between old and new titles.
 *
 * Body: { taskId: string, oldTitle: string, newTitle: string }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { taskId, oldTitle, newTitle } = await req.json();

    if (!taskId || !oldTitle || !newTitle) {
      return NextResponse.json(
        { error: "taskId, oldTitle, and newTitle are required" },
        { status: 400 }
      );
    }

    // Update the task title in PG and mark for Notion sync
    const updated = await sqlOne(
      `UPDATE tasks SET title = $1, notion_sync_status = 'pending', updated_at = now()
       WHERE id = $2::uuid RETURNING id`,
      [newTitle, taskId]
    );

    if (!updated) {
      return NextResponse.json(
        { error: "Task not found" },
        { status: 404 }
      );
    }

    // Compute word-level diff and extract corrections
    const oldWords = oldTitle.split(/\s+/).filter(Boolean);
    const newWords = newTitle.split(/\s+/).filter(Boolean);
    const learned: Record<string, string> = {};

    const len = Math.min(oldWords.length, newWords.length);
    for (let i = 0; i < len; i++) {
      const ow = oldWords[i];
      const nw = newWords[i];

      // Skip identical words
      if (ow === nw) continue;

      // Skip if EITHER word is a stop word (was &&, caused with→Story bug)
      if (STOP_WORDS.has(ow.toLowerCase()) || STOP_WORDS.has(nw.toLowerCase()))
        continue;

      // Safety: never learn corrections for short common words (caused IBEW, Tim, AEC bugs)
      if (ow.length <= 3 || nw.length <= 3) continue;

      // Only learn if the words are close (likely a transcription error)
      if (areClose(ow, nw)) {
        learned[ow] = nw;
      }
    }

    // Merge into corrections table
    if (Object.keys(learned).length > 0) {
      for (const [wrong, correct] of Object.entries(learned)) {
        await sql(
          `INSERT INTO corrections (wrong, correct)
           VALUES ($1, $2)
           ON CONFLICT (wrong) DO UPDATE SET correct = $2`,
          [wrong, correct]
        );
      }
    }

    return NextResponse.json({
      ok: true,
      corrections: Object.keys(learned).length,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
