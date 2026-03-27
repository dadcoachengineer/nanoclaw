import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { proxiedFetch } from "@/lib/onecli";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const TOPIC_INDEX_PATH = path.join(STORE_DIR, "topic-index.json");
const SUMMARIES_PATH = path.join(STORE_DIR, "webex-summaries.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

function loadJson(p: string) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return {}; }
}

/* ------------------------------------------------------------------ */
/*  Priority keyword buckets                                          */
/* ------------------------------------------------------------------ */
const PRIORITY_KEYWORDS: Record<string, { label: string; keywords: string[] }> = {
  personal_development: {
    label: "Personal Development",
    keywords: ["coaching", "ipec", "development", "training", "learning"],
  },
  thought_leadership: {
    label: "Workplace Field CTO Thought Leadership",
    keywords: ["thought leadership", "vidcast", "publish", "article", "presentation", "speaking"],
  },
  partner_alignment: {
    label: "Partner Alignment",
    keywords: ["partner", "wesco", "ibew", "neca", "distributor", "ecosystem"],
  },
  customer_engagement: {
    label: "Customer Engagement",
    keywords: ["customer", "pov", "demo", "proof of value", "account", "opportunity"],
  },
  team_engagement: {
    label: "Team Engagement",
    keywords: ["1:1", "team sync", "forecast", "pipeline"],
  },
  coaching: {
    label: "Coaching/Mentorship/SE Leadership",
    keywords: ["coaching", "mentor", "interview", "candidate", "hiring", "panel"],
  },
  enablement: {
    label: "Enablement",
    keywords: ["enablement", "cisco live", "training", "workshop", "session"],
  },
};

function classifyTask(title: string): string[] {
  const lower = title.toLowerCase();
  const matched: string[] = [];
  for (const [key, { keywords }] of Object.entries(PRIORITY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matched.push(key);
    }
  }
  return matched.length > 0 ? matched : ["customer_engagement"]; // default bucket
}

/* ------------------------------------------------------------------ */
/*  Time helpers                                                      */
/* ------------------------------------------------------------------ */
function getMondayOfCurrentWeek(): Date {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function isWithinPastWeek(dateStr: string, monday: Date): boolean {
  const d = new Date(dateStr);
  const weekAgo = new Date(monday);
  weekAgo.setDate(weekAgo.getDate() - 7);
  return d >= weekAgo && d < new Date(monday.getTime() + 7 * 86400000);
}

/* ------------------------------------------------------------------ */
/*  Meeting engagement scoring                                        */
/* ------------------------------------------------------------------ */
interface MeetingSignal {
  title: string;
  date: string;
  engagementScore: number;
  signals: string[];
  source: string;
}

function scoreMeetingEngagement(
  summaries: Record<string, any>,
  personIndex: Record<string, any>,
  monday: Date
): { loved: MeetingSignal[]; loathed: MeetingSignal[] } {
  const scored: MeetingSignal[] = [];
  const seen = new Set<string>();

  // Score from AI summaries
  for (const s of Object.values(summaries)) {
    const entry = s as any;
    if (!entry.date || !isWithinPastWeek(entry.date, monday)) continue;
    const title = entry.title || "Untitled Meeting";
    if (seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());

    let score = 0;
    const signals: string[] = [];

    const actionCount = (entry.actionItems || []).length;
    if (actionCount > 3) {
      score += 3;
      signals.push(`${actionCount} action items created`);
    } else if (actionCount > 0) {
      score += 1;
      signals.push(`${actionCount} action item${actionCount > 1 ? "s" : ""}`);
    } else {
      score -= 2;
      signals.push("No action items");
    }

    const summaryLen = (entry.summary || "").length;
    if (summaryLen > 500) {
      score += 2;
      signals.push("Rich discussion");
    } else if (summaryLen > 200) {
      score += 1;
      signals.push("Moderate discussion");
    }

    // Check for follow-up messages in person index
    const titleLower = title.toLowerCase();
    for (const person of Object.values(personIndex)) {
      const p = person as any;
      const msgs = (p.messageExcerpts || []).filter((m: any) => {
        if (!m.date || !isWithinPastWeek(m.date, monday)) return false;
        const msgDate = new Date(m.date);
        const mtgDate = new Date(entry.date);
        return msgDate > mtgDate && msgDate.getTime() - mtgDate.getTime() < 3 * 86400000;
      });
      if (msgs.length > 0) {
        score += 1;
        signals.push("Follow-up messages sent");
        break;
      }
    }

    scored.push({ title, date: entry.date, engagementScore: score, signals, source: "Webex AI Summary" });
  }

  // Also add meetings from person-index that lack an AI summary
  for (const person of Object.values(personIndex)) {
    const p = person as any;
    for (const mtg of p.meetings || []) {
      if (!mtg.date || !isWithinPastWeek(mtg.date, monday)) continue;
      const title = mtg.topic || "Untitled";
      if (seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());

      let score = -1; // No AI summary means lower engagement
      const signals: string[] = [];

      // Check if there's a transcript
      const hasTranscript = (p.transcriptMentions || []).some(
        (t: any) => t.topic?.toLowerCase() === title.toLowerCase()
      );
      if (!hasTranscript) {
        score -= 1;
        signals.push("No transcript");
      }

      signals.push("No AI summary available");
      scored.push({ title, date: mtg.date, engagementScore: score, signals, source: "Calendar" });
    }
  }

  scored.sort((a, b) => b.engagementScore - a.engagementScore);

  return {
    loved: scored.filter((m) => m.engagementScore > 0).slice(0, 5),
    loathed: scored.filter((m) => m.engagementScore <= 0).slice(0, 5),
  };
}

/* ------------------------------------------------------------------ */
/*  Manager connect detection                                         */
/* ------------------------------------------------------------------ */
function detectManagerConnect(
  personIndex: Record<string, any>,
  summaries: Record<string, any>,
  monday: Date
): string[] {
  const evidence: string[] = [];
  const managerTerms = ["alfredo", "bouchot"];

  // Check meetings
  let found = false;
  for (const person of Object.values(personIndex)) {
    const p = person as any;
    const nameLower = (p.name || "").toLowerCase();
    if (!managerTerms.some((t) => nameLower.includes(t))) continue;
    const recentMeetings = (p.meetings || []).filter((m: any) =>
      m.date && isWithinPastWeek(m.date, monday)
    );
    if (recentMeetings.length > 0) {
      found = true;
      for (const m of recentMeetings) {
        evidence.push(`Met with Alfredo: ${m.topic} (${new Date(m.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`);
      }
    }
  }

  // Check AI summaries
  for (const s of Object.values(summaries)) {
    const entry = s as any;
    if (!entry.date || !isWithinPastWeek(entry.date, monday)) continue;
    const titleLower = (entry.title || "").toLowerCase();
    if (managerTerms.some((t) => titleLower.includes(t))) {
      if (!found) found = true;
      evidence.push(`AI summary: ${entry.title}`);
    }
  }

  if (!found) {
    evidence.push("No 1:1 with Alfredo detected this week");
  }

  return evidence;
}

/* ------------------------------------------------------------------ */
/*  GET /api/weekly-checkin                                           */
/* ------------------------------------------------------------------ */
export async function GET() {
  const personIndex = loadJson(INDEX_PATH);
  const topicIndex = loadJson(TOPIC_INDEX_PATH);
  const summaries = loadJson(SUMMARIES_PATH);
  const monday = getMondayOfCurrentWeek();

  const weekOfLabel = monday.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  /* --- Notion tasks (Cisco project, modified last 7 days) --- */
  const weekAgo = new Date(monday);
  weekAgo.setDate(weekAgo.getDate() - 7);

  let doneTasks: any[] = [];
  let openTasks: any[] = [];

  try {
    // Completed tasks
    const doneResp = await proxiedFetch(
      `https://api.notion.com/v1/databases/${NOTION_DB}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          filter: {
            and: [
              { property: "Project", select: { equals: "Cisco" } },
              { property: "Status", status: { equals: "Done" } },
              { timestamp: "last_edited_time", last_edited_time: { on_or_after: weekAgo.toISOString().slice(0, 10) } },
            ],
          },
          page_size: 50,
        }),
      }
    );
    const doneData = (await doneResp.json()) as { results?: any[] };
    doneTasks = (doneData.results || []).map((page: any) => ({
      id: page.id,
      title: page.properties?.Task?.title?.[0]?.plain_text || "",
      status: page.properties?.Status?.status?.name || "",
      priority: page.properties?.Priority?.select?.name || "",
    }));
  } catch {}

  try {
    // Open tasks
    const openResp = await proxiedFetch(
      `https://api.notion.com/v1/databases/${NOTION_DB}/query`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          filter: {
            and: [
              { property: "Project", select: { equals: "Cisco" } },
              { property: "Status", status: { does_not_equal: "Done" } },
              { timestamp: "last_edited_time", last_edited_time: { on_or_after: weekAgo.toISOString().slice(0, 10) } },
            ],
          },
          page_size: 50,
        }),
      }
    );
    const openData = (await openResp.json()) as { results?: any[] };
    openTasks = (openData.results || []).map((page: any) => ({
      id: page.id,
      title: page.properties?.Task?.title?.[0]?.plain_text || "",
      status: page.properties?.Status?.status?.name || "",
      priority: page.properties?.Priority?.select?.name || "",
      delegated: page.properties?.Delegated?.select?.name || "",
      notes: page.properties?.Notes?.rich_text?.[0]?.plain_text || "",
    }));
  } catch {}

  /* --- Build priorities --- */
  const priorities: Record<string, {
    label: string;
    items: string[];
    tasksDone: number;
    tasksOpen: number;
  }> = {};

  for (const [key, { label }] of Object.entries(PRIORITY_KEYWORDS)) {
    priorities[key] = { label, items: [], tasksDone: 0, tasksOpen: 0 };
  }

  for (const task of doneTasks) {
    const buckets = classifyTask(task.title);
    for (const bucket of buckets) {
      priorities[bucket].tasksDone++;
      priorities[bucket].items.push(task.title);
    }
  }

  for (const task of openTasks) {
    const buckets = classifyTask(task.title);
    for (const bucket of buckets) {
      priorities[bucket].tasksOpen++;
    }
  }

  /* --- Strengths evidence --- */
  const strengthEvidence: string[] = [];

  // Count unique meetings this week
  const weekMeetings = new Set<string>();
  for (const person of Object.values(personIndex)) {
    const p = person as any;
    for (const m of p.meetings || []) {
      if (m.date && isWithinPastWeek(m.date, monday)) {
        weekMeetings.add(m.topic || m.id);
      }
    }
  }
  if (weekMeetings.size > 0) {
    strengthEvidence.push(`Attended ${weekMeetings.size} meeting${weekMeetings.size > 1 ? "s" : ""} this week`);
  }

  // Count people interacted with
  const interactedPeople = new Set<string>();
  for (const [key, person] of Object.entries(personIndex)) {
    const p = person as any;
    const hasMeeting = (p.meetings || []).some((m: any) => m.date && isWithinPastWeek(m.date, monday));
    const hasMessage = (p.messageExcerpts || []).some((m: any) => m.date && isWithinPastWeek(m.date, monday));
    if (hasMeeting || hasMessage) interactedPeople.add(p.name || key);
  }
  if (interactedPeople.size > 0) {
    strengthEvidence.push(`Engaged with ${interactedPeople.size} people`);
  }

  if (doneTasks.length > 0) {
    strengthEvidence.push(`Completed ${doneTasks.length} task${doneTasks.length > 1 ? "s" : ""}`);
  }

  // Add top completed task titles
  const highPriorityDone = doneTasks
    .filter((t: any) => t.priority?.includes("P0") || t.priority?.includes("P1"))
    .slice(0, 3);
  for (const t of highPriorityDone) {
    strengthEvidence.push(`Closed ${t.priority}: ${t.title}`);
  }

  /* --- Outstanding value evidence --- */
  const valueEvidence: string[] = [];
  if (highPriorityDone.length > 0) {
    valueEvidence.push(`Closed ${highPriorityDone.length} high-priority task${highPriorityDone.length > 1 ? "s" : ""}`);
  }

  // AI summaries with many action items as value signals
  for (const s of Object.values(summaries)) {
    const entry = s as any;
    if (!entry.date || !isWithinPastWeek(entry.date, monday)) continue;
    const actionCount = (entry.actionItems || []).length;
    if (actionCount >= 3) {
      valueEvidence.push(`Led ${entry.title} (${actionCount} action items)`);
    }
  }

  if (doneTasks.length > 0 && valueEvidence.length === 0) {
    valueEvidence.push(`${doneTasks.length} task${doneTasks.length > 1 ? "s" : ""} completed this week`);
  }

  /* --- Manager connect --- */
  const managerEvidence = detectManagerConnect(personIndex, summaries, monday);

  /* --- Loved / Loathed --- */
  const { loved, loathed } = scoreMeetingEngagement(summaries, personIndex, monday);

  /* --- Manager help --- */
  const blockedTasks = openTasks.filter((t: any) =>
    t.status?.toLowerCase().includes("blocked") ||
    t.status?.toLowerCase().includes("waiting") ||
    t.notes?.toLowerCase().includes("need") ||
    t.notes?.toLowerCase().includes("blocked")
  );
  let managerHelp = "";
  if (blockedTasks.length > 0) {
    const items = blockedTasks.slice(0, 3).map((t: any) => t.title).join(", ");
    managerHelp = `Suggested: Need Alfredo's input on ${items}`;
  } else if (openTasks.length > 10) {
    managerHelp = `Suggested: Discuss prioritization - ${openTasks.length} open tasks need triage`;
  } else {
    managerHelp = "No blocked tasks detected. Consider proactively sharing wins and upcoming plans.";
  }

  /* --- Build response --- */
  const response = {
    weekOf: weekOfLabel,
    generatedAt: new Date().toISOString(),
    ratings: {
      strengths: {
        score: null,
        evidence: strengthEvidence.length > 0 ? strengthEvidence : ["No activity data found for this week"],
      },
      outstandingValue: {
        score: null,
        evidence: valueEvidence.length > 0 ? valueEvidence : ["No high-impact completions detected"],
      },
      managerConnect: {
        score: null,
        evidence: managerEvidence,
      },
    },
    loved: loved.map((m) => ({
      activity: m.title,
      signal: m.signals.join(", "),
      source: m.source,
    })),
    loathed: loathed.map((m) => ({
      activity: m.title,
      signal: m.signals.join(", "),
      source: m.source,
    })),
    priorities,
    managerHelp,
  };

  return NextResponse.json(response);
}
