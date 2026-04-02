import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { execFileSync } from "child_process";
import { requireAuth } from "@/lib/require-auth";

// Computed at runtime — opaque to turbopack's static analysis
function getProjectRoot() {
  return process.env.NANOCLAW_ROOT || path.join(process.cwd(), "..");
}
const OLLAMA_URL = process.env.OLLAMA_URL || "http://studio.shearer.live:11434";

/**
 * GET /api/search?q=sustainability+strategy&limit=10&source=transcript
 *
 * Semantic search: embeds query via Ollama, searches SQLite-vec via subprocess.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const query = searchParams.get("q");
  const limit = parseInt(searchParams.get("limit") || "15", 10);
  const sourceFilter = searchParams.get("source") || "";

  if (!query) {
    return NextResponse.json({ error: "q parameter required" }, { status: 400 });
  }

  try {
    // Embed the query via Ollama
    const embedResp = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nomic-embed-text", input: query }),
    });
    const embedData = (await embedResp.json()) as { embeddings: number[][] };
    const queryVec = embedData.embeddings[0];

    // Run vector search via subprocess (native SQLite modules don't work in Turbopack)
    const root = getProjectRoot();
    const scriptPath = [root, "scripts", "vector-search.cjs"].join(path.sep);
    const result = execFileSync(
      "node",
      [scriptPath, JSON.stringify(queryVec), String(limit * 2), sourceFilter],
      { cwd: root, timeout: 10000, encoding: "utf-8" }
    );

    const results = JSON.parse(result).slice(0, limit);
    return NextResponse.json({ query, results, total: results.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
