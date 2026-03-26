import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";

/**
 * POST /api/send-webex
 * Body: { roomId, text }
 *
 * Sends a message to a Webex room via API.
 */
export async function POST(req: NextRequest) {
  try {
    const { roomId, text } = await req.json();

    if (!roomId || !text) {
      return NextResponse.json(
        { error: "roomId and text required" },
        { status: 400 }
      );
    }

    const resp = await proxiedFetch("https://webexapis.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roomId, text }),
    });

    const data = await resp.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
