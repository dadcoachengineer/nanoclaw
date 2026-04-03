import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import crypto from "crypto";
import fs from "fs";
import Database from "better-sqlite3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── DC instance definitions ──────────────────────

const DC_INSTANCES = [
  {
    id: "defenseclaw-ollama",
    label: "DefenseClaw Ollama",
    apiPort: 18790,
    dataDir: `${process.env.HOME}/.defenseclaw`,
  },
  {
    id: "defenseclaw-anthropic",
    label: "DefenseClaw Anthropic",
    apiPort: 18792,
    dataDir: `${process.env.HOME}/.dc-anthropic-home/.defenseclaw`,
  },
];

const DB_PATHS: Record<string, string> = {
  ollama: `${process.env.HOME}/.defenseclaw/audit.db`,
  anthropic: `${process.env.HOME}/.dc-anthropic-home/.defenseclaw/audit.db`,
};

// ── Types ──────────────────────

/** Matches DefenseClaw ToolInspectRequest in inspect.go */
export interface ToolInspectRequest {
  tool: string;
  args?: Record<string, unknown>;
  content?: string;
  direction?: "inbound" | "outbound";
}

/** Matches DefenseClaw RuleFinding in rules.go */
export interface DetailedFinding {
  rule_id: string;
  title: string;
  severity: string;
  confidence: number;
  evidence?: string;
  tags?: string[];
}

/** Matches DefenseClaw ToolInspectVerdict in inspect.go */
export interface ToolInspectVerdict {
  action: "allow" | "alert" | "block";
  severity: "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  reason: string;
  findings: string[];
  detailed_findings?: DetailedFinding[];
  mode: string;
}

/** Tool inspection event from audit_events table */
export interface ToolInspectEvent {
  id: string;
  timestamp: string;
  action: string;
  tool: string;
  severity: string;
  details: string;
  instance: string;
}

// ── Master key derivation ──────────────────────

function deriveMasterKey(dataDir: string): string {
  try {
    const keyData = fs.readFileSync(`${dataDir}/device.key`);
    const mac = crypto
      .createHmac("sha256", "defenseclaw-proxy-master-key")
      .update(keyData)
      .digest("hex");
    return "sk-dc-" + mac.slice(0, 32);
  } catch {
    return "";
  }
}

// ── Helpers ──────────────────────

function findInstance(id: string) {
  return DC_INSTANCES.find((i) => i.id === id);
}

async function fetchDcInspect(
  inst: (typeof DC_INSTANCES)[number],
  body: object,
): Promise<Response> {
  const clientKey = deriveMasterKey(inst.dataDir);
  return fetch(`http://127.0.0.1:${inst.apiPort}/api/v1/inspect/tool`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-DefenseClaw-Client": clientKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

/** Convert UTC timestamp to America/Chicago 24h format */
function formatTimestamp(ts: string): string {
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

/** Parse tool name and inspection details from audit event */
function parseInspectDetails(details: string): {
  severity: string;
  confidence: string;
  reason: string;
  elapsed: string;
  mode: string;
} {
  const severityMatch = /severity=(\S+)/.exec(details);
  const confidenceMatch = /confidence=(\S+)/.exec(details);
  const reasonMatch = /reason=(.+?)(?:\s+elapsed=|\s*$)/.exec(details);
  const elapsedMatch = /elapsed=(\S+)/.exec(details);
  const modeMatch = /mode=(\S+)/.exec(details);
  return {
    severity: severityMatch?.[1] || "NONE",
    confidence: confidenceMatch?.[1] || "0",
    reason: reasonMatch?.[1] || "",
    elapsed: elapsedMatch?.[1] || "",
    mode: modeMatch?.[1] || "observe",
  };
}

/**
 * GET /api/defenseclaw/tool-inspect
 *
 * Query recent tool inspection events from the audit DB.
 * Params:
 *   limit    - max events (default 50, max 200)
 *   instance - "ollama" | "anthropic" (default: both)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limitParam = req.nextUrl.searchParams.get("limit");
  const instanceParam = req.nextUrl.searchParams.get("instance");

  const limit = Math.min(Math.max(parseInt(limitParam || "50", 10) || 50, 1), 200);
  const instances = instanceParam ? [instanceParam] : Object.keys(DB_PATHS);

  const events: ToolInspectEvent[] = [];

  for (const inst of instances) {
    const db = openDb(inst);
    if (!db) continue;
    try {
      const rows = db
        .prepare(
          `SELECT id, timestamp, action, target, details, severity
           FROM audit_events
           WHERE action LIKE 'inspect-tool%'
           ORDER BY timestamp DESC
           LIMIT ?`,
        )
        .all(limit) as {
        id: string;
        timestamp: string;
        action: string;
        target: string | null;
        details: string | null;
        severity: string | null;
      }[];

      for (const r of rows) {
        const parsed = parseInspectDetails(r.details || "");
        events.push({
          id: r.id,
          timestamp: formatTimestamp(r.timestamp),
          action: r.action,
          tool: r.target || "",
          severity: parsed.severity,
          details: r.details || "",
          instance: inst,
        });
      }
    } finally {
      db.close();
    }
  }

  // Sort by timestamp descending
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Compute summary stats
  const total = events.length;
  const blocks = events.filter((e) => e.action === "inspect-tool-block").length;
  const alerts = events.filter((e) => e.action === "inspect-tool-alert").length;
  const allows = events.filter((e) => e.action === "inspect-tool-allow").length;

  return NextResponse.json({
    events: events.slice(0, limit),
    summary: { total, blocks, alerts, allows },
  });
}

/**
 * POST /api/defenseclaw/tool-inspect
 *
 * Proxy a tool inspection request to DefenseClaw's /api/v1/inspect/tool.
 *
 * Body:
 *   instance   - "defenseclaw-ollama" | "defenseclaw-anthropic" (default: ollama)
 *   tool       - tool name (required)
 *   args       - tool arguments object
 *   content    - message content (for outbound message inspection)
 *   direction  - "inbound" | "outbound"
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { instance: instanceId, tool, args, content, direction } = body;

  if (!tool) {
    return NextResponse.json({ error: "tool is required" }, { status: 400 });
  }

  const inst = findInstance(instanceId || "defenseclaw-ollama");
  if (!inst) {
    return NextResponse.json({ error: "unknown instance" }, { status: 404 });
  }

  try {
    const dcBody: Record<string, unknown> = { tool };
    if (args) dcBody.args = args;
    if (content) dcBody.content = content;
    if (direction) dcBody.direction = direction;

    const resp = await fetchDcInspect(inst, dcBody);
    const verdict = (await resp.json()) as ToolInspectVerdict;

    return NextResponse.json({
      instance: inst.id,
      label: inst.label,
      verdict,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `DefenseClaw unreachable: ${String(err)}` },
      { status: 502 },
    );
  }
}
