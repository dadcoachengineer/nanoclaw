import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import crypto from "crypto";
import fs from "fs";

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

// ── Types ──────────────────────

export interface MCPServerEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: string;
}

export interface Finding {
  id: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  description: string;
  location: string;
  remediation: string;
  scanner: string;
  tags?: string[];
}

export interface ScanResult {
  scanner: string;
  target: string;
  timestamp: string;
  findings: Finding[];
  duration: number; // nanoseconds
}

export interface SkillInfo {
  name: string;
  path: string;
  status?: string;
  lastScan?: ScanResult | null;
}

export interface ScannerInstanceData {
  id: string;
  label: string;
  skills: SkillInfo[];
  mcpServers: MCPServerEntry[];
  toolCatalog: { count: number; error?: string };
  error?: string;
}

export interface ScannersResponse {
  instances: ScannerInstanceData[];
  containerSkills: { name: string; path: string }[];
  notes: string[];
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

async function fetchDcApi(
  inst: (typeof DC_INSTANCES)[number],
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const clientKey = deriveMasterKey(inst.dataDir);
  return fetch(`http://127.0.0.1:${inst.apiPort}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-DefenseClaw-Client": clientKey,
      ...options?.headers,
    },
    signal: AbortSignal.timeout(5000),
  });
}

function findInstance(id: string) {
  return DC_INSTANCES.find((i) => i.id === id);
}

// Discover container skills from NanoClaw's container/skills directory
function getContainerSkills(): { name: string; path: string }[] {
  const containerSkillsDir = `${process.env.HOME}/nanoclaw/container/skills`;
  try {
    const entries = fs.readdirSync(containerSkillsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        path: `${containerSkillsDir}/${e.name}`,
      }));
  } catch {
    return [];
  }
}

// ── GET: fetch skill/MCP scan status from both DC instances ──────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const instanceFilter = req.nextUrl.searchParams.get("instance");

  const instances: ScannerInstanceData[] = await Promise.all(
    DC_INSTANCES
      .filter((i) => !instanceFilter || i.id === instanceFilter)
      .map(async (inst) => {
        const result: ScannerInstanceData = {
          id: inst.id,
          label: inst.label,
          skills: [],
          mcpServers: [],
          toolCatalog: { count: 0 },
        };

        // Fetch skills, MCPs, and tool catalog in parallel
        const [skillsRes, mcpsRes, toolsRes] = await Promise.allSettled([
          fetchDcApi(inst, "/skills").then((r) => r.json()),
          fetchDcApi(inst, "/mcps").then((r) => r.json()),
          fetchDcApi(inst, "/tools/catalog").then((r) => r.json()),
        ]);

        // Parse skills
        if (skillsRes.status === "fulfilled") {
          const data = skillsRes.value;
          if (Array.isArray(data)) {
            result.skills = data.map((s: any) => ({
              name: s.name || s.skill_key || "unknown",
              path: s.path || s.target || "",
              status: s.status || "discovered",
              lastScan: s.last_scan || s.lastScan || null,
            }));
          } else if (data?.error) {
            // Gateway not connected -- skills endpoint requires websocket to gateway
            result.error = data.error;
          }
        }

        // Parse MCP servers
        if (mcpsRes.status === "fulfilled") {
          const data = mcpsRes.value;
          if (Array.isArray(data)) {
            result.mcpServers = data.map((m: any) => ({
              name: m.name,
              command: m.command,
              args: m.args,
              env: m.env,
              url: m.url,
              transport: m.transport,
            }));
          }
        }

        // Parse tool catalog
        if (toolsRes.status === "fulfilled") {
          const data = toolsRes.value;
          if (data?.error) {
            result.toolCatalog = { count: 0, error: data.error };
          } else if (Array.isArray(data)) {
            result.toolCatalog = { count: data.length };
          } else if (typeof data === "object" && data !== null) {
            // Tool catalog might be an object with tools array or count
            const tools = data.tools || data.catalog || [];
            result.toolCatalog = { count: Array.isArray(tools) ? tools.length : 0 };
          }
        }

        return result;
      }),
  );

  const containerSkills = getContainerSkills();

  // Build notes about configuration gaps
  const notes: string[] = [];

  // Check if watcher has skills directories configured
  const watcherSkillsDirs = [
    `${process.env.HOME}/.openclaw/skills`,
    `${process.env.HOME}/.openclaw/extensions`,
  ];
  for (const dir of watcherSkillsDirs) {
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(dir);
        if (entries.length === 0) {
          notes.push(`Watcher directory ${dir} exists but is empty -- skills installed here will be auto-scanned`);
        }
      }
    } catch {
      notes.push(`Watcher directory ${dir} does not exist -- create it for auto-scanning of new skill installs`);
    }
  }

  // Check if any instance has "gateway not connected" error (skills endpoint needs websocket)
  const gwNotConnected = instances.some((i) => i.error?.includes("not connected"));
  if (gwNotConnected) {
    notes.push(
      "Skills endpoint requires the gateway websocket (OpenClaw). " +
      "MCP servers and scan triggers work independently via the management API."
    );
  }

  // Advise on MCP server registration
  if (instances.every((i) => i.mcpServers.length === 0)) {
    notes.push(
      "No MCP servers registered with DefenseClaw. NanoClaw's MCP servers (Home Assistant, Gmail, " +
      "Google Calendar, Canva, Sentry, Vercel) are configured in Claude Code settings, not in DC. " +
      "To register them for scanning, add their configs to openclaw.json under mcp.servers or use " +
      "'defenseclaw mcp set <name> --command <cmd> [--args ...]'"
    );
  }

  // Note about container skills not being auto-watched
  if (containerSkills.length > 0) {
    notes.push(
      `${containerSkills.length} container skills found (${containerSkills.map((s) => s.name).join(", ")}). ` +
      "These are loaded inside agent containers at runtime and can be scanned via POST /v1/skill/scan."
    );
  }

  const response: ScannersResponse = { instances, containerSkills, notes };
  return NextResponse.json(response);
}

// ── POST: trigger a scan of a specific skill or MCP server ──────────────────────

interface ScanRequest {
  instance: string;
  type: "skill" | "mcp";
  target: string;
  name?: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: ScanRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.instance) return NextResponse.json({ error: "instance is required" }, { status: 400 });
  if (!body.type || !["skill", "mcp"].includes(body.type)) {
    return NextResponse.json({ error: "type must be 'skill' or 'mcp'" }, { status: 400 });
  }
  if (!body.target) return NextResponse.json({ error: "target is required" }, { status: 400 });

  const inst = findInstance(body.instance);
  if (!inst) return NextResponse.json({ error: "Unknown instance" }, { status: 404 });

  const endpoint = body.type === "skill" ? "/v1/skill/scan" : "/v1/mcp/scan";

  try {
    const resp = await fetchDcApi(inst, endpoint, {
      method: "POST",
      body: JSON.stringify({ target: body.target, name: body.name || "" }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return NextResponse.json(
        { error: data.error || `Scan failed (${resp.status})`, status: resp.status },
        { status: resp.status },
      );
    }

    return NextResponse.json({
      ok: true,
      result: data,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
