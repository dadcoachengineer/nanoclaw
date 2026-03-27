# Local Model Routing

Privacy-first local inference for NanoClaw groups via Ollama.

## Architecture

```
Container Agent → host.docker.internal:8089 (shim) → studio.shearer.live:11434 (Ollama)
```

The translation shim converts Anthropic Messages API format to OpenAI Chat Completions format for Ollama. It runs as part of the NanoClaw process on port 8089 (localhost only).

## Configuration

### Per-Group Model Selection

Create `groups/{folder}/model.json`:

```json
{
  "backend": "local",
  "local": {
    "model": "qwen3-coder:30b",
    "num_ctx": 16384
  }
}
```

Groups without `model.json` default to Anthropic API (no change in behavior).

### Available Models

| Model | Size | Tool Calling | Speed | Use Case |
|-------|------|-------------|-------|----------|
| qwen3-coder:30b | 19GB | Yes (native) | ~30-40 tok/s | Default for agentic groups |
| qwen3:8b | 4.9GB | Limited | ~88 tok/s | Fast lightweight tasks |
| deepseek-r1:70b | 40GB | **No** (Ollama limitation) | ~10-15 tok/s | Analysis-only, no tool use |

**Important:** DeepSeek-R1:70b does NOT support Ollama's native tool calling. Groups configured with this model will work for conversational/analysis tasks but cannot execute tools (bash, file I/O, web search). Use qwen3-coder:30b for any group that needs agentic capabilities.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| OLLAMA_BASE_URL | http://studio.shearer.live:11434 | Ollama instance URL |
| OLLAMA_DEFAULT_MODEL | qwen3-coder:30b | Default model for local groups |
| SHIM_PORT | 8089 | Translation shim port |
| OLLAMA_TIMEOUT_MS | 120000 | Request timeout |
| OLLAMA_NUM_CTX | 16384 | Default context window size |

### Model Memory Management

The Mac Studio (96GB) can hold one large model warm at a time. Model switching requires unload/load (120s+). To keep qwen3-coder resident:

```bash
# On the Mac Studio, set keep-alive to infinite
curl http://studio.shearer.live:11434/api/generate -d '{"model": "qwen3-coder:30b", "keep_alive": -1}'
```

## Shim Endpoints

- `POST /v1/messages` — Anthropic Messages API translation
- `GET /health` — Ollama connectivity and model status
- `GET /v1/models` — Fake model list for SDK compatibility

## Security

- Shim listens on 127.0.0.1 only (not exposed to LAN)
- Containers reach shim via host.docker.internal
- Dummy API key (`sk-local-placeholder`) used for local groups
- Ollama communication is LAN-only (private IP validation)
- Zero data leaves the local network for local-backend groups

## Troubleshooting

**Shim not starting:** Check if port 8089 is in use. Check OLLAMA_BASE_URL is reachable.

**Model loading timeout:** First request after model switch takes 60-120s. Increase OLLAMA_TIMEOUT_MS or pre-warm the model.

**Tool calls failing:** Verify the model supports tool calling (qwen3-coder does, deepseek-r1 does not). Check shim logs for repair layer activity.

**"Ollama returned invalid response":** Model may be loading. Retry after the model is fully loaded. Check `curl http://studio.shearer.live:11434/api/tags` for model status.
