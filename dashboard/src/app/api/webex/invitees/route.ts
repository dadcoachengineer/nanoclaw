import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");

/**
 * GET /api/webex/invitees?meetingId=xxx
 * Returns invitees with person index context (interaction counts).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const meetingId = req.nextUrl.searchParams.get("meetingId");
  if (!meetingId) return NextResponse.json({ error: "meetingId required" }, { status: 400 });

  try {
    const resp = await proxiedFetch(
      `https://webexapis.com/v1/meetingInvitees?meetingId=${encodeURIComponent(meetingId)}&max=50`,
      { headers: { "Content-Type": "application/json" } }
    );
    const data = (await resp.json()) as { items?: any[] };
    const invitees = data.items || [];

    // Enrich with person index stats
    let index: Record<string, any> = {};
    try { index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); } catch {}

    const enriched = invitees
      .filter((inv: any) => inv.email !== "jasheare@cisco.com") // exclude self
      .map((inv: any) => {
        const email = inv.email?.toLowerCase();
        const name = inv.displayName || "";
        // Find in person index by email or name
        let person = null;
        for (const [, p] of Object.entries(index)) {
          const pe = p as any;
          if (pe.emails?.includes(email)) { person = pe; break; }
        }
        if (!person) {
          const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
          if (index[key]) person = index[key];
        }

        return {
          name,
          email,
          avatar: person?.avatar || null,
          meetings: (person?.meetings || []).length,
          messages: (person?.messageExcerpts || []).length,
          transcripts: (person?.transcriptMentions || []).length,
          tasks: (person?.notionTasks || []).length,
          company: person?.company || null,
          jobTitle: person?.jobTitle || null,
        };
      });

    return NextResponse.json({ invitees: enriched });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
