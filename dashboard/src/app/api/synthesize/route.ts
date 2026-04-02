import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/require-auth";
import { ollamaChat } from "@/lib/ollama-client";

const MODEL = "phi4:14b";

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

    const result = await ollamaChat({
      model: MODEL,
      messages: [{ role: "user", content: `/no_think\n${prompt}` }],
      options: { num_ctx: 4096 },
    });

    return NextResponse.json({ content: result.content });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
