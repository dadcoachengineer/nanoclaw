import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const PROJECTS_PATH = path.join(STORE_DIR, "initiatives.json");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const TOPIC_INDEX_PATH = path.join(STORE_DIR, "topic-index.json");
const SUMMARIES_PATH = path.join(STORE_DIR, "webex-summaries.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

function loadJson(p: string) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return {}; }
}

function saveJson(p: string, data: unknown) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Case-insensitive keyword match against a text string. */
function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Auto-linking helpers (list view counts)
// ---------------------------------------------------------------------------

interface InitiativeEntry {
  name: string;
  description: string;
  status: string;
  owner: string;
  notionProject?: string;
  keywords: string[];
  pinnedTaskIds: string[];
  pinnedPeople: string[];
  pinnedMeetingTitles: string[];
  createdAt: string;
}

function countLinkedPeople(
  personIndex: Record<string, any>,
  project: InitiativeEntry
): { count: number; latestDate: string | null } {
  let count = 0;
  let latest: string | null = null;

  for (const entry of Object.values(personIndex)) {
    const e = entry as any;
    const isPinned = project.pinnedPeople.some(
      (pp) => pp.toLowerCase() === (e.name || "").toLowerCase()
    );
    if (isPinned) {
      count++;
      continue;
    }
    // Check meetings, transcripts, and AI summaries for keyword matches
    const texts: { text: string; date?: string }[] = [];
    for (const m of e.meetings || []) texts.push({ text: m.topic || "", date: m.date });
    for (const t of e.transcriptMentions || []) texts.push({ text: t.topic || "", date: t.date });
    for (const s of e.aiSummaries || []) texts.push({ text: `${s.title || ""} ${s.summary || ""}`, date: s.date });

    const matched = texts.some((t) => matchesKeywords(t.text, project.keywords));
    if (matched) {
      count++;
      for (const t of texts) {
        if (t.date && (!latest || t.date > latest)) latest = t.date;
      }
    }
  }
  return { count, latestDate: latest };
}

function countLinkedMeetings(
  personIndex: Record<string, any>,
  summaries: Record<string, any>,
  project: InitiativeEntry
): { count: number; latestDate: string | null } {
  const seen = new Set<string>();
  let latest: string | null = null;

  // From pinned titles
  for (const title of project.pinnedMeetingTitles) {
    seen.add(title.toLowerCase());
  }

  // From person index meetings
  for (const entry of Object.values(personIndex)) {
    const e = entry as any;
    for (const m of e.meetings || []) {
      const key = (m.topic || "").toLowerCase();
      if (!seen.has(key) && matchesKeywords(m.topic || "", project.keywords)) {
        seen.add(key);
        if (m.date && (!latest || m.date > latest)) latest = m.date;
      }
    }
  }

  // From webex summaries
  for (const s of Object.values(summaries)) {
    const sm = s as any;
    const key = (sm.title || "").toLowerCase();
    if (!seen.has(key) && matchesKeywords(sm.title || "", project.keywords)) {
      seen.add(key);
      if (sm.date && (!latest || sm.date > latest)) latest = sm.date;
    }
  }

  return { count: seen.size, latestDate: latest };
}

// ---------------------------------------------------------------------------
// Detail view helpers
// ---------------------------------------------------------------------------

async function fetchNotionTasks(
  keywords: string[],
  pinnedTaskIds: string[]
): Promise<any[]> {
  const tasks: any[] = [];
  const seen = new Set<string>();

  // Fetch pinned tasks by ID
  for (const id of pinnedTaskIds) {
    try {
      const resp = await proxiedFetch(`https://api.notion.com/v1/pages/${id}`, {
        method: "GET",
        headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
      });
      const page = (await resp.json()) as any;
      if (page.id) {
        seen.add(page.id);
        tasks.push({
          id: page.id,
          title: page.properties?.Task?.title?.[0]?.plain_text || "",
          status: page.properties?.Status?.status?.name || "",
          priority: page.properties?.Priority?.select?.name || "",
          source: "pinned",
          pinned: true,
        });
      }
    } catch { /* skip unreachable tasks */ }
  }

  // Search by keywords
  for (const kw of keywords.slice(0, 5)) {
    try {
      const resp = await proxiedFetch(
        `https://api.notion.com/v1/databases/${NOTION_DB}/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
          body: JSON.stringify({
            filter: {
              and: [
                { property: "Status", status: { does_not_equal: "Done" } },
                {
                  or: [
                    { property: "Task", title: { contains: kw } },
                    { property: "Notes", rich_text: { contains: kw } },
                  ],
                },
              ],
            },
            page_size: 10,
          }),
        }
      );
      const data = (await resp.json()) as { results?: any[] };
      for (const page of data.results || []) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        tasks.push({
          id: page.id,
          title: page.properties?.Task?.title?.[0]?.plain_text || "",
          status: page.properties?.Status?.status?.name || "",
          priority: page.properties?.Priority?.select?.name || "",
          source: `keyword:${kw}`,
          pinned: false,
        });
      }
    } catch { /* skip failed queries */ }
  }

  return tasks;
}

function findLinkedPeople(
  personIndex: Record<string, any>,
  project: InitiativeEntry
): any[] {
  const people: any[] = [];
  const seen = new Set<string>();

  for (const [key, entry] of Object.entries(personIndex)) {
    const e = entry as any;
    const name = e.name || key;
    const isPinned = project.pinnedPeople.some(
      (pp) => pp.toLowerCase() === name.toLowerCase()
    );

    if (isPinned) {
      seen.add(key);
      people.push({
        name,
        email: e.emails?.[0] || null,
        avatar: e.avatar || null,
        meetingCount: (e.meetings || []).length,
        pinned: true,
      });
      continue;
    }

    // Check meetings, transcripts, and AI summaries
    const allTexts: string[] = [];
    for (const m of e.meetings || []) allTexts.push(m.topic || "");
    for (const t of e.transcriptMentions || []) allTexts.push(t.topic || "");
    for (const s of e.aiSummaries || []) allTexts.push(`${s.title || ""} ${s.summary || ""}`);

    if (allTexts.some((txt) => matchesKeywords(txt, project.keywords))) {
      if (seen.has(key)) continue;
      seen.add(key);
      people.push({
        name,
        email: e.emails?.[0] || null,
        avatar: e.avatar || null,
        meetingCount: (e.meetings || []).length,
        pinned: false,
      });
    }
  }

  // Sort: pinned first, then by meetingCount descending
  people.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.meetingCount - a.meetingCount;
  });

  return people;
}

function findLinkedMeetings(
  personIndex: Record<string, any>,
  summaries: Record<string, any>,
  project: InitiativeEntry
): any[] {
  const meetings: any[] = [];
  const seen = new Set<string>();

  // Pinned meetings first
  for (const title of project.pinnedMeetingTitles) {
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Try to find date from summaries or person index
    let date: string | null = null;
    let hasSummary = false;
    for (const s of Object.values(summaries)) {
      const sm = s as any;
      if ((sm.title || "").toLowerCase() === key) {
        date = sm.date || null;
        hasSummary = true;
        break;
      }
    }
    if (!date) {
      for (const entry of Object.values(personIndex)) {
        const e = entry as any;
        for (const m of e.meetings || []) {
          if ((m.topic || "").toLowerCase() === key) {
            date = m.date || null;
            break;
          }
        }
        if (date) break;
      }
    }

    meetings.push({ title, date, hasSummary, pinned: true });
  }

  // From person index
  for (const entry of Object.values(personIndex)) {
    const e = entry as any;
    for (const m of e.meetings || []) {
      const key = (m.topic || "").toLowerCase();
      if (seen.has(key)) continue;
      if (matchesKeywords(m.topic || "", project.keywords)) {
        seen.add(key);
        const hasSummary = Object.values(summaries).some(
          (s: any) => (s.title || "").toLowerCase() === key
        );
        meetings.push({ title: m.topic, date: m.date || null, hasSummary, pinned: false });
      }
    }
  }

  // From webex summaries
  for (const s of Object.values(summaries)) {
    const sm = s as any;
    const key = (sm.title || "").toLowerCase();
    if (seen.has(key)) continue;
    if (matchesKeywords(sm.title || "", project.keywords)) {
      seen.add(key);
      meetings.push({ title: sm.title, date: sm.date || null, hasSummary: true, pinned: false });
    }
  }

  // Sort: pinned first, then by date descending
  meetings.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.date || "").localeCompare(a.date || "");
  });

  return meetings;
}

function findLinkedSummaries(
  summaries: Record<string, any>,
  project: InitiativeEntry
): any[] {
  const result: any[] = [];

  for (const [meetingId, s] of Object.entries(summaries)) {
    const sm = s as any;
    if (matchesKeywords(sm.title || "", project.keywords)) {
      result.push({
        meetingId,
        title: sm.title || "",
        date: sm.date || null,
        summary: sm.summary || "",
        actionItems: sm.actionItems || [],
      });
    }
  }

  result.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return result;
}

function buildActivityFeed(
  tasks: any[],
  meetings: any[],
  summariesList: any[]
): any[] {
  const activity: any[] = [];

  for (const t of tasks) {
    activity.push({
      type: "task",
      title: t.title,
      date: null, // Notion tasks don't carry a date from our query
      detail: `${t.status}${t.priority ? " / " + t.priority : ""}`,
    });
  }

  for (const m of meetings) {
    activity.push({
      type: "meeting",
      title: m.title,
      date: m.date,
      detail: m.hasSummary ? "Has AI summary" : "No summary",
    });
  }

  for (const s of summariesList) {
    activity.push({
      type: "summary",
      title: s.title,
      date: s.date,
      detail: (s.actionItems || []).length + " action items",
    });
  }

  // Sort by date descending; null dates go last
  activity.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  return activity;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const slug = searchParams.get("slug");
  const projects = loadJson(PROJECTS_PATH) as Record<string, InitiativeEntry>;

  if (slug) {
    // --- Detail view ---
    const project = projects[slug];
    if (!project) {
      return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
    }

    const personIndex = loadJson(INDEX_PATH);
    const summaries = loadJson(SUMMARIES_PATH);

    const [tasks, people, meetings, summariesList] = await Promise.all([
      fetchNotionTasks(project.keywords, project.pinnedTaskIds),
      Promise.resolve(findLinkedPeople(personIndex, project)),
      Promise.resolve(findLinkedMeetings(personIndex, summaries, project)),
      Promise.resolve(findLinkedSummaries(summaries, project)),
    ]);

    const activity = buildActivityFeed(tasks, meetings, summariesList);

    return NextResponse.json({
      name: project.name,
      description: project.description,
      status: project.status,
      keywords: project.keywords,
      tasks,
      people,
      meetings,
      summaries: summariesList,
      activity,
    });
  }

  // --- List view ---
  const personIndex = loadJson(INDEX_PATH);
  const summaries = loadJson(SUMMARIES_PATH);

  const list = Object.entries(projects).map(([slug, project]) => {
    const { count: peopleCount, latestDate: peopleLast } = countLinkedPeople(personIndex, project);
    const { count: meetingCount, latestDate: meetingLast } = countLinkedMeetings(
      personIndex,
      summaries,
      project
    );

    // Task count is expensive (Notion API) so we skip it in list view and report 0.
    // The detail view will give the real count.
    const dates = [peopleLast, meetingLast, project.createdAt].filter(Boolean) as string[];
    const recentActivity = dates.sort().pop() || project.createdAt;

    return {
      slug,
      name: project.name,
      description: project.description,
      status: project.status,
      owner: project.owner,
      taskCount: 0,
      peopleCount: peopleCount,
      meetingCount: meetingCount,
      recentActivity,
      pinnedTaskIds: project.pinnedTaskIds || [],
    };
  });

  // Sort: active first, then by recentActivity descending
  list.sort((a, b) => {
    if (a.status !== b.status) {
      if (a.status === "active") return -1;
      if (b.status === "active") return 1;
    }
    return (b.recentActivity || "").localeCompare(a.recentActivity || "");
  });

  return NextResponse.json(list);
}

// ---------------------------------------------------------------------------
// POST handler — create initiative
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, description, keywords, notionProject, owner } = body;

  if (!name || !description || !keywords || !Array.isArray(keywords)) {
    return NextResponse.json(
      { error: "name, description, and keywords (array) are required" },
      { status: 400 }
    );
  }

  const projects = loadJson(PROJECTS_PATH) as Record<string, InitiativeEntry>;
  const slug = slugify(name);

  if (projects[slug]) {
    return NextResponse.json({ error: "Initiative with this slug already exists" }, { status: 409 });
  }

  const newProject: InitiativeEntry = {
    name,
    description,
    status: "active",
    owner: owner || "Jason",
    notionProject: notionProject || undefined,
    keywords,
    pinnedTaskIds: [],
    pinnedPeople: [],
    pinnedMeetingTitles: [],
    createdAt: new Date().toISOString().slice(0, 10),
  };

  projects[slug] = newProject;
  saveJson(PROJECTS_PATH, projects);

  return NextResponse.json({ slug, ...newProject }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PATCH handler — update initiative (fields + pin/unpin)
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { slug, ...updates } = body;

  if (!slug) {
    return NextResponse.json({ error: "slug is required" }, { status: 400 });
  }

  const projects = loadJson(PROJECTS_PATH) as Record<string, InitiativeEntry>;
  const project = projects[slug];

  if (!project) {
    return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
  }

  // Pin / unpin operations
  if (updates.pinTask) {
    if (!project.pinnedTaskIds.includes(updates.pinTask)) {
      project.pinnedTaskIds.push(updates.pinTask);
    }
  }
  if (updates.unpinTask) {
    project.pinnedTaskIds = project.pinnedTaskIds.filter((id: string) => id !== updates.unpinTask);
  }
  if (updates.pinPerson) {
    if (!project.pinnedPeople.includes(updates.pinPerson)) {
      project.pinnedPeople.push(updates.pinPerson);
    }
  }
  if (updates.unpinPerson) {
    project.pinnedPeople = project.pinnedPeople.filter((n: string) => n !== updates.unpinPerson);
  }
  if (updates.pinMeeting) {
    if (!project.pinnedMeetingTitles.includes(updates.pinMeeting)) {
      project.pinnedMeetingTitles.push(updates.pinMeeting);
    }
  }
  if (updates.unpinMeeting) {
    project.pinnedMeetingTitles = project.pinnedMeetingTitles.filter(
      (t: string) => t !== updates.unpinMeeting
    );
  }

  // Direct field updates
  if (updates.status !== undefined) project.status = updates.status;
  if (updates.description !== undefined) project.description = updates.description;
  if (updates.keywords !== undefined) project.keywords = updates.keywords;

  projects[slug] = project;
  saveJson(PROJECTS_PATH, projects);

  return NextResponse.json({ slug, ...project });
}
