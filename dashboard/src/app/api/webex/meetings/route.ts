import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { searchParams } = req.nextUrl;
    const from = searchParams.get("from") || "";
    const to = searchParams.get("to") || "";

    const resp = await proxiedFetch(
      `https://webexapis.com/v1/meetings?from=${from}&to=${to}&max=50&meetingType=scheduledMeeting`,
      {
        headers: { Accept: "application/json" },
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
