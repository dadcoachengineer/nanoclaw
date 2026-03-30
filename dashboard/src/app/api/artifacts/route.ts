import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * GET /api/artifacts?taskId=xxx — list artifacts for a task
 * GET /api/artifacts?person=name — list artifacts mentioning a person
 * GET /api/artifacts?project=name — list artifacts for a project
 * GET /api/artifacts?id=xxx — get single artifact with content
 * GET /api/artifacts — list all
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const taskId = searchParams.get("taskId");
  const person = searchParams.get("person");
  const project = searchParams.get("project");

  // Single artifact with content
  if (id) {
    const artifact = await sqlOne(
      "SELECT * FROM artifacts WHERE id = $1", [id]
    );
    if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      id: artifact.id, title: artifact.title, intent: artifact.intent,
      taskId: artifact.task_id, taskTitle: artifact.task_title,
      project: artifact.project, sources: artifact.sources,
      mentionedPeople: artifact.mentioned_people,
      content: artifact.content, charCount: artifact.char_count,
      createdAt: artifact.created_at,
    });
  }

  // Build query with filters
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (taskId) { conditions.push(`task_id = $${idx}::uuid`); params.push(taskId); idx++; }
  if (person) { conditions.push(`$${idx} = ANY(mentioned_people)`); params.push(person); idx++; }
  if (project) { conditions.push(`project ILIKE $${idx}`); params.push(`%${project}%`); idx++; }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await sql(
    `SELECT id, title, intent, task_id, task_title, project, sources, mentioned_people, char_count, created_at
     FROM artifacts ${where} ORDER BY created_at DESC LIMIT 50`,
    params
  );

  return NextResponse.json(rows.map((a: any) => ({
    id: a.id, title: a.title, intent: a.intent,
    taskId: a.task_id, taskTitle: a.task_title,
    project: a.project, sources: a.sources,
    mentionedPeople: a.mentioned_people,
    charCount: a.char_count, createdAt: a.created_at,
  })));
}

/**
 * POST /api/artifacts — save a new artifact
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { title, content, intent, taskId, taskTitle, project, sources } = await req.json();
    if (!title || !content) return NextResponse.json({ error: "title and content required" }, { status: 400 });

    const dateStr = new Date().toISOString().slice(0, 10);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const id = `${dateStr}-${slug}-${Date.now().toString(36)}`;

    // Extract mentioned people
    let mentionedPeople: string[] = [];
    try {
      const people = await sql("SELECT name FROM people WHERE length(name) >= 4");
      for (const p of people) {
        const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "i").test(content)) {
          mentionedPeople.push(p.name);
        }
      }
    } catch {}

    await sql(
      `INSERT INTO artifacts (id, title, intent, task_id, task_title, project, sources, mentioned_people, content, char_count, created_at)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, now())`,
      [id, title, intent || "research", taskId || null, taskTitle || null,
       project || null, sources || [], mentionedPeople, content, content.length]
    );

    // Index in vector DB
    try {
      const chunks = content.match(/.{1,500}/gs) || [content];
      for (const chunk of chunks.slice(0, 20)) {
        await sql(
          "INSERT INTO vector_chunks (id, source, text, metadata) VALUES ($1, 'artifact', $2, $3::jsonb)",
          [`art-${id}-${Math.random().toString(36).slice(2, 8)}`, `Artifact "${title}": ${chunk}`, JSON.stringify({ artifactId: id })]
        );
      }
    } catch {}

    // Link to task notes if taskId provided
    if (taskId) {
      try {
        await sql(
          `UPDATE tasks SET notes = COALESCE(notes, '') || E'\n[Artifact: ${title.replace(/'/g, "''")}] (${dateStr})',
           notion_sync_status = 'pending', updated_at = now()
           WHERE id = $1::uuid`,
          [taskId]
        );
      } catch {}
    }

    const meta = { id, title, intent: intent || "research", taskId, taskTitle, project, sources: sources || [], mentionedPeople, charCount: content.length, createdAt: new Date().toISOString() };
    return NextResponse.json(meta);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
