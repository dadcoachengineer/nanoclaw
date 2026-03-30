import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const TEAM_PATH = path.join(STORE_DIR, "team.json");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

interface TeamMember {
  name: string;
  role: string;
  email: string;
}

function loadTeam(): TeamMember[] {
  try {
    return JSON.parse(fs.readFileSync(TEAM_PATH, "utf-8")).members || [];
  } catch { return []; }
}

function loadPersonIndex(): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); } catch { return {}; }
}

/**
 * GET /api/team — team overview with task counts, engagement stats, upcoming 1:1s
 * GET /api/team?member=Liz+Helyer — detailed view for one member
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberName = req.nextUrl.searchParams.get("member");
  const team = loadTeam();
  const personIndex = loadPersonIndex();

  if (memberName) {
    // Detail view for one member
    const member = team.find((m) => m.name.toLowerCase() === memberName.toLowerCase());
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const key = member.name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    const person = personIndex[key] || {};

    // Fetch their delegated tasks from Notion
    let tasks: any[] = [];
    try {
      const firstName = member.name.split(" ")[0];
      // Query 1: Tasks delegated to this person
      const delegatedResp = await proxiedFetch("https://api.notion.com/v1/databases/" + NOTION_DB + "/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          filter: {
            and: [
              { property: "Status", status: { does_not_equal: "Done" } },
              { property: "Delegated To", select: { equals: firstName } },
            ],
          },
          page_size: 50,
        }),
      });
      const delegatedData = await delegatedResp.json() as any;

      // Query 2: Tasks mentioning this person by name (in title or notes)
      const mentionedResp = await proxiedFetch("https://api.notion.com/v1/databases/" + NOTION_DB + "/query", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          filter: {
            and: [
              { property: "Status", status: { does_not_equal: "Done" } },
              { or: [
                { property: "Task", title: { contains: firstName } },
                { property: "Notes", rich_text: { contains: member.name } },
              ]},
            ],
          },
          page_size: 50,
        }),
      });
      const mentionedData = await mentionedResp.json() as any;

      // Merge, dedupe, and classify relationship tier
      const allResults = [...(delegatedData.results || []), ...(mentionedData.results || [])];
      const seen = new Set<string>();
      tasks = allResults
        .filter((p: any) => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
        .map((p: any) => {
          const isDelegated = p.properties?.["Delegated To"]?.select?.name === firstName;
          const notes = (p.properties?.Notes?.rich_text || []).map((t: any) => t.plain_text).join("");
          const isTagged = notes.includes(`[People:`) && notes.toLowerCase().includes(member.name.toLowerCase());
          // Tier: delegated > tagged > mentioned
          const tier: "delegated" | "tagged" | "mentioned" = isDelegated ? "delegated" : isTagged ? "tagged" : "mentioned";
          return {
            id: p.id,
            title: (p.properties?.Task?.title || []).map((t: any) => t.plain_text).join(""),
            priority: p.properties?.Priority?.select?.name || "",
            status: p.properties?.Status?.status?.name || "",
            project: p.properties?.Project?.select?.name || "",
            context: p.properties?.Context?.select?.name || "",
            tier,
          };
        })
        .sort((a, b) => {
          const tierRank = { delegated: 0, tagged: 1, mentioned: 2 };
          const tierDiff = tierRank[a.tier] - tierRank[b.tier];
          if (tierDiff !== 0) return tierDiff;
          // Within same tier, sort by priority
          const pRank = (p: string) => p.includes("P0") ? 0 : p.includes("P1") ? 1 : p.includes("P2") ? 2 : 3;
          return pRank(a.priority) - pRank(b.priority);
        });
    } catch {}

    return NextResponse.json({
      ...member,
      avatar: person.avatar || null,
      company: person.company || "Cisco",
      jobTitle: person.jobTitle || member.role,
      tasks,
      stats: {
        meetings: (person.meetings || []).length,
        messages: (person.messageExcerpts || []).length,
        transcripts: (person.transcriptMentions || []).length,
        openTasks: tasks.length,
      },
      recentMessages: (person.messageExcerpts || [])
        .sort((a: any, b: any) => b.date.localeCompare(a.date))
        .slice(0, 5),
      recentMeetings: (person.meetings || [])
        .sort((a: any, b: any) => b.date.localeCompare(a.date))
        .slice(0, 5),
    });
  }

  // Team overview
  const overview = await Promise.all(team.map(async (member) => {
    const key = member.name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
    const person = personIndex[key] || {};

    // Count tasks: delegated + mentioned by name
    let taskCount = 0;
    let p0Count = 0;
    try {
      const firstName = member.name.split(" ")[0];
      const [delegatedResp, mentionedResp] = await Promise.all([
        proxiedFetch("https://api.notion.com/v1/databases/" + NOTION_DB + "/query", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
          body: JSON.stringify({
            filter: { and: [
              { property: "Status", status: { does_not_equal: "Done" } },
              { property: "Delegated To", select: { equals: firstName } },
            ]},
            page_size: 100,
          }),
        }),
        proxiedFetch("https://api.notion.com/v1/databases/" + NOTION_DB + "/query", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
          body: JSON.stringify({
            filter: { and: [
              { property: "Status", status: { does_not_equal: "Done" } },
              { or: [
                { property: "Task", title: { contains: firstName } },
                { property: "Notes", rich_text: { contains: member.name } },
              ]},
            ]},
            page_size: 100,
          }),
        }),
      ]);
      const d1 = await delegatedResp.json() as any;
      const d2 = await mentionedResp.json() as any;
      const seen = new Set<string>();
      const all = [...(d1.results || []), ...(d2.results || [])].filter((p: any) => {
        if (seen.has(p.id)) return false; seen.add(p.id); return true;
      });
      taskCount = all.length;
      p0Count = all.filter((p: any) => p.properties?.Priority?.select?.name?.includes("P0")).length;
    } catch {}

    return {
      name: member.name,
      role: member.role,
      email: member.email,
      avatar: person.avatar || null,
      stats: {
        openTasks: taskCount,
        p0Tasks: p0Count,
        meetings: (person.meetings || []).length,
        messages: (person.messageExcerpts || []).length,
      },
    };
  }));

  return NextResponse.json({ team: overview });
}

/**
 * PATCH /api/team — update team roster
 * Body: { members: TeamMember[] }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { members } = await req.json();
    fs.writeFileSync(TEAM_PATH, JSON.stringify({ members }, null, 2));
    return NextResponse.json({ updated: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
