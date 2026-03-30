import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

/**
 * GET /api/people/lookup?name=Michael+Parker
 * GET /api/people/lookup?email=mparker@dbs-poe.com
 *
 * Tries multiple strategies to find profile data:
 * 1. Webex People API (by email or displayName)
 * 2. Webex room membership scan (if person has a known room ID in PG)
 * 3. Person index enrichment from PG (existing messages/meetings context)
 *
 * Returns: { results: [{ displayName, email, title, company, avatar, source }] }
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const name = searchParams.get("name");
  const email = searchParams.get("email");

  if (!name && !email) {
    return NextResponse.json({ error: "name or email required" }, { status: 400 });
  }

  const results: {
    displayName: string;
    email?: string;
    title?: string;
    company?: string;
    avatar?: string;
    source: string;
  }[] = [];

  // Strategy 1: Webex People API
  try {
    const query = email
      ? `email=${encodeURIComponent(email)}`
      : `displayName=${encodeURIComponent(name!)}&max=5`;

    const resp = await proxiedFetch(
      `https://webexapis.com/v1/people?${query}`,
      { headers: { "Content-Type": "application/json" } }
    );
    const data = (await resp.json()) as { items?: any[] };

    for (const p of data.items || []) {
      results.push({
        displayName: p.displayName || "",
        email: p.emails?.[0] || "",
        title: p.title || "",
        company: p.orgId ? "Cisco" : "",
        avatar: p.avatar || "",
        source: "webex",
      });
    }
  } catch { /* continue */ }

  // Strategy 2: Check PG for room IDs, then look up room membership
  if (results.length === 0 && name) {
    try {
      const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      const room = await sqlOne<{ room_id: string }>(
        `SELECT pwr.room_id FROM person_webex_rooms pwr
         JOIN people p ON p.id = pwr.person_id
         WHERE p.key = $1 OR p.name ILIKE $2
         LIMIT 1`,
        [key, `%${name}%`]
      );

      if (room) {
        const resp = await proxiedFetch(
          `https://webexapis.com/v1/memberships?roomId=${encodeURIComponent(room.room_id)}&max=10`,
          { headers: { "Content-Type": "application/json" } }
        );
        const data = (await resp.json()) as { items?: any[] };

        for (const m of data.items || []) {
          // Match by name (the person's display name in the room)
          if (m.personDisplayName?.toLowerCase().includes(name.toLowerCase().split(" ")[0])) {
            // Now get their full profile
            try {
              const profileResp = await proxiedFetch(
                `https://webexapis.com/v1/people/${m.personId}`,
                { headers: { "Content-Type": "application/json" } }
              );
              const profile = await profileResp.json() as any;
              if (profile.displayName) {
                results.push({
                  displayName: profile.displayName,
                  email: profile.emails?.[0] || m.personEmail || "",
                  title: profile.title || "",
                  company: profile.orgId ? "Cisco" : "",
                  avatar: profile.avatar || "",
                  source: "webex-room",
                });
              }
            } catch { /* continue */ }
          }
        }
      }
    } catch { /* continue */ }
  }

  // Strategy 3: Enrich from PG person data (email, company, job title)
  if (name) {
    try {
      const key = name.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      const person = await sqlOne<{ name: string; email: string | null; job_title: string | null; company: string | null }>(
        `SELECT p.name, pe.email, p.job_title, p.company
         FROM people p
         LEFT JOIN person_emails pe ON pe.person_id = p.id AND pe.is_primary = true
         WHERE p.key = $1 OR p.name ILIKE $2
         LIMIT 1`,
        [key, `%${name}%`]
      );

      if (person && (person.email || person.company)) {
        results.push({
          displayName: person.name,
          email: person.email || "",
          title: person.job_title || "",
          company: person.company || "",
          avatar: "",
          source: "index",
        });
      }
    } catch { /* continue */ }
  }

  return NextResponse.json({ results });
}
