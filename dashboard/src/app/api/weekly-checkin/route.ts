import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

const PRIORITY_KEYWORDS: Record<string, { label: string; keywords: string[] }> = {
  personal_development: { label: "Personal Development", keywords: ["coaching", "ipec", "development", "training", "learning"] },
  thought_leadership: { label: "Workplace Field CTO Thought Leadership", keywords: ["thought leadership", "vidcast", "publish", "article", "presentation", "speaking"] },
  partner_alignment: { label: "Partner Alignment", keywords: ["partner", "wesco", "ibew", "neca", "distributor", "ecosystem"] },
  customer_engagement: { label: "Customer Engagement", keywords: ["customer", "pov", "demo", "proof of value", "account", "opportunity"] },
  team_engagement: { label: "Team Engagement", keywords: ["1:1", "team sync", "forecast", "pipeline"] },
  coaching: { label: "Coaching/Mentorship/SE Leadership", keywords: ["coaching", "mentor", "interview", "candidate", "hiring", "panel"] },
  enablement: { label: "Enablement", keywords: ["enablement", "cisco live", "training", "workshop", "session"] },
};

function classifyTask(title: string): string[] {
  const lower = title.toLowerCase();
  const matched: string[] = [];
  for (const [key, { keywords }] of Object.entries(PRIORITY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) matched.push(key);
  }
  return matched.length > 0 ? matched : ["customer_engagement"];
}

function getMondayOfCurrentWeek(): Date {
  const now = new Date();
  const diff = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * GET /api/weekly-checkin — weekly review data from PostgreSQL
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const monday = getMondayOfCurrentWeek();
    const weekAgo = new Date(monday);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekEnd = new Date(monday.getTime() + 7 * 86400000);

    // Tasks completed this week
    const completedTasks = await sql(
      `SELECT id, title, priority, source, project, delegated_to, updated_at::text
       FROM tasks WHERE status = 'Done' AND updated_at >= $1 AND updated_at < $2
       ORDER BY updated_at DESC`,
      [weekAgo.toISOString(), weekEnd.toISOString()]
    );

    // Open tasks (carry-forward)
    const openTasks = await sql(
      `SELECT id, title, priority, status, source, project, delegated_to, created_at::text
       FROM tasks WHERE status != 'Done'
       ORDER BY CASE WHEN priority LIKE 'P0%' THEN 0 WHEN priority LIKE 'P1%' THEN 1 WHEN priority LIKE 'P2%' THEN 2 ELSE 3 END
       LIMIT 50`
    );

    // Meetings this week
    const weekMeetings = await sql(
      `SELECT id, topic, date::text, host_name, host_email FROM meetings
       WHERE date >= $1 AND date < $2 ORDER BY date DESC`,
      [weekAgo.toISOString(), weekEnd.toISOString()]
    );

    // AI summaries this week
    const weekSummaries = await sql(
      `SELECT title, date::text, summary, action_items FROM ai_summaries
       WHERE date >= $1 AND date < $2 ORDER BY date DESC`,
      [weekAgo.toISOString(), weekEnd.toISOString()]
    );

    // Classify tasks into priority buckets
    const buckets: Record<string, { label: string; completed: any[]; open: any[] }> = {};
    for (const [key, { label }] of Object.entries(PRIORITY_KEYWORDS)) {
      buckets[key] = { label, completed: [], open: [] };
    }

    for (const t of completedTasks) {
      const classes = classifyTask(t.title);
      for (const c of classes) {
        if (buckets[c]) buckets[c].completed.push({ id: t.id, title: t.title, priority: t.priority, source: t.source });
      }
    }
    for (const t of openTasks) {
      const classes = classifyTask(t.title);
      for (const c of classes) {
        if (buckets[c]) buckets[c].open.push({ id: t.id, title: t.title, priority: t.priority, status: t.status });
      }
    }

    // People engagement this week
    const topPeople = await sql(
      `SELECT p.name, pe.email, COUNT(DISTINCT me.id) as messages, COUNT(DISTINCT mp.meeting_id) as meetings
       FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id AND pe.is_primary = true
       LEFT JOIN message_excerpts me ON me.person_id = p.id AND me.date >= $1
       LEFT JOIN meeting_participants mp ON mp.person_id = p.id
         AND EXISTS (SELECT 1 FROM meetings m WHERE m.id = mp.meeting_id AND m.date >= $1 AND m.date < $2)
       GROUP BY p.id, p.name, pe.email
       HAVING COUNT(DISTINCT me.id) + COUNT(DISTINCT mp.meeting_id) > 0
       ORDER BY COUNT(DISTINCT me.id) + COUNT(DISTINCT mp.meeting_id) DESC
       LIMIT 15`,
      [weekAgo.toISOString(), weekEnd.toISOString()]
    );

    // Triage decisions this week
    const triageStats = await sqlOne(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE action = 'accept') as accepted,
              COUNT(*) FILTER (WHERE action = 'delegate') as delegated,
              COUNT(*) FILTER (WHERE action = 'dismiss') as dismissed
       FROM triage_decisions WHERE decided_at >= $1`,
      [weekAgo.toISOString()]
    );

    return NextResponse.json({
      weekOf: monday.toISOString().slice(0, 10),
      stats: {
        tasksCompleted: completedTasks.length,
        tasksOpen: openTasks.length,
        meetingsAttended: weekMeetings.length,
        summariesGenerated: weekSummaries.length,
        triageDecisions: parseInt(triageStats?.total || "0"),
      },
      buckets,
      completedTasks: completedTasks.slice(0, 20),
      openTasks: openTasks.slice(0, 20),
      meetings: weekMeetings.map((m: any) => ({ title: m.topic, date: m.date, host: m.host_name })),
      summaries: weekSummaries.map((s: any) => ({ title: s.title, date: s.date, summary: s.summary?.slice(0, 300), actionItems: s.action_items })),
      topPeople: topPeople.map((p: any) => ({ name: p.name, email: p.email, messages: parseInt(p.messages), meetings: parseInt(p.meetings) })),
      triageStats: triageStats ? { accepted: parseInt(triageStats.accepted), delegated: parseInt(triageStats.delegated), dismissed: parseInt(triageStats.dismissed) } : null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
