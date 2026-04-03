import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import fs from "fs";

const CACHE_PATH = "/tmp/nanoclaw-platform-health.json";
const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

interface HealthReport {
  status: "healthy" | "degraded" | "critical";
  timestamp: string;
  checks: CheckResult[];
  summary: { pass: number; fail: number; warn: number };
}

function readCache(): HealthReport | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const stat = fs.statSync(CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > CACHE_MAX_AGE_MS) return null;

    const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")) as HealthReport;
    // Validate shape
    if (!data.status || !data.timestamp || !Array.isArray(data.checks)) return null;
    return data;
  } catch {
    return null;
  }
}

async function runHealthTest(): Promise<HealthReport> {
  try {
    const { execSync } = await import("child_process");
    const output = execSync(
      "npx tsx /Users/nanoclaw/nanoclaw/scripts/platform-health-test.ts",
      {
        timeout: 120_000,
        encoding: "utf-8",
        cwd: "/Users/nanoclaw/nanoclaw",
        env: { ...process.env, HOME: "/Users/nanoclaw" },
      },
    );
    return JSON.parse(output) as HealthReport;
  } catch (err: unknown) {
    // The script may have exited non-zero (degraded/critical) but still produced JSON on stdout
    if (err && typeof err === "object" && "stdout" in err) {
      const stdout = (err as { stdout: string }).stdout;
      try {
        return JSON.parse(stdout) as HealthReport;
      } catch {
        // fall through
      }
    }
    return {
      status: "critical",
      timestamp: new Date().toISOString(),
      checks: [
        {
          name: "Health Test Runner",
          status: "fail",
          message: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: 0,
        },
      ],
      summary: { pass: 0, fail: 1, warn: 0 },
    };
  }
}

/**
 * GET /api/platform-health — returns cached platform health or runs a fresh check.
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Try cache first
  const cached = readCache();
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  // Run fresh check
  const report = await runHealthTest();
  return NextResponse.json({ ...report, cached: false });
}
