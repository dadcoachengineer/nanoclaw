/**
 * PostgreSQL read operations — mirrors the SQLite read functions in db.ts.
 * Used when DATA_BACKEND is 'postgres'.
 */
import { query } from './pg.js';
import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

export interface ChatInfo {
  jid: string;
  name: string | null;
  last_message_time: string;
  channel: string | null;
  is_group: boolean;
}

export interface TaskRunLogRow extends TaskRunLog {
  id: number;
}

// ── Chats ──────────────────────────────────────────────

export async function pgGetAllChats(): Promise<ChatInfo[]> {
  const rows = await query(
    `SELECT jid, name, last_message_time, channel, is_group FROM chats WHERE jid != '__group_sync__' ORDER BY last_message_time DESC`,
  );
  return rows.rows;
}

export async function pgGetLastGroupSync(): Promise<string | null> {
  const result = await query(
    `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
  );
  return result.rows[0]?.last_message_time || null;
}

// ── Messages ──────────────────────────────────────────────

export async function pgGetNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };
  const placeholders = jids.map((_, i) => `$${i + 1}`).join(',');
  const result = await query(
    `SELECT chat_jid, sender_jid, sender_name, text, timestamp, message_id, is_group
     FROM chat_messages
     WHERE chat_jid IN (${placeholders})
       AND timestamp > $${jids.length + 1}
       AND (sender_name IS NULL OR sender_name NOT LIKE $${jids.length + 2})
     ORDER BY timestamp ASC
     LIMIT $${jids.length + 3}`,
    [...jids, lastTimestamp, `${botPrefix}%`, limit],
  );
  const messages = result.rows as NewMessage[];
  const newTimestamp =
    messages.length > 0
      ? messages[messages.length - 1].timestamp
      : lastTimestamp;
  return { messages, newTimestamp };
}

export async function pgGetMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  const result = await query(
    `SELECT chat_jid, sender_jid, sender_name, text, timestamp, message_id, is_group
     FROM chat_messages
     WHERE chat_jid = $1 AND timestamp > $2
       AND (sender_name IS NULL OR sender_name NOT LIKE $3)
     ORDER BY timestamp ASC LIMIT $4`,
    [chatJid, sinceTimestamp, `${botPrefix}%`, limit],
  );
  return result.rows as NewMessage[];
}

// ── Scheduled Tasks ──────────────────────────────────────

export async function pgGetTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const result = await query('SELECT * FROM scheduled_tasks WHERE id = $1', [
    id,
  ]);
  return result.rows[0] as ScheduledTask | undefined;
}

export async function pgGetTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  const result = await query(
    'SELECT * FROM scheduled_tasks WHERE group_folder = $1 ORDER BY created_at DESC',
    [groupFolder],
  );
  return result.rows as ScheduledTask[];
}

export async function pgGetAllTasks(): Promise<ScheduledTask[]> {
  const result = await query(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  return result.rows as ScheduledTask[];
}

export async function pgGetDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const result = await query(
    `SELECT * FROM scheduled_tasks
     WHERE status = 'active'
       AND (next_run IS NULL OR next_run <= $1)
     ORDER BY next_run ASC NULLS FIRST`,
    [now],
  );
  return result.rows as ScheduledTask[];
}

// ── Run Logs ──────────────────────────────────────────────

export async function pgGetRecentRunLogs(limit = 50): Promise<TaskRunLogRow[]> {
  const result = await query(
    'SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT $1',
    [limit],
  );
  return result.rows as TaskRunLogRow[];
}

export async function pgGetRunLogsForTask(
  taskId: string,
  limit = 20,
): Promise<TaskRunLogRow[]> {
  const result = await query(
    'SELECT * FROM task_run_logs WHERE task_id = $1 ORDER BY run_at DESC LIMIT $2',
    [taskId, limit],
  );
  return result.rows as TaskRunLogRow[];
}

// ── Router State ──────────────────────────────────────────

export async function pgGetRouterState(
  key: string,
): Promise<string | undefined> {
  const result = await query('SELECT value FROM router_state WHERE key = $1', [
    key,
  ]);
  return result.rows[0]?.value;
}

// ── Sessions ──────────────────────────────────────────────

export async function pgGetSession(
  groupFolder: string,
): Promise<string | undefined> {
  const result = await query(
    'SELECT session_id FROM sessions WHERE group_folder = $1',
    [groupFolder],
  );
  return result.rows[0]?.session_id;
}

export async function pgGetAllSessions(): Promise<Record<string, string>> {
  const result = await query('SELECT group_folder, session_id FROM sessions');
  const sessions: Record<string, string> = {};
  for (const row of result.rows) sessions[row.group_folder] = row.session_id;
  return sessions;
}

// ── Registered Groups ──────────────────────────────────────

export async function pgGetRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  const result = await query('SELECT * FROM registered_groups WHERE jid = $1', [
    jid,
  ]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger ?? true,
    isMain: row.is_main ?? false,
  };
}

export async function pgGetAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  const result = await query('SELECT * FROM registered_groups');
  const groups: Record<string, RegisteredGroup> = {};
  for (const row of result.rows) {
    groups[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger ?? true,
      isMain: row.is_main ?? false,
    };
  }
  return groups;
}
