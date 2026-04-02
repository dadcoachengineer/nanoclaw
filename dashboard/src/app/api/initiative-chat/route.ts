import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";
import { ollamaChat } from "@/lib/ollama-client";

const MODEL = "gemma3:27b";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/initiative-chat?slug=xxx — load chat history */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const messages = await sql(
    "SELECT id, role, content, created_at FROM initiative_chat_messages WHERE initiative_slug = $1 ORDER BY created_at ASC",
    [slug]
  );
  return NextResponse.json({ messages });
}

/** POST /api/initiative-chat — send message, get response */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { slug, message } = await req.json();
  if (!slug || !message) return NextResponse.json({ error: "slug and message required" }, { status: 400 });

  // Save user message
  await sql(
    "INSERT INTO initiative_chat_messages (initiative_slug, role, content) VALUES ($1, 'user', $2)",
    [slug, message]
  );

  // Gather initiative context
  const ini = await sqlOne("SELECT * FROM initiatives WHERE slug = $1", [slug]);
  if (!ini) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });

  // Get all tasks
  const tasks = await sql(
    `SELECT t.title, t.priority, t.status, t.source, t.notes
     FROM initiative_pinned_tasks ipt JOIN tasks t ON t.id = ipt.task_id
     WHERE ipt.initiative_slug = $1`,
    [slug]
  );

  // Get all artifacts linked to initiative tasks
  const taskIds = (await sql(
    "SELECT task_id FROM initiative_pinned_tasks WHERE initiative_slug = $1", [slug]
  )).map((r: any) => r.task_id);

  let artifactCtx = "";
  if (taskIds.length > 0) {
    const ph = taskIds.map((_: any, i: number) => `$${i + 1}::uuid`).join(",");
    const arts = await sql(
      `SELECT title, LEFT(content, 1500) as preview FROM artifacts WHERE task_id IN (${ph}) ORDER BY created_at DESC LIMIT 5`,
      taskIds
    );
    if (arts.length > 0) {
      artifactCtx = "\n## Artifacts and plans\n";
      for (const a of arts) artifactCtx += `${a.title}:\n${a.preview}\n\n`;
    }
  }

  // Get people
  const people = await sql(
    `SELECT ipp.person_name, pe.email,
            (SELECT LEFT(text, 200) FROM message_excerpts me JOIN people pp ON pp.id = me.person_id WHERE pp.name ILIKE '%' || ipp.person_name || '%' ORDER BY me.date DESC LIMIT 1) as last_message
     FROM initiative_pinned_people ipp
     LEFT JOIN people p ON p.name ILIKE '%' || ipp.person_name || '%'
     LEFT JOIN person_emails pe ON pe.person_id = p.id AND pe.is_primary = true
     WHERE ipp.initiative_slug = $1`,
    [slug]
  );

  // Get phases
  const phases = await sql(
    "SELECT label, sort_order, start_date::text, end_date::text FROM initiative_phases WHERE initiative_slug = $1 ORDER BY sort_order",
    [slug]
  );

  // Prior chat
  const priorMessages = await sql(
    "SELECT role, content FROM initiative_chat_messages WHERE initiative_slug = $1 ORDER BY created_at ASC",
    [slug]
  );

  // Build context
  let tasksCtx = "\n## Tasks\n";
  for (const t of tasks) tasksCtx += `- [${t.priority || "?"}] ${t.status || "?"}: ${t.title}\n`;

  let peopleCtx = "";
  if (people.length > 0) {
    peopleCtx = "\n## People\n";
    for (const p of people) {
      peopleCtx += `- ${p.person_name}${p.email ? ` (${p.email})` : ""}`;
      if (p.last_message) peopleCtx += `: "${p.last_message}"`;
      peopleCtx += "\n";
    }
  }

  let phasesCtx = "";
  if (phases.length > 0) {
    phasesCtx = "\n## Phases\n";
    for (const ph of phases) phasesCtx += `${ph.sort_order + 1}. ${ph.label}${ph.start_date ? ` (${ph.start_date} — ${ph.end_date || "?"})` : ""}\n`;
  }

  const systemPrompt = `You are Jason Shearer's initiative reasoning assistant. You help him track progress, plan next steps, draft communications, and think strategically about this initiative.

RULES:
- Be direct and specific to THIS initiative. No generic advice.
- USE the context below — reference specific tasks, people, artifacts, and phases.
- When Jason tells you something is done, acknowledge it and move forward.
- Plain text only. No markdown headers, no bold, no bullet formatting. Use short paragraphs and numbered lists if needed.
- Keep responses under 300 words unless asked for detail.

## Initiative: ${ini.name}
Description: ${ini.description || ""}
Status: ${ini.status}
Target date: ${ini.target_date || "Not set"}
Progress: ${tasks.filter((t: any) => t.status === "Done").length}/${tasks.length} tasks done
${phasesCtx}${tasksCtx}${peopleCtx}${artifactCtx}`;

  const ollamaMessages: { role: string; content: string }[] = [
    { role: "system", content: systemPrompt },
  ];
  for (const m of priorMessages.slice(-20)) {
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

    const saved = await sqlOne(
      "INSERT INTO initiative_chat_messages (initiative_slug, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
      [slug, content]
    );

    return NextResponse.json({ id: saved?.id, role: "assistant", content, created_at: new Date().toISOString() });
  } catch (err) {
    console.error("[initiative-chat] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
