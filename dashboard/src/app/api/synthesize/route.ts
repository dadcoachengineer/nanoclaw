import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://studio.shearer.live:11434";
const MODEL = "qwen3-coder:30b";

/**
 * POST /api/synthesize
 * Body: { prompt: string }
 * Runs a simple text synthesis task on the local Ollama model.
 * Used for merge synthesis, title cleanup, etc.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { prompt } = await req.json();
    if (!prompt) return NextResponse.json({ error: "prompt required" }, { status: 400 });

    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        options: { num_ctx: 4096 },
        messages: [{ role: "user", content: `/no_think\n${prompt}` }],
      }),
    });

    if (!resp.ok) {
      return NextResponse.json({ error: `Ollama returned ${resp.status}` }, { status: 502 });
    }

    const data = await resp.json();
    const content = data.message?.content || "";

    return NextResponse.json({ content });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
