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

export interface EnforceRule {
  id: string;
  target_type: string;
  target_name: string;
  reason: string;
  updated_at: string;
}

export interface EnforceListResponse {
  instance: string;
  label: string;
  blocked: EnforceRule[];
  allowed: EnforceRule[];
  error?: string;
}

interface AddRuleBody {
  instance: string;
  action: "allow" | "block";
  target_type: string;
  target_name: string;
  reason: string;
}

interface DeleteRuleBody {
  instance: string;
  action: "allow" | "block";
  target_type: string;
  target_name: string;
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

// ── GET: fetch block/allow lists from all (or one) instances ──────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const instanceFilter = req.nextUrl.searchParams.get("instance");

  const results: EnforceListResponse[] = await Promise.all(
    DC_INSTANCES.filter((i) => !instanceFilter || i.id === instanceFilter).map(
      async (inst) => {
        try {
          const [blockedResp, allowedResp] = await Promise.all([
            fetchDcApi(inst, "/enforce/blocked"),
            fetchDcApi(inst, "/enforce/allowed"),
          ]);

          const blocked: EnforceRule[] = blockedResp.ok
            ? await blockedResp.json()
            : [];
          const allowed: EnforceRule[] = allowedResp.ok
            ? await allowedResp.json()
            : [];

          return {
            instance: inst.id,
            label: inst.label,
            blocked,
            allowed,
          };
        } catch (err) {
          return {
            instance: inst.id,
            label: inst.label,
            blocked: [],
            allowed: [],
            error: String(err),
          };
        }
      },
    ),
  );

  return NextResponse.json({ instances: results });
}

// ── POST: add a block or allow rule ──────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: AddRuleBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { instance, action, target_type, target_name, reason } = body;

  if (!instance || !action || !target_type || !target_name) {
    return NextResponse.json(
      {
        error:
          "instance, action (allow|block), target_type, and target_name are required",
      },
      { status: 400 },
    );
  }

  if (action !== "allow" && action !== "block") {
    return NextResponse.json(
      { error: 'action must be "allow" or "block"' },
      { status: 400 },
    );
  }

  const inst = findInstance(instance);
  if (!inst)
    return NextResponse.json(
      { error: "Unknown instance" },
      { status: 404 },
    );

  const endpoint =
    action === "allow" ? "/enforce/allow" : "/enforce/block";

  try {
    const resp = await fetchDcApi(inst, endpoint, {
      method: "POST",
      body: JSON.stringify({
        target_type,
        target_name,
        reason: reason || `${action}ed via dashboard`,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return NextResponse.json(
        { error: data.error || "DC API error" },
        { status: resp.status },
      );
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

// ── DELETE: remove a block or allow rule ──────────────────────
//
// DC's /enforce/block supports DELETE (calls Unblock which clears the install field).
// DC's /enforce/allow does NOT support DELETE natively, so for allow rules we
// send a DELETE to /enforce/block with the same target — Unblock clears the
// install field entirely, which removes both block and allow state.

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: DeleteRuleBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { instance, target_type, target_name } = body;

  if (!instance || !target_type || !target_name) {
    return NextResponse.json(
      { error: "instance, target_type, and target_name are required" },
      { status: 400 },
    );
  }

  const inst = findInstance(instance);
  if (!inst)
    return NextResponse.json(
      { error: "Unknown instance" },
      { status: 404 },
    );

  // DELETE /enforce/block clears the install action field (works for both block and allow)
  try {
    const resp = await fetchDcApi(inst, "/enforce/block", {
      method: "DELETE",
      body: JSON.stringify({ target_type, target_name }),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return NextResponse.json(
        { error: data.error || "DC API error" },
        { status: resp.status },
      );
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
