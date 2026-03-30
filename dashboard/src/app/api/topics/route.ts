import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * GET /api/topics — list all topics with stats
 * GET /api/topics?name=Cisco+Spaces — get detail for one topic
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const name = searchParams.get("name");

  if (name) {
    // Detail view — full topic data
    const key = name.toLowerCase();
    const topic = await sqlOne<{ id: string; name: string }>(
      "SELECT id, name FROM topics WHERE key = $1",
      [key]
    );
    if (!topic) return NextResponse.json({ error: "Topic not found" }, { status: 404 });

    // Get meetings for this topic
    const meetings = await sql(
      `SELECT m.id, m.topic, m.date::text
       FROM meetings m JOIN topic_meetings tm ON tm.meeting_id = m.id
       WHERE tm.topic_id = $1 ORDER BY m.date DESC`,
      [topic.id]
    );

    // Get transcript snippets — aggregate from transcript_mentions for meetings in this topic
    const transcriptSnippets = await sql(
      `SELECT m.topic, m.date::text,
              array_agg(DISTINCT p.name) FILTER (WHERE p.name IS NOT NULL) as speakers,
              array_agg(unnested.snippet) FILTER (WHERE unnested.snippet IS NOT NULL) as "keyLines"
       FROM topic_meetings tm
       JOIN meetings m ON m.id = tm.meeting_id
       JOIN transcript_mentions trm ON trm.meeting_id = m.id
       JOIN people p ON p.id = trm.person_id
       LEFT JOIN LATERAL unnest(trm.snippets) AS unnested(snippet) ON true
       WHERE tm.topic_id = $1
       GROUP BY m.id, m.topic, m.date
       ORDER BY m.date DESC`,
      [topic.id]
    );

    // Get tasks for this topic
    const notionTasks = await sql(
      `SELECT t.id, t.title, t.status, t.source
       FROM tasks t JOIN topic_tasks tt ON tt.task_id = t.id
       WHERE tt.topic_id = $1 ORDER BY t.created_at DESC`,
      [topic.id]
    );

    // Get people names for this topic
    const peopleRows = await sql(
      `SELECT p.name FROM people p JOIN topic_people tp ON tp.person_id = p.id
       WHERE tp.topic_id = $1 ORDER BY p.name`,
      [topic.id]
    );
    const people = peopleRows.map((r: any) => r.name);

    // webexRooms — not tracked in PG topic tables, return empty for now
    const webexRooms: { id: string; title: string }[] = [];

    return NextResponse.json({
      name: topic.name,
      meetings,
      transcriptSnippets: transcriptSnippets.map((t: any) => ({
        topic: t.topic,
        date: t.date,
        speakers: t.speakers || [],
        keyLines: t.keyLines || [],
      })),
      webexRooms,
      notionTasks,
      people,
    });
  }

  // List view — summary of all topics with counts
  const summary = await sql(
    `SELECT t.id, t.key, t.name,
            COUNT(DISTINCT tm.meeting_id) as meetings,
            COUNT(DISTINCT tt.task_id) as tasks,
            COUNT(DISTINCT tp.person_id) as people
     FROM topics t
     LEFT JOIN topic_meetings tm ON tm.topic_id = t.id
     LEFT JOIN topic_tasks tt ON tt.topic_id = t.id
     LEFT JOIN topic_people tp ON tp.topic_id = t.id
     GROUP BY t.id
     ORDER BY COUNT(DISTINCT tm.meeting_id) + COUNT(DISTINCT tt.task_id) DESC`
  );

  // Count transcripts per topic (separate query for clarity)
  const transcriptCounts = await sql(
    `SELECT tm2.topic_id, COUNT(DISTINCT trm.id) as cnt
     FROM topic_meetings tm2
     JOIN transcript_mentions trm ON trm.meeting_id = tm2.meeting_id
     GROUP BY tm2.topic_id`
  );
  const tcMap = new Map(transcriptCounts.map((r: any) => [r.topic_id, parseInt(r.cnt)]));

  const result = summary.map((t: any) => ({
    key: t.key,
    name: t.name,
    meetings: parseInt(t.meetings),
    transcripts: tcMap.get(t.id) || 0,
    tasks: parseInt(t.tasks),
    rooms: 0,
    people: parseInt(t.people),
  }));

  return NextResponse.json(result);
}
