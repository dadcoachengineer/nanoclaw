import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { execFileSync } from "child_process";

const PROJECT_ROOT = process.env.NANOCLAW_ROOT || path.join(process.cwd(), "..");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

/**
 * GET /api/search?q=sustainability+strategy&limit=10&source=transcript
 *
 * Semantic search: embeds query via Ollama, searches SQLite-vec via subprocess.
 */
export async function GET(req: NextRequest) {
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
    const result = execFileSync(
      "node",
      [
        path.join(PROJECT_ROOT, "scripts", "vector-search.cjs"),
        JSON.stringify(queryVec),
        String(limit * 2),
        sourceFilter,
      ],
      { cwd: PROJECT_ROOT, timeout: 10000, encoding: "utf-8" }
    );

    const results = JSON.parse(result).slice(0, limit);
    return NextResponse.json({ query, results, total: results.length });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
