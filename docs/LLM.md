# LLM Providers

VibeCanvas has a pluggable LLM layer. The Prompt Architect node (`agent.prompt-architect`) and Vision Review node (`review.quality`) talk to whatever LLM you configure — they are not bound to any specific vendor.

Two independent profiles (one for each node) live in the shared config file under `llm.architect` and `llm.reviewer`. The reviewer profile usually points to a vision-capable model while the architect uses a cheaper text model.

## Provider kinds

| Provider | Use case | Endpoint |
|---|---|---|
| `openai-chat` | OpenAI-compatible chat completions: OpenAI, Doubao (Ark), GLM, OpenRouter, ollama, vLLM | `POST {baseUrl}/chat/completions` |
| `opencode-session` | Legacy `opencode serve` HTTP API | `POST /session/{id}/message` |
| `fallback` | Deterministic local heuristic. No external calls. The default. | n/a |

When a profile is `fallback`, the Prompt Architect uses its local `buildPromptSpec` heuristic, and the Vision Review degrades to technical-only review (image statistics: resolution, entropy, file size) with a warning in the report.

## Configuration

### Option A: environment variables (recommended for CI / temporary tests)

```bash
# Architect — text model for composing PromptSpec from a creative brief
VIBECANVAS_LLM_ARCHITECT_PROVIDER=openai-chat
VIBECANVAS_LLM_ARCHITECT_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
VIBECANVAS_LLM_ARCHITECT_API_KEY=sk-...
VIBECANVAS_LLM_ARCHITECT_MODEL=doubao-pro-32k-241226

# Reviewer — vision-capable model for comparing candidate images
VIBECANVAS_LLM_REVIEWER_PROVIDER=openai-chat
VIBECANVAS_LLM_REVIEWER_BASE_URL=https://api.openai.com/v1
VIBECANVAS_LLM_REVIEWER_API_KEY=sk-...
VIBECANVAS_LLM_REVIEWER_MODEL=gpt-4o
```

### Option B: shared config file (recommended for long-term setups)

Edit `%APPDATA%\VibeCanvas\config.json` (Windows) or `~/.config/vibecanvas/config.json` (Linux/macOS):

```json
{
  "llm": {
    "architect": {
      "provider": "openai-chat",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
      "apiKey": "sk-...",
      "model": "doubao-pro-32k-241226"
    },
    "reviewer": {
      "provider": "openai-chat",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "model": "gpt-4o"
    }
  }
}
```

Use the Web UI's Provider panel to edit interactively; secrets are redacted in API responses.

### Option C: legacy `opencode serve`

If you already run `opencode serve --hostname 127.0.0.1 --port 4096`, keep it and configure:

```bash
VIBECANVAS_LLM_ARCHITECT_PROVIDER=opencode-session
VIBECANVAS_LLM_REVIEWER_PROVIDER=opencode-session
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_SESSION_ID=<your-session-id>
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<optional-basic-auth>
```

The legacy `OPENCODE_*` variables only feed profiles whose `provider` is `opencode-session`.

## OpenAI-compatible request shape

`OpenAIChatProvider` sends:

```json
{
  "model": "<configured model>",
  "messages": [
    { "role": "system", "content": "<optional system>" },
    { "role": "user", "content": [
      { "type": "text", "text": "<prompt>" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
    ] }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "vibecanvas_output", "schema": "<node-specific JSON schema>", "strict": false }
  },
  "temperature": 0.4
}
```

The response's `choices[0].message.content` is parsed as JSON, with tolerance for code fences and surrounding prose. The runner then validates the parsed object against the node's zod schema (`promptSpecSchema` for architect, `evaluationReportSchema` for reviewer).

If your provider does not support `response_format: json_schema`, set `temperature: 0` and ask for raw JSON in the prompt — VibeCanvas will still parse fenced JSON. Structured output is best-effort, not hard-required.

## Per-node control

Each Prompt Architect node has a `llmEnabled` config field (default `true`):
- `true` and provider ≠ `fallback` → calls the LLM.
- `true` and provider = `fallback` → silently uses the local heuristic (no error).
- `false` → always uses the local heuristic, regardless of provider.

Each Vision Review node has a `reviewMode` config (`technical` / `agent` / `hybrid`):
- `technical` → local image statistics only.
- `agent` → LLM semantic review only. Requires non-fallback provider.
- `hybrid` → both. If provider is `fallback`, falls back to technical with a `llm-unavailable` warning rather than failing.

## Cancellation

Run cancellation (`cancel_run`) propagates an `AbortController` into the in-flight LLM HTTP request. The provider may still bill for compute already started; VibeCanvas cannot refund that.

## Migration from OpenCode-only setup

If you previously had `OPENCODE_*` set and want to switch to a generic OpenAI-compatible provider:

1. Set `VIBECANVAS_LLM_ARCHITECT_PROVIDER=openai-chat` (and `VIBECANVAS_LLM_REVIEWER_PROVIDER=openai-chat`).
2. Provide `_BASE_URL`, `_API_KEY`, `_MODEL` for each.
3. Leave the `OPENCODE_*` variables in place or remove them — they are ignored unless a profile is `opencode-session`.
4. Restart both the Web and MCP processes so they pick up the new config.
