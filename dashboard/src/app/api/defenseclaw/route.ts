import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DC_INSTANCES = [
  { id: "defenseclaw-ollama", label: "DefenseClaw Ollama", apiPort: 18790, guardPort: 9001, logFile: `${process.env.HOME}/.defenseclaw/gateway.log` },
  { id: "defenseclaw-anthropic", label: "DefenseClaw Anthropic", apiPort: 18792, guardPort: 9002, logFile: `${process.env.HOME}/nanoclaw/logs/defenseclaw-anthropic.error.log` },
];

// Strip ANSI escape codes
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

interface Verdict {
  time: string;
  direction: string;
  model: string;
  severity: string;
  tokens?: string;
  latency?: string;
  messages?: number;
  preview?: string;
}

// Parse recent verdicts from DefenseClaw gateway log
async function parseRecentVerdicts(logFile: string, limit = 30): Promise<Verdict[]> {
  const fs = await import("fs");
  try {
    const raw = fs.readFileSync(logFile, "utf-8");
    const lines = stripAnsi(raw).split("\n");

    const entries: Verdict[] = [];
    // PRE-CALL:  [03:11:28] PRE-CALL  model=gemma3:27b  messages=2  0ms
    // POST-CALL: [03:11:28] POST-CALL  model=gemma3:27b  in=452 out=74  0ms
    const callRe = /\[(\d{2}:\d{2}:\d{2})\]\s+(PRE-CALL|POST-CALL)\s+model=(\S+)\s+(.*)/;
    const verdictRe = /verdict:\s+(\S+)(?:\s+action=(\S+))?\s*(.*)/;
    const msgCountRe = /messages=(\d+)/;
    const responseRe = /response\s+\((\d+)\s+chars?\):\s*(.*)/;
    const userContentRe = /\[\d+\]\s+user\s+\(\d+\s+chars?\):\s*(.*)/;

    for (let i = 0; i < lines.length; i++) {
      const m = callRe.exec(lines[i]);
      if (!m) continue;
      const [, time, direction, model, rest] = m;

      const tokenMatch = /in=(\d+)\s+out=(\d+)/.exec(rest);
      const latencyMatch = /(\d+m?s)$/.exec(rest.trim());
      const msgMatch = msgCountRe.exec(rest);

      // Scan next lines for verdict, content preview
      let severity = "NONE";
      let action: string | undefined;
      let reason: string | undefined;
      let preview: string | undefined;

      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const line = lines[j].trim();
        const vm = verdictRe.exec(line);
        if (vm) {
          severity = vm[1];
          action = vm[2];
          reason = vm[3] || undefined;
          break;
        }
        // Capture user content from PRE-CALL or response from POST-CALL
        if (direction === "PRE-CALL" && !preview) {
          const um = userContentRe.exec(line);
          if (um) preview = um[1].substring(0, 80);
        }
        if (direction === "POST-CALL" && !preview) {
          const rm = responseRe.exec(line);
          if (rm) preview = rm[2].substring(0, 80);
        }
      }

      entries.push({
        time,
        direction: direction === "PRE-CALL" ? "prompt" : "completion",
        model,
        severity,
        tokens: tokenMatch ? `${tokenMatch[1]}/${tokenMatch[2]}` : undefined,
        latency: latencyMatch ? latencyMatch[1] : undefined,
        messages: msgMatch ? parseInt(msgMatch[1]) : undefined,
        preview: preview || (action === "block" ? `BLOCKED: ${reason}` : undefined),
      });
    }
    return entries.slice(-limit);
  } catch { return []; }
}

// Derive master key from device key (same as Go's deriveMasterKey)
async function deriveMasterKey(dataDir: string): Promise<string> {
  const fs = await import("fs");
  const crypto = await import("crypto");
  try {
    const keyData = fs.readFileSync(`${dataDir}/device.key`);
    const mac = crypto.createHmac("sha256", "defenseclaw-proxy-master-key").update(keyData).digest("hex");
    return "sk-dc-" + mac.slice(0, 32);
  } catch { return ""; }
}

/**
 * GET /api/defenseclaw — get status + recent verdicts for all instances
 * GET /api/defenseclaw?instance=defenseclaw-ollama — single instance
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const instanceFilter = req.nextUrl.searchParams.get("instance");

  const instances = await Promise.all(
    DC_INSTANCES
      .filter((i) => !instanceFilter || i.id === instanceFilter)
      .map(async (inst) => {
        try {
          const [statusResp, healthResp] = await Promise.all([
            fetch(`http://127.0.0.1:${inst.apiPort}/status`, { signal: AbortSignal.timeout(3000) }),
            fetch(`http://127.0.0.1:${inst.guardPort}/health/liveliness`, { signal: AbortSignal.timeout(3000) }),
          ]);

          const status = await statusResp.json() as any;
          const health = await healthResp.json() as any;
          const guardrail = status.health?.guardrail || {};

          const verdicts = await parseRecentVerdicts(inst.logFile);
          return {
            id: inst.id,
            label: inst.label,
            healthy: health.status === "healthy",
            mode: guardrail.details?.mode || "unknown",
            scannerMode: guardrail.details?.scanner_mode || "local",
            port: guardrail.details?.port || inst.guardPort,
            uptime: status.health?.uptime_ms ? Math.round(status.health.uptime_ms / 1000) : 0,
            state: guardrail.state || "unknown",
            verdicts,
          };
        } catch {
          return {
            id: inst.id, label: inst.label, healthy: false,
            mode: "unknown", port: inst.guardPort, uptime: 0, state: "down",
          };
        }
      })
  );

  return NextResponse.json({ instances });
}

/**
 * PATCH /api/defenseclaw — update DefenseClaw config
 * Body: { instance: string, mode?: "observe" | "action" }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { instance, mode } = await req.json();
  if (!instance) return NextResponse.json({ error: "instance required" }, { status: 400 });

  const inst = DC_INSTANCES.find((i) => i.id === instance);
  if (!inst) return NextResponse.json({ error: "unknown instance" }, { status: 404 });

  // Determine data dir for this instance
  const dataDir = inst.id === "defenseclaw-ollama"
    ? `${process.env.HOME}/.defenseclaw`
    : `${process.env.HOME}/.dc-anthropic-home/.defenseclaw`;

  const clientKey = await deriveMasterKey(dataDir);

  try {
    const body: Record<string, string> = {};
    if (mode) body.mode = mode;

    const resp = await fetch(`http://127.0.0.1:${inst.apiPort}/v1/guardrail/config`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-DefenseClaw-Client": clientKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    const data = await resp.json() as any;
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
