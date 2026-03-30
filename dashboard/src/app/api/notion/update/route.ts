import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/** Extract value from Notion property format */
function extractPropValue(prop: any): string | null {
  if (!prop) return null;
  if (prop.title) return prop.title.map((t: any) => t.text?.content || t.plain_text || "").join("");
  if (prop.select) return prop.select?.name || null;
  if (prop.status) return prop.status?.name || null;
  if (prop.rich_text) return prop.rich_text.map((t: any) => t.text?.content || t.plain_text || "").join("");
  if (prop.date) return prop.date?.start || null;
  return null;
}

/**
 * PATCH /api/notion/update — update a task in PostgreSQL + queue Notion sync
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { page_id, properties, appendNote, comment } = body;

    if (!page_id) return NextResponse.json({ error: "page_id required" }, { status: 400 });

    // Build SQL updates from Notion property format
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    const propMap: Record<string, string> = {
      Task: "title", Priority: "priority", Status: "status", Source: "source",
      Project: "project", Context: "context", Zone: "zone",
      "Delegated To": "delegated_to", Energy: "energy", Notes: "notes",
    };

    if (properties) {
      for (const [key, val] of Object.entries(properties)) {
        const col = propMap[key];
        if (col) {
          const value = extractPropValue(val);
          updates.push(`${col} = $${idx}`);
          values.push(value);
          idx++;
        }
      }
    }

    // Handle appendNote
    if (appendNote) {
      const current = await sqlOne<{ notes: string }>("SELECT notes FROM tasks WHERE id = $1::uuid", [page_id]);
      const existing = current?.notes || "";
      const timestamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const newNotes = existing ? `${existing}\n\n[${timestamp}] ${appendNote}` : `[${timestamp}] ${appendNote}`;
      updates.push(`notes = $${idx}`);
      values.push(newNotes);
      idx++;
    }

    if (updates.length > 0) {
      updates.push("updated_at = now()");
      updates.push("notion_sync_status = 'pending'");
      values.push(page_id);
      await sql(`UPDATE tasks SET ${updates.join(", ")} WHERE id = $${idx}::uuid`, values);
    }

    // Return updated task in Notion page shape
    const row = await sqlOne(
      `SELECT id, title, priority, status, source, project, context, zone,
              delegated_to, energy, due_date, notes, updated_at, notion_page_id
       FROM tasks WHERE id = $1::uuid`,
      [page_id]
    );

    if (!row) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    return NextResponse.json({
      id: row.id,
      properties: {
        Task: { type: "title", title: [{ plain_text: row.title }] },
        Status: { type: "status", status: { name: row.status } },
        Priority: { type: "select", select: row.priority ? { name: row.priority } : null },
        Notes: { type: "rich_text", rich_text: row.notes ? [{ plain_text: row.notes }] : [] },
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

/**
 * POST /api/notion/update — create a new task in PostgreSQL + queue Notion sync
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { properties } = body;

    const title = extractPropValue(properties?.Task) || "Untitled";
    const priority = extractPropValue(properties?.Priority);
    const status = extractPropValue(properties?.Status) || "Not started";
    const source = extractPropValue(properties?.Source);
    const project = extractPropValue(properties?.Project);
    const context = extractPropValue(properties?.Context);
    const zone = extractPropValue(properties?.Zone);
    const delegatedTo = extractPropValue(properties?.["Delegated To"]);
    const notes = extractPropValue(properties?.Notes);

    const result = await sqlOne<{ id: string }>(
      `INSERT INTO tasks (id, title, priority, status, source, project, context, zone,
         delegated_to, notes, notion_sync_status, triage_status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'accepted', now(), now())
       RETURNING id`,
      [title, priority, status, source, project, context, zone, delegatedTo, notes]
    );

    return NextResponse.json({ id: result?.id, ok: true }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
