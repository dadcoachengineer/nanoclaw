import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { sql } from "@/lib/pg";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const PROFILE_PATH = path.join(STORE_DIR, "profile.md");

export interface SuggestedAction {
  type: "email" | "webex" | "meeting" | "document" | "subtask";
  label: string;
  to?: string;
  toEmail?: string;
  toRoomId?: string;
  subject?: string;
  body?: string;
  airgapped: boolean;
  reason: string;
}

function loadProfile(): string {
  try { return fs.readFileSync(PROFILE_PATH, "utf-8"); } catch { return ""; }
}

/** Find people mentioned in text using PG */
async function findMentionedPeople(text: string): Promise<{ name: string; email?: string; context: string }[]> {
  const people = await sql(
    "SELECT key, name FROM people WHERE length(name) >= 4"
  );
  const found: string[] = [];
  for (const p of people) {
    const escaped = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) found.push(p.key);
    else {
      const parts = p.name.split(/\s+/);
      if (parts.length >= 2 && parts[parts.length - 1].length >= 4) {
        const last = parts[parts.length - 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${last}\\b`, "i").test(text)) found.push(p.key);
      }
    }
  }
  if (found.length === 0) return [];

  // Get full context for found people
  const placeholders = found.map((_, i) => `$${i + 1}`).join(",");
  const rows = await sql(
    `SELECT p.name, pe.email,
            (SELECT string_agg(
               '[' || me.date::date || '] ' || LEFT(me.text, 200), E'\n'
             ) FROM (SELECT * FROM message_excerpts WHERE person_id = p.id ORDER BY date DESC LIMIT 3) me
            ) as recent_messages,
            (SELECT string_agg(m.topic || ' (' || m.date::date || ')', ', ')
             FROM meeting_participants mp JOIN meetings m ON m.id = mp.meeting_id
             WHERE mp.person_id = p.id ORDER BY m.date DESC LIMIT 3
            ) as recent_meetings
     FROM people p
     LEFT JOIN person_emails pe ON pe.person_id = p.id AND pe.is_primary = true
     WHERE p.key IN (${placeholders})`,
    found
  );

  return rows.map((r: any) => {
    let ctx = `${r.name}`;
    if (r.email) ctx += ` (${r.email})`;
    ctx += ":\n";
    if (r.recent_messages) ctx += `  Messages:\n  ${r.recent_messages.split("\n").join("\n  ")}\n`;
    if (r.recent_meetings) ctx += `  Meetings: ${r.recent_meetings}\n`;
    return { name: r.name, email: r.email, context: ctx };
  });
}

/** Search vector DB (PG) for related conversations */
async function searchRelated(title: string): Promise<string> {
  const stopWords = new Set(["this","that","with","from","about","follow","confirm","tomorrow","today","friday","interest","timing","week","next","talk","call","send","email","update","need","want","back","into","over","your","they","have","been","will","would","could","should","just","also","some","more","very","most","like"]);
  const keywords = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  if (keywords.length === 0) return "";

  const conditions = keywords.map((_, i) => `text ILIKE $${i + 1}`).join(" OR ");
  const params = keywords.map((k) => `%${k}%`);

  const hits = await sql(
    `SELECT source, text FROM vector_chunks WHERE ${conditions} ORDER BY id DESC LIMIT 8`,
    params
  );

  if (hits.length === 0) return "";
  let ctx = "\n## Related conversations found in indexed messages and transcripts\n";
  ctx += "These are REAL messages and transcripts from Jason's communication history:\n";
  for (const h of hits) ctx += `- [${h.source}] ${h.text.slice(0, 400)}\n`;
  return ctx;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { title, notes, project, context: taskContext, priority, source, delegatedTo } = body;
    if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

    const profile = loadProfile();
    const taskText = `${title} ${notes || ""}`;

    // Find people mentioned (from PG, not JSON)
    const mentionedPeople = await findMentionedPeople(taskText);
    const personContext = mentionedPeople.length > 0
      ? "\n## People mentioned in this task\n" + mentionedPeople.map((p) => p.context).join("\n")
      : "";

    // Search vector DB for related conversations (from PG, not subprocess)
    const conversationContext = await searchRelated(title);

    // Also search notes for additional people
    if (notes) {
      const notesPeople = await findMentionedPeople(notes);
      for (const np of notesPeople) {
        if (!mentionedPeople.some((mp) => mp.name === np.name)) {
          mentionedPeople.push(np);
        }
      }
    }

    const enrichedPersonContext = mentionedPeople.length > 0
      ? "\n## People mentioned in this task\n" + mentionedPeople.map((p) => p.context).join("\n")
      : "";

    const isCisco = /cisco|webex|splunk|meraki/i.test(`${project || ""} ${taskText}`);

    const systemPrompt = `You are an action planning assistant for Jason Shearer.

${profile ? `## Jason's Profile\n${profile.slice(0, 2000)}\n` : ""}

## Your Job
Given a task from Jason's action item queue, suggest 1-3 concrete next actions he can take RIGHT NOW to move this forward.

## Action Types Available
- **email**: Draft an email. Specify who it goes to and a subject line.
- **webex**: Draft a Webex message. Specify the recipient.
- **meeting**: Schedule a meeting. Specify attendees and purpose.
- **document**: Draft a document (announcement, memo, brief). Specify what kind.
- **subtask**: Create a follow-up task. Specify what needs to happen.

## Critical: Getting the People Right
- The "People mentioned" section shows people whose names appear in the task. Read carefully — not every match is relevant.
- The task's Source field tells you where it came from. Notes often contain who originated the request.
- If you identify someone relevant not in the matched list, still include them.

## Important Context
- Tasks mentioning Cisco, Webex, Splunk, Meraki are CISCO WORK — mark airgapped.
- Personal tasks can use direct email/calendar APIs.
- Draft content should be in Jason's voice — direct, specific, warm but not corporate.

${enrichedPersonContext}
${conversationContext}

## Output Format
Return a JSON array of actions. Each:
\`\`\`json
{"type":"email|webex|meeting|document|subtask","label":"Short label","to":"Person","toEmail":"email","subject":"Subject","body":"Draft content","airgapped":true/false,"reason":"Why this step"}
\`\`\`
Return ONLY the JSON array, no markdown fencing.`;

    const userMsg = `Task: "${title}"${notes ? `\nNotes: ${notes}` : ""}${project ? `\nProject: ${project}` : ""}${taskContext ? `\nContext: ${taskContext}` : ""}${priority ? `\nPriority: ${priority}` : ""}${source ? `\nSource: ${source}` : ""}${delegatedTo ? `\nDelegated To: ${delegatedTo}` : ""}

What are the concrete next actions?`;

    const resp = await proxiedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    const data = (await resp.json()) as any;
    if (data.error) return NextResponse.json({ error: data.error.message }, { status: 500 });

    const rawText = data.content?.find((c: any) => c.type === "text")?.text || "[]";
    const cleaned = rawText.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "").trim();

    let actions: SuggestedAction[];
    try { actions = JSON.parse(cleaned); } catch { return NextResponse.json({ actions: [], raw: rawText }); }

    if (isCisco) actions = actions.map((a) => ({ ...a, airgapped: true }));

    // Enrich with emails from PG
    for (const action of actions) {
      if (action.to && !action.toEmail) {
        const match = mentionedPeople.find((p) => p.name.toLowerCase().includes(action.to!.toLowerCase().split(" ")[0]));
        if (match?.email) action.toEmail = match.email;
      }
    }

    return NextResponse.json({ actions, people: mentionedPeople.map((p) => p.name) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
