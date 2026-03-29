import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

interface PersonEntry {
  name: string;
  emails: string[];
  webexRoomIds: string[];
  webexGroupRooms: string[];
  meetings: { id: string; topic: string; date: string; role: string }[];
  transcriptMentions: {
    recordingId: string;
    topic: string;
    date: string;
    snippetCount: number;
    snippets: string[];
  }[];
  notionTasks: { id: string; title: string; status: string }[];
  messageExcerpts: { text: string; date: string; roomTitle: string }[];
}

type PersonIndex = Record<string, PersonEntry>;

let indexCache: { data: PersonIndex; loadedAt: number } | null = null;

function loadIndex(): PersonIndex {
  if (indexCache && Date.now() - indexCache.loadedAt < 60_000) {
    return indexCache.data;
  }
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    indexCache = { data, loadedAt: Date.now() };
    return data;
  } catch {
    return {};
  }
}

function findPerson(index: PersonIndex, email?: string, name?: string): PersonEntry | null {
  // Try exact email match first
  if (email) {
    for (const entry of Object.values(index)) {
      if (entry.emails.includes(email)) return entry;
    }
  }

  // Try name match
  if (name) {
    const lower = name.toLowerCase();
    // Exact key match
    const key = lower.replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    if (index[key]) return index[key];

    // Partial match — last name or first+last
    for (const entry of Object.values(index)) {
      const entryLower = entry.name.toLowerCase();
      if (entryLower === lower) return entry;
      if (entryLower.includes(lower) || lower.includes(entryLower)) return entry;
      // Last name match
      const parts = lower.split(" ");
      const entryParts = entryLower.split(" ");
      if (
        parts.length > 0 &&
        entryParts.length > 0 &&
        parts[parts.length - 1] === entryParts[entryParts.length - 1] &&
        parts[parts.length - 1].length > 3
      ) {
        return entry;
      }
    }
  }

  return null;
}

/**
 * GET /api/context?email=person@cisco.com&name=Marcela
 *
 * Returns cross-platform context for a person from the person index.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const email = searchParams.get("email") || undefined;
  const name = searchParams.get("name") || undefined;

  if (!email && !name) {
    return NextResponse.json({ error: "email or name required" }, { status: 400 });
  }

  const index = loadIndex();
  const person = findPerson(index, email, name);

  if (!person) {
    // Fallback: live search for basic data
    const results: Record<string, unknown> = { match: null };

    // At least try Notion task search
    const searchTerm = name || email?.split("@")[0] || "";
    if (searchTerm) {
      try {
        const resp = await proxiedFetch(
          `https://api.notion.com/v1/databases/${NOTION_DB}/query`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Notion-Version": "2022-06-28",
            },
            body: JSON.stringify({
              filter: {
                or: [
                  { property: "Task", title: { contains: searchTerm } },
                  { property: "Notes", rich_text: { contains: searchTerm } },
                ],
              },
              page_size: 10,
            }),
          }
        );
        const data = (await resp.json()) as { results?: { id: string; properties: Record<string, unknown> }[] };
        results.relatedTasks = (data.results || []).map((p) => {
          const taskProp = p.properties?.Task as { title?: { plain_text: string }[] };
          const statusProp = p.properties?.Status as { status?: { name: string } };
          return {
            id: p.id,
            title: taskProp?.title?.[0]?.plain_text || "?",
            status: statusProp?.status?.name || "?",
          };
        });
      } catch {}
    }

    return NextResponse.json(results);
  }

  // Return the full person context from the index
  return NextResponse.json({
    match: {
      name: person.name,
      emails: person.emails,
    },
    directMessages: person.messageExcerpts
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 15)
      .map((m) => ({
        text: m.text,
        from: m.roomTitle,
        created: m.date,
      })),
    recentMeetings: person.meetings
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10)
      .map((m) => ({
        topic: m.topic,
        date: m.date,
        role: m.role,
      })),
    transcriptSnippets: person.transcriptMentions
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5)
      .map((t) => ({
        topic: t.topic,
        date: t.date,
        snippetCount: t.snippetCount,
        snippets: t.snippets,
      })),
    relatedTasks: person.notionTasks.slice(0, 15),
    stats: {
      totalMeetings: person.meetings.length,
      totalTranscripts: person.transcriptMentions.length,
      totalMessages: person.messageExcerpts.length,
      totalTasks: person.notionTasks.length,
    },
  });
}
