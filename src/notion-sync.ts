/**
 * Notion Sync Worker — bidirectional sync between PostgreSQL (system of record)
 * and Notion (mobile access / sharing).
 *
 * Outbound: PG tasks with notion_sync_status='pending' → push to Notion
 * Inbound:  Poll Notion for changes → merge into PG (future, Phase 6+)
 *
 * Runs as a background interval within the main NanoClaw process.
 */
import { query, getClient } from './pg.js';
import { logger } from './logger.js';
import { DATA_BACKEND } from './config.js';

// OneCLI proxy for Notion API
const ONECLI_TOKEN = process.env.ONECLI_AGENT_TOKEN || '';
const NOTION_DB = '5b4e1d2d7259496ea237ef0525c3ce78';

let syncInterval: ReturnType<typeof setInterval> | null = null;
let syncing = false;

// ── Notion API helpers ─────────────────────────────────

async function notionFetch(
  url: string,
  method: string,
  body?: unknown,
): Promise<any> {
  const { default: fetch } = await import('node-fetch');
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const agent = new HttpsProxyAgent(`http://x:${ONECLI_TOKEN}@localhost:10255`);

  const resp = await fetch(url, {
    method,
    agent,
    headers: {
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as any);

  return resp.json();
}

// ── Outbound sync: PG → Notion ─────────────────────────

interface PendingTask {
  id: string;
  title: string;
  priority: string | null;
  status: string;
  source: string | null;
  project: string | null;
  context: string | null;
  zone: string | null;
  delegated_to: string | null;
  energy: string | null;
  notes: string | null;
  notion_page_id: string | null;
}

function buildNotionProperties(task: PendingTask): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Task: { title: [{ text: { content: task.title } }] },
    Status: { status: { name: task.status || 'Not started' } },
  };

  if (task.priority) props.Priority = { select: { name: task.priority } };
  if (task.source) props.Source = { select: { name: task.source } };
  if (task.project) props.Project = { select: { name: task.project } };
  if (task.context) props.Context = { select: { name: task.context } };
  if (task.zone) props.Zone = { select: { name: task.zone } };
  if (task.delegated_to)
    props['Delegated To'] = { select: { name: task.delegated_to } };
  if (task.notes)
    props.Notes = {
      rich_text: [{ text: { content: task.notes.slice(0, 2000) } }],
    };

  return props;
}

async function syncOutbound(): Promise<{
  created: number;
  updated: number;
  errors: number;
}> {
  const result = { created: 0, updated: 0, errors: 0 };

  // Get tasks that need syncing to Notion
  const pending = await query<PendingTask>(
    `SELECT id, title, priority, status, source, project, context, zone,
            delegated_to, energy, notes, notion_page_id
     FROM tasks
     WHERE notion_sync_status = 'pending'
     ORDER BY updated_at ASC
     LIMIT 20`,
  );

  if (pending.rows.length === 0) return result;

  logger.info(`Notion sync: ${pending.rows.length} tasks to push`);

  for (const task of pending.rows) {
    try {
      const properties = buildNotionProperties(task);

      if (task.notion_page_id) {
        // Update existing Notion page
        await notionFetch(
          `https://api.notion.com/v1/pages/${task.notion_page_id}`,
          'PATCH',
          { properties },
        );
        result.updated++;
      } else {
        // Create new Notion page
        const resp = await notionFetch(
          'https://api.notion.com/v1/pages',
          'POST',
          {
            parent: { database_id: NOTION_DB },
            properties,
          },
        );

        if (resp.id) {
          // Store the Notion page ID back in PG
          await query('UPDATE tasks SET notion_page_id = $1 WHERE id = $2', [
            resp.id,
            task.id,
          ]);
          result.created++;
        } else {
          throw new Error(resp.message || 'Failed to create Notion page');
        }
      }

      // Mark as synced
      await query(
        `UPDATE tasks SET notion_sync_status = 'synced', notion_synced_at = now() WHERE id = $1`,
        [task.id],
      );

      // Log sync
      await query(
        `INSERT INTO notion_sync_log (entity_type, entity_id, direction, status)
         VALUES ('task', $1, 'to_notion', 'success')`,
        [task.id],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Notion sync error for task ${task.id.slice(0, 8)}: ${msg}`);

      await query(
        `UPDATE tasks SET notion_sync_status = 'error' WHERE id = $1`,
        [task.id],
      );
      await query(
        `INSERT INTO notion_sync_log (entity_type, entity_id, direction, status, error)
         VALUES ('task', $1, 'to_notion', 'error', $2)`,
        [task.id, msg],
      );

      result.errors++;
    }

    // Rate limit: 3 requests/sec to avoid Notion API throttling
    await new Promise((r) => setTimeout(r, 350));
  }

  return result;
}

// ── Sync loop ──────────────────────────────────────────

async function runSyncCycle(): Promise<void> {
  if (syncing) return;
  syncing = true;

  try {
    const outbound = await syncOutbound();
    if (outbound.created + outbound.updated + outbound.errors > 0) {
      logger.info(
        `Notion sync complete: ${outbound.created} created, ${outbound.updated} updated, ${outbound.errors} errors`,
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Notion sync cycle failed: ${msg}`);
  } finally {
    syncing = false;
  }
}

// ── Public API ─────────────────────────────────────────

/** Start the background Notion sync worker (runs every 30 seconds) */
export function startNotionSync(): void {
  if (DATA_BACKEND === 'sqlite') {
    logger.info('Notion sync disabled (DATA_BACKEND=sqlite)');
    return;
  }

  if (!ONECLI_TOKEN) {
    logger.warn('Notion sync disabled (no ONECLI_AGENT_TOKEN)');
    return;
  }

  logger.info('Notion sync worker started (30s interval)');
  syncInterval = setInterval(runSyncCycle, 30_000);

  // Run immediately on startup
  runSyncCycle();
}

/** Stop the sync worker */
export function stopNotionSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

/** Mark a task as needing sync to Notion */
export async function markTaskForSync(taskId: string): Promise<void> {
  await query(`UPDATE tasks SET notion_sync_status = 'pending' WHERE id = $1`, [
    taskId,
  ]);
}

/** Create a task in PG and queue it for Notion sync */
export async function createTaskLocal(task: {
  title: string;
  priority?: string;
  status?: string;
  source?: string;
  project?: string;
  context?: string;
  zone?: string;
  delegatedTo?: string;
  notes?: string;
  triageStatus?: string;
}): Promise<string> {
  const result = await query(
    `INSERT INTO tasks (id, title, priority, status, source, project, context, zone,
       delegated_to, notes, notion_sync_status, triage_status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, now(), now())
     RETURNING id`,
    [
      task.title,
      task.priority || null,
      task.status || 'Not started',
      task.source || null,
      task.project || null,
      task.context || null,
      task.zone || null,
      task.delegatedTo || null,
      task.notes || null,
      task.triageStatus || 'inbox',
    ],
  );
  return result.rows[0].id;
}

/** Update a task in PG and queue it for Notion sync */
export async function updateTaskLocal(
  taskId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const fieldMap: Record<string, string> = {
    title: 'title',
    priority: 'priority',
    status: 'status',
    source: 'source',
    project: 'project',
    context: 'context',
    zone: 'zone',
    delegatedTo: 'delegated_to',
    delegated_to: 'delegated_to',
    notes: 'notes',
    triageStatus: 'triage_status',
    triage_status: 'triage_status',
  };

  for (const [key, val] of Object.entries(updates)) {
    const col = fieldMap[key];
    if (col && val !== undefined) {
      fields.push(`${col} = $${idx}`);
      values.push(val);
      idx++;
    }
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = now()`);
  fields.push(`notion_sync_status = 'pending'`);

  values.push(taskId);
  await query(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
}
