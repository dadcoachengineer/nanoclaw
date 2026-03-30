import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * GET /api/team — team overview from PostgreSQL (no Notion API calls)
 * GET /api/team?member=Name — detailed view for one member
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberName = req.nextUrl.searchParams.get("member");

  if (memberName) {
    // Detail view for one member
    const member = await sqlOne(
      `SELECT tm.*, p.id as person_id, p.avatar, p.company, p.job_title
       FROM team_members tm
       LEFT JOIN people p ON p.name = tm.name
       WHERE tm.name ILIKE $1`,
      [`%${memberName}%`]
    );
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const firstName = member.name.split(" ")[0];

    // Get tasks: delegated + mentioned
    const tasks = await sql(
      `SELECT DISTINCT t.id, t.title, t.priority, t.status, t.project, t.context,
              CASE
                WHEN t.delegated_to = $1 THEN 'delegated'
                WHEN t.notes LIKE '%[People:%' || $2 || '%' THEN 'tagged'
                ELSE 'mentioned'
              END as tier
       FROM tasks t
       WHERE t.status != 'Done'
         AND (t.delegated_to = $1 OR t.title ILIKE $3 OR t.notes ILIKE $4)
       ORDER BY
         CASE WHEN t.delegated_to = $1 THEN 0
              WHEN t.notes LIKE '%[People:%' || $2 || '%' THEN 1
              ELSE 2 END,
         CASE WHEN t.priority LIKE 'P0%' THEN 0 WHEN t.priority LIKE 'P1%' THEN 1
              WHEN t.priority LIKE 'P2%' THEN 2 ELSE 3 END`,
      [firstName, member.name, `%${firstName}%`, `%${member.name}%`]
    );

    // Get stats from person index
    let stats = { meetings: 0, messages: 0, transcripts: 0, openTasks: tasks.length };
    if (member.person_id) {
      const s = await sqlOne(
        `SELECT
           (SELECT COUNT(*) FROM meeting_participants WHERE person_id = $1) as meetings,
           (SELECT COUNT(*) FROM message_excerpts WHERE person_id = $1) as messages,
           (SELECT COUNT(*) FROM transcript_mentions WHERE person_id = $1) as transcripts`,
        [member.person_id]
      );
      if (s) stats = { ...stats, meetings: parseInt(s.meetings), messages: parseInt(s.messages), transcripts: parseInt(s.transcripts) };
    }

    // Recent messages
    const recentMessages = member.person_id ? await sql(
      `SELECT text, date::text FROM message_excerpts WHERE person_id = $1 ORDER BY date DESC LIMIT 5`,
      [member.person_id]
    ) : [];

    // Recent meetings
    const recentMeetings = member.person_id ? await sql(
      `SELECT m.topic, m.date::text FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.person_id = $1 ORDER BY m.date DESC LIMIT 5`,
      [member.person_id]
    ) : [];

    return NextResponse.json({
      name: member.name, role: member.role, email: member.email,
      avatar: member.avatar, company: member.company || "Cisco",
      jobTitle: member.job_title || member.role,
      tasks, stats, recentMessages, recentMeetings,
    });
  }

  // Team overview — single query, no Notion API calls
  const overview = await sql(
    `SELECT tm.name, tm.role, tm.email, p.avatar,
            COALESCE(task_counts.total, 0) as open_tasks,
            COALESCE(task_counts.p0, 0) as p0_tasks,
            COALESCE(msg_counts.messages, 0) as messages,
            COALESCE(mtg_counts.meetings, 0) as meetings
     FROM team_members tm
     LEFT JOIN people p ON p.name = tm.name
     LEFT JOIN LATERAL (
       SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE t.priority LIKE 'P0%') as p0
       FROM tasks t
       WHERE t.status != 'Done'
         AND (t.delegated_to = split_part(tm.name, ' ', 1)
              OR t.title ILIKE '%' || split_part(tm.name, ' ', 1) || '%'
              OR t.notes ILIKE '%' || tm.name || '%')
     ) task_counts ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) as messages FROM message_excerpts me WHERE me.person_id = p.id
     ) msg_counts ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT mp.meeting_id) as meetings FROM meeting_participants mp WHERE mp.person_id = p.id
     ) mtg_counts ON true
     ORDER BY tm.name`
  );

  return NextResponse.json({
    team: overview.map((m: any) => ({
      name: m.name, role: m.role, email: m.email, avatar: m.avatar,
      stats: {
        openTasks: parseInt(m.open_tasks),
        p0Tasks: parseInt(m.p0_tasks),
        meetings: parseInt(m.meetings),
        messages: parseInt(m.messages),
      },
    })),
  });
}

/**
 * PATCH /api/team — update team roster
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { members } = await req.json();
    await sql("DELETE FROM team_members");
    for (const m of members) {
      await sql("INSERT INTO team_members (name, role, email) VALUES ($1, $2, $3)", [m.name, m.role, m.email]);
    }
    return NextResponse.json({ updated: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
