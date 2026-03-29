import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const PERSON_INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const PROFILE_PATH = path.join(STORE_DIR, "profile.md");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SuggestedAction {
  type: "email" | "webex" | "meeting" | "document" | "subtask";
  label: string;
  /** Who this action targets — name, email, etc. */
  to?: string;
  toEmail?: string;
  toRoomId?: string;
  /** Pre-filled fields for the compose UI */
  subject?: string;
  body?: string;
  /** Whether this goes through airgapped copy flow (Cisco) or direct API */
  airgapped: boolean;
  /** Brief rationale shown in the UI */
  reason: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadPersonIndex(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(PERSON_INDEX_PATH, "utf-8"));
  } catch { return {}; }
}

function loadProfile(): string {
  try {
    return fs.readFileSync(PROFILE_PATH, "utf-8");
  } catch { return ""; }
}

/** Check if a name appears as a whole word in text (not as a substring of another word) */
function matchesWholeWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/** Look up all people mentioned by name in the task title/notes */
function findMentionedPeople(
  text: string,
  index: Record<string, any>
): { key: string; person: any }[] {
  const found: { key: string; person: any }[] = [];

  for (const [key, person] of Object.entries(index)) {
    const name = (person as any).name as string;
    if (!name) continue;

    // Check full name (word-boundary match)
    if (matchesWholeWord(text, name)) {
      found.push({ key, person });
      continue;
    }

    // Check last name only (must be 4+ chars to avoid false positives)
    const parts = name.split(/\s+/);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      if (last.length >= 4 && matchesWholeWord(text, last)) {
        found.push({ key, person });
      }
    }
  }

  return found;
}

function buildPersonContext(people: { key: string; person: any }[]): string {
  if (people.length === 0) return "";
  let ctx = "\n## People mentioned in this task\n";
  for (const { person } of people) {
    ctx += `\n### ${person.name}\n`;
    if (person.emails?.length) ctx += `Emails: ${person.emails.join(", ")}\n`;
    if (person.webexRoomIds?.length) ctx += `Has Webex DM room\n`;
    const recentMtgs = (person.meetings || [])
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .slice(0, 3);
    if (recentMtgs.length) {
      ctx += `Recent meetings: ${recentMtgs.map((m: any) => `${m.topic} (${m.date.slice(0, 10)})`).join(", ")}\n`;
    }
    const recentMsgs = (person.messageExcerpts || [])
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .slice(0, 3);
    if (recentMsgs.length) {
      ctx += `Recent messages:\n`;
      for (const m of recentMsgs) {
        ctx += `  - [${m.date.slice(0, 10)}] ${m.text.slice(0, 150)}\n`;
      }
    }
    const tasks = (person.notionTasks || []).slice(0, 3);
    if (tasks.length) {
      ctx += `Related tasks: ${tasks.map((t: any) => t.title).join("; ")}\n`;
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// POST /api/task-actions
// Body: { taskId, title, notes?, project?, context?, priority?, source?, delegatedTo? }
//
// Returns: { actions: SuggestedAction[] }
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { title, notes, project, context: taskContext, priority, source, delegatedTo } = body;

    if (!title) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }

    // Gather context
    const personIndex = loadPersonIndex();
    const profile = loadProfile();
    const taskText = `${title} ${notes || ""}`;
    const mentionedPeople = findMentionedPeople(taskText, personIndex);

    // Also look for people referenced in notes metadata (e.g. "webex_room:...", sender names)
    // Notes often contain "From: Person Name" or "Requested by: Person" patterns
    if (notes) {
      const notesPeople = findMentionedPeople(notes, personIndex);
      for (const np of notesPeople) {
        if (!mentionedPeople.some((mp) => mp.key === np.key)) {
          mentionedPeople.push(np);
        }
      }
    }
    const personContext = buildPersonContext(mentionedPeople);

    // Search the vector DB for related conversations using keyword matching
    // (embedding model may not be available, so we use direct SQL keyword search)
    let conversationContext = "";
    try {
      // Extract meaningful keywords from the task title (skip common words)
      const stopWords = new Set(["this","that","with","from","about","follow","confirm","tomorrow","today","friday","monday","tuesday","wednesday","thursday","saturday","sunday","interest","timing","week","next","talk","call","send","email","message","update","need","want","back","into","over","your","they","them","their","have","been","will","would","could","should","just","also","some","more","very","most","like"]);
      const keywords = title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((w: string) => w.length > 3 && !stopWords.has(w));

      if (keywords.length > 0) {
        const projectRoot = process.env.NANOCLAW_ROOT || path.join(process.cwd(), "..");
        const script = `const D=require("better-sqlite3"),db=new D(process.argv[1],{readonly:!0}),kw=JSON.parse(process.argv[2]),c=kw.map(()=>"text LIKE ?").join(" OR "),p=kw.map(k=>"%"+k+"%"),h=db.prepare("SELECT source,text FROM chunks WHERE "+c+" ORDER BY id DESC LIMIT 8").all(...p);db.close();console.log(JSON.stringify(h))`;
        const result = execFileSync("node", ["-e", script, path.join(STORE_DIR, "vectors.db"), JSON.stringify(keywords)],
          { cwd: projectRoot, timeout: 10000, encoding: "utf-8" });
        const hits = JSON.parse(result) as { source: string; text: string }[];

        if (hits.length > 0) {
          conversationContext = "\n## Related conversations found in indexed messages and transcripts\n";
          conversationContext += "These are REAL messages and transcripts from Jason's communication history:\n";
          for (const hit of hits) {
            conversationContext += `- [${hit.source}] ${hit.text.slice(0, 400)}\n`;
          }
          // Discover people mentioned in these conversations
          for (const hit of hits) {
            const hitPeople = findMentionedPeople(hit.text, personIndex);
            for (const hp of hitPeople) {
              if (!mentionedPeople.some((mp) => mp.key === hp.key)) {
                mentionedPeople.push(hp);
              }
            }
          }
        }
      }
    } catch {
      // DB search is optional — continue without it
    }

    // Rebuild person context after conversation search may have added new people
    const enrichedPersonContext = buildPersonContext(mentionedPeople);

    // Determine domain — Cisco tasks are airgapped
    const isCisco = /cisco|webex|splunk|meraki/i.test(`${project || ""} ${taskText}`);

    // Build AI prompt
    const systemPrompt = `You are an action planning assistant for Jason Shearer.

${profile ? `## Jason's Profile\n${profile.slice(0, 2000)}\n` : ""}

## Your Job
Given a task from Jason's action item queue, suggest 1-3 concrete next actions he can take RIGHT NOW to move this forward. Each action should be specific and executable — not vague advice.

## Action Types Available
- **email**: Draft an email. Specify who it goes to and a subject line.
- **webex**: Draft a Webex message. Specify the recipient.
- **meeting**: Schedule a meeting. Specify attendees and purpose.
- **document**: Draft a document (announcement, memo, brief). Specify what kind.
- **subtask**: Create a follow-up task. Specify what needs to happen.

## Critical: Getting the People Right
- The "People mentioned" section below shows people whose names appear in the task text. But names can be wrong — "Kite" is not "Kit", "timing" is not "Tim".
- ALWAYS read the task title and notes carefully to determine who is ACTUALLY involved. Don't assume every matched person is relevant.
- The task's Source field tells you where the task came from (e.g., "Webex Transcript", "Gmail", "Manual"). The notes often contain who originated the request.
- If the notes mention a specific person asking for something, THAT person is the key contact — even if their name wasn't matched in the person index.
- If you identify a person who IS relevant but wasn't in the matched list, still include them in your actions — just note you don't have their email.

## Important Context
- Tasks mentioning Cisco, Webex, Splunk, Meraki, or internal team names are CISCO WORK — these must be marked airgapped (Jason will copy-paste into Outlook/Webex manually).
- Tasks about MomentumEQ, Ordinary Epics, personal items, or coaching are PERSONAL — these can use direct email/calendar APIs.
- When you identify a person, use their full name. If you can identify their email from the person context, include it.
- Each action needs a short "reason" explaining why this is the right next step.
- Draft content should be in Jason's voice — direct, specific, warm but not corporate.

${enrichedPersonContext}
${conversationContext}

## Output Format
Return a JSON array of actions. Each action:
\`\`\`json
{
  "type": "email|webex|meeting|document|subtask",
  "label": "Short action label for the UI button",
  "to": "Person name",
  "toEmail": "their@email.com (if known)",
  "subject": "Email subject or meeting title (if applicable)",
  "body": "The draft content — full email body, message text, or document text",
  "airgapped": true/false,
  "reason": "Why this is the right next step"
}
\`\`\`

Return ONLY the JSON array, no markdown fencing, no explanation.`;

    const userMsg = `Task: "${title}"${notes ? `\nNotes: ${notes}` : ""}${project ? `\nProject: ${project}` : ""}${taskContext ? `\nContext: ${taskContext}` : ""}${priority ? `\nPriority: ${priority}` : ""}${source ? `\nSource: ${source}` : ""}${delegatedTo ? `\nDelegated To: ${delegatedTo}` : ""}

What are the concrete next actions to move this forward?`;

    const resp = await proxiedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    const data = (await resp.json()) as {
      content?: { type: string; text: string }[];
      error?: { message: string };
    };

    if (data.error) {
      return NextResponse.json({ error: data.error.message }, { status: 500 });
    }

    const rawText = data.content?.find((c) => c.type === "text")?.text || "[]";

    // Parse the JSON — strip any markdown fencing if present
    const cleaned = rawText.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "").trim();
    let actions: SuggestedAction[];
    try {
      actions = JSON.parse(cleaned);
    } catch {
      // If JSON parsing fails, return empty actions with the raw text for debugging
      return NextResponse.json({ actions: [], raw: rawText });
    }

    // Enforce airgapped flag for Cisco-related actions
    if (isCisco) {
      actions = actions.map((a) => ({ ...a, airgapped: true }));
    }

    // Enrich with person index data (emails, room IDs)
    for (const action of actions) {
      if (action.to && !action.toEmail) {
        const match = mentionedPeople.find(
          (p) => p.person.name?.toLowerCase().includes(action.to!.toLowerCase().split(" ")[0])
        );
        if (match?.person.emails?.length) {
          action.toEmail = match.person.emails[0];
        }
      }
    }

    return NextResponse.json({ actions, people: mentionedPeople.map((p) => p.person.name) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
