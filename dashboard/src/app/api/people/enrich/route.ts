import { NextRequest, NextResponse } from "next/server";
import { proxiedFetch } from "@/lib/onecli";
import { requireAuth } from "@/lib/require-auth";
import fs from "fs";
import path from "path";

const STORE_DIR = process.env.NANOCLAW_STORE || path.join(process.cwd(), "..", "store");
const INDEX_PATH = path.join(STORE_DIR, "person-index.json");

// Device/bot name patterns to skip
const DEVICE_PATTERN = /\b(desk\s*pro|board\s*\d|room\s*kit|webex\s*bot|meeting\s*room|conf\s*room)\b/i;

/**
 * GET /api/people/enrich — list people missing emails (candidates for enrichment)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    const candidates: { key: string; name: string; interactions: number }[] = [];

    for (const [key, person] of Object.entries(index) as [string, any][]) {
      if (person.emails?.length) continue;
      const name = person.name || "";
      if (name.split(/\s+/).length < 2) continue;
      if (DEVICE_PATTERN.test(name)) continue;

      const interactions =
        (person.meetings || []).length +
        (person.messageExcerpts || []).length +
        (person.transcriptMentions || []).length;

      candidates.push({ key, name, interactions });
    }

    candidates.sort((a, b) => b.interactions - a.interactions);
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
 * Body: { updates: [{ key: string, email: string, company?: string, jobTitle?: string }] }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();

    const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")) as Record<string, any>;
    let applied = 0;

    // Bulk email/company enrichment
    if (body.updates) {
      for (const u of body.updates as { key: string; email: string; company?: string; jobTitle?: string; avatar?: string }[]) {
        const person = index[u.key];
        if (!person) continue;
        if (u.email) {
          if (!person.emails) person.emails = [];
          if (!person.emails.includes(u.email.toLowerCase())) {
            person.emails.unshift(u.email.toLowerCase());
          }
        }
        if (u.company) person.company = u.company;
        if (u.jobTitle) person.jobTitle = u.jobTitle;
        if (u.avatar) person.avatar = u.avatar;
        applied++;
      }
    }

    // Delete people
    if (body.deleteKeys) {
      for (const key of body.deleteKeys as string[]) {
        if (index[key]) {
          delete index[key];
          applied++;
        }
      }
    }

    // Rename: change the name and re-key
    if (body.rename) {
      const { key, newName } = body.rename as { key: string; newName: string };
      if (index[key]) {
        const person = index[key];
        person.name = newName.trim();
        const newKey = newName.trim().toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
        if (newKey !== key) {
          delete index[key];
          index[newKey] = person;
        }
        applied++;
      }
    }

    // Merge: combine sourceKey into targetKey, then delete sourceKey
    if (body.merge) {
      const { sourceKey, targetKey } = body.merge as { sourceKey: string; targetKey: string };
      const source = index[sourceKey];
      const target = index[targetKey];
      if (source && target) {
        // Merge emails
        for (const e of source.emails || []) {
          if (!target.emails) target.emails = [];
          if (!target.emails.includes(e)) target.emails.push(e);
        }
        // Merge arrays by concatenating and deduping by a key field
        for (const field of ["meetings", "messageExcerpts", "transcriptMentions", "notionTasks", "webexRoomIds", "webexGroupRooms"]) {
          const sourceArr = source[field] || [];
          const targetArr = target[field] || [];
          if (sourceArr.length > 0) {
            const existing = new Set(targetArr.map((x: any) => JSON.stringify(x)));
            for (const item of sourceArr) {
              if (!existing.has(JSON.stringify(item))) {
                targetArr.push(item);
              }
            }
            target[field] = targetArr;
          }
        }
        // Merge custom fields (keep target's if set, else use source's)
        for (const f of ["company", "jobTitle", "profileNotes", "avatar"]) {
          if (!target[f] && source[f]) target[f] = source[f];
        }
        delete index[sourceKey];
        applied++;
      }
    }

    fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
    return NextResponse.json({ applied });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
