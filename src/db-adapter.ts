/**
 * Database adapter — wraps SQLite (db.ts) and PostgreSQL (pg-writes.ts).
 *
 * When DATA_BACKEND is:
 * - 'sqlite':   all reads and writes go to SQLite only (current behavior)
 * - 'dual':     writes go to BOTH SQLite and PostgreSQL; reads come from SQLite
 * - 'postgres': all reads and writes go to PostgreSQL only (future state)
 *
 * This adapter wraps the WRITE functions. Read functions still come directly
 * from db.ts (they'll be migrated in Phase 6 when we switch reads to PG).
 */
import { DATA_BACKEND } from './config.js';
import { logger } from './logger.js';
import * as sqlite from './db.js';
import * as pg from './pg-writes.js';
import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

const dual = DATA_BACKEND === 'dual' || DATA_BACKEND === 'postgres';

/** Fire-and-forget PG write — never blocks the SQLite path */
function pgWrite(fn: () => Promise<void>, label: string): void {
  if (!dual) return;
  fn().catch((err) => {
    logger.warn(`PG dual-write failed (${label}): ${err.message}`);
  });
}

// ── Re-export all READ functions directly from SQLite ──
// These will be swapped to PG reads in Phase 6
export {
  initDatabase,
  _initTestDatabase,
  getAllChats,
  getLastGroupSync,
  getNewMessages,
  getMessagesSince,
  getTaskById,
  getTasksForGroup,
  getAllTasks,
  getDueTasks,
  getRecentRunLogs,
  getRunLogsForTask,
  getRouterState,
  getSession,
  getAllSessions,
  getRegisteredGroup,
  getAllRegisteredGroups,
} from './db.js';

export type { ChatInfo, TaskRunLogRow } from './db.js';

// ── WRITE functions — dual-write when enabled ──────────

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  sqlite.storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
  pgWrite(
    () => pg.pgStoreChatMetadata(chatJid, timestamp, name, channel, isGroup),
    'storeChatMetadata',
  );
}

export function updateChatName(chatJid: string, name: string): void {
  sqlite.updateChatName(chatJid, name);
  pgWrite(() => pg.pgUpdateChatName(chatJid, name), 'updateChatName');
}

export function setLastGroupSync(): void {
  sqlite.setLastGroupSync();
  pgWrite(() => pg.pgSetLastGroupSync(), 'setLastGroupSync');
}

export function storeMessage(msg: NewMessage): void {
  sqlite.storeMessage(msg);
  pgWrite(() => pg.pgStoreMessage(msg), 'storeMessage');
}

export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  sqlite.storeMessageDirect(msg);
  pgWrite(() => pg.pgStoreMessage(msg as NewMessage), 'storeMessageDirect');
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'model'> & {
    model?: string | null;
  },
): void {
  sqlite.createTask(task);
  pgWrite(() => pg.pgCreateTask(task), 'createTask');
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  sqlite.updateTask(id, updates);
  pgWrite(() => pg.pgUpdateTask(id, updates), 'updateTask');
}

export function deleteTask(id: string): void {
  sqlite.deleteTask(id);
  pgWrite(() => pg.pgDeleteTask(id), 'deleteTask');
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  sqlite.updateTaskAfterRun(id, nextRun, lastResult);
  pgWrite(
    () => pg.pgUpdateTaskAfterRun(id, nextRun, lastResult),
    'updateTaskAfterRun',
  );
}

export function logTaskRun(log: TaskRunLog): void {
  sqlite.logTaskRun(log);
  pgWrite(() => pg.pgLogTaskRun(log), 'logTaskRun');
}

export function setRouterState(key: string, value: string): void {
  sqlite.setRouterState(key, value);
  pgWrite(() => pg.pgSetRouterState(key, value), 'setRouterState');
}

export function setSession(groupFolder: string, sessionId: string): void {
  sqlite.setSession(groupFolder, sessionId);
  pgWrite(() => pg.pgSetSession(groupFolder, sessionId), 'setSession');
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  sqlite.setRegisteredGroup(jid, group);
  pgWrite(() => pg.pgSetRegisteredGroup(jid, group), 'setRegisteredGroup');
}
