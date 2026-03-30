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

    // Build ratings evidence from the week's data
    const strengthsEvidence: string[] = [];
    const outstandingEvidence: string[] = [];
    const managerEvidence: string[] = [];

    // Strengths: tasks completed, pipeline throughput
    if (completedTasks.length > 0) strengthsEvidence.push(`Completed ${completedTasks.length} tasks this week`);
    if (weekMeetings.length > 5) strengthsEvidence.push(`Attended ${weekMeetings.length} meetings — high engagement`);
    for (const t of completedTasks.slice(0, 3)) strengthsEvidence.push(`Closed: ${t.title.slice(0, 80)}`);

    // Outstanding value: key deliverables
    const p0Completed = completedTasks.filter((t: any) => t.priority?.includes("P0"));
    if (p0Completed.length > 0) outstandingEvidence.push(`${p0Completed.length} P0 urgent items resolved`);
    for (const s of weekSummaries.slice(0, 2)) {
      if (s.action_items?.length) outstandingEvidence.push(`Meeting "${s.title}": ${s.action_items.length} action items driven`);
    }
    if (outstandingEvidence.length === 0) outstandingEvidence.push("Review deliverables for this week");

    // Manager connect: 1:1s and team interactions
    const teamMeetings = weekMeetings.filter((m: any) => /1:1|sync|check.in/i.test(m.topic));
    if (teamMeetings.length > 0) managerEvidence.push(`${teamMeetings.length} 1:1s and team syncs this week`);
    for (const m of teamMeetings.slice(0, 3)) managerEvidence.push(`${m.topic} on ${new Date(m.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`);
    if (managerEvidence.length === 0) managerEvidence.push("Schedule manager check-in");

    const ratings = {
      strengths: { evidence: strengthsEvidence, score: null },
      outstandingValue: { evidence: outstandingEvidence, score: null },
      managerConnect: { evidence: managerEvidence, score: null },
    };

    // Meeting engagement — loved/loathed based on meeting patterns
    const loved: { title: string; date: string; signals: string[] }[] = [];
    const loathed: { title: string; date: string; signals: string[] }[] = [];

    for (const m of weekMeetings) {
      const signals: string[] = [];
      const topic = m.topic || "";
      // Positive signals
      if (/1:1|sync|connect/i.test(topic)) signals.push("Direct engagement");
      if (weekSummaries.some((s: any) => s.title === topic && (s.action_items?.length || 0) > 2)) signals.push("Generated action items");
      // Negative signals
      const isLargeGroup = !/1:1|sync/i.test(topic) && /team|all.hands|cadence|roundtable/i.test(topic);
      if (isLargeGroup) signals.push("Large group meeting");

      if (signals.length > 0) {
        const entry = { title: topic, date: m.date, signals };
        if (isLargeGroup) loathed.push(entry);
        else loved.push(entry);
      }
    }

    return NextResponse.json({
      weekOf: monday.toISOString().slice(0, 10),
      ratings,
      loved: loved.slice(0, 5),
      loathed: loathed.slice(0, 5),
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
