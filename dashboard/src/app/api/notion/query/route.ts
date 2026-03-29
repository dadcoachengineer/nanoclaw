import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { database_id, filter, sorts } = body;

    const allResults: unknown[] = [];
    let cursor: string | undefined;

    // Paginate through all results (max 5 pages = 500 items)
    for (let i = 0; i < 5; i++) {
      const resp = await proxiedFetch(
        `https://api.notion.com/v1/databases/${database_id}/query`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
          },
          body: JSON.stringify({
            ...(filter ? { filter } : {}),
            ...(sorts ? { sorts } : {}),
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          }),
        }
      );

      const data = await resp.json();
      allResults.push(...(data.results || []));

      if (!data.has_more) break;
      cursor = data.next_cursor;
    }

    return NextResponse.json({ results: allResults });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 502 }
    );
  }
}
