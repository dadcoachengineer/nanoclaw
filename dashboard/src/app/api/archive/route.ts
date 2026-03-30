import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * GET /api/archive — overview of archive types and counts
 * GET /api/archive?type=transcripts — list items of a type
 * GET /api/archive?type=transcripts&id=abc — single item
 * GET /api/archive?type=transcripts&q=search — search within type
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const type = req.nextUrl.searchParams.get("type");
  const id = req.nextUrl.searchParams.get("id");
  const search = req.nextUrl.searchParams.get("q");

  if (!type) {
    // Overview
    const counts = await sql(
      "SELECT source_type, COUNT(*) as count FROM archive_items GROUP BY source_type"
    );
    const overview: Record<string, number> = {};
    for (const row of counts) overview[row.source_type] = parseInt(row.count);
    return NextResponse.json(overview);
  }

  if (id) {
    const item = await sqlOne(
      "SELECT id, source_type, title, date::text, content, metadata FROM archive_items WHERE id = $1 AND source_type = $2",
      [id, type]
    );
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const meta = typeof item.metadata === "string" ? JSON.parse(item.metadata) : item.metadata;
    return NextResponse.json({
      id: item.id, title: item.title, date: item.date,
      content: item.content, source: item.source_type,
      speakers: meta?.speakers, charCount: meta?.charCount,
    });
  }

  // List with optional search
  let rows;
  if (search) {
    rows = await sql(
      `SELECT id, title, date::text, LEFT(content, 200) as preview, source_type as source
       FROM archive_items WHERE source_type = $1 AND (title ILIKE $2 OR content ILIKE $2)
       ORDER BY date DESC NULLS LAST LIMIT 50`,
      [type, `%${search}%`]
    );
  } else {
    rows = await sql(
      `SELECT id, title, date::text, LEFT(content, 200) as preview, source_type as source
       FROM archive_items WHERE source_type = $1 ORDER BY date DESC NULLS LAST LIMIT 50`,
      [type]
    );
  }

  return NextResponse.json({ items: rows, total: rows.length });
}
