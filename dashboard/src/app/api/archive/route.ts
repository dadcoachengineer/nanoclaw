import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const ARCHIVE_DIR = path.join(STORE_DIR, "archive");

/**
 * GET /api/archive?type=transcript&id=abc123 — retrieve a single archived item
 * GET /api/archive?type=transcript — list all items of that type
 * GET /api/archive — list all types and counts
 *
 * Types: transcripts, messages, emails, boox, plaud, summaries
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const type = req.nextUrl.searchParams.get("type");
  const id = req.nextUrl.searchParams.get("id");
  const search = req.nextUrl.searchParams.get("q");

  // Overview of all archive types
  if (!type) {
    const types = ["transcripts", "messages", "emails", "boox", "plaud", "summaries"];
    const overview: Record<string, number> = {};
    for (const t of types) {
      const dir = path.join(ARCHIVE_DIR, t);
      try {
        overview[t] = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
      } catch {
        overview[t] = 0;
      }
    }
    return NextResponse.json(overview);
  }

  const typeDir = path.join(ARCHIVE_DIR, type);
  if (!fs.existsSync(typeDir)) {
    return NextResponse.json({ error: "Unknown archive type" }, { status: 404 });
  }

  // Single item by ID
  if (id) {
    const filePath = path.join(typeDir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return NextResponse.json(data);
    } catch {
      return NextResponse.json({ error: "Failed to read" }, { status: 500 });
    }
  }

  // List items of a type, optionally filtered by search
  try {
    const files = fs.readdirSync(typeDir).filter((f) => f.endsWith(".json")).sort().reverse();
    const items = files.slice(0, 50).map((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(typeDir, f), "utf-8"));
        return {
          id: f.replace(".json", ""),
          title: data.title || data.meeting || data.subject || f,
          date: data.date || data.timestamp || data.createdAt || "",
          source: data.source || type,
          preview: (data.content || data.text || data.body || "").slice(0, 200),
        };
      } catch { return null; }
    }).filter(Boolean);

    const filtered = search
      ? items.filter((i: any) =>
          i.title.toLowerCase().includes(search.toLowerCase()) ||
          i.preview.toLowerCase().includes(search.toLowerCase())
        )
      : items;

    return NextResponse.json({ items: filtered, total: files.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
