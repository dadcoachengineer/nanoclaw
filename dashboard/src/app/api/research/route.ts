import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const PERSON_INDEX_PATH = path.join(STORE_DIR, "person-index.json");
const PROFILE_PATH = path.join(STORE_DIR, "profile.md");

function loadJSON(filePath: string): any {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

/**
 * POST /api/research
 * Body: {
 *   topic: string,           — What to research (task title or custom)
 *   taskNotes?: string,      — Existing task notes
 *   project?: string,        — Project/initiative context
 *   documents?: string[],    — User-pasted document content
 *   urls?: string[],         — URLs to reference (content fetched by caller if needed)
 *   focusAreas?: string[],   — Specific research angles ("company background", "stakeholders", etc.)
 * }
 *
 * Returns: { brief: string, sources: string[] }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { topic, taskNotes, project, documents, urls, focusAreas, guidance, intent } = body;

    if (!topic) {
      return NextResponse.json({ error: "topic required" }, { status: 400 });
    }

    // --- Gather all available context ---

    // 1. Person index — find relevant people
    const personIndex = loadJSON(PERSON_INDEX_PATH) || {};
    const topicLower = `${topic} ${taskNotes || ""}`.toLowerCase();
    const relevantPeople: { name: string; context: string }[] = [];

    for (const [, person] of Object.entries(personIndex)) {
      const p = person as any;
      if (!p.name) continue;
      // Check if person's messages/transcripts mention the topic
      const msgs = (p.messageExcerpts || []) as { text: string; date: string }[];
      const relevantMsgs = msgs.filter((m) =>
        topic.split(/\s+/).some((w: string) => w.length > 3 && m.text.toLowerCase().includes(w.toLowerCase()))
      );
      const transcripts = (p.transcriptMentions || []) as { topic: string; snippets?: string[] }[];
      const relevantTranscripts = transcripts.filter((t) =>
        topic.split(/\s+/).some((w: string) => w.length > 3 && (t.topic?.toLowerCase().includes(w.toLowerCase()) ||
          t.snippets?.some((s) => s.toLowerCase().includes(w.toLowerCase()))))
      );

      if (relevantMsgs.length > 0 || relevantTranscripts.length > 0) {
        let ctx = `${p.name}`;
        if (p.emails?.length) ctx += ` (${p.emails[0]})`;
        ctx += ":\n";
        for (const m of relevantMsgs.slice(0, 3)) {
          ctx += `  - [${m.date.slice(0, 10)}] ${m.text.slice(0, 250)}\n`;
        }
        for (const t of relevantTranscripts.slice(0, 2)) {
          ctx += `  - Transcript "${t.topic}": ${(t.snippets || []).slice(0, 2).map((s) => s.slice(0, 150)).join(" | ")}\n`;
        }
        relevantPeople.push({ name: p.name, context: ctx });
      }
    }

    // 2. Vector DB — keyword search for related content
    let vectorHits: string[] = [];
    try {
      const stopWords = new Set(["this","that","with","from","about","follow","confirm","tomorrow","today","interest","timing","week","next","talk","call","send","email","message","update","need","want","back","into","their","have","been","will","would","just","also","some","more","like","research","background","draft","prepare"]);
      const keywords = topic.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/)
        .filter((w: string) => w.length > 3 && !stopWords.has(w));
      if (keywords.length > 0) {
        const projectRoot = process.env.NANOCLAW_ROOT || path.join(process.cwd(), "..");
        const script = `const D=require("better-sqlite3"),db=new D(process.argv[1],{readonly:!0}),kw=JSON.parse(process.argv[2]),c=kw.map(()=>"text LIKE ?").join(" OR "),p=kw.map(k=>"%"+k+"%"),h=db.prepare("SELECT source,text FROM chunks WHERE "+c+" ORDER BY id DESC LIMIT 12").all(...p);db.close();console.log(JSON.stringify(h))`;
        const result = execFileSync("node", ["-e", script, path.join(STORE_DIR, "vectors.db"), JSON.stringify(keywords)],
          { cwd: projectRoot, timeout: 10000, encoding: "utf-8" });
        const hits = JSON.parse(result) as { source: string; text: string }[];
        vectorHits = hits.map((h) => `[${h.source}] ${h.text.slice(0, 400)}`);
      }
    } catch { /* continue without */ }

    // 3. Profile for writing style
    const profile = loadJSON(PROFILE_PATH) ? "" : ""; // It's markdown, not JSON
    let profileText = "";
    try { profileText = fs.readFileSync(PROFILE_PATH, "utf-8").slice(0, 1500); } catch { /* skip */ }

    // 4. Topic index — related themes
    const topicIndex = loadJSON(path.join(STORE_DIR, "topic-index.json"));
    let topicContext = "";
    if (topicIndex) {
      const keywords = topic.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      for (const [topicKey, data] of Object.entries(topicIndex as Record<string, any>)) {
        if (keywords.some((k: string) => topicKey.toLowerCase().includes(k))) {
          topicContext += `Topic "${topicKey}": ${data.meetings?.length || 0} meetings, ${data.tasks?.length || 0} tasks, people: ${(data.people || []).slice(0, 5).join(", ")}\n`;
        }
      }
    }

    // --- Build the research prompt ---

    // Detect if the intent is to PRODUCE a deliverable (draft, announcement, email)
    // vs. RESEARCH a topic (background, prep, discovery)
    const isDraft = intent && /draft|write|compose|announce|announcement|email|message|memo|brief to team/i.test(intent);

    const structureBlock = isDraft
      ? `## Your Job
The intent is: "${intent}"
You are producing a DELIVERABLE — not a research brief. Jason needs a polished, ready-to-send draft that he can review, edit, and distribute.

## How to structure the output:

### The Draft
Write the full deliverable (announcement, email, memo, message — whatever the intent calls for). Write it as the FINAL version, ready to send. Use Jason's voice. Pull specific facts, accomplishments, and context from the provided documents and conversation history. Do NOT use placeholder brackets like [specific area] — either use real information from the context or omit the detail.

### Context & Sources
After the draft, include a short section noting what sources informed the draft (which documents, conversations, dates) so Jason knows what was synthesized.

### Suggested Distribution
Who should receive this, via what channel (email, Webex, Slack), and any timing considerations.`
      : `## Your Job
Produce a comprehensive, actionable research brief on the topic below. This will be used to prepare Jason for a conversation, meeting, or decision.

## Structure your brief as:

### Executive Summary
2-3 sentences on what Jason needs to know right now.

### Key People & Relationships
Who is involved, their role, and Jason's history with them (use the provided conversation data).

### Background & Context
What do we know from existing conversations, transcripts, and messages? Cite specific dates and quotes where available.

### Company/Organization Intel
If this involves an external company, what do we know? Pull from any provided documents or context.

### Open Questions & Discovery Topics
What does Jason still need to find out? Frame as specific questions he can ask in a conversation.

### Recommended Next Steps
Concrete actions with specific people, in priority order.

### Talking Points
3-5 key points Jason should make or address, written in his voice (direct, specific, confident — not corporate).`;

    const systemPrompt = `You are a research analyst and executive communications assistant for Jason Shearer.

${profileText ? `## Jason's Background (for context)\n${profileText}\n` : ""}

${structureBlock}

## Important Rules
- Only state facts that are supported by the provided context. If you don't have information, say so explicitly rather than making assumptions.
- Reference specific dates, quotes, and people from the conversation history.
- ALWAYS write in Jason's voice — direct, specific, no corporate speak. No "I'm pleased to announce" or "we're excited" — Jason doesn't talk like that.
- If documents were provided, extract and synthesize key information from them. Use specific accomplishments, numbers, and details — not vague summaries.
- Never use placeholder brackets like [specific area] or [TBD]. Use real data from the context or leave the detail out.`;

    let userContent = `## Research Topic\n${topic}\n`;
    if (taskNotes) userContent += `\n## Task Notes\n${taskNotes}\n`;
    if (project) userContent += `\n## Project: ${project}\n`;

    if (relevantPeople.length > 0) {
      userContent += `\n## People with relevant conversation history\n`;
      for (const p of relevantPeople) {
        userContent += `\n${p.context}\n`;
      }
    }

    if (vectorHits.length > 0) {
      userContent += `\n## Related messages and transcripts from history\n`;
      for (const hit of vectorHits) {
        userContent += `- ${hit}\n`;
      }
    }

    if (topicContext) {
      userContent += `\n## Related topics from index\n${topicContext}\n`;
    }

    if (documents && documents.length > 0) {
      userContent += `\n## User-Provided Documents\n`;
      for (let i = 0; i < documents.length; i++) {
        userContent += `\n### Document ${i + 1}\n${documents[i].slice(0, 5000)}\n`;
      }
    }

    if (urls && urls.length > 0) {
      userContent += `\n## Referenced URLs\n${urls.join("\n")}\n`;
    }

    if (focusAreas && focusAreas.length > 0) {
      userContent += `\n## Specific focus areas requested\n${focusAreas.join(", ")}\n`;
    }

    if (guidance) {
      userContent += `\n## Additional guidance from Jason\nIMPORTANT — Jason provided this specific direction for the research. Follow it closely:\n${guidance}\n`;
    }

    userContent += `\nProduce the research brief now.`;

    // --- Call Claude ---

    const resp = await proxiedFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const data = (await resp.json()) as {
      content?: { type: string; text: string }[];
      error?: { message: string };
    };

    if (data.error) {
      return NextResponse.json({ error: data.error.message }, { status: 500 });
    }

    const brief = data.content?.find((c) => c.type === "text")?.text || "";
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
