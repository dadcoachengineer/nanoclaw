import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { database_id, filter, sorts } = body;

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
        }),
      }
    );

    const data = await resp.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 502 }
    );
  }
}
