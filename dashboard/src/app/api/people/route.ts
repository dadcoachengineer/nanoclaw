import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");

let cache: { data: unknown; loadedAt: number } | null = null;

function loadIndex() {
  if (cache && Date.now() - cache.loadedAt < 60_000) return cache.data;
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    cache = { data, loadedAt: Date.now() };
    return data;
  } catch {
    return {};
  }
}

/**
 * GET /api/people — list all people with stats
 * GET /api/people?name=Tara+Clark — get detail for one person
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const name = searchParams.get("name");
  const index = loadIndex() as Record<string, any>;

  if (name) {
    // Find by name (fuzzy)
    const lower = name.toLowerCase();
    const key = lower.replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    let person = index[key];

    if (!person) {
      // Try partial match
      for (const [k, entry] of Object.entries(index) as [string, any][]) {
        if (
          entry.name.toLowerCase().includes(lower) ||
          lower.includes(entry.name.toLowerCase())
        ) {
          person = entry;
          break;
        }
      }
    }

    if (!person) return NextResponse.json({ error: "Person not found" }, { status: 404 });
    return NextResponse.json(person);
  }

  // Return summary of all people sorted by interaction volume
  const summary = Object.entries(index).map(([key, p]: [string, any]) => ({
    key,
    name: p.name,
    emails: p.emails || [],
    avatar: p.avatar || null,
    meetings: (p.meetings || []).length,
    transcripts: (p.transcriptMentions || []).length,
    messages: (p.messageExcerpts || []).length,
    tasks: (p.notionTasks || []).length,
    total:
      (p.meetings || []).length +
      (p.transcriptMentions || []).length +
      (p.messageExcerpts || []).length +
      (p.notionTasks || []).length,
  }));

  // Filter out low-signal entries (device names, bots, etc.)
  // Keep entries with interactions, emails, or multi-word names (hot-seeded people)
  const filtered = summary.filter((p) => p.total > 1 || p.emails.length > 0 || p.name.split(/\s+/).length >= 2);
  filtered.sort((a, b) => b.total - a.total);

  return NextResponse.json(filtered);
}

/**
 * POST /api/people — hot-seed a new person into the person index
 * Body: { name, email? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { name, email } = await req.json();
    if (!name || typeof name !== "string" || name.trim().length < 2) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }

    const trimmed = name.trim();
    const key = trimmed.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

    // Load raw index (bypass cache)
    let index: Record<string, any> = {};
    try {
      index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    } catch { /* start fresh if missing */ }

    // Don't overwrite existing entries
    if (index[key]) {
      return NextResponse.json({ exists: true, name: index[key].name });
    }

    // Seed minimal entry
    index[key] = {
      name: trimmed,
      emails: email ? [email] : [],
      meetings: [],
      messageExcerpts: [],
      transcriptMentions: [],
      notionTasks: [],
      webexRoomIds: [],
      webexGroupRooms: [],
    };

    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
    cache = null; // Invalidate cache

    return NextResponse.json({ seeded: true, name: trimmed });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * PATCH /api/people — update a person's profile
 * Body: { key: string, name?, email?, company?, title?, notes? }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { key, name, email, company, title: jobTitle, notes, avatar } = await req.json();
    if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

    let index: Record<string, any> = {};
    try { index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); } catch {}

    const normalizedKey = key.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    if (!index[normalizedKey]) {
      return NextResponse.json({ error: "Person not found" }, { status: 404 });
    }

    const person = index[normalizedKey];

    // Update name (also re-key if changed)
    if (name && name.trim() !== person.name) {
      const newKey = name.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      person.name = name.trim();
      if (newKey !== normalizedKey) {
        delete index[normalizedKey];
        index[newKey] = person;
      }
    }

    // Update email — add if not present, don't duplicate
    if (email) {
      const trimEmail = email.trim().toLowerCase();
      if (!person.emails) person.emails = [];
      if (!person.emails.includes(trimEmail)) {
        person.emails.unshift(trimEmail);
      }
    }

    // Update company/title/notes as custom fields
    if (company !== undefined) person.company = company;
    if (jobTitle !== undefined) person.jobTitle = jobTitle;
    if (notes !== undefined) person.profileNotes = notes;
    if (avatar) person.avatar = avatar;

    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
    cache = null;

    return NextResponse.json({ updated: true, person });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
