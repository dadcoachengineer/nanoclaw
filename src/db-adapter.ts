/**
 * Database adapter — two databases with distinct roles:
 *
 * SQLite (messages.db): NanoClaw's internal message bus — chats, messages,
 * sessions, registered groups, router state. Synchronous, embedded, fast
 * for real-time message polling. Core process reads and writes here.
 *
 * PostgreSQL: Mission Control application database — tasks, people,
 * initiatives, artifacts, archive, vectors, triage. Dashboard reads
 * exclusively from here.
 *
 * Bridge: scheduled_tasks and task_run_logs write to BOTH — SQLite for
 * the core's internal scheduling, PG for dashboard visibility.
 *
 * DATA_BACKEND='dual' is the permanent architecture, not a migration state.
 */
import { DATA_BACKEND } from './config.js';
import { logger } from './logger.js';
import * as sqlite from './db.js';
import * as pg from './pg-writes.js';
import * as pgReads from './pg-reads.js';
import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

const usePg = DATA_BACKEND === 'postgres';
const dual = DATA_BACKEND === 'dual';

/** Fire-and-forget PG write — never blocks the SQLite path */
function pgWrite(fn: () => Promise<void>, label: string): void {
  fn().catch((err) => {
    logger.warn(`PG write failed (${label}): ${err.message}`);
  });
}

// ── Types ──────────────────────────────────────────────
// Define adapter-level types that are compatible with both SQLite and PG returns.
// SQLite uses number for booleans and non-nullable strings; PG uses real booleans
// and nullable strings. The union covers both.
export interface ChatInfo {
  jid: string;
  name: string | null;
  last_message_time: string;
  channel: string | null;
  is_group: boolean | number;
}

export interface TaskRunLogRow extends TaskRunLog {
  id?: number;
}

// ── Database init ──────────────────────────────────────
export function initDatabase(): void {
  // Always init SQLite — the framework's native db layer expects it to exist.
  // In postgres mode we don't write to it, but it prevents null reference
  // crashes if any code path reaches db.ts directly.
  sqlite.initDatabase();
}

export function _initTestDatabase(): void {
  sqlite._initTestDatabase();
}

// ── READ functions ──────────────────────────────────────
// When postgres: async PG reads
// When sqlite/dual: sync SQLite reads

export async function getAllChats(): Promise<ChatInfo[]> {
  if (usePg) return pgReads.pgGetAllChats();
  return sqlite.getAllChats();
}

export async function getLastGroupSync(): Promise<string | null> {
  if (usePg) return pgReads.pgGetLastGroupSync();
  return sqlite.getLastGroupSync();
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit?: number,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (usePg)
    return pgReads.pgGetNewMessages(jids, lastTimestamp, botPrefix, limit);
  return sqlite.getNewMessages(jids, lastTimestamp, botPrefix, limit);
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit?: number,
): Promise<NewMessage[]> {
  if (usePg)
    return pgReads.pgGetMessagesSince(
      chatJid,
      sinceTimestamp,
      botPrefix,
      limit,
    );
  return sqlite.getMessagesSince(chatJid, sinceTimestamp, botPrefix, limit);
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  if (usePg) return pgReads.pgGetTaskById(id);
  return sqlite.getTaskById(id);
}

export async function getTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  if (usePg) return pgReads.pgGetTasksForGroup(groupFolder);
  return sqlite.getTasksForGroup(groupFolder);
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  if (usePg) return pgReads.pgGetAllTasks();
  return sqlite.getAllTasks();
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  if (usePg) return pgReads.pgGetDueTasks();
  return sqlite.getDueTasks();
}

export async function getRecentRunLogs(
  limit?: number,
): Promise<TaskRunLogRow[]> {
  if (usePg) return pgReads.pgGetRecentRunLogs(limit);
  return sqlite.getRecentRunLogs(limit);
}

export async function getRunLogsForTask(
  taskId: string,
  limit?: number,
): Promise<TaskRunLogRow[]> {
  if (usePg) return pgReads.pgGetRunLogsForTask(taskId, limit);
  return sqlite.getRunLogsForTask(taskId, limit);
}

export async function getRouterState(key: string): Promise<string | undefined> {
  if (usePg) return pgReads.pgGetRouterState(key);
  return sqlite.getRouterState(key);
}

export async function getSession(
  groupFolder: string,
): Promise<string | undefined> {
  if (usePg) return pgReads.pgGetSession(groupFolder);
  return sqlite.getSession(groupFolder);
}

export async function getAllSessions(): Promise<Record<string, string>> {
  if (usePg) return pgReads.pgGetAllSessions();
  return sqlite.getAllSessions();
}

export async function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  if (usePg) return pgReads.pgGetRegisteredGroup(jid);
  return sqlite.getRegisteredGroup(jid);
}

export async function getAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  if (usePg) return pgReads.pgGetAllRegisteredGroups();
  return sqlite.getAllRegisteredGroups();
}

// ── WRITE functions ──────────────────────────────────────

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  if (!usePg)
    sqlite.storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
  if (usePg || dual)
    pgWrite(
      () => pg.pgStoreChatMetadata(chatJid, timestamp, name, channel, isGroup),
      'storeChatMetadata',
    );
}

export function updateChatName(chatJid: string, name: string): void {
  if (!usePg) sqlite.updateChatName(chatJid, name);
  if (usePg || dual)
    pgWrite(() => pg.pgUpdateChatName(chatJid, name), 'updateChatName');
}

export function setLastGroupSync(): void {
  if (!usePg) sqlite.setLastGroupSync();
  if (usePg || dual) pgWrite(() => pg.pgSetLastGroupSync(), 'setLastGroupSync');
}

export function storeMessage(msg: NewMessage): void {
  if (!usePg) sqlite.storeMessage(msg);
  if (usePg || dual) pgWrite(() => pg.pgStoreMessage(msg), 'storeMessage');
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
  if (!usePg) sqlite.storeMessageDirect(msg);
  if (usePg || dual)
    pgWrite(() => pg.pgStoreMessage(msg as NewMessage), 'storeMessageDirect');
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result' | 'model'> & {
    model?: string | null;
  },
): void {
  if (!usePg) sqlite.createTask(task);
  if (usePg || dual) pgWrite(() => pg.pgCreateTask(task), 'createTask');
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
  if (!usePg) sqlite.updateTask(id, updates);
  if (usePg || dual) pgWrite(() => pg.pgUpdateTask(id, updates), 'updateTask');
}

export function deleteTask(id: string): void {
  if (!usePg) sqlite.deleteTask(id);
  if (usePg || dual) pgWrite(() => pg.pgDeleteTask(id), 'deleteTask');
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  if (!usePg) sqlite.updateTaskAfterRun(id, nextRun, lastResult);
  if (usePg || dual)
    pgWrite(
      () => pg.pgUpdateTaskAfterRun(id, nextRun, lastResult),
      'updateTaskAfterRun',
    );
}

export function logTaskRun(log: TaskRunLog): void {
  if (!usePg) sqlite.logTaskRun(log);
  if (usePg || dual) pgWrite(() => pg.pgLogTaskRun(log), 'logTaskRun');
}

export function setRouterState(key: string, value: string): void {
  if (!usePg) sqlite.setRouterState(key, value);
  if (usePg || dual)
    pgWrite(() => pg.pgSetRouterState(key, value), 'setRouterState');
}

export function setSession(groupFolder: string, sessionId: string): void {
  if (!usePg) sqlite.setSession(groupFolder, sessionId);
  if (usePg || dual)
    pgWrite(() => pg.pgSetSession(groupFolder, sessionId), 'setSession');
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!usePg) sqlite.setRegisteredGroup(jid, group);
  if (usePg || dual)
    pgWrite(() => pg.pgSetRegisteredGroup(jid, group), 'setRegisteredGroup');
}
