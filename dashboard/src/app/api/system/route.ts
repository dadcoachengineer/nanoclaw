import { NextRequest, NextResponse } from "next/server";

const SYSTEM_API = process.env.NANOCLAW_API || "http://127.0.0.1:3939";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const path = searchParams.get("path") || "/api/stats";

    const resp = await fetch(`${SYSTEM_API}${path}`);
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: String(err) },
      { status: 502 }
    );
  }
}
