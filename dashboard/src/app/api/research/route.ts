import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { sql } from "@/lib/pg";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const PROFILE_PATH = path.join(STORE_DIR, "profile.md");

/**
 * POST /api/research — generate a research brief using PG for all context
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { topic, taskNotes, project, documents, urls, focusAreas, guidance, intent } = body;
    if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });

    // 1. Find relevant people via PG — search messages/transcripts for topic keywords
    const keywords = topic.split(/\s+/).filter((w: string) => w.length > 3);
    const relevantPeople: { name: string; context: string }[] = [];

    if (keywords.length > 0) {
      const kwConditions = keywords.map((_: string, i: number) => `me.text ILIKE $${i + 1}`).join(" OR ");
      const kwParams = keywords.map((k: string) => `%${k}%`);

      const peopleWithMsgs = await sql(
        `SELECT DISTINCT p.name, pe.email,
                string_agg(DISTINCT '[' || me.date::date || '] ' || LEFT(me.text, 200), E'\n') as msgs
         FROM people p
         JOIN message_excerpts me ON me.person_id = p.id
         LEFT JOIN person_emails pe ON pe.person_id = p.id
         WHERE ${kwConditions}
         GROUP BY p.id, p.name, pe.email LIMIT 10`,
        kwParams
      );

      for (const p of peopleWithMsgs) {
        let ctx = `${p.name}${p.email ? ` (${p.email})` : ""}:\n`;
        if (p.msgs) ctx += `  Messages:\n  ${p.msgs.split("\n").join("\n  ")}\n`;
        relevantPeople.push({ name: p.name, context: ctx });
      }
    }

    // 2. Vector search — keyword match from PG
    let vectorHits: string[] = [];
    const stopWords = new Set(["this","that","with","from","about","follow","confirm","tomorrow","today","interest","timing","week","next","talk","call","send","email","message","update","need","want","back","into","their","have","been","will","would","just","also","some","more","like","research","background","draft","prepare"]);
    const searchKw = topic.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/)
      .filter((w: string) => w.length > 3 && !stopWords.has(w));

    if (searchKw.length > 0) {
      const conditions = searchKw.map((_: string, i: number) => `text ILIKE $${i + 1}`).join(" OR ");
      const params = searchKw.map((k: string) => `%${k}%`);
      const hits = await sql(
        `SELECT source, text FROM vector_chunks WHERE ${conditions} ORDER BY id DESC LIMIT 12`,
        params
      );
      vectorHits = hits.map((h: any) => `[${h.source}] ${h.text.slice(0, 400)}`);
    }

    // 3. Profile
    let profileText = "";
    try { profileText = fs.readFileSync(PROFILE_PATH, "utf-8").slice(0, 1500); } catch {}

    // 4. Topic context from PG
    let topicContext = "";
    if (searchKw.length > 0) {
      const topicHits = await sql(
        `SELECT t.name, COUNT(DISTINCT tm.meeting_id) as meetings, COUNT(DISTINCT tt.task_id) as tasks
         FROM topics t
         LEFT JOIN topic_meetings tm ON tm.topic_id = t.id
         LEFT JOIN topic_tasks tt ON tt.topic_id = t.id
         WHERE t.key ILIKE $1
         GROUP BY t.id LIMIT 3`,
        [`%${searchKw[0]}%`]
      );
      for (const t of topicHits) {
        topicContext += `Topic "${t.name}": ${t.meetings} meetings, ${t.tasks} tasks\n`;
      }
    }

    // Build the research prompt
    const isDraft = intent && /draft|write|compose|announce|announcement|email|message|memo/i.test(intent);

    const structureBlock = isDraft
      ? `## Your Job\nThe intent is: "${intent}"\nProduce a DELIVERABLE — not a research brief. Write the full draft ready to send. Use Jason's voice. Pull specific facts from provided context. Do NOT use placeholder brackets.\n\n### The Draft\nFull deliverable in Jason's voice.\n\n### Context & Sources\nWhat sources informed the draft.\n\n### Suggested Distribution\nWho should receive this, via what channel.`
      : `## Your Job\nProduce a comprehensive, actionable research brief.\n\n### Executive Summary\n2-3 sentences.\n\n### Key People & Relationships\n### Background & Context\n### Company/Organization Intel\n### Open Questions & Discovery Topics\n### Recommended Next Steps\n### Talking Points\n3-5 key points in Jason's voice.`;

    const systemPrompt = `You are a research analyst and executive communications assistant for Jason Shearer.\n\n${profileText ? `## Jason's Background\n${profileText}\n` : ""}\n\n${structureBlock}\n\n## Important Rules\n- Only state facts supported by context. If missing info, say so.\n- Reference specific dates, quotes, people.\n- Write in Jason's voice — direct, specific, no corporate speak.\n- Never use placeholder brackets.`;

    let userContent = `## Research Topic\n${topic}\n`;
    if (taskNotes) userContent += `\n## Task Notes\n${taskNotes}\n`;
    if (project) userContent += `\n## Project: ${project}\n`;
    if (relevantPeople.length > 0) {
      userContent += `\n## People with relevant conversation history\n`;
      for (const p of relevantPeople) userContent += `\n${p.context}\n`;
    }
    if (vectorHits.length > 0) {
      userContent += `\n## Related messages and transcripts\n`;
      for (const hit of vectorHits) userContent += `- ${hit}\n`;
    }
    if (topicContext) userContent += `\n## Related topics\n${topicContext}\n`;
    if (documents?.length) {
      userContent += `\n## User-Provided Documents\n`;
      for (let i = 0; i < documents.length; i++) userContent += `\n### Document ${i + 1}\n${documents[i].slice(0, 5000)}\n`;
    }
    if (urls?.length) userContent += `\n## Referenced URLs\n${urls.join("\n")}\n`;
    if (focusAreas?.length) userContent += `\n## Focus areas\n${focusAreas.join(", ")}\n`;
    if (guidance) userContent += `\n## Additional guidance from Jason\nIMPORTANT — follow this closely:\n${guidance}\n`;
    userContent += `\nProduce the research brief now.`;

    const resp = await proxiedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const data = (await resp.json()) as any;
    if (data.error) return NextResponse.json({ error: data.error.message }, { status: 500 });

    const brief = data.content?.find((c: any) => c.type === "text")?.text || "";
    const sources = [
      ...relevantPeople.map((p) => p.name),
      vectorHits.length > 0 ? `${vectorHits.length} indexed conversations` : null,
      documents?.length ? `${documents.length} user-provided document(s)` : null,
      topicContext ? "Topic index" : null,
    ].filter(Boolean) as string[];

    return NextResponse.json({ brief, sources });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
