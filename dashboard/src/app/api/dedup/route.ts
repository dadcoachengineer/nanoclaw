import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql } from "@/lib/pg";

// Title similarity (inlined from task-dedup)
const STOP_WORDS = new Set(["a","an","the","and","or","to","for","with","in","on","of","from","about","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","should","could","can","may","might","shall","that","this","these","those","it","its"]);

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/^(reply to|follow up with|respond to|schedule|connect with|check with|email|call|message|send)\s+/i, "")
    .replace(/[^a-z0-9\s]/g, "").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a), wordsB = tokenize(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setA = new Set(wordsA), setB = new Set(wordsB);
  return [...setA].filter((w) => setB.has(w)).length / Math.max(setA.size, setB.size);
}

function dismissKey(idA: string, idB: string): string { return [idA, idB].sort().join(":"); }

/**
 * GET /api/dedup — scan open tasks for duplicate pairs (from PG)
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tasks = await sql(
      `SELECT id, title, source, priority, project, delegated_to, notes
       FROM tasks WHERE status != 'Done' ORDER BY priority, created_at DESC`
    );

    // Load dismissed pairs from a simple PG table or keep in-memory for now
    const dismissed = new Set<string>();

    const pairs: { a: any; b: any; score: number }[] = [];
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const key = dismissKey(tasks[i].id, tasks[j].id);
        if (dismissed.has(key)) continue;
        let score = titleSimilarity(tasks[i].title, tasks[j].title);
        if (tasks[i].project === tasks[j].project && tasks[i].project) score += 0.1;
        if (score >= 0.4) {
          pairs.push({
            a: { id: tasks[i].id, title: tasks[i].title, source: tasks[i].source, priority: tasks[i].priority, project: tasks[i].project },
            b: { id: tasks[j].id, title: tasks[j].title, source: tasks[j].source, priority: tasks[j].priority, project: tasks[j].project },
            score: Math.round(score * 100) / 100,
          });
        }
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    return NextResponse.json({ pairs: pairs.slice(0, 50), total: pairs.length, scanned: tasks.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/dedup — merge or dismiss duplicate pairs
 * Body: { action: "merge"|"dismiss"|"merge-all-skips", pairA, pairB }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { action, pairA, pairB } = body;

    if (action === "merge" && pairA && pairB) {
      // Keep pairA (higher priority), mark pairB as Done
      const note = `[Dedup] Merged with: "${pairB.title}" on ${new Date().toLocaleDateString()}`;
      await sql(
        `UPDATE tasks SET notes = COALESCE(notes, '') || E'\n' || $2, notion_sync_status = 'pending', updated_at = now() WHERE id = $1::uuid`,
        [pairA.id, note]
      );
      await sql(
        `UPDATE tasks SET status = 'Done', notion_sync_status = 'pending', updated_at = now() WHERE id = $1::uuid`,
        [pairB.id]
      );
      return NextResponse.json({ ok: true, merged: pairB.id });
    }

    if (action === "dismiss" && pairA && pairB) {
      // Just acknowledge — we don't persist dismissals for now
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
