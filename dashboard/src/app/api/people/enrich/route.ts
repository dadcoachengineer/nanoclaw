import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

// Device/bot name patterns to skip
const DEVICE_PATTERN = /\b(desk\s*pro|board\s*\d|room\s*kit|webex\s*bot|meeting\s*room|conf\s*room)\b/i;

/**
 * GET /api/people/enrich — list people missing emails (candidates for enrichment)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const rows = await sql(
      `SELECT p.key, p.name,
              COUNT(DISTINCT mp.meeting_id) + COUNT(DISTINCT me.id) + COUNT(DISTINCT tm.id) as interactions
       FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id
       LEFT JOIN meeting_participants mp ON mp.person_id = p.id
       LEFT JOIN message_excerpts me ON me.person_id = p.id
       LEFT JOIN transcript_mentions tm ON tm.person_id = p.id
       WHERE pe.email IS NULL
         AND array_length(string_to_array(p.name, ' '), 1) >= 2
       GROUP BY p.id
       ORDER BY COUNT(DISTINCT mp.meeting_id) + COUNT(DISTINCT me.id) + COUNT(DISTINCT tm.id) DESC`
    );

    const candidates = rows
      .filter((r: any) => !DEVICE_PATTERN.test(r.name))
      .map((r: any) => ({
        key: r.key,
        name: r.name,
        interactions: parseInt(r.interactions),
      }));

    return NextResponse.json({ candidates, total: candidates.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/people/enrich — batch lookup via Webex People API
 * Body: { names: string[] } — up to 20 names at a time
 *
 * Returns: { results: [{ name, matches: [{ displayName, email, title, company }] }] }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { names } = await req.json();
    if (!names?.length) return NextResponse.json({ error: "names required" }, { status: 400 });

    const batch = (names as string[]).slice(0, 20);
    const results: { name: string; matches: { displayName: string; email: string; title: string; company: string }[] }[] = [];

    for (const name of batch) {
      try {
        const resp = await proxiedFetch(
          `https://webexapis.com/v1/people?displayName=${encodeURIComponent(name)}&max=3`,
          { headers: { "Content-Type": "application/json" } }
        );
        const data = (await resp.json()) as { items?: any[] };
        const matches = (data.items || []).map((p: any) => ({
          displayName: p.displayName || "",
          email: p.emails?.[0] || "",
          title: p.title || "",
          company: p.orgId ? "Cisco" : "",
          avatar: p.avatar || "",
        }));
        results.push({ name, matches });
      } catch {
        results.push({ name, matches: [] });
      }
      // Brief pause to avoid rate limiting
      await new Promise((r) => setTimeout(r, 200));
    }

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * PATCH /api/people/enrich — apply enrichment results to person index
 * Body: { updates: [{ key, email, company?, jobTitle?, avatar? }], deleteKeys?: string[], rename?: { key, newName }, merge?: { sourceKey, targetKey } }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    let applied = 0;

    // Bulk email/company enrichment
    if (body.updates) {
      for (const u of body.updates as { key: string; email: string; company?: string; jobTitle?: string; avatar?: string }[]) {
        const person = await sqlOne<{ id: string }>("SELECT id FROM people WHERE key = $1", [u.key]);
        if (!person) continue;

        const sets: string[] = ["updated_at = now()"];
        const vals: any[] = [];
        let idx = 1;

        if (u.company) { sets.push(`company = $${idx}`); vals.push(u.company); idx++; }
        if (u.jobTitle) { sets.push(`job_title = $${idx}`); vals.push(u.jobTitle); idx++; }
        if (u.avatar) { sets.push(`avatar = $${idx}`); vals.push(u.avatar); idx++; }

        vals.push(person.id);
        await sql(`UPDATE people SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

        if (u.email) {
          await sql(
            "INSERT INTO person_emails (person_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [person.id, u.email.toLowerCase()]
          );
        }
        applied++;
      }
    }

    // Delete people
    if (body.deleteKeys) {
      for (const key of body.deleteKeys as string[]) {
        const result = await sql("DELETE FROM people WHERE key = $1 RETURNING id", [key]);
        if (result.length > 0) applied++;
      }
    }

    // Rename: change the name and re-key
    if (body.rename) {
      const { key, newName } = body.rename as { key: string; newName: string };
      const newKey = newName.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
      const result = await sql(
        "UPDATE people SET name = $1, key = $2, updated_at = now() WHERE key = $3 RETURNING id",
        [newName.trim(), newKey, key]
      );
      if (result.length > 0) applied++;
    }

    // Merge: combine sourceKey into targetKey, then delete sourceKey
    if (body.merge) {
      const { sourceKey, targetKey } = body.merge as { sourceKey: string; targetKey: string };
      const source = await sqlOne<{ id: string }>("SELECT id FROM people WHERE key = $1", [sourceKey]);
      const target = await sqlOne<{ id: string }>("SELECT id FROM people WHERE key = $1", [targetKey]);

      if (source && target) {
        // Move emails (ignore conflicts)
        await sql(
          "UPDATE person_emails SET person_id = $1 WHERE person_id = $2 AND email NOT IN (SELECT email FROM person_emails WHERE person_id = $1)",
          [target.id, source.id]
        );

        // Move meeting participations (ignore conflicts)
        await sql(
          `INSERT INTO meeting_participants (meeting_id, person_id, role)
           SELECT meeting_id, $1, role FROM meeting_participants WHERE person_id = $2
           ON CONFLICT DO NOTHING`,
          [target.id, source.id]
        );

        // Move transcript mentions (ignore conflicts)
        await sql(
          `INSERT INTO transcript_mentions (person_id, meeting_id, snippet_count, snippets)
           SELECT $1, meeting_id, snippet_count, snippets FROM transcript_mentions WHERE person_id = $2
           ON CONFLICT DO NOTHING`,
          [target.id, source.id]
        );

        // Move message excerpts
        await sql("UPDATE message_excerpts SET person_id = $1 WHERE person_id = $2", [target.id, source.id]);

        // Move task associations (ignore conflicts)
        await sql(
          `INSERT INTO task_people (task_id, person_id, relationship)
           SELECT task_id, $1, relationship FROM task_people WHERE person_id = $2
           ON CONFLICT DO NOTHING`,
          [target.id, source.id]
        );

        // Move webex rooms (ignore conflicts)
        await sql(
          `INSERT INTO person_webex_rooms (person_id, room_id, room_type)
           SELECT $1, room_id, room_type FROM person_webex_rooms WHERE person_id = $2
           ON CONFLICT DO NOTHING`,
          [target.id, source.id]
        );

        // Copy profile fields if target is missing them
        await sql(
          `UPDATE people SET
             company = COALESCE(company, (SELECT company FROM people WHERE id = $2)),
             job_title = COALESCE(job_title, (SELECT job_title FROM people WHERE id = $2)),
             profile_notes = COALESCE(profile_notes, (SELECT profile_notes FROM people WHERE id = $2)),
             avatar = COALESCE(avatar, (SELECT avatar FROM people WHERE id = $2)),
             updated_at = now()
           WHERE id = $1`,
          [target.id, source.id]
        );

        // Delete source person (cascades related rows)
        await sql("DELETE FROM people WHERE id = $1", [source.id]);
        applied++;
      }
    }

    return NextResponse.json({ applied });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
