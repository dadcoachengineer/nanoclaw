import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { getFirewallStatus, updateFirewallEnabled } from "@/lib/defenseclaw-firewall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/defenseclaw/firewall
 *
 * Returns the INTENDED firewall state from ~/.defenseclaw/firewall.yaml
 * plus a best-effort check on whether pfctl rules are actually loaded.
 *
 * Response shape:
 * {
 *   configured: boolean,
 *   enforced: boolean,          // true if pfctl anchor has rules loaded
 *   configPath: string,
 *   defaultAction: "deny" | "allow",
 *   ruleCount: number,          // deny rules + allowlist entries
 *   allowedDomains: string[],
 *   allowedIPs: string[],
 *   allowedPorts: number[],
 *   denyRules: Array<{ name, destination, action }>,
 *   loggingEnabled: boolean,
 *   error?: string
 * }
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const status = await getFirewallStatus();
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { configured: false, enforced: false, error: String(err) },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/defenseclaw/firewall
 *
 * Toggle the firewall config between enabled (deny-by-default) and disabled (allow-all).
 * This updates the YAML config file only — it does NOT activate pfctl rules.
 * Enforcement requires a manual `sudo pfctl -a com.defenseclaw -f ...` step.
 *
 * Body: { enabled: boolean }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled (boolean) required" }, { status: 400 });
    }

    const updated = updateFirewallEnabled(body.enabled);
    if (!updated) {
      return NextResponse.json(
        { error: "Failed to update firewall config. File may not exist or is not writable." },
        { status: 500 },
      );
    }

    const status = await getFirewallStatus();
    return NextResponse.json({ ok: true, ...status });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
