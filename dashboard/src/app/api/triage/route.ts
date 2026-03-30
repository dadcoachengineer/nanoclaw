import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const ACCEPTED_PATH = path.join(STORE_DIR, "triage-accepted.json");
const DECISIONS_PATH = path.join(STORE_DIR, "triage-decisions.json");
const TEAM_PATH = path.join(STORE_DIR, "team.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

function loadJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return []; }
}
function saveJson(p: string, data: any) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

interface TriageDecision {
  taskId: string;
  title: string;
  source: string;
  project: string;
  action: "accept" | "delegate" | "merge" | "dismiss" | "edit";
  priority?: string;
  delegatedTo?: string;
  mergedInto?: string;
  timestamp: string;
}

/**
 * GET /api/triage — returns tasks not yet accepted (triage inbox)
 * Optional: ?suggest=true to include AI-suggested actions
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const suggest = req.nextUrl.searchParams.get("suggest") === "true";

  try {
    const accepted = new Set<string>(loadJson(ACCEPTED_PATH));

    // Fetch all open tasks from Notion
    const resp = await proxiedFetch("https://api.notion.com/v1/databases/" + NOTION_DB + "/query", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
      body: JSON.stringify({
        filter: {
          and: [
            { property: "Status", status: { does_not_equal: "Done" } },
          ],
        },
        page_size: 100,
      }),
    });
    const data = await resp.json() as any;

    const allTasks = (data.results || []).map((p: any) => ({
      id: p.id,
      title: (p.properties?.Task?.title || []).map((t: any) => t.plain_text).join(""),
      priority: p.properties?.Priority?.select?.name || "",
      status: p.properties?.Status?.status?.name || "",
      source: p.properties?.Source?.select?.name || "",
      project: p.properties?.Project?.select?.name || "",
      context: p.properties?.Context?.select?.name || "",
      delegatedTo: p.properties?.["Delegated To"]?.select?.name || "",
      notes: (p.properties?.Notes?.rich_text || []).map((t: any) => t.plain_text).join("").slice(0, 200),
      createdTime: p.created_time,
    }));

    // Split into accepted (main queue) and triage (inbox)
    const inbox = allTasks.filter((t: any) => !accepted.has(t.id));
    const queue = allTasks.filter((t: any) => accepted.has(t.id));

    let suggestions: Record<string, { action: string; confidence: number; reason: string }> = {};

    // Generate suggestions if requested
    if (suggest && inbox.length > 0) {
      const decisions: TriageDecision[] = loadJson(DECISIONS_PATH);
      if (decisions.length >= 5) {
        // Use local model to suggest actions based on past decisions
        try {
          const recentDecisions = decisions.slice(-50).map((d) =>
            `"${d.title}" (${d.source}, ${d.project}) → ${d.action}${d.delegatedTo ? ` to ${d.delegatedTo}` : ""}${d.priority ? ` as ${d.priority}` : ""}`
          ).join("\n");

          const inboxSummary = inbox.slice(0, 15).map((t: any) =>
            `ID:${t.id.slice(0, 8)} "${t.title}" (Source: ${t.source}, Project: ${t.project})`
          ).join("\n");

          const team = loadJson(TEAM_PATH)?.members?.map((m: any) => m.name).join(", ") || "";

          const synthResp = await fetch("http://studio.shearer.live:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "qwen3-coder:30b",
              stream: false,
              options: { num_ctx: 4096 },
              messages: [{ role: "user", content: `/no_think
Based on Jason's past triage decisions, suggest an action for each new task.

Past decisions (what Jason typically does):
${recentDecisions}

Team members available for delegation: ${team}

New tasks to triage:
${inboxSummary}

For each task ID, respond with a JSON object on one line:
{"id":"<8-char-id>","action":"accept|delegate|dismiss","delegatedTo":"<name or empty>","priority":"P0|P1|P2|P3","confidence":0.0-1.0,"reason":"<brief reason>"}

Output ONLY JSON lines, one per task.` }],
            }),
          });

          if (synthResp.ok) {
            const { message } = await synthResp.json();
            const lines = (message?.content || "").split("\n");
            for (const line of lines) {
              try {
                const parsed = JSON.parse(line.trim());
                if (parsed.id) {
                  const fullId = inbox.find((t: any) => t.id.startsWith(parsed.id))?.id;
                  if (fullId) {
                    suggestions[fullId] = {
                      action: parsed.action,
                      confidence: parsed.confidence || 0.5,
                      reason: `${parsed.reason || ""}${parsed.delegatedTo ? ` → ${parsed.delegatedTo}` : ""}${parsed.priority ? ` (${parsed.priority})` : ""}`,
                    };
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }
    }

    return NextResponse.json({
      inbox: inbox.sort((a: any, b: any) => b.createdTime.localeCompare(a.createdTime)),
      queueCount: queue.length,
      suggestions,
      decisionCount: (loadJson(DECISIONS_PATH) as any[]).length,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/triage — process a triage decision
 * Body: { taskId, action, priority?, delegatedTo?, mergedInto? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { taskId, title, source, project, action, priority, delegatedTo, mergedInto } = body;

    if (!taskId || !action) {
      return NextResponse.json({ error: "taskId and action required" }, { status: 400 });
    }

    // Log the decision for RLHF
    const decisions: TriageDecision[] = loadJson(DECISIONS_PATH);
    decisions.push({
      taskId, title: title || "", source: source || "", project: project || "",
      action, priority, delegatedTo, mergedInto,
      timestamp: new Date().toISOString(),
    });
    saveJson(DECISIONS_PATH, decisions);

    // Execute the action
    const properties: Record<string, any> = {};

    if (action === "accept") {
      if (priority) properties.Priority = { select: { name: priority } };
      // Mark as accepted
      const accepted: string[] = loadJson(ACCEPTED_PATH);
      if (!accepted.includes(taskId)) accepted.push(taskId);
      saveJson(ACCEPTED_PATH, accepted);
    }

    if (action === "delegate") {
      if (delegatedTo) properties["Delegated To"] = { select: { name: delegatedTo } };
      if (priority) properties.Priority = { select: { name: priority } };
      const accepted: string[] = loadJson(ACCEPTED_PATH);
      if (!accepted.includes(taskId)) accepted.push(taskId);
      saveJson(ACCEPTED_PATH, accepted);
    }

    if (action === "dismiss") {
      properties.Status = { status: { name: "Done" } };
      const accepted: string[] = loadJson(ACCEPTED_PATH);
      if (!accepted.includes(taskId)) accepted.push(taskId);
      saveJson(ACCEPTED_PATH, accepted);
    }

    // Update Notion if we have property changes
    if (Object.keys(properties).length > 0) {
      await proxiedFetch(`https://api.notion.com/v1/pages/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({ properties }),
      });
    }

    return NextResponse.json({ ok: true, action });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * PATCH /api/triage — bulk accept (seed existing tasks as accepted)
 * Body: { acceptAll: true } — marks all current open tasks as accepted
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { acceptAll } = await req.json();
    if (acceptAll) {
      // Fetch all open task IDs and mark them as accepted
      const resp = await proxiedFetch("https://api.notion.com/v1/databases/" + NOTION_DB + "/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          filter: { property: "Status", status: { does_not_equal: "Done" } },
          page_size: 100,
        }),
      });
      const data = await resp.json() as any;
      const ids = (data.results || []).map((p: any) => p.id);

      // Paginate if needed
      let cursor = data.next_cursor;
      while (data.has_more && cursor) {
        const nextResp = await proxiedFetch("https://api.notion.com/v1/databases/" + NOTION_DB + "/query", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
          body: JSON.stringify({
            filter: { property: "Status", status: { does_not_equal: "Done" } },
            start_cursor: cursor,
            page_size: 100,
          }),
        });
        const nextData = await nextResp.json() as any;
        ids.push(...(nextData.results || []).map((p: any) => p.id));
        cursor = nextData.has_more ? nextData.next_cursor : null;
      }

      saveJson(ACCEPTED_PATH, ids);
      return NextResponse.json({ accepted: ids.length });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
