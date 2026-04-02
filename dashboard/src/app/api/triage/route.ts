import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";
import { ollamaChat } from "@/lib/ollama-client";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const TEAM_PATH = path.join(STORE_DIR, "team.json");

/**
 * GET /api/triage — returns tasks in triage inbox from PostgreSQL
 * Optional: ?suggest=true to include AI-suggested actions
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const suggest = req.nextUrl.searchParams.get("suggest") === "true";

  try {
    // Query PG directly — no Notion API calls
    const inbox = await sql(
      `SELECT id, title, priority, status, source, project, context, delegated_to,
              notes, triage_status, created_at
       FROM tasks
       WHERE triage_status = 'inbox' AND status != 'Done'
       ORDER BY created_at DESC
       LIMIT 50`
    );

    const queueCount = await sqlOne<{ c: string }>(
      "SELECT COUNT(*) as c FROM tasks WHERE triage_status = 'accepted' AND status != 'Done'"
    );

    let suggestions: Record<string, { action: string; confidence: number; reason: string }> = {};

    if (suggest && inbox.length > 0) {
      const decisionCount = await sqlOne<{ c: string }>("SELECT COUNT(*) as c FROM triage_decisions");
      if (parseInt(decisionCount?.c || "0") >= 5) {
        try {
          const recentDecisions = await sql(
            `SELECT title, source, project, action, delegated_to, priority
             FROM triage_decisions ORDER BY decided_at DESC LIMIT 50`
          );
          const decisionsText = recentDecisions.map((d) =>
            `"${d.title}" (${d.source}, ${d.project}) → ${d.action}${d.delegated_to ? ` to ${d.delegated_to}` : ""}${d.priority ? ` as ${d.priority}` : ""}`
          ).join("\n");

          const inboxSummary = inbox.slice(0, 15).map((t) =>
            `ID:${t.id.slice(0, 8)} "${t.title}" (Source: ${t.source}, Project: ${t.project})`
          ).join("\n");

          let team = "";
          try { team = JSON.parse(fs.readFileSync(TEAM_PATH, "utf-8"))?.members?.map((m: any) => m.name).join(", ") || ""; } catch {}

          const triageResult = await ollamaChat({
            model: "phi4:14b",
            messages: [{ role: "user", content: `/no_think\nBased on Jason's past triage decisions, suggest an action for each new task.\n\nPast decisions:\n${decisionsText}\n\nTeam: ${team}\n\nNew tasks:\n${inboxSummary}\n\nFor each task ID, respond with one JSON object per line:\n{"id":"<8-char-id>","action":"accept|delegate|dismiss","delegatedTo":"<name or empty>","priority":"P0|P1|P2|P3","confidence":0.0-1.0,"reason":"<brief reason>"}\n\nOutput ONLY JSON lines.` }],
            options: { num_ctx: 4096 },
          });
          if (triageResult.content) {
            for (const line of triageResult.content.split("\n")) {
              try {
                const parsed = JSON.parse(line.trim());
                if (parsed.id) {
                  const fullId = inbox.find((t) => t.id.startsWith(parsed.id))?.id;
                  if (fullId) suggestions[fullId] = { action: parsed.action, confidence: parsed.confidence || 0.5, reason: `${parsed.reason || ""}${parsed.delegatedTo ? ` → ${parsed.delegatedTo}` : ""}${parsed.priority ? ` (${parsed.priority})` : ""}` };
                }
              } catch {}
            }
          }
        } catch {}
      }
    }

    return NextResponse.json({
      inbox,
      queueCount: parseInt(queueCount?.c || "0"),
      suggestions,
      decisionCount: parseInt((await sqlOne<{ c: string }>("SELECT COUNT(*) as c FROM triage_decisions"))?.c || "0"),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/triage — process a triage decision
 * Body: { taskId, action, priority?, delegatedTo?, title?, source?, project? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { taskId, title, source, project, action, priority, delegatedTo } = body;

    if (!taskId || !action) {
      return NextResponse.json({ error: "taskId and action required" }, { status: 400 });
    }

    // Log the decision for RLHF
    await sql(
      `INSERT INTO triage_decisions (task_id, title, source, project, action, priority, delegated_to, decided_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, now())`,
      [taskId, title || "", source || "", project || "", action, priority || null, delegatedTo || null]
    );

    // Execute the action on the task
    if (action === "accept") {
      await sql(
        `UPDATE tasks SET triage_status = 'accepted', priority = COALESCE($2, priority),
         notion_sync_status = 'pending', updated_at = now() WHERE id = $1::uuid`,
        [taskId, priority || null]
      );
    } else if (action === "delegate") {
      await sql(
        `UPDATE tasks SET triage_status = 'accepted', delegated_to = $2,
         priority = COALESCE($3, priority), notion_sync_status = 'pending', updated_at = now()
         WHERE id = $1::uuid`,
        [taskId, delegatedTo || null, priority || null]
      );
    } else if (action === "dismiss") {
      await sql(
        `UPDATE tasks SET status = 'Done', triage_status = 'accepted',
         notion_sync_status = 'pending', updated_at = now() WHERE id = $1::uuid`,
        [taskId]
      );
    }

    return NextResponse.json({ ok: true, action });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * PATCH /api/triage — bulk accept (seed existing tasks)
 * Body: { acceptAll: true }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { acceptAll } = await req.json();
    if (acceptAll) {
      const result = await sql(
        "UPDATE tasks SET triage_status = 'accepted' WHERE triage_status = 'inbox' RETURNING id"
      );
      return NextResponse.json({ accepted: result.length });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
