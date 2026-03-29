import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const EVENTS_PATH = path.join(STORE_DIR, "google-calendar-events.json");

export async function GET() {
  const user = await requireAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    if (!fs.existsSync(EVENTS_PATH)) {
      return NextResponse.json({ events: [], fetchedAt: null });
    }
    const raw = fs.readFileSync(EVENTS_PATH, "utf-8");
    const data = JSON.parse(raw);
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to read calendar events" }, { status: 500 });
  }
}
