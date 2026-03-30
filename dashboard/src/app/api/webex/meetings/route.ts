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

    // Fetch both scheduled meetings and ad-hoc meetings to catch all types
    const [scheduledResp, meetingResp] = await Promise.all([
      proxiedFetch(`https://webexapis.com/v1/meetings?from=${from}&to=${to}&max=50&meetingType=scheduledMeeting`, { headers: { Accept: "application/json" } }),
      proxiedFetch(`https://webexapis.com/v1/meetings?from=${from}&to=${to}&max=50&meetingType=meeting`, { headers: { Accept: "application/json" } }),
    ]);

    const scheduled = await scheduledResp.json() as any;
    const meetings = await meetingResp.json() as any;

    // Merge and dedupe by ID
    const seen = new Set<string>();
    const allItems: any[] = [];
    for (const item of [...(scheduled.items || []), ...(meetings.items || [])]) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        allItems.push(item);
      }
    }

    // Sort by start time
    allItems.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

    return NextResponse.json({ items: allItems });
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 502 }
    );
  }
}
