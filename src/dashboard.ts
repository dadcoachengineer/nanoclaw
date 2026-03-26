/**
 * Local Mission Control dashboard.
 * Serves a personal command center at / and system diagnostics at /system.
 * Proxies Notion and Webex API requests with caching.
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { URL } from 'url';
import { fileURLToPath } from 'url';

import { DASHBOARD_PORT, STORE_DIR, TIMEZONE } from './config.js';
import {
  getAllTasks,
  getTaskById,
  getRecentRunLogs,
  getRunLogsForTask,
  getAllRegisteredGroups,
} from './db.js';
import { logger } from './logger.js';
import type { GroupQueue } from './group-queue.js';
import type { RegisteredGroup } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DashboardDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  startedAt: Date;
}

let server: http.Server | null = null;

// --- Simple response helpers ---

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// --- API proxy cache ---

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 60_000; // 1 minute

function getCached(key: string): unknown | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}

// --- External API proxy helpers ---

function getWebexToken(): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'webex-oauth.json'), 'utf-8'));
    return config.access_token;
  } catch {
    return null;
  }
}

function getNotionToken(): string | null {
  // Read from OneCLI secret store — but we don't have direct access.
  // The Notion token is managed by OneCLI. For the dashboard proxy,
  // we'll read it from a local cache file if available.
  try {
    const config = JSON.parse(fs.readFileSync(path.join(STORE_DIR, 'notion-token.json'), 'utf-8'));
    return config.token;
  } catch {
    return null;
  }
}

function proxyRequest(
  url: string,
  headers: Record<string, string>,
  method = 'GET',
  body?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        ...headers,
        'Accept': 'application/json',
      },
    };
    const req = https.request(opts, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      proxyRes.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Request body reader ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
  });
}

// --- API handler ---

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  searchParams: URLSearchParams,
  deps: DashboardDependencies,
): Promise<void> {
  // === System endpoints ===

  if (pathname === '/api/health') {
    const groups = deps.registeredGroups();
    const queueStatus = deps.queue.getStatus();
    return json(res, {
      status: 'ok',
      uptime: Math.floor((Date.now() - deps.startedAt.getTime()) / 1000),
      timezone: TIMEZONE,
      groups: Object.keys(groups).length,
      containers: queueStatus,
    });
  }

  if (pathname === '/api/tasks') {
    const tasks = getAllTasks();
    const status = searchParams.get('status');
    const filtered = status ? tasks.filter((t) => t.status === status) : tasks;
    return json(res, filtered.map((t) => ({
      id: t.id, group_folder: t.group_folder, schedule_type: t.schedule_type,
      schedule_value: t.schedule_value, status: t.status, next_run: t.next_run,
      last_run: t.last_run, last_result: t.last_result, context_mode: t.context_mode,
      created_at: t.created_at,
    })));
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const task = getTaskById(taskMatch[1]);
    if (!task) return json(res, { error: 'Not found' }, 404);
    return json(res, task);
  }

  const runsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/runs$/);
  if (runsMatch) {
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    return json(res, getRunLogsForTask(runsMatch[1], limit));
  }

  if (pathname === '/api/runs/recent') {
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    return json(res, getRecentRunLogs(limit));
  }

  if (pathname === '/api/groups') {
    return json(res, getAllRegisteredGroups());
  }

  if (pathname === '/api/stats') {
    const tasks = getAllTasks();
    const runs = getRecentRunLogs(100);
    const today = new Date().toISOString().slice(0, 10);
    const todayRuns = runs.filter((r) => r.run_at.startsWith(today));
    return json(res, {
      tasks: { total: tasks.length, active: tasks.filter((t) => t.status === 'active').length, paused: tasks.filter((t) => t.status === 'paused').length },
      runs: { today: todayRuns.length, success: todayRuns.filter((r) => r.status === 'success').length, error: todayRuns.filter((r) => r.status === 'error').length },
      containers: deps.queue.getStatus(),
    });
  }

  // === Webex proxy ===

  if (pathname === '/api/webex/meetings') {
    const from = searchParams.get('from') || '';
    const to = searchParams.get('to') || '';
    const cacheKey = `webex:meetings:${from}:${to}`;
    const cached = getCached(cacheKey);
    if (cached) return json(res, cached);

    const token = getWebexToken();
    if (!token) return json(res, { error: 'Webex token not configured' }, 500);

    try {
      const data = await proxyRequest(
        `https://webexapis.com/v1/meetings?from=${from}&to=${to}&max=50&meetingType=scheduledMeeting`,
        { Authorization: `Bearer ${token}` },
      );
      setCache(cacheKey, data);
      return json(res, data);
    } catch (err) {
      return json(res, { error: String(err) }, 502);
    }
  }

  // === Notion proxy ===

  if (pathname === '/api/notion/query' && req.method === 'POST') {
    const token = getNotionToken();
    if (!token) return json(res, { error: 'Notion token not configured — create store/notion-token.json with {"token":"secret_xxx"}' }, 500);

    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const dbId = parsed.database_id;
      const cacheKey = `notion:query:${JSON.stringify(parsed)}`;
      const cached = getCached(cacheKey);
      if (cached) return json(res, cached);

      const data = await proxyRequest(
        `https://api.notion.com/v1/databases/${dbId}/query`,
        {
          Authorization: `Bearer ${token}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        'POST',
        JSON.stringify({ filter: parsed.filter, sorts: parsed.sorts }),
      );
      setCache(cacheKey, data);
      return json(res, data);
    } catch (err) {
      return json(res, { error: String(err) }, 502);
    }
  }

  json(res, { error: 'Not found' }, 404);
}

// --- Server ---

export function startDashboard(deps: DashboardDependencies): http.Server {
  const commandCenterPath = path.join(__dirname, 'dashboard', 'command-center.html');
  // System dashboard is inline (already built)
  const systemDashboardPath = path.join(__dirname, 'dashboard', 'system.html');

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${DASHBOARD_PORT}`);
    const { pathname, searchParams } = url;

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, pathname, searchParams, deps);
      } catch (err) {
        logger.error({ err, pathname }, 'Dashboard API error');
        json(res, { error: 'Internal error' }, 500);
      }
    } else if (pathname === '/' || pathname === '/index.html') {
      serveFile(res, commandCenterPath, 'text/html; charset=utf-8');
    } else if (pathname === '/system') {
      serveFile(res, systemDashboardPath, 'text/html; charset=utf-8');
    } else {
      json(res, { error: 'Not found' }, 404);
    }
  });

  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard started');
  });

  return server;
}

export function stopDashboard(): void {
  server?.close();
}
