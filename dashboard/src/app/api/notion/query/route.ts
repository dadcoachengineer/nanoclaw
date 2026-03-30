import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql } from "@/lib/pg";

/**
 * POST /api/notion/query — query tasks from PostgreSQL (replaces Notion API)
 * Accepts Notion-style filter syntax, returns Notion-shaped results.
 * The frontend doesn't need to change.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { filter, page_size } = body;

    // Translate Notion filter syntax to SQL WHERE clause
    const { where, params } = translateFilter(filter);
    const limit = Math.min(page_size || 500, 500);

    const rows = await sql(
      `SELECT id, title, priority, status, source, project, context, zone,
              delegated_to, energy, due_date, notes, created_at, updated_at,
              notion_page_id
       FROM tasks
       ${where ? `WHERE ${where}` : ""}
       ORDER BY
         CASE WHEN priority LIKE 'P0%' THEN 0 WHEN priority LIKE 'P1%' THEN 1
              WHEN priority LIKE 'P2%' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT ${limit}`,
      params
    );

    // Convert PG rows to Notion page shape for frontend compatibility
    const results = rows.map((row: any) => pgRowToNotionPage(row));

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

/** Convert a PG task row to Notion page shape */
function pgRowToNotionPage(row: any) {
  return {
    id: row.id,
    last_edited_time: row.updated_at,
    url: row.notion_page_id ? `https://www.notion.so/${row.notion_page_id.replace(/-/g, "")}` : "",
    created_time: row.created_at,
    properties: {
      Task: { type: "title", title: [{ plain_text: row.title || "" }] },
      Priority: { type: "select", select: row.priority ? { name: row.priority } : null },
      Status: { type: "status", status: { name: row.status || "Not started" } },
      Source: { type: "select", select: row.source ? { name: row.source } : null },
      Project: { type: "select", select: row.project ? { name: row.project } : null },
      Context: { type: "select", select: row.context ? { name: row.context } : null },
      Zone: { type: "select", select: row.zone ? { name: row.zone } : null },
      "Delegated To": { type: "select", select: row.delegated_to ? { name: row.delegated_to } : null },
      Energy: { type: "select", select: row.energy ? { name: row.energy } : null },
      "Due Date": { type: "date", date: row.due_date ? { start: row.due_date } : null },
      Notes: { type: "rich_text", rich_text: row.notes ? [{ plain_text: row.notes }] : [] },
    },
  };
}

interface FilterResult {
  where: string;
  params: any[];
}

/** Translate Notion-style filter to SQL WHERE clause */
function translateFilter(filter: any, paramOffset = 0): FilterResult {
  if (!filter) return { where: "", params: [] };

  // AND
  if (filter.and) {
    const parts: string[] = [];
    const allParams: any[] = [];
    for (const sub of filter.and) {
      const result = translateFilter(sub, paramOffset + allParams.length);
      if (result.where) {
        parts.push(result.where);
        allParams.push(...result.params);
      }
    }
    return { where: parts.length > 0 ? `(${parts.join(" AND ")})` : "", params: allParams };
  }

  // OR
  if (filter.or) {
    const parts: string[] = [];
    const allParams: any[] = [];
    for (const sub of filter.or) {
      const result = translateFilter(sub, paramOffset + allParams.length);
      if (result.where) {
        parts.push(result.where);
        allParams.push(...result.params);
      }
    }
    return { where: parts.length > 0 ? `(${parts.join(" OR ")})` : "", params: allParams };
  }

  // Property filter
  const prop = filter.property;
  if (!prop) return { where: "", params: [] };

  const colMap: Record<string, string> = {
    Task: "title", Priority: "priority", Status: "status", Source: "source",
    Project: "project", Context: "context", Zone: "zone",
    "Delegated To": "delegated_to", Energy: "energy", Notes: "notes",
  };
  const col = colMap[prop] || prop.toLowerCase().replace(/\s+/g, "_");
  const idx = paramOffset + 1;

  // Status filters
  if (filter.status) {
    if (filter.status.equals) return { where: `${col} = $${idx}`, params: [filter.status.equals] };
    if (filter.status.does_not_equal) return { where: `${col} != $${idx}`, params: [filter.status.does_not_equal] };
  }

  // Select filters
  if (filter.select) {
    if (filter.select.equals) return { where: `${col} = $${idx}`, params: [filter.select.equals] };
    if (filter.select.does_not_equal) return { where: `(${col} IS NULL OR ${col} != $${idx})`, params: [filter.select.does_not_equal] };
  }

  // Title/rich_text filters
  if (filter.title) {
    if (filter.title.contains) return { where: `${col} ILIKE $${idx}`, params: [`%${filter.title.contains}%`] };
    if (filter.title.equals) return { where: `${col} = $${idx}`, params: [filter.title.equals] };
  }
  if (filter.rich_text) {
    if (filter.rich_text.contains) return { where: `${col} ILIKE $${idx}`, params: [`%${filter.rich_text.contains}%`] };
  }

  return { where: "", params: [] };
}
