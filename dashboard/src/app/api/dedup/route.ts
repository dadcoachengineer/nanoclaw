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

    const pairs: { taskA: any; taskB: any; score: number; action: string }[] = [];
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const key = dismissKey(tasks[i].id, tasks[j].id);
        if (dismissed.has(key)) continue;
        let score = titleSimilarity(tasks[i].title, tasks[j].title);
        if (tasks[i].project === tasks[j].project && tasks[i].project) score += 0.1;
        if (score >= 0.4) {
          // Classify: >=0.8 = skip (near-exact dupe), >=0.6 = merge candidate, else review
          const action = score >= 0.8 ? "skip" : score >= 0.6 ? "merge" : "review";
          const makeTask = (t: any) => ({
            id: t.id, title: t.title, source: t.source || "",
            priority: t.priority || "", project: t.project || "",
            url: "", // PG tasks don't have Notion URLs
          });
          pairs.push({
            taskA: makeTask(tasks[i]),
            taskB: makeTask(tasks[j]),
            score: Math.round(score * 100) / 100,
            action,
          });
        }
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    const summary = {
      skip: pairs.filter((p) => p.action === "skip").length,
      merge: pairs.filter((p) => p.action === "merge").length,
      review: pairs.filter((p) => p.action === "review").length,
    };

    return NextResponse.json({ pairs: pairs.slice(0, 50), totalTasks: tasks.length, summary });
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
    const { action, keepId, removeId, note } = body;

    if (action === "merge" && keepId && removeId) {
      const mergeNote = note || `[Dedup] Merged on ${new Date().toLocaleDateString()}`;
      // Append merge note to the kept task
      await sql(
        `UPDATE tasks SET notes = COALESCE(notes, '') || E'\n' || $1, notion_sync_status = 'pending', updated_at = now() WHERE id = $2`,
        [mergeNote, keepId]
      );
      // Mark the duplicate as Done
      await sql(
        `UPDATE tasks SET status = 'Done', notion_sync_status = 'pending', updated_at = now() WHERE id = $1`,
        [removeId]
      );
      return NextResponse.json({ ok: true, merged: removeId, kept: keepId });
    }

    if (action === "merge-all-skips" && body.pairs?.length > 0) {
      let merged = 0;
      for (const pair of body.pairs) {
        const mergeNote = pair.note || `[Dedup] Bulk merged on ${new Date().toLocaleDateString()}`;
        try {
          await sql(
            `UPDATE tasks SET notes = COALESCE(notes, '') || E'\n' || $1, notion_sync_status = 'pending', updated_at = now() WHERE id = $2`,
            [mergeNote, pair.keepId]
          );
          await sql(
            `UPDATE tasks SET status = 'Done', notion_sync_status = 'pending', updated_at = now() WHERE id = $1`,
            [pair.removeId]
          );
          merged++;
        } catch { /* skip individual failures */ }
      }
      return NextResponse.json({ ok: true, merged });
    }

    if (action === "dismiss") {
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
