import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import Database from "better-sqlite3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DB_PATHS: Record<string, string> = {
  ollama: `${process.env.HOME}/.defenseclaw/audit.db`,
  anthropic: `${process.env.HOME}/.dc-anthropic-home/.defenseclaw/audit.db`,
};

interface AuditRow {
  id: string;
  timestamp: string;
  action: string;
  target: string | null;
  actor: string;
  details: string | null;
  severity: string | null;
}

interface ActionRow {
  id: string;
  target_type: string;
  target_name: string;
  source_path: string | null;
  actions_json: string;
  reason: string | null;
  updated_at: string;
}

interface ScanRow {
  id: string;
  scanner: string;
  target: string;
  timestamp: string;
  duration_ms: number | null;
  finding_count: number | null;
  max_severity: string | null;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  action: string;
  target: string;
  actor: string;
  details: string;
  severity: string;
  instance: string;
}

export interface AuditAction {
  id: string;
  targetType: string;
  targetName: string;
  sourcePath: string;
  actions: Record<string, string>;
  reason: string;
  updatedAt: string;
  instance: string;
}

export interface AuditScan {
  id: string;
  scanner: string;
  target: string;
  timestamp: string;
  durationMs: number;
  findingCount: number;
  maxSeverity: string;
  instance: string;
}

/** Map DB severity to a normalized display severity */
export function normalizeSeverity(sev: string | null | undefined): string {
  if (!sev) return "INFO";
  const upper = sev.toUpperCase();
  switch (upper) {
    case "CRITICAL": return "CRITICAL";
    case "HIGH": return "HIGH";
    case "MEDIUM": return "MEDIUM";
    case "LOW": return "LOW";
    case "ERROR": return "ERROR";
    case "INFO": return "INFO";
    default: return "INFO";
  }
}

/** Convert UTC timestamp to America/Chicago 24h format */
export function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString("en-GB", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return ts;
  }
}

function openDb(instance: string): Database.Database | null {
  const dbPath = DB_PATHS[instance];
  if (!dbPath) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function queryEvents(db: Database.Database, limit: number, instance: string): AuditEvent[] {
  try {
    const rows = db.prepare(
      `SELECT id, timestamp, action, target, actor, details, severity
       FROM audit_events ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as AuditRow[];

    return rows.map((r) => ({
      id: r.id,
      timestamp: formatTimestamp(r.timestamp),
      action: r.action,
      target: r.target || "",
      actor: r.actor,
      details: r.details || "",
      severity: normalizeSeverity(r.severity),
      instance,
    }));
  } catch {
    return [];
  }
}

function queryActions(db: Database.Database, limit: number, instance: string): AuditAction[] {
  try {
    const rows = db.prepare(
      `SELECT id, target_type, target_name, source_path, actions_json, reason, updated_at
       FROM actions ORDER BY updated_at DESC LIMIT ?`
    ).all(limit) as ActionRow[];

    return rows.map((r) => {
      let actions: Record<string, string> = {};
      try { actions = JSON.parse(r.actions_json || "{}"); } catch { /* empty */ }
      return {
        id: r.id,
        targetType: r.target_type,
        targetName: r.target_name,
        sourcePath: r.source_path || "",
        actions,
        reason: r.reason || "",
        updatedAt: formatTimestamp(r.updated_at),
        instance,
      };
    });
  } catch {
    return [];
  }
}

function queryScans(db: Database.Database, limit: number, instance: string): AuditScan[] {
  try {
    const rows = db.prepare(
      `SELECT id, scanner, target, timestamp, duration_ms, finding_count, max_severity
       FROM scan_results ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as ScanRow[];

    return rows.map((r) => ({
      id: r.id,
      scanner: r.scanner,
      target: r.target,
      timestamp: formatTimestamp(r.timestamp),
      durationMs: r.duration_ms || 0,
      findingCount: r.finding_count || 0,
      maxSeverity: normalizeSeverity(r.max_severity),
      instance,
    }));
  } catch {
    return [];
  }
}

/**
 * GET /api/defenseclaw/audit
 *
 * Query params:
 *   limit     — max events per instance (default 50, max 200)
 *   instance  — "ollama" | "anthropic" (default: both)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limitParam = req.nextUrl.searchParams.get("limit");
  const instanceParam = req.nextUrl.searchParams.get("instance");

  const limit = Math.min(Math.max(parseInt(limitParam || "50", 10) || 50, 1), 200);
  const instances = instanceParam ? [instanceParam] : Object.keys(DB_PATHS);

  const events: AuditEvent[] = [];
  const actions: AuditAction[] = [];
  const scans: AuditScan[] = [];

  for (const inst of instances) {
    const db = openDb(inst);
    if (!db) continue;
    try {
      events.push(...queryEvents(db, limit, inst));
      actions.push(...queryActions(db, limit, inst));
      scans.push(...queryScans(db, limit, inst));
    } finally {
      db.close();
    }
  }

  // Sort combined results by timestamp descending
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  actions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  scans.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return NextResponse.json({ events, actions, scans });
}
