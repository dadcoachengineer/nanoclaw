---
name: Local Model Routing
description: Ollama shim for privacy-first local inference — qwen3-coder:30b default, deepseek-r1:70b analysis-only, Mac Studio at studio.shearer.live:11434
type: project
---

Local model routing via Anthropic-to-Ollama translation shim on port 8089.

**Infrastructure:**
- Mac Studio (96GB) at studio.shearer.live:11434, Ollama 0.18.0
- qwen3-coder:30b — default agentic model (tool calling works, ~30-40 tok/s warm)
- deepseek-r1:70b — analysis-only, NO Ollama native tool calling support
- qwen3:8b — fast lightweight tasks (88 tok/s)

**Critical findings:**
- DeepSeek-R1:70b does NOT support Ollama tool calling → restrict to tool-free analysis groups
- Mac Studio holds one large model warm at a time. Switching qwen3→deepseek requires 120s+ unload/load. Keep qwen3-coder resident via OLLAMA_KEEP_ALIVE.
- qwen3-coder:30b produces clean tool calls: proper JSON objects, multi-tool support, no stringified args. `function.index` field needs stripping, `done_reason: "stop"` even with tool calls.

**Implementation status (Phase 1+2 complete):**
- src/shim-types.ts, shim-tool-translator.ts, shim-tool-repair.ts
- src/anthropic-ollama-shim.ts (non-streaming, tested end-to-end)
- src/container-runner.ts modified for per-group model.json routing
- Phase 3 (streaming SSE) and Phase 4 (orchestrator wiring) remaining

**Why:** Reduce Anthropic API costs by routing privacy-sensitive and simple groups to local inference. Zero external Python dependencies (LiteLLM supply chain attack context).

**How to apply:** Per-group model.json in groups/*/model.json selects local vs api backend. Groups without model.json default to Anthropic API.
