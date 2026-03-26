import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { proxiedFetch } from "@/lib/onecli";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const TOPIC_INDEX_PATH = path.join(STORE_DIR, "topic-index.json");
const NOTION_DB = "5b4e1d2d7259496ea237ef0525c3ce78";

function loadJson(p: string) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return {}; }
}

interface PersonCandidate {
  key: string;
  name: string;
  email?: string;
  avatar?: string;
  meetingCount: number;
  messageCount: number;
}

function findPerson(index: Record<string, any>, name: string) {
  const lower = name.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  if (index[lower]) return index[lower];
  for (const entry of Object.values(index)) {
    const e = entry as any;
    if (e.name?.toLowerCase().includes(lower) || lower.includes(e.name?.toLowerCase())) return e;
    // Last name match
    const parts = lower.split(" ");
    const eParts = (e.name || "").toLowerCase().split(" ");
    if (parts.length > 0 && eParts.length > 0 &&
        parts[parts.length - 1] === eParts[eParts.length - 1] &&
        parts[parts.length - 1].length > 3) return e;
  }
  return null;
}

function findPersonCandidates(index: Record<string, any>, name: string): PersonCandidate[] {
  const lower = name.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const seen = new Set<string>();
  const candidates: PersonCandidate[] = [];

  function addCandidate(key: string, e: any) {
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      key,
      name: e.name || key,
      email: e.emails?.[0],
      avatar: e.avatar,
      meetingCount: (e.meetings || []).length,
      messageCount: (e.messageExcerpts || []).length,
    });
  }

  // Exact key match
  if (index[lower]) addCandidate(lower, index[lower]);

  for (const [key, entry] of Object.entries(index)) {
    const e = entry as any;
    const eName = (e.name || "").toLowerCase();
    // Name includes match (bidirectional)
    if (eName.includes(lower) || lower.includes(eName)) {
      addCandidate(key, e);
      continue;
    }
    // Last name match
    const parts = lower.split(" ");
    const eParts = eName.split(" ");
    if (parts.length > 0 && eParts.length > 0 &&
        parts[parts.length - 1] === eParts[eParts.length - 1] &&
        parts[parts.length - 1].length > 3) {
      addCandidate(key, e);
    }
  }

  // Sort by total interaction count descending
  candidates.sort((a, b) => (b.meetingCount + b.messageCount) - (a.meetingCount + a.messageCount));
  return candidates;
}

function extractPersonName(meetingTitle: string, hostName?: string, hostEmail?: string): string {
  // For 1:1s, extract the other person's name from the title
  const cleaned = meetingTitle
    .replace(/&/g, "")
    .replace(/1:1/gi, "")
    .replace(/Jason/gi, "")
    .replace(/Shearer/gi, "")
    .replace(/['']s?\s*(meeting|sync|catch up|check in)/gi, "")
    .replace(/\d{8}/g, "")
    .replace(/[-–]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(",")[0]
    .trim();

  return cleaned || (hostEmail !== "jasheare@cisco.com" ? (hostName || "") : "");
}

/**
 * GET /api/meeting-prep?meetingId=xxx
 * or GET /api/meeting-prep?title=xxx&host=xxx&hostEmail=xxx
 *
 * Returns contextual prep data for a specific meeting.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const title = searchParams.get("title") || "";
  const host = searchParams.get("host") || "";
  const hostEmail = searchParams.get("hostEmail") || "";
  const selectedPerson = searchParams.get("selectedPerson") || "";

  const personIndex = loadJson(INDEX_PATH);
  const topicIndex = loadJson(TOPIC_INDEX_PATH);

  const personName = extractPersonName(title, host, hostEmail);

  let person: any = null;
  let candidates: PersonCandidate[] | undefined;

  if (selectedPerson && personIndex[selectedPerson]) {
    // Explicit selection — skip fuzzy matching
    person = personIndex[selectedPerson];
  } else if (personName) {
    const allCandidates = findPersonCandidates(personIndex, personName);
    if (allCandidates.length > 1) {
      candidates = allCandidates;
    }
    person = allCandidates.length > 0 ? personIndex[allCandidates[0].key] : null;
  }

  // Match topics
  const titleLower = title.toLowerCase();
  const matchedTopics = Object.values(topicIndex)
    .filter((t: any) => {
      const tName = (t.name || "").toLowerCase();
      return titleLower.includes(tName) || tName.split(/[\/\s]/).some((w: string) => w.length > 3 && titleLower.includes(w));
    })
    .map((t: any) => ({
      name: t.name,
      taskCount: (t.notionTasks || []).length,
      meetingCount: (t.meetings || []).length,
      people: (t.people || []).slice(0, 10),
    }));

  // Get open tasks related to this person or topic
  let openTasks: any[] = [];
  let followUpsOwed: any[] = [];

  const searchTerms: string[] = [];
  if (personName) searchTerms.push(personName);
  // Add topic keywords
  for (const t of matchedTopics) {
    searchTerms.push(t.name.split(/[\/\(\)]/)[0].trim());
  }

  for (const term of searchTerms.slice(0, 3)) {
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
                { or: [
                  { property: "Task", title: { contains: term } },
                  { property: "Notes", rich_text: { contains: term } },
                ]},
              ],
            },
            page_size: 5,
          }),
        }
      );
      const data = (await resp.json()) as { results?: any[] };
      for (const page of data.results || []) {
        const taskTitle = page.properties?.Task?.title?.[0]?.plain_text || "";
        const status = page.properties?.Status?.status?.name || "";
        const priority = page.properties?.Priority?.select?.name || "";
        const delegated = page.properties?.Delegated?.select?.name || "";
        const id = page.id;

        if (openTasks.find((t) => t.id === id)) continue;

        const task = { id, title: taskTitle, status, priority, delegated };
        openTasks.push(task);

        // Tasks delegated to Jason or where he's the owner
        if (delegated === "Jason" || !delegated) {
          followUpsOwed.push(task);
        }
      }
    } catch {}
  }

  // Build the prep
  const prep: Record<string, unknown> = {
    meetingTitle: title,
    personName: person?.name || personName || null,
    personEmail: person?.emails?.[0] || (hostEmail !== "jasheare@cisco.com" ? hostEmail : null),
    personAvatar: person?.avatar || null,
  };

  if (person) {
    prep.recentMessages = (person.messageExcerpts || [])
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .slice(0, 5)
      .map((m: any) => ({ text: m.text, date: m.date }));

    prep.previousMeetings = (person.meetings || [])
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .slice(0, 5)
      .map((m: any) => ({ topic: m.topic, date: m.date }));

    prep.transcriptHighlights = (person.transcriptMentions || [])
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .slice(0, 3)
      .map((t: any) => ({
        topic: t.topic,
        date: t.date,
        snippets: (t.snippets || []).slice(0, 2),
      }));

    prep.stats = {
      meetings: (person.meetings || []).length,
      transcripts: (person.transcriptMentions || []).length,
      messages: (person.messageExcerpts || []).length,
      tasks: (person.notionTasks || []).length,
    };
  }

  prep.matchedTopics = matchedTopics;
  prep.openTasks = openTasks;
  prep.followUpsOwed = followUpsOwed;
  if (candidates) prep.candidates = candidates;

  return NextResponse.json(prep);
}
