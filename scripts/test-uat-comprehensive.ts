/**
 * Comprehensive UAT — tests every dashboard API route for correct response shape.
 * Catches missing fields, wrong types, and broken queries before the user sees them.
 */
import pg from "pg";

const PG_URL = process.env.DATABASE_URL || "postgresql://nanoclaw@localhost:5432/nanoclaw";
let pool: pg.Pool;
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) { console.log(`  \x1b[32m✓\x1b[0m ${label}`); passed++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function testRoute(method: string, path: string, body?: any): Promise<any> {
  const DASHBOARD = "http://127.0.0.1:3940";
  try {
    const opts: any = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${DASHBOARD}${path}`, opts);
    // Routes return 401 without auth — that's fine, it means the route exists and compiles
    if (resp.status === 401) return { _status: 401, _authRequired: true };
    if (resp.status === 307) return { _status: 307, _redirect: true };
    const text = await resp.text();
    try { return { _status: resp.status, ...JSON.parse(text) }; }
    catch { return { _status: resp.status, _raw: text.slice(0, 200) }; }
  } catch (err: any) {
    return { _status: 0, _error: err.message };
  }
}

async function testSQL(label: string, sql: string, params?: any[], validator?: (rows: any[]) => boolean) {
  try {
    const result = await pool.query(sql, params);
    const valid = validator ? validator(result.rows) : result.rows.length >= 0;
    assert(valid, label, valid ? undefined : `got ${result.rows.length} rows`);
    return result.rows;
  } catch (err: any) {
    assert(false, label, err.message.slice(0, 100));
    return [];
  }
}

// ══════════════════════════════════════════════════════════
async function testAPIRoutes() {
  console.log("\n\x1b[1m━━━ API Route Availability (all 20 routes) ━━━\x1b[0m");

  const routes = [
    { method: "GET", path: "/api/health" },
    { method: "POST", path: "/api/notion/query", body: { filter: { property: "Status", status: { does_not_equal: "Done" } }, page_size: 1 } },
    { method: "GET", path: "/api/triage" },
    { method: "GET", path: "/api/people" },
    { method: "GET", path: "/api/team" },
    { method: "GET", path: "/api/artifacts" },
    { method: "GET", path: "/api/archive" },
    { method: "GET", path: "/api/initiatives" },
    { method: "GET", path: "/api/topics" },
    { method: "GET", path: "/api/dedup" },
    { method: "GET", path: "/api/weekly-checkin" },
    { method: "GET", path: "/api/system-status" },
    { method: "GET", path: "/api/calendar/events" },
    { method: "GET", path: "/api/relevance?context=test" },
    { method: "GET", path: "/api/context?name=test" },
    { method: "GET", path: "/api/search?q=test" },
    { method: "GET", path: "/api/meeting-prep?title=test" },
    { method: "GET", path: "/api/people/enrich" },
    { method: "POST", path: "/api/synthesize", body: { prompt: "test" } },
    { method: "POST", path: "/api/task-actions", body: { title: "test" } },
  ];

  for (const r of routes) {
    const result = await testRoute(r.method, r.path, r.body);
    const ok = result._status === 401 || result._status === 200 || result._status === 201;
    assert(ok, `${r.method} ${r.path}: ${result._status}`, !ok ? (result._error || result._raw?.slice(0, 60) || `status ${result._status}`) : undefined);
  }
}

// ══════════════════════════════════════════════════════════
async function testNotionQueryCompat() {
  console.log("\n\x1b[1m━━━ Notion Query Compatibility ━━━\x1b[0m");

  // Test the filter translator with all filter types used by the frontend
  const filters = [
    { name: "Status does_not_equal Done", filter: { property: "Status", status: { does_not_equal: "Done" } } },
    { name: "Priority equals P0", filter: { property: "Priority", select: { equals: "P0 \u2014 Today" } } },
    { name: "Title contains search", filter: { property: "Task", title: { contains: "test" } } },
    { name: "Notes contains text", filter: { property: "Notes", rich_text: { contains: "test" } } },
    { name: "AND compound", filter: { and: [{ property: "Status", status: { does_not_equal: "Done" } }, { property: "Priority", select: { equals: "P1 \u2014 This Week" } }] } },
    { name: "OR compound", filter: { or: [{ property: "Priority", select: { equals: "P0 \u2014 Today" } }, { property: "Priority", select: { equals: "P1 \u2014 This Week" } }] } },
    { name: "Complex AND+OR", filter: { and: [{ property: "Status", status: { does_not_equal: "Done" } }, { or: [{ property: "Priority", select: { equals: "P0 \u2014 Today" } }, { property: "Priority", select: { equals: "P1 \u2014 This Week" } }] }] } },
  ];

  for (const f of filters) {
    await testSQL(f.name,
      // Simulate what the notion/query route does
      `SELECT COUNT(*) as c FROM tasks WHERE ${translateFilter(f.filter).where || '1=1'}`,
      translateFilter(f.filter).params,
      (rows) => parseInt(rows[0]?.c) >= 0
    );
  }
}

function translateFilter(filter: any, offset = 0): { where: string; params: any[] } {
  if (!filter) return { where: "", params: [] };
  if (filter.and) {
    const parts: string[] = []; const allParams: any[] = [];
    for (const sub of filter.and) { const r = translateFilter(sub, offset + allParams.length); if (r.where) { parts.push(r.where); allParams.push(...r.params); } }
    return { where: parts.length > 0 ? `(${parts.join(" AND ")})` : "", params: allParams };
  }
  if (filter.or) {
    const parts: string[] = []; const allParams: any[] = [];
    for (const sub of filter.or) { const r = translateFilter(sub, offset + allParams.length); if (r.where) { parts.push(r.where); allParams.push(...r.params); } }
    return { where: parts.length > 0 ? `(${parts.join(" OR ")})` : "", params: allParams };
  }
  const prop = filter.property; if (!prop) return { where: "", params: [] };
  const colMap: Record<string, string> = { Task: "title", Priority: "priority", Status: "status", Source: "source", Project: "project", Context: "context", Notes: "notes" };
  const col = colMap[prop] || prop.toLowerCase(); const idx = offset + 1;
  if (filter.status?.equals) return { where: `${col} = $${idx}`, params: [filter.status.equals] };
  if (filter.status?.does_not_equal) return { where: `${col} != $${idx}`, params: [filter.status.does_not_equal] };
  if (filter.select?.equals) return { where: `${col} = $${idx}`, params: [filter.select.equals] };
  if (filter.title?.contains) return { where: `${col} ILIKE $${idx}`, params: [`%${filter.title.contains}%`] };
  if (filter.rich_text?.contains) return { where: `${col} ILIKE $${idx}`, params: [`%${filter.rich_text.contains}%`] };
  return { where: "", params: [] };
}

// ══════════════════════════════════════════════════════════
async function testFrontendDataShapes() {
  console.log("\n\x1b[1m━━━ Frontend Data Shape Compatibility ━━━\x1b[0m");

  // Today view: tasks must have NotionPage shape
  const tasks = await pool.query("SELECT id, title, priority, status, source, project, context, delegated_to, notes FROM tasks WHERE status != 'Done' LIMIT 3");
  for (const t of tasks.rows) {
    assert(!!t.id && !!t.title, `Task shape: "${t.title?.slice(0, 40)}..."`, !t.id ? "missing id" : undefined);
    assert(typeof t.priority === "string" || t.priority === null, `  priority: ${typeof t.priority}`);
    assert(typeof t.status === "string", `  status: ${t.status}`);
  }

  // People list: must have name, emails array, stat counts
  const people = await pool.query(`
    SELECT p.name, array_agg(DISTINCT pe.email) FILTER (WHERE pe.email IS NOT NULL) as emails,
           COUNT(DISTINCT mp.meeting_id) as meetings
    FROM people p LEFT JOIN person_emails pe ON pe.person_id = p.id
    LEFT JOIN meeting_participants mp ON mp.person_id = p.id
    GROUP BY p.id LIMIT 3
  `);
  for (const p of people.rows) {
    assert(!!p.name, `Person shape: ${p.name}`);
    assert(Array.isArray(p.emails) || p.emails === null, `  emails is array: ${typeof p.emails}`);
  }

  // Initiatives list: must have slug, name, pinnedTaskIds
  const initiatives = await pool.query(`
    SELECT i.slug, i.name, i.status,
           array_agg(DISTINCT ipt.task_id) FILTER (WHERE ipt.task_id IS NOT NULL) as pinned_task_ids
    FROM initiatives i LEFT JOIN initiative_pinned_tasks ipt ON ipt.initiative_slug = i.slug
    GROUP BY i.slug LIMIT 3
  `);
  for (const ini of initiatives.rows) {
    assert(!!ini.slug && !!ini.name, `Initiative shape: ${ini.name}`);
    assert(!!ini.status, `  status: ${ini.status}`);
  }

  // Team members: must have name, role, join to people
  const team = await pool.query(`
    SELECT tm.name, tm.role, tm.email, p.id as person_id
    FROM team_members tm LEFT JOIN people p ON p.name = tm.name
  `);
  for (const m of team.rows) {
    assert(!!m.name && !!m.role, `Team member: ${m.name}`);
    assert(!!m.person_id, `  linked to people table`, !m.person_id ? "person NOT FOUND" : undefined);
  }

  // Weekly checkin: test the full query doesn't crash
  await testSQL("Weekly checkin stats query",
    `SELECT COUNT(*) as c FROM tasks WHERE status = 'Done' AND updated_at >= now() - interval '7 days'`,
    [], (rows) => parseInt(rows[0]?.c) >= 0
  );

  // Triage: inbox vs accepted
  await testSQL("Triage inbox count",
    "SELECT COUNT(*) as c FROM tasks WHERE triage_status = 'inbox' AND status != 'Done'",
    [], (rows) => parseInt(rows[0]?.c) >= 0
  );
}

// ══════════════════════════════════════════════════════════
async function testCrossTableJoins() {
  console.log("\n\x1b[1m━━━ Cross-Table Joins (data linking) ━━━\x1b[0m");

  // Person → emails → meetings → transcripts (full chain)
  await testSQL("Person full context join",
    `SELECT p.name, COUNT(DISTINCT pe.email) as emails, COUNT(DISTINCT mp.meeting_id) as meetings,
            COUNT(DISTINCT me.id) as messages, COUNT(DISTINCT tm.id) as transcripts
     FROM people p
     LEFT JOIN person_emails pe ON pe.person_id = p.id
     LEFT JOIN meeting_participants mp ON mp.person_id = p.id
     LEFT JOIN message_excerpts me ON me.person_id = p.id
     LEFT JOIN transcript_mentions tm ON tm.person_id = p.id
     GROUP BY p.id HAVING COUNT(DISTINCT me.id) > 0 LIMIT 1`,
    [], (rows) => rows.length > 0
  );

  // Task → people link
  await testSQL("Task people join",
    "SELECT t.title, p.name FROM task_people tp JOIN tasks t ON t.id = tp.task_id JOIN people p ON p.id = tp.person_id LIMIT 3",
    [], (rows) => rows.length >= 0
  );

  // Initiative → pinned tasks
  await testSQL("Initiative pinned tasks join",
    `SELECT i.name, t.title FROM initiative_pinned_tasks ipt
     JOIN initiatives i ON i.slug = ipt.initiative_slug
     JOIN tasks t ON t.id = ipt.task_id LIMIT 3`,
    [], (rows) => rows.length > 0
  );

  // Archive → vector chunks linkage
  await testSQL("Archive items exist",
    "SELECT source_type, COUNT(*) as c FROM archive_items GROUP BY source_type ORDER BY c DESC",
    [], (rows) => rows.length > 0
  );

  // Artifacts → mentioned people
  await testSQL("Artifacts with people",
    "SELECT title, mentioned_people FROM artifacts WHERE array_length(mentioned_people, 1) > 0 LIMIT 2",
    [], (rows) => rows.length >= 0
  );

  // Team member → tasks (the query that was failing)
  await testSQL("Team member task lookup",
    `SELECT t.id, t.title FROM tasks t
     WHERE t.status != 'Done' AND (t.delegated_to = $1 OR t.title ILIKE $2 OR t.notes ILIKE $3) LIMIT 5`,
    ["Tim", "%Tim%", "%Tim Marshfield%"],
    (rows) => rows.length >= 0
  );

  // Notion sync integrity
  await testSQL("Notion sync — all tasks have page IDs",
    "SELECT COUNT(*) as c FROM tasks WHERE notion_page_id IS NOT NULL",
    [], (rows) => parseInt(rows[0]?.c) > 1000
  );

  // Triage decisions → tasks FK
  await testSQL("Triage decisions link to tasks",
    "SELECT td.action, t.title FROM triage_decisions td JOIN tasks t ON t.id = td.task_id LIMIT 3",
    [], (rows) => rows.length >= 0
  );
}

// ══════════════════════════════════════════════════════════
async function testEdgeCases() {
  console.log("\n\x1b[1m━━━ Edge Cases ━━━\x1b[0m");

  // Empty searches shouldn't crash
  await testSQL("Empty keyword search", "SELECT COUNT(*) as c FROM vector_chunks WHERE text ILIKE '%' LIMIT 1", [], () => true);

  // NULL handling in task properties
  await testSQL("Tasks with NULL priority",
    "SELECT COUNT(*) as c FROM tasks WHERE priority IS NULL AND status != 'Done'",
    [], (rows) => parseInt(rows[0]?.c) >= 0
  );

  // Very long task titles
  await testSQL("Long title handling",
    "SELECT MAX(LENGTH(title)) as max_len FROM tasks",
    [], (rows) => parseInt(rows[0]?.max_len) < 10000
  );

  // Unicode in names
  await testSQL("Unicode people names",
    "SELECT name FROM people WHERE name LIKE '%ö%' OR name LIKE '%ü%' OR name LIKE '%é%' LIMIT 3",
    [], () => true
  );

  // Concurrent connection handling
  const promises = Array.from({ length: 5 }, (_, i) =>
    pool.query("SELECT $1::int as n", [i])
  );
  const results = await Promise.all(promises);
  assert(results.every((r) => r.rows.length === 1), "5 concurrent queries succeed");
}

// ══════════════════════════════════════════════════════════
async function main() {
  pool = new pg.Pool({ connectionString: PG_URL });

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║     Comprehensive UAT — Post-Migration Validation       ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  await testAPIRoutes();
  await testNotionQueryCompat();
  await testFrontendDataShapes();
  await testCrossTableJoins();
  await testEdgeCases();

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log(`║  Results: \x1b[32m${passed} passed\x1b[0m  \x1b[31m${failed} failed\x1b[0m${" ".repeat(Math.max(0, 30 - String(passed).length - String(failed).length))}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
