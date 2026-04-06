import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */
const MANAGER_NAME = "Alfredo Bouchot";
const LLM_ENDPOINT = "http://127.0.0.1:9001/v1/chat/completions";
const LLM_AUTH = "Bearer sk-dc-e7fd8f75b937dcf500f317e016931a6c";
const LLM_MODEL = "gemma3:27b";

const PRIORITY_KEYWORDS: Record<string, { label: string; keywords: string[] }> = {
  personal_development: { label: "Personal Development", keywords: ["coaching", "ipec", "development", "training", "learning"] },
  thought_leadership: { label: "Workplace Field CTO Thought Leadership", keywords: ["thought leadership", "vidcast", "publish", "article", "presentation", "speaking"] },
  partner_alignment: { label: "Partner Alignment", keywords: ["partner", "wesco", "ibew", "neca", "distributor", "ecosystem"] },
  customer_engagement: { label: "Customer Engagement", keywords: ["customer", "pov", "demo", "proof of value", "account", "opportunity"] },
  team_engagement: { label: "Team Engagement", keywords: ["1:1", "team sync", "forecast", "pipeline"] },
  coaching: { label: "Coaching/Mentorship/SE Leadership", keywords: ["coaching", "mentor", "interview", "candidate", "hiring", "panel"] },
  enablement: { label: "Enablement", keywords: ["enablement", "cisco live", "training", "workshop", "session"] },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function classifyTask(title: string): string[] {
  const lower = title.toLowerCase();
  const matched: string[] = [];
  for (const [key, { keywords }] of Object.entries(PRIORITY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) matched.push(key);
  }
  return matched.length > 0 ? matched : ["customer_engagement"];
}

/** Returns the Monday of the current reflect week (last week) in America/Chicago. */
function getReflectMonday(): Date {
  // Current time in Chicago
  const nowStr = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
  const now = new Date(nowStr);
  const dayOfWeek = now.getDay(); // 0=Sun
  // Monday of THIS week
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  thisMonday.setHours(0, 0, 0, 0);
  // Reflect on LAST week
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  return lastMonday;
}

function formatDateRange(start: Date, days: number): { start: string; end: string } {
  const end = new Date(start);
  end.setDate(start.getDate() + days - 1);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  return { start: fmt(start), end: fmt(end) };
}

/** Call local LLM. Returns empty string on failure (non-blocking). */
async function llmSynthesize(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    const resp = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: LLM_AUTH },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 600,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return "";
    const data = await resp.json();
    return (data.choices?.[0]?.message?.content || "").trim();
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/*  GET — full weekly check-in                                         */
/* ------------------------------------------------------------------ */
export async function GET() {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const reflectMonday = getReflectMonday();
    const reflectEnd = new Date(reflectMonday);
    reflectEnd.setDate(reflectMonday.getDate() + 7);

    const planMonday = new Date(reflectEnd); // this week's Monday
    const planEnd = new Date(planMonday);
    planEnd.setDate(planMonday.getDate() + 7);

    const reflectRange = formatDateRange(reflectMonday, 7);
    const planRange = formatDateRange(planMonday, 7);

    // ---- Parallel PG queries ----
    const [completedTasks, openTasks, weekMeetings, weekSummaries, topPeople, triageStats] =
      await Promise.all([
        sql(
          `SELECT id, title, priority, source, project, delegated_to, updated_at::text
           FROM tasks WHERE status = 'Done' AND updated_at >= $1 AND updated_at < $2
           ORDER BY updated_at DESC`,
          [reflectMonday.toISOString(), reflectEnd.toISOString()],
        ),
        sql(
          `SELECT id, title, priority, status, source, project, delegated_to, created_at::text
           FROM tasks WHERE status != 'Done'
           ORDER BY CASE WHEN priority LIKE 'P0%' THEN 0 WHEN priority LIKE 'P1%' THEN 1 WHEN priority LIKE 'P2%' THEN 2 ELSE 3 END
           LIMIT 50`,
        ),
        sql(
          `SELECT id, topic, date::text, host_name, host_email FROM meetings
           WHERE date >= $1 AND date < $2 ORDER BY date DESC`,
          [reflectMonday.toISOString(), reflectEnd.toISOString()],
        ),
        sql(
          `SELECT title, date::text, summary, action_items FROM ai_summaries
           WHERE date >= $1 AND date < $2 ORDER BY date DESC`,
          [reflectMonday.toISOString(), reflectEnd.toISOString()],
        ),
        sql(
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
          [reflectMonday.toISOString(), reflectEnd.toISOString()],
        ),
        sqlOne(
          `SELECT COUNT(*) as total,
                  COUNT(*) FILTER (WHERE action = 'accept') as accepted,
                  COUNT(*) FILTER (WHERE action = 'delegate') as delegated,
                  COUNT(*) FILTER (WHERE action = 'dismiss') as dismissed
           FROM triage_decisions WHERE decided_at >= $1`,
          [reflectMonday.toISOString()],
        ),
      ]);

    // ---- Classify into priority buckets ----
    const buckets: Record<string, { label: string; completed: any[]; open: any[] }> = {};
    for (const [key, { label }] of Object.entries(PRIORITY_KEYWORDS)) {
      buckets[key] = { label, completed: [], open: [] };
    }
    for (const t of completedTasks) {
      for (const c of classifyTask(t.title)) {
        if (buckets[c]) buckets[c].completed.push(t);
      }
    }
    for (const t of openTasks) {
      for (const c of classifyTask(t.title)) {
        if (buckets[c]) buckets[c].open.push(t);
      }
    }

    const priorities: Record<string, { label: string; items: string[]; tasksDone: number; tasksOpen: number }> = {};
    for (const [key, bucket] of Object.entries(buckets)) {
      priorities[key] = {
        label: bucket.label,
        items: [
          ...bucket.completed.map((t: any) => t.title),
          ...bucket.open.map((t: any) => t.title),
        ],
        tasksDone: bucket.completed.length,
        tasksOpen: bucket.open.length,
      };
    }

    // ---- Build context blocks for LLM ----
    const completedTaskList = completedTasks
      .slice(0, 25)
      .map((t: any) => `- ${t.title} [${t.priority || ""}] (${t.source || "manual"})`)
      .join("\n");

    const meetingList = weekMeetings
      .slice(0, 20)
      .map((m: any) => `- ${m.topic} (${m.date?.slice(0, 10)}, host: ${m.host_name || "unknown"})`)
      .join("\n");

    const summaryList = weekSummaries
      .slice(0, 10)
      .map((s: any) => {
        const ai = Array.isArray(s.action_items) ? s.action_items.join("; ") : s.action_items || "";
        return `- ${s.title}: ${(s.summary || "").slice(0, 200)}${ai ? ` | Actions: ${ai}` : ""}`;
      })
      .join("\n");

    const peopleList = topPeople
      .slice(0, 10)
      .map((p: any) => `- ${p.name} (${p.messages} messages, ${p.meetings} meetings)`)
      .join("\n");

    const openTaskList = openTasks
      .slice(0, 15)
      .map((t: any) => `- ${t.title} [${t.priority || ""}] status: ${t.status}`)
      .join("\n");

    const dataContext = [
      "COMPLETED TASKS THIS WEEK:",
      completedTaskList || "(none)",
      "",
      "MEETINGS THIS WEEK:",
      meetingList || "(none)",
      "",
      "MEETING SUMMARIES WITH ACTION ITEMS:",
      summaryList || "(none)",
      "",
      "TOP PEOPLE INTERACTIONS:",
      peopleList || "(none)",
      "",
      "OPEN / CARRY-FORWARD TASKS:",
      openTaskList || "(none)",
      "",
      `TRIAGE: ${triageStats?.accepted || 0} accepted, ${triageStats?.delegated || 0} delegated, ${triageStats?.dismissed || 0} dismissed`,
    ].join("\n");

    // ---- Parallel LLM calls ----
    const [lovedDraft, loathedDraft, strengthsDraft, valueDraft, managerHelpDraft, managerConnectDraft] =
      await Promise.all([
        // Loved
        llmSynthesize(
          "You are writing a weekly check-in for Jason Shearer, a Cisco Field CTO. Write in first person as Jason. Be specific — reference real people, meetings, and activities from the data. Use bullet points starting with '- '. Keep it under 2000 characters. Tone: fulfilled, focused, energized.",
          `Given this week's data, write 3-5 bullet points about activities that felt fulfilling, focused, or energizing.\n\n${dataContext}`,
        ),
        // Loathed
        llmSynthesize(
          "You are writing a weekly check-in for Jason Shearer, a Cisco Field CTO. Write in first person as Jason. Be honest but professional. Use bullet points starting with '- '. Keep it under 2000 characters. Tone: drained, laborious, things avoided or postponed.",
          `Given open/overdue tasks, meetings without clear outcomes, and carry-forward items — identify activities that felt draining or were postponed.\n\n${dataContext}`,
        ),
        // Strengths rating
        llmSynthesize(
          "You are evaluating Jason Shearer's weekly check-in. Respond with ONLY a JSON object: {\"rating\": <1-5>, \"reasoning\": \"<one sentence>\"}. The question is: 'Last week, I had a chance to use my strengths every day.' 1=Strongly Disagree, 5=Strongly Agree.",
          `Based on this data, rate 1-5 with reasoning:\n\n${dataContext}`,
        ),
        // Outstanding value rating
        llmSynthesize(
          "You are evaluating Jason Shearer's weekly check-in. Respond with ONLY a JSON object: {\"rating\": <1-5>, \"reasoning\": \"<one sentence>\"}. The question is: 'Last week, I added outstanding value.' 1=Strongly Disagree, 5=Strongly Agree.",
          `Based on this data, rate 1-5 with reasoning:\n\n${dataContext}`,
        ),
        // Manager help
        llmSynthesize(
          `You are writing a weekly check-in for Jason Shearer. His manager is ${MANAGER_NAME}. Write in first person as Jason. Forward-looking, actionable asks. Keep it under 2000 characters.`,
          `Given upcoming work, open blockers, and pending decisions — what help might Jason need from ${MANAGER_NAME} this week?\n\n${dataContext}`,
        ),
        // Manager connect
        llmSynthesize(
          `You are evaluating whether Jason Shearer's manager ${MANAGER_NAME} connected with him about work priorities last week. Respond with ONLY a JSON object: {\"connected\": true/false, \"reasoning\": \"<one sentence>\"}. Look for 1:1s, syncs, or direct messages with the manager.`,
          `Based on this data, did ${MANAGER_NAME} connect with Jason about work priorities?\n\n${dataContext}`,
        ),
      ]);

    // ---- Parse LLM rating responses ----
    function parseRating(raw: string): { suggested: number; reasoning: string } {
      try {
        // Try to extract JSON from the response
        const jsonMatch = raw.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            suggested: Math.min(5, Math.max(1, parseInt(parsed.rating) || 3)),
            reasoning: parsed.reasoning || "",
          };
        }
      } catch {}
      return { suggested: 3, reasoning: "Unable to assess — review the data above." };
    }

    function parseManagerConnect(raw: string): { suggested: boolean; reasoning: string } {
      try {
        const jsonMatch = raw.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            suggested: !!parsed.connected,
            reasoning: parsed.reasoning || "",
          };
        }
      } catch {}
      return { suggested: false, reasoning: "Unable to determine — check your 1:1 schedule." };
    }

    const strengthsParsed = parseRating(strengthsDraft);
    const valueParsed = parseRating(valueDraft);
    const connectParsed = parseManagerConnect(managerConnectDraft);

    // ---- Build response ----
    return NextResponse.json({
      weekOf: reflectMonday.toISOString().slice(0, 10),
      reflectWeek: reflectRange,
      planWeek: planRange,
      manager: MANAGER_NAME,
      drafts: {
        strengths: strengthsParsed,
        outstandingValue: valueParsed,
        managerConnect: { suggested: connectParsed.suggested, reasoning: connectParsed.reasoning },
        loved: lovedDraft || "- (Review the completed tasks and meetings above to draft your response)",
        loathed: loathedDraft || "- (Review open/overdue tasks to identify draining activities)",
        priorities,
        managerHelp: managerHelpDraft || `- Would love to connect on priorities for next week with ${MANAGER_NAME}.`,
      },
      rawData: {
        completedTasks: completedTasks.slice(0, 25),
        meetings: weekMeetings.slice(0, 20),
        topPeople: topPeople.slice(0, 10),
        openTasks: openTasks.slice(0, 15),
        triageStats,
      },
    });
  } catch (err) {
    console.error("[weekly-checkin] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ------------------------------------------------------------------ */
/*  POST — regenerate a single field                                   */
/* ------------------------------------------------------------------ */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { field, context } = body as { field: string; context?: string };

    if (!field) return NextResponse.json({ error: "Missing field" }, { status: 400 });

    const reflectMonday = getReflectMonday();
    const reflectEnd = new Date(reflectMonday);
    reflectEnd.setDate(reflectMonday.getDate() + 7);

    // Gather context for the regeneration
    const [completedTasks, openTasks, weekMeetings, weekSummaries, topPeople] = await Promise.all([
      sql(
        `SELECT title, priority, source FROM tasks WHERE status = 'Done' AND updated_at >= $1 AND updated_at < $2 ORDER BY updated_at DESC LIMIT 25`,
        [reflectMonday.toISOString(), reflectEnd.toISOString()],
      ),
      sql(
        `SELECT title, priority, status FROM tasks WHERE status != 'Done' ORDER BY CASE WHEN priority LIKE 'P0%' THEN 0 WHEN priority LIKE 'P1%' THEN 1 ELSE 2 END LIMIT 15`,
      ),
      sql(
        `SELECT topic, date::text, host_name FROM meetings WHERE date >= $1 AND date < $2 ORDER BY date DESC LIMIT 20`,
        [reflectMonday.toISOString(), reflectEnd.toISOString()],
      ),
      sql(
        `SELECT title, summary, action_items FROM ai_summaries WHERE date >= $1 AND date < $2 ORDER BY date DESC LIMIT 10`,
        [reflectMonday.toISOString(), reflectEnd.toISOString()],
      ),
      sql(
        `SELECT p.name, COUNT(DISTINCT me.id) as messages, COUNT(DISTINCT mp.meeting_id) as meetings
         FROM people p
         LEFT JOIN message_excerpts me ON me.person_id = p.id AND me.date >= $1
         LEFT JOIN meeting_participants mp ON mp.person_id = p.id
           AND EXISTS (SELECT 1 FROM meetings m WHERE m.id = mp.meeting_id AND m.date >= $1 AND m.date < $2)
         GROUP BY p.id, p.name
         HAVING COUNT(DISTINCT me.id) + COUNT(DISTINCT mp.meeting_id) > 0
         ORDER BY COUNT(DISTINCT me.id) + COUNT(DISTINCT mp.meeting_id) DESC LIMIT 10`,
        [reflectMonday.toISOString(), reflectEnd.toISOString()],
      ),
    ]);

    const dataContext = [
      "COMPLETED TASKS:", completedTasks.map((t: any) => `- ${t.title}`).join("\n") || "(none)",
      "\nMEETINGS:", weekMeetings.map((m: any) => `- ${m.topic}`).join("\n") || "(none)",
      "\nSUMMARIES:", weekSummaries.map((s: any) => `- ${s.title}: ${(s.summary || "").slice(0, 150)}`).join("\n") || "(none)",
      "\nPEOPLE:", topPeople.map((p: any) => `- ${p.name}`).join("\n") || "(none)",
      "\nOPEN TASKS:", openTasks.map((t: any) => `- ${t.title} [${t.priority}]`).join("\n") || "(none)",
      context ? `\nADDITIONAL CONTEXT: ${context}` : "",
    ].join("\n");

    let result = "";

    switch (field) {
      case "loved":
        result = await llmSynthesize(
          "You are writing a weekly check-in for Jason Shearer, a Cisco Field CTO. Write in first person. Reference specific people and activities. Use bullet points with '- '. Max 2000 chars. Tone: fulfilled, focused, energized.",
          `Write 3-5 bullet points about fulfilling activities this week:\n\n${dataContext}`,
        );
        break;
      case "loathed":
        result = await llmSynthesize(
          "You are writing a weekly check-in for Jason Shearer. Write in first person. Honest but professional. Use '- ' bullets. Max 2000 chars. Tone: drained, laborious.",
          `Identify draining or postponed activities:\n\n${dataContext}`,
        );
        break;
      case "managerHelp":
        result = await llmSynthesize(
          `You are writing for Jason Shearer. Manager: ${MANAGER_NAME}. First person. Forward-looking. Max 2000 chars.`,
          `What help does Jason need from ${MANAGER_NAME} this week?\n\n${dataContext}`,
        );
        break;
      case "strengths":
        result = await llmSynthesize(
          "Respond with ONLY JSON: {\"rating\": <1-5>, \"reasoning\": \"...\"}. Question: 'I had a chance to use my strengths every day.'",
          `Rate 1-5:\n\n${dataContext}`,
        );
        return NextResponse.json({ field, draft: result });
      case "outstandingValue":
        result = await llmSynthesize(
          "Respond with ONLY JSON: {\"rating\": <1-5>, \"reasoning\": \"...\"}. Question: 'I added outstanding value.'",
          `Rate 1-5:\n\n${dataContext}`,
        );
        return NextResponse.json({ field, draft: result });
      default:
        return NextResponse.json({ error: `Unknown field: ${field}` }, { status: 400 });
    }

    return NextResponse.json({ field, draft: result || "(Unable to generate — try again)" });
  } catch (err) {
    console.error("[weekly-checkin POST] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
