import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { proxiedFetch } from "@/lib/onecli";

const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";
const STORE_DIR =
  process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const DISMISSED_PATH = path.join(STORE_DIR, "dedup-dismissed.json");

// ---------------------------------------------------------------------------
// Title similarity (inlined from scripts/lib/task-dedup.ts)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "to", "for", "with", "in", "on", "of",
  "from", "about", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should",
  "could", "can", "may", "might", "shall", "that", "this", "these",
  "those", "it", "its",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(
      /^(reply to|follow up with|respond to|schedule|connect with|check with|email|call|message|send)\s+/i,
      ""
    )
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function titleSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const overlap = [...setA].filter((w) => setB.has(w)).length;

  return overlap / Math.max(setA.size, setB.size);
}

// ---------------------------------------------------------------------------
// Dismissed pairs persistence
// ---------------------------------------------------------------------------

function loadDismissed(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(DISMISSED_PATH, "utf-8"));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(dismissed: Set<string>): void {
  fs.writeFileSync(
    DISMISSED_PATH,
    JSON.stringify([...dismissed], null, 2) + "\n",
    "utf-8"
  );
}

function dismissKey(idA: string, idB: string): string {
  return [idA, idB].sort().join(":");
}

// ---------------------------------------------------------------------------
// Notion helpers
// ---------------------------------------------------------------------------

async function notionPost(endpoint: string, body: unknown): Promise<unknown> {
  const resp = await proxiedFetch(`https://api.notion.com/v1${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function notionPatch(
  pageId: string,
  properties: Record<string, unknown>
): Promise<void> {
  await proxiedFetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    },
    body: JSON.stringify({ properties }),
  });
}

// ---------------------------------------------------------------------------
// GET handler -- scan for duplicate pairs
// ---------------------------------------------------------------------------

interface TaskRecord {
  id: string;
  title: string;
  source: string;
  priority: string;
  project: string;
  assignee: string;
  notes: string;
  url: string;
}

export async function GET() {
  try {
    // Fetch all open tasks (paginated, up to 500)
    const allPages: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const body: any = {
        filter: { property: "Status", status: { does_not_equal: "Done" } },
        sorts: [{ property: "Priority", direction: "ascending" }],
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;
      const data = (await notionPost(
        `/databases/${NOTION_DB}/query`,
        body
      )) as any;
      allPages.push(...(data.results || []));
      if (!data.has_more) break;
      cursor = data.next_cursor;
    }

    // Extract metadata
    const tasks: TaskRecord[] = allPages.map((t: any) => ({
      id: t.id,
      title:
        t.properties?.Task?.title?.map((x: any) => x.plain_text).join("") ||
        "",
      source: t.properties?.Source?.select?.name || "",
      project: t.properties?.Project?.select?.name || "",
      priority: t.properties?.Priority?.select?.name || "",
      assignee: t.properties?.Assignee?.select?.name || "",
      notes:
        t.properties?.Notes?.rich_text
          ?.map((x: any) => x.plain_text)
          .join("") || "",
      url: t.url,
    }));

    // Load dismissed pairs
    const dismissed = loadDismissed();

    // Find duplicate pairs
    interface DupePair {
      score: number;
      action: "skip" | "merge" | "review";
      taskA: Omit<TaskRecord, "notes" | "assignee">;
      taskB: Omit<TaskRecord, "notes" | "assignee">;
    }

    const pairs: DupePair[] = [];

    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const tScore = titleSimilarity(tasks[i].title, tasks[j].title);
        if (tScore < 0.3) continue;

        let totalScore = tScore;
        if (
          tasks[i].project &&
          tasks[i].project === tasks[j].project
        )
          totalScore += 0.1;
        if (
          tasks[i].assignee &&
          tasks[i].assignee === tasks[j].assignee
        )
          totalScore += 0.1;

        if (totalScore < 0.45) continue;

        // Skip dismissed pairs
        const key = dismissKey(tasks[i].id, tasks[j].id);
        if (dismissed.has(key)) continue;

        const action: DupePair["action"] =
          totalScore >= 0.8 ? "skip" : totalScore >= 0.5 ? "merge" : "review";

        pairs.push({
          score: Math.round(totalScore * 100) / 100,
          action,
          taskA: {
            id: tasks[i].id,
            title: tasks[i].title,
            source: tasks[i].source,
            priority: tasks[i].priority,
            project: tasks[i].project,
            url: tasks[i].url,
          },
          taskB: {
            id: tasks[j].id,
            title: tasks[j].title,
            source: tasks[j].source,
            priority: tasks[j].priority,
            project: tasks[j].project,
            url: tasks[j].url,
          },
        });
      }
    }

    // Sort by score descending
    pairs.sort((a, b) => b.score - a.score);

    const summary = {
      skip: pairs.filter((p) => p.action === "skip").length,
      merge: pairs.filter((p) => p.action === "merge").length,
      review: pairs.filter((p) => p.action === "review").length,
    };

    return NextResponse.json({
      totalTasks: tasks.length,
      pairs,
      summary,
    });
  } catch (err) {
    console.error("[dedup] GET error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST handler -- execute dedup actions
// ---------------------------------------------------------------------------

interface MergeBody {
  action: "merge";
  keepId: string;
  removeId: string;
  note: string;
}

interface DismissBody {
  action: "dismiss";
  idA: string;
  idB: string;
}

interface BulkMergeBody {
  action: "merge-all-skips";
  pairs: { keepId: string; removeId: string; note: string }[];
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (body.action === "merge") {
      const { keepId, removeId, note } = body as MergeBody;

      // Mark removeId as Done
      await notionPatch(removeId, {
        Status: { status: { name: "Done" } },
      });

      // Append corroboration note to keepId
      if (note) {
        await notionPatch(keepId, {
          Notes: {
            rich_text: [{ text: { content: note } }],
          },
        });
      }

      return NextResponse.json({ ok: true, message: `Merged: kept ${keepId}, removed ${removeId}` });
    }

    if (body.action === "dismiss") {
      const { idA, idB } = body as DismissBody;
      const dismissed = loadDismissed();
      dismissed.add(dismissKey(idA, idB));
      saveDismissed(dismissed);
      return NextResponse.json({ ok: true, message: "Pair dismissed" });
    }

    if (body.action === "merge-all-skips") {
      const { pairs } = body as BulkMergeBody;
      let merged = 0;
      const errors: string[] = [];

      for (const pair of pairs) {
        try {
          await notionPatch(pair.removeId, {
            Status: { status: { name: "Done" } },
          });
          if (pair.note) {
            await notionPatch(pair.keepId, {
              Notes: {
                rich_text: [{ text: { content: pair.note } }],
              },
            });
          }
          merged++;
        } catch (err) {
          errors.push(`${pair.removeId}: ${String(err)}`);
        }
      }

      return NextResponse.json({
        ok: true,
        message: `Merged ${merged} of ${pairs.length} pairs`,
        merged,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("[dedup] POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
