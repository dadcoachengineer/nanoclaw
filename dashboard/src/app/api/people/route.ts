import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * GET /api/people — list all people with stats (from PostgreSQL)
 * GET /api/people?name=Tara+Clark — get detail for one person
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const name = searchParams.get("name");

  if (name) {
    // Detail view — full person data with related entities
    const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    const person = await sqlOne(
      `SELECT p.*, array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails,
              array_agg(DISTINCT pwr.room_id) FILTER (WHERE pwr.room_id IS NOT NULL AND pwr.room_type = 'direct') as webex_room_ids,
              array_agg(DISTINCT pwr.room_id) FILTER (WHERE pwr.room_id IS NOT NULL AND pwr.room_type = 'group') as webex_group_rooms
       FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id
       LEFT JOIN person_webex_rooms pwr ON pwr.person_id = p.id
       WHERE p.key = $1 OR p.name ILIKE $2
       GROUP BY p.id LIMIT 1`,
      [key, `%${name}%`]
    );
    if (!person) return NextResponse.json({ error: "Person not found" }, { status: 404 });

    // Get meetings
    const meetings = await sql(
      `SELECT m.id, m.topic, m.date::text, mp.role
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.person_id = $1 ORDER BY m.date DESC`,
      [person.id]
    );

    // Get transcript mentions
    const transcriptMentions = await sql(
      `SELECT tm.snippet_count as "snippetCount", tm.snippets, m.id as "recordingId", m.topic, m.date::text
       FROM transcript_mentions tm JOIN meetings m ON m.id = tm.meeting_id
       WHERE tm.person_id = $1 ORDER BY m.date DESC`,
      [person.id]
    );

    // Get message excerpts
    const messageExcerpts = await sql(
      `SELECT text, date::text, room_title as "roomTitle"
       FROM message_excerpts WHERE person_id = $1 ORDER BY date DESC`,
      [person.id]
    );

    // Get related tasks
    const notionTasks = await sql(
      `SELECT t.id, t.title, t.status
       FROM tasks t JOIN task_people tp ON tp.task_id = t.id
       WHERE tp.person_id = $1 ORDER BY t.created_at DESC LIMIT 10`,
      [person.id]
    );

    // Get AI summaries
    const aiSummaries = await sql(
      `SELECT s.meeting_id as "meetingId", s.title, s.date::text, s.summary
       FROM ai_summaries s
       JOIN meeting_participants mp ON mp.meeting_id = s.meeting_id
       WHERE mp.person_id = $1 ORDER BY s.date DESC LIMIT 5`,
      [person.id]
    );

    return NextResponse.json({
      name: person.name,
      emails: person.emails || [],
      avatar: person.avatar,
      company: person.company,
      jobTitle: person.job_title,
      profileNotes: person.profile_notes,
      linkedinUrl: person.linkedin_url,
      webexRoomIds: person.webex_room_ids || [],
      webexGroupRooms: person.webex_group_rooms || [],
      meetings,
      transcriptMentions,
      messageExcerpts,
      notionTasks,
      aiSummaries,
    });
  }

  // List view — summary of all people
  const summary = await sql(
    `SELECT p.key, p.name, p.avatar, p.company, p.job_title,
            array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails,
            COUNT(DISTINCT mp.meeting_id) as meetings,
            COUNT(DISTINCT tm.id) as transcripts,
            COUNT(DISTINCT me.id) as messages,
            COUNT(DISTINCT tp.task_id) as tasks
     FROM people p
     LEFT JOIN person_emails pe ON pe.person_id = p.id
     LEFT JOIN meeting_participants mp ON mp.person_id = p.id
     LEFT JOIN transcript_mentions tm ON tm.person_id = p.id
     LEFT JOIN message_excerpts me ON me.person_id = p.id
     LEFT JOIN task_people tp ON tp.person_id = p.id
     GROUP BY p.id
     HAVING COUNT(DISTINCT mp.meeting_id) + COUNT(DISTINCT me.id) + COUNT(DISTINCT tm.id) > 1
        OR array_length(array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL), 1) > 0
        OR array_length(string_to_array(p.name, ' '), 1) >= 2
     ORDER BY COUNT(DISTINCT mp.meeting_id) + COUNT(DISTINCT me.id) + COUNT(DISTINCT tm.id) DESC`
  );

  const result = summary.map((p: any) => ({
    key: p.key,
    name: p.name,
    emails: p.emails || [],
    avatar: p.avatar,
    meetings: parseInt(p.meetings),
    transcripts: parseInt(p.transcripts),
    messages: parseInt(p.messages),
    tasks: parseInt(p.tasks),
    total: parseInt(p.meetings) + parseInt(p.transcripts) + parseInt(p.messages) + parseInt(p.tasks),
  }));

  return NextResponse.json(result);
}

/**
 * POST /api/people — hot-seed a new person
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

    // Check if exists
    const existing = await sqlOne("SELECT id FROM people WHERE key = $1", [key]);
    if (existing) return NextResponse.json({ exists: true, name: trimmed });

    // Insert
    const result = await sqlOne<{ id: string }>(
      "INSERT INTO people (key, name) VALUES ($1, $2) RETURNING id",
      [key, trimmed]
    );

    if (email && result) {
      await sql("INSERT INTO person_emails (person_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING", [result.id, email.toLowerCase()]);
    }

    return NextResponse.json({ seeded: true, name: trimmed });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * PATCH /api/people — update a person's profile
 * Body: { key, name?, email?, company?, title?, notes?, avatar? }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { key, name, email, company, title: jobTitle, notes, avatar } = await req.json();
    if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

    const normalizedKey = key.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    const person = await sqlOne("SELECT id FROM people WHERE key = $1", [normalizedKey]);
    if (!person) return NextResponse.json({ error: "Person not found" }, { status: 404 });

    // Build update
    const updates: string[] = ["updated_at = now()"];
    const values: any[] = [];
    let idx = 1;

    if (name) {
      const newKey = name.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      updates.push(`name = $${idx}`, `key = $${idx + 1}`);
      values.push(name.trim(), newKey);
      idx += 2;
    }
    if (company !== undefined) { updates.push(`company = $${idx}`); values.push(company); idx++; }
    if (jobTitle !== undefined) { updates.push(`job_title = $${idx}`); values.push(jobTitle); idx++; }
    if (notes !== undefined) { updates.push(`profile_notes = $${idx}`); values.push(notes); idx++; }
    if (avatar) { updates.push(`avatar = $${idx}`); values.push(avatar); idx++; }

    values.push(person.id);
    await sql(`UPDATE people SET ${updates.join(", ")} WHERE id = $${idx}`, values);

    // Add email if provided
    if (email) {
      await sql("INSERT INTO person_emails (person_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING", [person.id, email.trim().toLowerCase()]);
    }

    return NextResponse.json({ updated: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
