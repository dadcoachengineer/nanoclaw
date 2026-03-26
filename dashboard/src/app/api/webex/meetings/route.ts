import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";

export async function GET(req: NextRequest) {
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
