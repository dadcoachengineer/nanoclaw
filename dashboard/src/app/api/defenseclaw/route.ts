import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DC_INSTANCES = [
  { id: "defenseclaw-ollama", label: "DC Ollama", apiPort: 18790, guardPort: 9001 },
  { id: "defenseclaw-anthropic", label: "DC Anthropic", apiPort: 18792, guardPort: 9002 },
];

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

          return {
            id: inst.id,
            label: inst.label,
            healthy: health.status === "healthy",
            mode: guardrail.details?.mode || "unknown",
            port: guardrail.details?.port || inst.guardPort,
            uptime: status.health?.uptime_ms ? Math.round(status.health.uptime_ms / 1000) : 0,
            state: guardrail.state || "unknown",
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
