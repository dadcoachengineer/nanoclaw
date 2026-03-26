import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";

/**
 * GET /api/notion/blocks?page_id=xxx
 * Fetches all children blocks for a Notion page.
 */
export async function GET(req: NextRequest) {
  const pageId = req.nextUrl.searchParams.get("page_id");
  if (!pageId) {
    return NextResponse.json({ error: "page_id required" }, { status: 400 });
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
