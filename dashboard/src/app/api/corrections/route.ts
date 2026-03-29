import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR =
  process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const CORRECTIONS_PATH = path.join(STORE_DIR, "corrections.json");

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

function loadCorrections(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(CORRECTIONS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveCorrections(corrections: Record<string, string>): void {
  fs.writeFileSync(CORRECTIONS_PATH, JSON.stringify(corrections, null, 2));
}

/**
 * PATCH /api/corrections
 *
 * Updates a Notion task title and learns word-level corrections
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

    // Update the Notion page title
    const resp = await proxiedFetch(
      `https://api.notion.com/v1/pages/${taskId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
          properties: {
            Task: {
              title: [{ text: { content: newTitle } }],
            },
          },
        }),
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      return NextResponse.json(
        { error: `Notion API error: ${err}` },
        { status: resp.status }
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

      // Skip stop words
      if (STOP_WORDS.has(ow.toLowerCase()) && STOP_WORDS.has(nw.toLowerCase()))
        continue;

      // Only learn if the words are close (likely a transcription error)
      if (areClose(ow, nw)) {
        learned[ow] = nw;
      }
    }

    // Merge into stored glossary
    if (Object.keys(learned).length > 0) {
      const existing = loadCorrections();
      const merged = { ...existing, ...learned };
      saveCorrections(merged);
    }

    return NextResponse.json({
      ok: true,
      corrections: Object.keys(learned).length,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
