/**
 * PostgreSQL write operations — mirrors the SQLite functions in db.ts.
 * Used by the dual-write adapter when DATA_BACKEND is 'dual' or 'postgres'.
 */
import { query } from './pg.js';
import { logger } from './logger.js';
import type { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

// ── Chats ──────────────────────────────────────────────

export async function pgStoreChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  await query(
    `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (jid) DO UPDATE SET
       name = COALESCE(NULLIF($2, $1), chats.name),
       last_message_time = GREATEST(chats.last_message_time, $3),
       channel = COALESCE($4, chats.channel),
       is_group = COALESCE($5, chats.is_group)`,
    [chatJid, name || chatJid, timestamp, channel || null, isGroup ?? null],
  );
}

export async function pgUpdateChatName(chatJid: string, name: string): Promise<void> {
  await query(
    `INSERT INTO chats (jid, name, last_message_time)
     VALUES ($1, $2, $3)
     ON CONFLICT (jid) DO UPDATE SET name = $2`,
    [chatJid, name, new Date().toISOString()],
  );
}

// ── Messages ───────────────────────────────────────────

export async function pgStoreMessage(msg: NewMessage): Promise<void> {
  await query(
    `INSERT INTO chat_messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id, chat_jid) DO UPDATE SET
       content = $5, sender_name = COALESCE($4, chat_messages.sender_name)`,
    [msg.id, msg.chat_jid, msg.sender, msg.sender_name, msg.content, msg.timestamp, msg.is_from_me, msg.is_bot_message || false],
  );
}

// ── Scheduled Tasks ────────────────────────────────────

export async function pgCreateTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'model'> & { model?: string | null },
): Promise<void> {
  await query(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, model, next_run, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING`,
    [task.id, task.group_folder, task.chat_jid, task.prompt, task.schedule_type, task.schedule_value, task.context_mode || 'isolated', task.model || null, task.next_run, task.status, task.created_at],
  );
}

export async function pgUpdateTask(
  id: string,
  updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = $${idx}`);
      values.push(val);
      idx++;
    }
  }
  if (fields.length === 0) return;

  values.push(id);
  await query(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

export async function pgDeleteTask(id: string): Promise<void> {
  await query('DELETE FROM task_run_logs WHERE task_id = $1', [id]);
  await query('DELETE FROM scheduled_tasks WHERE id = $1', [id]);
}

export async function pgUpdateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `UPDATE scheduled_tasks
     SET next_run = $1, last_run = $2, last_result = $3,
         status = CASE WHEN $1 IS NULL THEN 'completed' ELSE status END
     WHERE id = $4`,
    [nextRun, now, lastResult, id],
  );
}

export async function pgLogTaskRun(log: TaskRunLog): Promise<void> {
  await query(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error],
  );
}

// ── Router State ───────────────────────────────────────

export async function pgSetRouterState(key: string, value: string): Promise<void> {
  await query(
    'INSERT INTO router_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, value],
  );
}

// ── Sessions ───────────────────────────────────────────

export async function pgSetSession(groupFolder: string, sessionId: string): Promise<void> {
  await query(
    'INSERT INTO sessions (group_folder, session_id) VALUES ($1, $2) ON CONFLICT (group_folder) DO UPDATE SET session_id = $2',
    [groupFolder, sessionId],
  );
}

// ── Registered Groups ──────────────────────────────────

export async function pgSetRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
  await query(
    `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (jid) DO UPDATE SET
       name = $2, folder = $3, trigger_pattern = $4,
       container_config = $6, requires_trigger = $7, is_main = $8`,
    [
      jid, group.name, group.folder, group.trigger, group.added_at,
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger ?? true, group.isMain ?? false,
    ],
  );
}

// ── Last Group Sync ────────────────────────────────────

export async function pgSetLastGroupSync(): Promise<void> {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', $1)
     ON CONFLICT (jid) DO UPDATE SET last_message_time = $1`,
    [now],
  );
}
