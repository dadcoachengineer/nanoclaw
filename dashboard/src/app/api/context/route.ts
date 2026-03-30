import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";


/**
 * GET /api/context?email=person@cisco.com&name=Marcela
 *
 * Returns cross-platform context for a person from PostgreSQL.
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

  // Find the person in PG — try email first, then name match
  let person: { id: string; name: string; emails: string[] } | null = null;

  if (email) {
    person = await sqlOne<{ id: string; name: string; emails: string[] }>(
      `SELECT p.id, p.name,
              array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails
       FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id
       WHERE p.id IN (SELECT person_id FROM person_emails WHERE email = $1)
       GROUP BY p.id
       LIMIT 1`,
      [email]
    );
  }

  if (!person && name) {
    const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    person = await sqlOne<{ id: string; name: string; emails: string[] }>(
      `SELECT p.id, p.name,
              array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails
       FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id
       WHERE p.key = $1 OR p.name ILIKE $2
       GROUP BY p.id
       LIMIT 1`,
      [key, `%${name}%`]
    );

    // If no exact match, try last-name match for names with >3 chars
    if (!person) {
      const parts = name.toLowerCase().split(" ");
      const lastName = parts[parts.length - 1];
      if (lastName && lastName.length > 3) {
        person = await sqlOne<{ id: string; name: string; emails: string[] }>(
          `SELECT p.id, p.name,
                  array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails
           FROM people p
           LEFT JOIN person_emails pe ON pe.person_id = p.id
           WHERE split_part(p.name, ' ', array_length(string_to_array(p.name, ' '), 1)) ILIKE $1
           GROUP BY p.id
           LIMIT 1`,
          [lastName]
        );
      }
    }
  }

  if (!person) {
    // Fallback: search PG tasks directly
    const searchTerm = name || email?.split("@")[0] || "";
    let relatedTasks: any[] = [];
    if (searchTerm) {
      relatedTasks = await sql(
        `SELECT id, title, status FROM tasks
         WHERE title ILIKE $1 OR notes ILIKE $1
         ORDER BY created_at DESC LIMIT 10`,
        [`%${searchTerm}%`]
      );
    }
    return NextResponse.json({ match: null, relatedTasks });
  }

  // Person found — fetch all related data from PG
  const [messageExcerpts, meetings, transcriptMentions, relatedTasks] = await Promise.all([
    sql(
      `SELECT text, date::text, room_title as "roomTitle"
       FROM message_excerpts WHERE person_id = $1 ORDER BY date DESC LIMIT 15`,
      [person.id]
    ),
    sql(
      `SELECT m.topic, m.date::text, mp.role
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.person_id = $1 ORDER BY m.date DESC LIMIT 10`,
      [person.id]
    ),
    sql(
      `SELECT tm.snippet_count as "snippetCount", tm.snippets, m.topic, m.date::text
       FROM transcript_mentions tm JOIN meetings m ON m.id = tm.meeting_id
       WHERE tm.person_id = $1 ORDER BY m.date DESC LIMIT 5`,
      [person.id]
    ),
    sql(
      `SELECT t.id, t.title, t.status
       FROM tasks t JOIN task_people tp ON tp.task_id = t.id
       WHERE tp.person_id = $1 ORDER BY t.created_at DESC LIMIT 15`,
      [person.id]
    ),
  ]);

  return NextResponse.json({
    match: {
      name: person.name,
      emails: person.emails || [],
    },
    directMessages: messageExcerpts.map((m: any) => ({
      text: m.text,
      from: m.roomTitle,
      created: m.date,
    })),
    recentMeetings: meetings.map((m: any) => ({
      topic: m.topic,
      date: m.date,
      role: m.role,
    })),
    transcriptSnippets: transcriptMentions.map((t: any) => ({
      topic: t.topic,
      date: t.date,
      snippetCount: t.snippetCount,
      snippets: t.snippets || [],
    })),
    relatedTasks,
    stats: {
      totalMeetings: meetings.length,
      totalTranscripts: transcriptMentions.length,
      totalMessages: messageExcerpts.length,
      totalTasks: relatedTasks.length,
    },
  });
}
