---
name: Local Model Routing
description: Ollama shim for local inference — Cisco GREEN models only (gemma3:27b, phi4:14b, granite3.3:8b) on Mac Studio at studio.shearer.live:11434
type: project
---

Local model routing via Anthropic-to-Ollama translation shim on port 8089.

**Infrastructure:**
- Mac Studio (96GB) at studio.shearer.live:11434, Ollama 0.18.0
- gemma3:27b — primary analysis model (Webex messages, transcripts, Gmail, Plaud). Cisco GREEN. Requires JSON enforcement suffix in system prompts.
- phi4:14b — synthesis/general model (triage suggestions, merge synthesis, shim default). Cisco GREEN.
- granite3.3:8b — fast lightweight tasks (calendar analysis). Cisco GREEN. Fastest model (~5s avg).

**Cisco policy compliance (2026-03-30):**
- DeepSeek R1:70b and Qwen3-coder:30b were NOT LISTED (likely Prohibited) — replaced.
- A/B tested all 6 models (5 tests each). GREEN models matched or exceeded non-compliant models.
- Gemma needs explicit JSON enforcement: "CRITICAL: You MUST respond with ONLY valid JSON lines. No explanatory text before or after. No markdown code fences. Start your response with {."

**Critical findings:**
- Mac Studio holds one large model warm at a time. Switching models requires 120s+ unload/load.
- phi4:14b produces clean tool calls via the shim (replaces qwen3-coder:30b role).
- `function.index` field needs stripping, `done_reason: "stop"` even with tool calls.

**Why:** Reduce Anthropic API costs by routing privacy-sensitive and simple groups to local inference. Zero external Python dependencies (LiteLLM supply chain attack context). All models Cisco GREEN compliant.

**How to apply:** Per-group model.json in groups/*/model.json selects local vs api backend. Groups without model.json default to Anthropic API.
