import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { sql, sqlOne } from "@/lib/pg";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * GET /api/initiatives — list or detail view (from PostgreSQL)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const slug = req.nextUrl.searchParams.get("slug");

  if (slug) {
    // --- Detail view ---
    const ini = await sqlOne(
      "SELECT * FROM initiatives WHERE slug = $1", [slug]
    );
    if (!ini) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });

    // Get pinned tasks
    const pinnedIds = (await sql(
      "SELECT task_id FROM initiative_pinned_tasks WHERE initiative_slug = $1", [slug]
    )).map((r: any) => r.task_id);

    // Get tasks: pinned + keyword-matched
    let tasks: any[] = [];
    if (pinnedIds.length > 0) {
      const pinnedPlaceholders = pinnedIds.map((_: any, i: number) => `$${i + 1}::uuid`).join(",");
      tasks = await sql(
        `SELECT id, title, priority, status, source, project, delegated_to, notes, created_at
         FROM tasks WHERE id IN (${pinnedPlaceholders})
         ORDER BY CASE WHEN status = 'Done' THEN 1 ELSE 0 END,
                  CASE WHEN priority LIKE 'P0%' THEN 0 WHEN priority LIKE 'P1%' THEN 1 WHEN priority LIKE 'P2%' THEN 2 ELSE 3 END`,
        pinnedIds
      );
    }
    // Also find keyword-matched tasks (split multi-word keywords into individual search terms)
    const searchTerms = (ini.keywords || []).flatMap((k: string) => k.split(/\s+/).filter((w: string) => w.length > 3));
    if (searchTerms.length > 0) {
      const kwConditions = searchTerms.map((_: string, i: number) => `title ILIKE $${i + 1}`).join(" OR ");
      const kwParams = searchTerms.map((k: string) => `%${k}%`);
      const kwTasks = await sql(
        `SELECT id, title, priority, status, source, project, delegated_to, notes, created_at
         FROM tasks WHERE status != 'Done' AND (${kwConditions})
         ORDER BY created_at DESC LIMIT 20`,
        kwParams
      );
      const existingIds = new Set(tasks.map((t: any) => t.id));
      for (const t of kwTasks) {
        if (!existingIds.has(t.id)) tasks.push(t);
      }
    }

    // Get linked people (pinned + keyword-matched in meetings)
    const pinnedPeople = (await sql(
      "SELECT person_name FROM initiative_pinned_people WHERE initiative_slug = $1", [slug]
    )).map((r: any) => r.person_name);

    const people: any[] = [];
    // Add pinned people
    for (const name of pinnedPeople) {
      const person = await sqlOne(
        `SELECT p.name, pe.email, COUNT(DISTINCT mp.meeting_id) as meetings
         FROM people p LEFT JOIN person_emails pe ON pe.person_id = p.id
         LEFT JOIN meeting_participants mp ON mp.person_id = p.id
         WHERE p.name ILIKE $1
         GROUP BY p.name, pe.email LIMIT 1`,
        [`%${name}%`]
      );
      if (person) people.push({ name: person.name, email: person.email, meetings: parseInt(person.meetings), pinned: true });
    }
    // Add keyword-matched people from meetings
    if (searchTerms.length > 0) {
      const kwCond = searchTerms.map((_: string, i: number) => `m.topic ILIKE $${i + 1}`).join(" OR ");
      const kwP = searchTerms.map((k: string) => `%${k}%`);
      const matched = await sql(
        `SELECT DISTINCT p.name, pe.email FROM people p
         JOIN meeting_participants mp ON mp.person_id = p.id
         JOIN meetings m ON m.id = mp.meeting_id
         LEFT JOIN person_emails pe ON pe.person_id = p.id
         WHERE ${kwCond} LIMIT 15`,
        kwP
      );
      const existingNames = new Set(people.map((p: any) => p.name.toLowerCase()));
      for (const m of matched) {
        if (!existingNames.has(m.name.toLowerCase())) people.push({ name: m.name, email: m.email, pinned: false });
      }
    }

    // Get linked meetings
    const meetings: any[] = [];
    if (searchTerms.length > 0) {
      const kwCond = searchTerms.map((_: string, i: number) => `topic ILIKE $${i + 1}`).join(" OR ");
      const kwP = searchTerms.map((k: string) => `%${k}%`);
      const mtgs = await sql(
        `SELECT id, topic, date::text, host_name FROM meetings WHERE ${kwCond} ORDER BY date DESC LIMIT 15`,
        kwP
      );
      meetings.push(...mtgs.map((m: any) => ({ id: m.id, topic: m.topic, date: m.date, host: m.host_name })));
    }

    // Get summaries
    const summaries: any[] = [];
    if (searchTerms.length > 0) {
      const kwCond = searchTerms.map((_: string, i: number) => `title ILIKE $${i + 1} OR summary ILIKE $${i + 1}`).join(" OR ");
      const kwP = searchTerms.map((k: string) => `%${k}%`);
      const sums = await sql(
        `SELECT meeting_id, title, date::text, summary FROM ai_summaries WHERE ${kwCond} ORDER BY date DESC LIMIT 5`,
        kwP
      );
      summaries.push(...sums.map((s: any) => ({ meetingId: s.meeting_id, title: s.title, date: s.date, summary: s.summary })));
    }

    // Get phases
    const phases = await sql(
      "SELECT id, label, sort_order, start_date::text, end_date::text FROM initiative_phases WHERE initiative_slug = $1 ORDER BY sort_order",
      [slug]
    );

    // Get pinned task phase assignments
    const taskPhases = await sql(
      "SELECT task_id, phase_id FROM initiative_pinned_tasks WHERE initiative_slug = $1 AND phase_id IS NOT NULL",
      [slug]
    );
    const taskPhaseMap: Record<string, string> = {};
    for (const tp of taskPhases) taskPhaseMap[tp.task_id] = tp.phase_id;

    // Get artifacts linked to any task in this initiative
    const allTaskIds = tasks.map((t: any) => t.id);
    let artifacts: any[] = [];
    if (allTaskIds.length > 0) {
      const artPlaceholders = allTaskIds.map((_: any, i: number) => `$${i + 1}::uuid`).join(",");
      artifacts = await sql(
        `SELECT id, title, intent, task_id, char_count, created_at::text FROM artifacts WHERE task_id IN (${artPlaceholders}) ORDER BY created_at DESC`,
        allTaskIds
      );
    }

    // Task progress
    const totalTasks = tasks.length;
    const doneTasks = tasks.filter((t: any) => t.status === "Done").length;

    // Add people's recent message excerpts
    for (const p of people) {
      if (p.pinned) {
        const excerpt = await sqlOne(
          `SELECT LEFT(text, 150) as text, date::text FROM message_excerpts me
           JOIN people pp ON pp.id = me.person_id
           WHERE pp.name ILIKE $1 ORDER BY me.date DESC LIMIT 1`,
          [`%${p.name}%`]
        );
        if (excerpt) p.lastMessage = excerpt.text;
      }
    }

    return NextResponse.json({
      name: ini.name, description: ini.description, status: ini.status,
      keywords: ini.keywords, target_date: ini.target_date, tasks, people,
      meetings, summaries, phases, artifacts, taskPhaseMap,
      progress: { total: totalTasks, done: doneTasks },
      activity: [],
    });
  }

  // --- List view ---
  const initiatives = await sql(
    `SELECT i.slug, i.name, i.description, i.status, i.owner, i.keywords, i.created_at,
            COALESCE(tc.task_count, 0) as task_count,
            COALESCE(pc.people_count, 0) as people_count,
            array_agg(DISTINCT ipt.task_id) FILTER (WHERE ipt.task_id IS NOT NULL) as pinned_task_ids
     FROM initiatives i
     LEFT JOIN initiative_pinned_tasks ipt ON ipt.initiative_slug = i.slug
     LEFT JOIN LATERAL (
       SELECT COUNT(*) as task_count FROM initiative_pinned_tasks WHERE initiative_slug = i.slug
     ) tc ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) as people_count FROM initiative_pinned_people WHERE initiative_slug = i.slug
     ) pc ON true
     GROUP BY i.slug, i.name, i.description, i.status, i.owner, i.keywords, i.created_at, tc.task_count, pc.people_count
     ORDER BY CASE WHEN i.status = 'active' THEN 0 ELSE 1 END, i.created_at DESC`
  );

  const list = initiatives.map((i: any) => ({
    slug: i.slug, name: i.name, description: i.description, status: i.status,
    owner: i.owner, taskCount: parseInt(i.task_count), peopleCount: parseInt(i.people_count),
    meetingCount: 0, recentActivity: i.created_at,
    pinnedTaskIds: (i.pinned_task_ids || []).filter(Boolean),
  }));

  return NextResponse.json(list);
}

/**
 * POST /api/initiatives — create initiative
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, description, keywords, notionProject, owner } = await req.json();
  if (!name || !description || !keywords || !Array.isArray(keywords)) {
    return NextResponse.json({ error: "name, description, and keywords (array) are required" }, { status: 400 });
  }

  const slug = slugify(name);
  const existing = await sqlOne("SELECT slug FROM initiatives WHERE slug = $1", [slug]);
  if (existing) return NextResponse.json({ error: "Initiative already exists" }, { status: 409 });

  await sql(
    `INSERT INTO initiatives (slug, name, description, status, owner, notion_project, keywords, created_at)
     VALUES ($1, $2, $3, 'active', $4, $5, $6, CURRENT_DATE)`,
    [slug, name, description, owner || "Jason", notionProject || null, keywords]
  );

  return NextResponse.json({ slug, name, description, status: "active", owner: owner || "Jason", keywords, pinnedTaskIds: [], pinnedPeople: [] }, { status: 201 });
}

/**
 * PATCH /api/initiatives — update initiative (fields + pin/unpin)
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { slug } = body;
  if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

  const ini = await sqlOne("SELECT * FROM initiatives WHERE slug = $1", [slug]);
  if (!ini) return NextResponse.json({ error: "Initiative not found" }, { status: 404 });

  // Field updates
  if (body.name) await sql("UPDATE initiatives SET name = $1 WHERE slug = $2", [body.name, slug]);
  if (body.description) await sql("UPDATE initiatives SET description = $1 WHERE slug = $2", [body.description, slug]);
  if (body.status) await sql("UPDATE initiatives SET status = $1 WHERE slug = $2", [body.status, slug]);
  if (body.keywords) await sql("UPDATE initiatives SET keywords = $1 WHERE slug = $2", [body.keywords, slug]);
  if (body.target_date !== undefined) await sql("UPDATE initiatives SET target_date = $1 WHERE slug = $2", [body.target_date || null, slug]);

  // Phase management
  if (body.addPhase) {
    const { label, sort_order, start_date, end_date } = body.addPhase;
    const phase = await sqlOne(
      "INSERT INTO initiative_phases (initiative_slug, label, sort_order, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [slug, label, sort_order || 0, start_date || null, end_date || null]
    );
    return NextResponse.json({ slug, phase });
  }
  if (body.updatePhase) {
    const { id: phId, label: phLabel, start_date: phStart, end_date: phEnd } = body.updatePhase;
    if (phLabel) await sql("UPDATE initiative_phases SET label = $1 WHERE id = $2::uuid AND initiative_slug = $3", [phLabel, phId, slug]);
    if (phStart !== undefined) await sql("UPDATE initiative_phases SET start_date = $1 WHERE id = $2::uuid AND initiative_slug = $3", [phStart || null, phId, slug]);
    if (phEnd !== undefined) await sql("UPDATE initiative_phases SET end_date = $1 WHERE id = $2::uuid AND initiative_slug = $3", [phEnd || null, phId, slug]);
  }
  if (body.removePhase) {
    await sql("DELETE FROM initiative_phases WHERE id = $1::uuid AND initiative_slug = $2", [body.removePhase, slug]);
  }
  if (body.assignTaskPhase) {
    const { taskId, phaseId } = body.assignTaskPhase;
    if (phaseId) {
      await sql("UPDATE initiative_pinned_tasks SET phase_id = $1::uuid WHERE initiative_slug = $2 AND task_id = $3::uuid", [phaseId, slug, taskId]);
    } else {
      await sql("UPDATE initiative_pinned_tasks SET phase_id = NULL WHERE initiative_slug = $1 AND task_id = $2::uuid", [slug, taskId]);
    }
  }

  // Pin/unpin task
  if (body.pinTask) {
    await sql("INSERT INTO initiative_pinned_tasks (initiative_slug, task_id) VALUES ($1, $2::uuid) ON CONFLICT DO NOTHING", [slug, body.pinTask]);
  }
  if (body.unpinTask) {
    await sql("DELETE FROM initiative_pinned_tasks WHERE initiative_slug = $1 AND task_id = $2::uuid", [slug, body.unpinTask]);
  }

  // Pin/unpin person
  if (body.pinPerson) {
    await sql("INSERT INTO initiative_pinned_people (initiative_slug, person_name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [slug, body.pinPerson]);
  }
  if (body.unpinPerson) {
    await sql("DELETE FROM initiative_pinned_people WHERE initiative_slug = $1 AND person_name = $2", [slug, body.unpinPerson]);
  }

  const updated = await sqlOne("SELECT * FROM initiatives WHERE slug = $1", [slug]);
  return NextResponse.json({ slug, ...updated });
}
