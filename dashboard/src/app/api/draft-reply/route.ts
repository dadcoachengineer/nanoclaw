import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import fs from "fs";
import path from "path";
import { requireAuth } from "@/lib/require-auth";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");

function loadPersonIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function findPerson(index: Record<string, any>, name?: string, email?: string) {
  if (email) {
    for (const entry of Object.values(index)) {
      if ((entry as any).emails?.includes(email)) return entry;
    }
  }
  if (name) {
    const lower = name.toLowerCase().replace(/[^a-z\s]/g, "").trim();
    if (index[lower]) return index[lower];
    for (const entry of Object.values(index)) {
      if ((entry as any).name?.toLowerCase().includes(lower)) return entry;
    }
  }
  return null;
}

/**
 * POST /api/draft-reply
 * Body: { message, personName, personEmail, channel, roomId? }
 *
 * Generates a contextual reply using Claude with full person context.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { message, personName, personEmail, channel } = body;

    if (!message) {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    // Gather person context
    const index = loadPersonIndex();
    const person = findPerson(index, personName, personEmail);

    let contextBlock = "";
    if (person) {
      contextBlock += `\n## About ${person.name}\n`;
      if (person.emails?.length) contextBlock += `Email: ${person.emails.join(", ")}\n`;

      // Recent messages (last 5)
      const recentMsgs = (person.messageExcerpts || [])
        .sort((a: any, b: any) => b.date.localeCompare(a.date))
        .slice(0, 5);
      if (recentMsgs.length) {
        contextBlock += `\n### Recent conversation:\n`;
        for (const m of recentMsgs) {
          contextBlock += `- [${m.date.slice(0, 10)}] ${m.text.slice(0, 200)}\n`;
        }
      }

      // Recent meetings
      const recentMtgs = (person.meetings || [])
        .sort((a: any, b: any) => b.date.localeCompare(a.date))
        .slice(0, 5);
      if (recentMtgs.length) {
        contextBlock += `\n### Recent meetings together:\n`;
        for (const m of recentMtgs) {
          contextBlock += `- [${m.date.slice(0, 10)}] ${m.topic}\n`;
        }
      }

      // What they said in transcripts (last 3)
      const recentTrans = (person.transcriptMentions || [])
        .sort((a: any, b: any) => b.date.localeCompare(a.date))
        .slice(0, 3);
      if (recentTrans.length) {
        contextBlock += `\n### What they've said recently:\n`;
        for (const t of recentTrans) {
          contextBlock += `In "${t.topic}" (${t.date.slice(0, 10)}):\n`;
          for (const s of (t.snippets || []).slice(0, 2)) {
            contextBlock += `  "${s.slice(0, 150)}"\n`;
          }
        }
      }

      // Related tasks
      const tasks = (person.notionTasks || []).slice(0, 5);
      if (tasks.length) {
        contextBlock += `\n### Related action items:\n`;
        for (const t of tasks) {
          contextBlock += `- [${t.status}] ${t.title}\n`;
        }
      }
    }

    // Build the prompt
    const systemPrompt = `You are drafting a reply as Jason Shearer, CTO at Cisco's Spatial Intelligence group.

Jason's communication style:
- Direct and action-oriented
- Enthusiastic about technology and innovation
- Professional but warm — not stiff or corporate
- Uses short, clear sentences
- Often references shared context from meetings or previous discussions
- Signs off casually when appropriate

Channel: ${channel || "Webex"}
${contextBlock}

Draft a reply to the message below. Keep it concise and natural. If there are relevant action items or shared context, reference them naturally. Do not be overly formal. Match the tone and length to what the message warrants — a quick acknowledgment for a quick message, a substantive reply for a substantive question.

Output ONLY the reply text, nothing else.`;

    const resp = await proxiedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Reply to this message from ${personName || "someone"}:\n\n"${message}"`,
          },
        ],
      }),
    });

    const data = (await resp.json()) as {
      content?: { type: string; text: string }[];
      error?: { message: string };
    };

    if (data.error) {
      return NextResponse.json({ error: data.error.message }, { status: 500 });
    }

    const reply = data.content?.find((c) => c.type === "text")?.text || "";

    return NextResponse.json({ reply, personContext: !!person });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
