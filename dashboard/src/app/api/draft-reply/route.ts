import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * POST /api/draft-reply
 * Body: { message, personName, personEmail, channel, roomId? }
 *
 * Generates a contextual reply using Claude with full person context from PostgreSQL.
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

    // Find person in PG — try email first, then name
    let person: { id: string; name: string; emails: string[] } | null = null;

    if (personEmail) {
      person = await sqlOne<{ id: string; name: string; emails: string[] }>(
        `SELECT p.id, p.name,
                array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails
         FROM people p
         LEFT JOIN person_emails pe ON pe.person_id = p.id
         WHERE p.id IN (SELECT person_id FROM person_emails WHERE email = $1)
         GROUP BY p.id
         LIMIT 1`,
        [personEmail]
      );
    }

    if (!person && personName) {
      const key = personName.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      person = await sqlOne<{ id: string; name: string; emails: string[] }>(
        `SELECT p.id, p.name,
                array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails
         FROM people p
         LEFT JOIN person_emails pe ON pe.person_id = p.id
         WHERE p.key = $1 OR p.name ILIKE $2
         GROUP BY p.id
         LIMIT 1`,
        [key, `%${personName}%`]
      );
    }

    // Build context block from PG data
    let contextBlock = "";
    if (person) {
      contextBlock += `\n## About ${person.name}\n`;
      if (person.emails?.length) contextBlock += `Email: ${(person.emails).join(", ")}\n`;

      // Recent messages (last 5)
      const recentMsgs = await sql(
        `SELECT text, date::text FROM message_excerpts
         WHERE person_id = $1 ORDER BY date DESC LIMIT 5`,
        [person.id]
      );
      if (recentMsgs.length) {
        contextBlock += `\n### Recent conversation:\n`;
        for (const m of recentMsgs) {
          contextBlock += `- [${m.date.slice(0, 10)}] ${m.text.slice(0, 200)}\n`;
        }
      }

      // Recent meetings (last 5)
      const recentMtgs = await sql(
        `SELECT m.topic, m.date::text
         FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
         WHERE mp.person_id = $1 ORDER BY m.date DESC LIMIT 5`,
        [person.id]
      );
      if (recentMtgs.length) {
        contextBlock += `\n### Recent meetings together:\n`;
        for (const m of recentMtgs) {
          contextBlock += `- [${m.date.slice(0, 10)}] ${m.topic}\n`;
        }
      }

      // Transcript mentions (last 3)
      const recentTrans = await sql(
        `SELECT tm.snippets, m.topic, m.date::text
         FROM transcript_mentions tm JOIN meetings m ON m.id = tm.meeting_id
         WHERE tm.person_id = $1 ORDER BY m.date DESC LIMIT 3`,
        [person.id]
      );
      if (recentTrans.length) {
        contextBlock += `\n### What they've said recently:\n`;
        for (const t of recentTrans) {
          contextBlock += `In "${t.topic}" (${t.date.slice(0, 10)}):\n`;
          for (const s of (t.snippets || []).slice(0, 2)) {
            contextBlock += `  "${s.slice(0, 150)}"\n`;
          }
        }
      }

      // Related tasks (last 5)
      const tasks = await sql(
        `SELECT t.title, t.status
         FROM tasks t JOIN task_people tp ON tp.task_id = t.id
         WHERE tp.person_id = $1 ORDER BY t.created_at DESC LIMIT 5`,
        [person.id]
      );
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
