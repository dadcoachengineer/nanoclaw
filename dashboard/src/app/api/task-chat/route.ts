import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";
import { ollamaChat } from "@/lib/ollama-client";

const MODEL = "gemma3:27b";

const STOP_WORDS = new Set(["this","that","with","from","about","follow","confirm","tomorrow","today","week","next","talk","call","send","email","update","need","want","back","into","over","your","they","have","been","will","would","could","should","just","also","some","more","very","most","like"]);

async function findMentionedPeople(text: string): Promise<string> {
  const people = await sql("SELECT key, name FROM people WHERE length(name) >= 4");
  const found: string[] = [];
  for (const p of people) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) { found.push(p.key); continue; }
    const parts = p.name.split(/\s+/);
    // Match last name (>= 4 chars)
    if (parts.length >= 2 && parts[parts.length - 1].length >= 4) {
      const last = parts[parts.length - 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${last}\\b`, "i").test(text)) { found.push(p.key); continue; }
    }
    // Match first name (>= 5 chars to avoid false positives)
    if (parts.length >= 2 && parts[0].length >= 5) {
      const first = parts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${first}\\b`, "i").test(text)) found.push(p.key);
    }
  }
  if (found.length === 0) return "";
  const placeholders = found.map((_, i) => `$${i + 1}`).join(",");
  const rows = await sql(
    `SELECT p.name, pe.email,
            (SELECT string_agg('[' || me.date::date || '] ' || LEFT(me.text, 200), E'\n')
             FROM (SELECT * FROM message_excerpts WHERE person_id = p.id ORDER BY date DESC LIMIT 3) me
            ) as recent_messages,
            (SELECT string_agg(sub.info, ', ')
             FROM (SELECT m.topic || ' (' || m.date::date || ')' as info
                   FROM meeting_participants mp JOIN meetings m ON m.id = mp.meeting_id
                   WHERE mp.person_id = p.id ORDER BY m.date DESC LIMIT 3) sub
            ) as recent_meetings
     FROM people p
     LEFT JOIN person_emails pe ON pe.person_id = p.id AND pe.is_primary = true
     WHERE p.key IN (${placeholders})`, found
  );
  let ctx = "\n## People involved\n";
  for (const r of rows as any[]) {
    ctx += `- ${r.name}${r.email ? ` (${r.email})` : ""}\n`;
    if (r.recent_messages) ctx += `  Recent messages:\n  ${r.recent_messages.split("\n").join("\n  ")}\n`;
    if (r.recent_meetings) ctx += `  Recent meetings: ${r.recent_meetings}\n`;
  }
  return ctx;
}

async function searchRelated(title: string): Promise<string> {
  const keywords = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
  if (keywords.length === 0) return "";
  const conditions = keywords.map((_, i) => `text ILIKE $${i + 1}`).join(" OR ");
  const params = keywords.map((k) => `%${k}%`);
  const hits = await sql(
    `SELECT source, LEFT(text, 400) as text FROM vector_chunks WHERE ${conditions} ORDER BY id DESC LIMIT 5`, params
  );
  if (hits.length === 0) return "";
  let ctx = "\n## Related conversations (real messages from Jason's history — use the content directly, do not cite source labels)\n";
  for (const h of hits) ctx += `- ${h.source}: ${h.text}\n`;
  return ctx;
}

/** GET /api/task-chat?taskId=xxx — load chat history */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const taskId = req.nextUrl.searchParams.get("taskId");
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });

  const messages = await sql(
    "SELECT id, role, content, created_at FROM task_chat_messages WHERE task_id = $1::uuid ORDER BY created_at ASC",
    [taskId]
  );
  return NextResponse.json({ messages });
}

// Force Node.js runtime for streaming support
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST /api/task-chat — send message, stream response */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId, message } = await req.json();
  if (!taskId || !message) return NextResponse.json({ error: "taskId and message required" }, { status: 400 });

  // Save user message
  await sql(
    "INSERT INTO task_chat_messages (task_id, role, content) VALUES ($1::uuid, 'user', $2)",
    [taskId, message]
  );

  // Gather context
  const task = await sqlOne("SELECT * FROM tasks WHERE id = $1::uuid", [taskId]);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const title = task.title || "";
  const notes = task.notes || "";
  const taskText = `${title} ${notes}`;

  const [peopleCtx, relatedCtx, artifacts, priorMessages, archiveContent] = await Promise.all([
    findMentionedPeople(taskText),
    searchRelated(title),
    sql("SELECT title, intent, LEFT(content, 1500) as preview FROM artifacts WHERE task_id = $1::uuid", [taskId]),
    sql("SELECT role, content FROM task_chat_messages WHERE task_id = $1::uuid ORDER BY created_at ASC", [taskId]),
    // Try to find source archive content
    (async () => {
      if (!notes) return "";
      const meetingMatch = notes.match(/From (?:recording|meeting): (.+?)(?:\.|$)/i);
      if (meetingMatch) {
        const hit = await sqlOne(
          "SELECT LEFT(content, 2000) as content FROM archive_items WHERE title ILIKE $1 LIMIT 1",
          [`%${meetingMatch[1].trim().slice(0, 60)}%`]
        );
        if (hit?.content) return `\n## Source transcript (excerpt)\n${hit.content}\n`;
      }
      return "";
    })(),
  ]);

  let artifactCtx = "";
  if (artifacts.length > 0) {
    artifactCtx = "\n## Artifacts\n";
    for (const a of artifacts) artifactCtx += `- ${a.title} (${a.intent}): ${(a.preview || "").slice(0, 200)}\n`;
  }

  const systemPrompt = `You are Jason Shearer's task reasoning assistant. You help him think through tasks, brainstorm, plan next steps, and draft content.

RULES:
- Be direct and specific to THIS task. No generic advice.
- USE the context below — reference specific people, conversations, and artifacts by name.
- When Jason tells you something is done, acknowledge it and move forward. Do not re-suggest completed steps.
- Plain text only. No markdown headers (###), no bold (**), no bullet formatting. Use short paragraphs and numbered lists if needed.
- Keep responses under 300 words unless Jason asks for detail.
- If you have real context from messages, transcripts, or artifacts, cite it. If you don't have info, say so — never make up details.

## Task
Title: ${title}
Priority: ${task.priority || "P2"}
Status: ${task.status || "Not started"}
Project: ${task.project || "Unknown"}
Source: ${task.source || "Unknown"}
Notes: ${notes}
${peopleCtx}${relatedCtx}${artifactCtx}${archiveContent}`;

  // Build messages array: system + prior history + new user message
  const ollamaMessages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];

  // Include up to last 20 messages for conversation continuity
  const recentMessages = priorMessages.slice(-20);
  for (const m of recentMessages) {
    ollamaMessages.push({ role: m.role, content: m.content });
  }

  try {
    const result = await ollamaChat({
      model: MODEL,
      messages: ollamaMessages,
      options: { num_ctx: 16384, temperature: 0.4 },
      timeoutMs: 120000,
    });
    let content = result.content;

    // Save assistant message to DB
    const saved = await sqlOne(
      "INSERT INTO task_chat_messages (task_id, role, content) VALUES ($1::uuid, 'assistant', $2) RETURNING id",
      [taskId, content]
    );

    return NextResponse.json({ id: saved?.id, role: "assistant", content, created_at: new Date().toISOString() });
  } catch (err) {
    console.error(`[task-chat] Error:`, err);
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
