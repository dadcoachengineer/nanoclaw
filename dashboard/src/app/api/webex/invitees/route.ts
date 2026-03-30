import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * GET /api/webex/invitees?meetingId=xxx
 * Returns invitees with person context (interaction counts) from PostgreSQL.
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

    const enriched = await Promise.all(
      invitees
        .filter((inv: any) => inv.email !== "jasheare@cisco.com") // exclude self
        .map(async (inv: any) => {
          const email = inv.email?.toLowerCase();
          const name = inv.displayName || "";

          // Look up person by email first, then by name
          let person: any = null;
          if (email) {
            person = await sqlOne(
              `SELECT p.id, p.name, p.avatar, p.company, p.job_title,
                      COUNT(DISTINCT mp.meeting_id) as meetings,
                      COUNT(DISTINCT me.id) as messages,
                      COUNT(DISTINCT tm.id) as transcripts,
                      COUNT(DISTINCT tp.task_id) as tasks
               FROM people p
               JOIN person_emails pe ON pe.person_id = p.id
               LEFT JOIN meeting_participants mp ON mp.person_id = p.id
               LEFT JOIN message_excerpts me ON me.person_id = p.id
               LEFT JOIN transcript_mentions tm ON tm.person_id = p.id
               LEFT JOIN task_people tp ON tp.person_id = p.id
               WHERE pe.email = $1
               GROUP BY p.id`,
              [email]
            );
          }
          if (!person && name) {
            const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
            person = await sqlOne(
              `SELECT p.id, p.name, p.avatar, p.company, p.job_title,
                      COUNT(DISTINCT mp.meeting_id) as meetings,
                      COUNT(DISTINCT me.id) as messages,
                      COUNT(DISTINCT tm.id) as transcripts,
                      COUNT(DISTINCT tp.task_id) as tasks
               FROM people p
               LEFT JOIN meeting_participants mp ON mp.person_id = p.id
               LEFT JOIN message_excerpts me ON me.person_id = p.id
               LEFT JOIN transcript_mentions tm ON tm.person_id = p.id
               LEFT JOIN task_people tp ON tp.person_id = p.id
               WHERE p.key = $1
               GROUP BY p.id`,
              [key]
            );
          }

          return {
            name,
            email,
            avatar: person?.avatar || null,
            meetings: parseInt(person?.meetings || "0"),
            messages: parseInt(person?.messages || "0"),
            transcripts: parseInt(person?.transcripts || "0"),
            tasks: parseInt(person?.tasks || "0"),
            company: person?.company || null,
            jobTitle: person?.job_title || null,
          };
        })
    );

    return NextResponse.json({ invitees: enriched });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
