import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { sqlOne } from "@/lib/pg";

/**
 * GET /api/notion/blocks?page_id=xxx
 * Fetches all children blocks for a Notion page.
 * Accepts either a Notion page ID or a PG task UUID (resolves via notion_page_id).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let pageId = req.nextUrl.searchParams.get("page_id");
  if (!pageId) {
    return NextResponse.json({ error: "page_id required" }, { status: 400 });
  }

  // If this looks like a PG UUID (has dashes), resolve to Notion page ID
  if (pageId.includes("-") && pageId.length > 30) {
    try {
      const row = await sqlOne("SELECT notion_page_id FROM tasks WHERE id = $1::uuid", [pageId]);
      if (row?.notion_page_id) {
        pageId = row.notion_page_id;
      } else {
        return NextResponse.json({ blocks: [] }); // Not yet synced to Notion
      }
    } catch { /* not a valid UUID — use as-is */ }
  }

  try {
    const blocks: any[] = [];
    let cursor: string | null = null;

    // Paginate through all blocks (max 3 pages = 300 blocks)
    for (let i = 0; i < 3; i++) {
      const url = `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
      const resp = await proxiedFetch(url, {
        headers: { "Notion-Version": "2022-06-28" },
      });
      const data = await resp.json();
      blocks.push(...(data.results || []));
      if (!data.has_more) break;
      cursor = data.next_cursor;
    }

    return NextResponse.json({ blocks });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
