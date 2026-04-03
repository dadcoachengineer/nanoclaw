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

// Convert HH:MM:SS from UTC to America/Chicago (Central Time), 24h format
function utcToCentral(hhmmss: string): string {
  const [h, m, s] = hhmmss.split(":").map(Number);
  const now = new Date();
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, s));
  return utc.toLocaleTimeString("en-GB", { timeZone: "America/Chicago", hour12: false });
}

interface Verdict {
  time: string;
  direction: string;
  model: string;
  severity: string;
  verdictAction?: string;
  verdictMatch?: string;
  judgeFindings?: string[];
  tokens?: string;
  latency?: string;
  messages?: number;
  contentChars?: number;
  preview?: string;
  fullContent?: string;
  source?: string;
}

// Infer pipeline source from system prompt or user content patterns
function inferSource(lines: string[], startIdx: number): string | undefined {
  for (let j = startIdx + 1; j < Math.min(startIdx + 6, lines.length); j++) {
    const line = lines[j].trim();
    if (line.includes("analyze Webex messages")) return "Webex Msgs";
    if (line.includes("extract action items from meeting transcripts") || line.includes("action items from meeting transcript")) return "Transcripts";
    if (line.includes("analyze meeting recordings")) return "Plaud";
    if (line.includes("analyze a week of calendar")) return "Calendar";
    if (line.includes("Meeting Prep Agent") || line.includes("meeting prep")) return "Meeting Prep";
    if (line.includes("Morning Briefing") || line.includes("morning briefing")) return "Briefing";
    if (line.includes("Read this handwritten note")) return "Boox OCR";
    if (line.includes("analyze Gmail") || line.includes("analyze email") || line.includes("Gmail")) return "Gmail";
    if (line.includes("research") || line.includes("Research")) return "Research";
    if (/\[0\] system \(28 chars\)/.test(line)) return "Ad-hoc";
  }
  return undefined;
}

// Parse recent verdicts from DefenseClaw gateway log
async function parseRecentVerdicts(logFile: string, limit = 100): Promise<Verdict[]> {
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
    // Content lines: [0] user (12087 chars): <content...>
    const contentHeaderRe = /\[(\d+)\]\s+(user|system|assistant)\s+\((\d+)\s+chars?\):\s*(.*)/;

    for (let i = 0; i < lines.length; i++) {
      const m = callRe.exec(lines[i]);
      if (!m) continue;
      const [, time, direction, model, rest] = m;

      const tokenMatch = /in=(\d+)\s+out=(\d+)/.exec(rest);
      const latencyMatch = /(\d+m?s)$/.exec(rest.trim());
      const msgMatch = msgCountRe.exec(rest);

      // Scan next lines for verdict, content, and context
      let severity = "NONE";
      let verdictAction: string | undefined;
      let verdictMatch: string | undefined;
      const judgeFindings: string[] = [];
      let preview: string | undefined;
      let contentChars = 0;
      const contentLines: string[] = [];

      for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
        const line = lines[j].trim();

        // Verdict line: verdict: MEDIUM  action=alert  matched: bearer
        const vm = verdictRe.exec(line);
        if (vm) {
          severity = vm[1];
          verdictAction = vm[2];
          const detail = vm[3]?.trim() || "";
          // Parse judge findings: "matched: bearer; judge-injection: Context Manipulation: ..."
          const parts = detail.split(/;\s*/);
          for (const part of parts) {
            if (part.startsWith("judge-")) {
              judgeFindings.push(part.replace(/^judge-\w+:\s*/, ""));
            } else if (part.startsWith("matched:")) {
              verdictMatch = part;
            } else if (part && !verdictMatch) {
              verdictMatch = part;
            }
          }
          break;
        }

        // Content header: [0] user (12087 chars): <system-reminder>
        const ch = contentHeaderRe.exec(line);
        if (ch) {
          const [, idx, role, chars, text] = ch;
          contentChars += parseInt(chars);
          const prefix = `[${role}] `;
          contentLines.push(prefix + text);
          if (!preview || preview.startsWith("<")) {
            preview = text.startsWith("<") ? `[${role}] ${text.substring(0, 80)}` : text.substring(0, 80);
          }
          // Capture continuation lines (indented content after the header)
          for (let k = j + 1; k < Math.min(j + 6, lines.length); k++) {
            const cont = lines[k];
            // Continuation lines are indented (start with spaces) and not a new section
            if (cont.startsWith("  ") && !cont.trim().startsWith("[") && !cont.trim().startsWith("verdict")) {
              contentLines.push(cont.trim());
            } else {
              break;
            }
          }
          continue;
        }

        // Response line: response (261 chars): {"task": ...}
        if (direction === "POST-CALL") {
          const rm = responseRe.exec(line);
          if (rm) {
            contentChars = parseInt(rm[1]);
            contentLines.push(rm[2]);
            if (!preview) preview = rm[2].substring(0, 80);
            // Capture continuation
            for (let k = j + 1; k < Math.min(j + 4, lines.length); k++) {
              if (lines[k].startsWith("  ") && !lines[k].trim().startsWith("verdict")) {
                contentLines.push(lines[k].trim());
              } else break;
            }
          }
        }
      }

      const source = direction === "PRE-CALL" ? inferSource(lines, i) : undefined;
      entries.push({
        time: utcToCentral(time),
        direction: direction === "PRE-CALL" ? "prompt" : "completion",
        model,
        severity,
        verdictAction,
        verdictMatch,
        judgeFindings: judgeFindings.length > 0 ? judgeFindings : undefined,
        tokens: tokenMatch ? `${tokenMatch[1]}/${tokenMatch[2]}` : undefined,
        latency: latencyMatch ? latencyMatch[1] : undefined,
        messages: msgMatch ? parseInt(msgMatch[1]) : undefined,
        contentChars: contentChars || undefined,
        preview: preview || (verdictAction === "block" ? `BLOCKED: ${verdictMatch}` : undefined),
        fullContent: contentLines.length > 0 ? contentLines.join("\n") : undefined,
        source,
      });
    }
    // Propagate source from PRE-CALL to the following POST-CALL (they come in pairs)
    let lastSource: string | undefined;
    for (const e of entries) {
      if (e.direction === "prompt" && e.source) lastSource = e.source;
      else if (e.direction === "completion" && !e.source && lastSource) e.source = lastSource;
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
