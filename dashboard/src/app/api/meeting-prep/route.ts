import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

function extractPersonName(meetingTitle: string, hostName?: string, hostEmail?: string): string {
  const cleaned = meetingTitle
    .replace(/&/g, "").replace(/1:1/gi, "").replace(/Jason/gi, "").replace(/Shearer/gi, "")
    .replace(/['']s?\s*(meeting|sync|catch up|check in)/gi, "")
    .replace(/\d{8}/g, "").replace(/[-–]/g, " ").replace(/\s+/g, " ").trim()
    .split(",")[0].trim();
  return cleaned || (hostEmail !== "jasheare@cisco.com" ? (hostName || "") : "");
}

/**
 * GET /api/meeting-prep — contextual prep data from PostgreSQL
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const title = searchParams.get("title") || "";
  const host = searchParams.get("host") || "";
  const hostEmail = searchParams.get("hostEmail") || "";
  const selectedPerson = searchParams.get("selectedPerson") || "";

  const personName = extractPersonName(title, host, hostEmail);

  // Find person in PG
  let person: any = null;
  let candidates: any[] | undefined;

  if (selectedPerson) {
    person = await sqlOne(
      `SELECT p.*, array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails
       FROM people p LEFT JOIN person_emails pe ON pe.person_id = p.id
       WHERE p.key = $1 GROUP BY p.id`,
      [selectedPerson]
    );
  } else if (personName) {
    const key = personName.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    const allCandidates = await sql(
      `SELECT p.key, p.name, p.avatar, pe.email,
              COUNT(DISTINCT mp.meeting_id) as meetings,
              COUNT(DISTINCT me.id) as messages
       FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id
       LEFT JOIN meeting_participants mp ON mp.person_id = p.id
       LEFT JOIN message_excerpts me ON me.person_id = p.id
       WHERE p.key = $1 OR p.name ILIKE $2
         OR (array_length(string_to_array(p.name, ' '), 1) >= 2
             AND split_part(p.name, ' ', array_length(string_to_array(p.name, ' '), 1)) ILIKE $3
             AND length($3) > 3)
       GROUP BY p.key, p.name, p.avatar, pe.email
       ORDER BY COUNT(DISTINCT mp.meeting_id) + COUNT(DISTINCT me.id) DESC
       LIMIT 5`,
      [key, `%${personName}%`, `%${personName.split(" ").pop()}%`]
    );
    if (allCandidates.length > 1) {
      candidates = allCandidates.map((c: any) => ({
        key: c.key, name: c.name, email: c.email, avatar: c.avatar,
        meetingCount: parseInt(c.meetings), messageCount: parseInt(c.messages),
      }));
    }
    if (allCandidates.length > 0) {
      person = await sqlOne(
        `SELECT p.*, array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails
         FROM people p LEFT JOIN person_emails pe ON pe.person_id = p.id
         WHERE p.key = $1 GROUP BY p.id`,
        [allCandidates[0].key]
      );
    }
  }

  // Build prep data from PG
  let recentMessages: any[] = [];
  let previousMeetings: any[] = [];
  let transcriptHighlights: any[] = [];
  let openTasks: any[] = [];
  let followUpsOwed: any[] = [];
  let aiSummaries: any[] = [];

  if (person) {
    recentMessages = await sql(
      `SELECT text, date::text, room_title as "roomTitle" FROM message_excerpts
       WHERE person_id = $1 ORDER BY date DESC LIMIT 10`,
      [person.id]
    );

    previousMeetings = await sql(
      `SELECT m.id, m.topic, m.date::text, mp.role
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.person_id = $1 ORDER BY m.date DESC LIMIT 10`,
      [person.id]
    );

    transcriptHighlights = await sql(
      `SELECT m.topic, m.date::text, tm.snippet_count as "snippetCount", tm.snippets
       FROM transcript_mentions tm JOIN meetings m ON m.id = tm.meeting_id
       WHERE tm.person_id = $1 ORDER BY m.date DESC LIMIT 5`,
      [person.id]
    );

    aiSummaries = await sql(
      `SELECT s.title, s.date::text, s.summary FROM ai_summaries s
       JOIN meeting_participants mp ON mp.meeting_id = s.meeting_id
       WHERE mp.person_id = $1 ORDER BY s.date DESC LIMIT 3`,
      [person.id]
    );

    // Open tasks mentioning this person
    const firstName = person.name.split(" ")[0];
    openTasks = await sql(
      `SELECT id, title, priority, status, source, project FROM tasks
       WHERE status != 'Done' AND (title ILIKE $1 OR notes ILIKE $2)
       ORDER BY CASE WHEN priority LIKE 'P0%' THEN 0 WHEN priority LIKE 'P1%' THEN 1 ELSE 2 END
       LIMIT 10`,
      [`%${firstName}%`, `%${person.name}%`]
    );

    // Follow-ups owed (tasks with "Reply to" or "Follow up with" + person name)
    followUpsOwed = await sql(
      `SELECT id, title, priority, status FROM tasks
       WHERE status != 'Done'
         AND (title ILIKE $1 OR title ILIKE $2)
       LIMIT 5`,
      [`%Reply%${firstName}%`, `%Follow up%${firstName}%`]
    );
  }

  // Matched topics from PG
  const titleWords = title.toLowerCase().split(/[\s\-&,]+/).filter((w: string) => w.length > 3);
  let matchedTopics: any[] = [];
  if (titleWords.length > 0) {
    const topicCond = titleWords.map((_: string, i: number) => `t.key ILIKE $${i + 1}`).join(" OR ");
    const topicParams = titleWords.map((w: string) => `%${w}%`);
    matchedTopics = await sql(
      `SELECT t.name, COUNT(DISTINCT tm.meeting_id) as meetings, COUNT(DISTINCT tt.task_id) as tasks
       FROM topics t
       LEFT JOIN topic_meetings tm ON tm.topic_id = t.id
       LEFT JOIN topic_tasks tt ON tt.topic_id = t.id
       WHERE ${topicCond}
       GROUP BY t.name LIMIT 5`,
      topicParams
    );
  }

  return NextResponse.json({
    meetingTitle: title,
    personName: person?.name || personName,
    personEmail: person?.emails?.[0] || "",
    personAvatar: person?.avatar || null,
    recentMessages,
    previousMeetings,
    transcriptHighlights,
    openTasks: openTasks.map((t: any) => ({ id: t.id, title: t.title, priority: t.priority, status: t.status, source: t.source })),
    followUpsOwed: followUpsOwed.map((t: any) => ({ id: t.id, title: t.title, priority: t.priority, status: t.status })),
    aiSummaries,
    matchedTopics: matchedTopics.map((t: any) => ({ name: t.name, taskCount: parseInt(t.tasks), meetingCount: parseInt(t.meetings) })),
    stats: {
      totalMeetings: previousMeetings.length,
      totalTranscripts: transcriptHighlights.length,
      totalMessages: recentMessages.length,
      totalTasks: openTasks.length,
    },
    candidates,
  });
}
