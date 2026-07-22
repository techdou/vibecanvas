<p align="center">
  <img src="assets/hero.png" alt="VibeCanvas — Agent-native image workflows" width="900" />
</p>

<h1 align="center">VibeCanvas</h1>

<p align="center">
  Local-first, agent-native visual creation studio — infinite canvas + typed workflow + MCP orchestration + OpenAI-compatible image provider.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%E2%89%A5%2022.5-brightgreen" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-blue" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-21%20tools-purple" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-54%20passed-brightgreen" />
</p>

---

## Overview

VibeCanvas is **not** a wrapper around a specific image API. It's a local-first canvas + typed workflow executor that lets any MCP-capable AI agent (ZCode, OpenCode, Claude Code, Codex, etc.) design and run visual creation pipelines. The agent reasons at the semantic level (prompt architect, vision review, candidate selection); an external image relay does the actual rendering.

```text
Freeform canvas + typed workflow
            ↓
Prompt Architect / Vision Review  (pluggable LLM, optional)
            ↓
Image generate or edit (OpenAI-compatible API)
            ↓
Candidate Selector / quality gate
            ↓
Artifact lineage + final status
            ↓
Place beside, below, or replace in place
```

VibeCanvas uses semantic creative nodes rather than diffusion-internal Checkpoint/VAE/Sampler nodes, making it suitable for hosted image APIs while remaining extensible.

## Table of contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Features](#features)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CLI](#cli)
- [LLM providers](#llm-providers)
- [Agent integration](#agent-integration)
- [MCP tools](#mcp-tools)
- [Project structure](#project-structure)
- [Development](#development)
- [Testing](#testing)
- [Security](#security)
- [License](#license)

## Architecture

Four layers with strict one-way dependencies — no circular imports, no layer leakage:

```text
src/web   (React + React Flow, browser SPA)
   │  imports core types only; talks to server via fetch + WebSocket
   ▼
src/server (Express + ws)  ──┐
   │  wraps core into HTTP/WS │  Two independent processes sharing
   ▼                          │  the same SQLite WAL + Artifact files
src/mcp   (MCP stdio)     ──┘
   │  wraps core into MCP tools
   ▼
src/core  (pure business logic — no React/Express/MCP dependencies)
```

**Key design decisions:**

- **Graph patch transactions** — every canvas mutation goes through `apply_graph_patch` with optimistic revision CAS (double-checked in memory + SQL `WHERE revision=?`)
- **Immutable run snapshots** — each run deep-clones the graph at enqueue time; runners never see live edits
- **Lease-based queue** — async run queue with heartbeat, crash recovery, and cancellation propagated to fetch/sleep/LLM calls
- **AbortController end-to-end** — from user cancel → DB status → in-flight API call

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full component view.

## Features

### Infinite canvas

- Clean creation-first UI — workflow nodes stay hidden, users only see images, notes, and placeholders
- Collapsible side panels (creation panel + inspector) for full-canvas focus mode
- Drag-and-drop artifacts from the inspector directly onto the canvas
- Images, notes, annotations, masks, nodes, connections, and previews in one coordinate system
- Strong port types with 14 typed ports and cycle prevention
- Revision history with automatic pruning (keeps latest 10 snapshots)
- Templates and subworkflows

### Image creation

- OpenAI-compatible `/images/generations` and multipart `/images/edits`
- Text-to-image, source image, multiple references, annotation image, and alpha mask
- **Arrow annotation editing** — draw arrows and text labels directly on canvas images to guide image-to-image edits, Cowart-style
- Automatic image compression for edit inputs exceeding provider file-size limits (4 MB threshold)
- Base64 or URL responses with SSRF protection (DNS-rebinding hardened via IP pinning)
- Custom endpoint paths, model aliases, request/download headers
- Output normalization to PNG/JPEG/WebP
- Timeout, retry, size validation, ratio validation, and SHA-256 hashing

### Agent collaboration

- **Pluggable LLM layer** for Prompt Architect and Vision Review (OpenAI-compatible, OpenCode session, or local fallback)
- Agent Vision Review receives actual candidate files (not filenames)
- Deterministic local fallback for workflows that don't need an LLM
- **21 MCP tools** for graph patching, artifact inspection, run control, and candidate resolution
- 5 parameter-level skills for routing, composing, generating, editing, and reviewing
- One-command agent config generation for ZCode, OpenCode, and Claude Code

### Reliability

- SQLite WAL allows Web and MCP processes to share the same project safely
- Periodic recovery of expired run leases (every 10s, not just at startup)
- Run snapshot audit trail (`run_snapshots` table)
- Cancelled operations propagate to subflow children — no orphaned runs burning API budget
- Persisted run events and cost estimates

## Quick start

### Prerequisites

- **Node.js ≥ 22.5** (uses built-in `node:sqlite`)
- **npm**
- An OpenAI-compatible image provider for generation (any `/v1/images/generations` endpoint)
- An OpenAI-compatible chat endpoint for LLM-assisted prompt/review (optional — falls back to local heuristic)

### Install

```bash
git clone https://github.com/techdou/vibecanvas.git
cd vibecanvas
npm install
npm run build
npm run doctor
```

### Development

```bash
npm run dev
```

This starts both the API server (tsx watch) and the web dev server (Vite) concurrently.

| URL | Description |
|---|---|
| `http://127.0.0.1:5173` | Development web UI (Vite) |
| `http://127.0.0.1:43120` | Production web UI (after `vibecanvas serve`) |

### Open a specific project

By default VibeCanvas uses the current working directory as the user project. To point it at a different project:

```bash
vibecanvas serve --project /absolute/path/to/your/project
# or: VIBECANVAS_PROJECT_DIR=/path/to/project vibecanvas serve
```

## Configuration

V2 uses **one shared config file** for Web, CLI, and MCP — no per-project `.env` required.

```text
Linux/macOS: ~/.config/vibecanvas/config.json
Windows:     %APPDATA%\VibeCanvas\config.json
```

The application creates it automatically on first run. Provider Settings in the Web UI can update the active profile.

<details>
<summary>Minimal config example</summary>

```json
{
  "version": 1,
  "activeProviderId": "my-relay",
  "providers": {
    "my-relay": {
      "id": "my-relay",
      "label": "My Image Relay",
      "apiKey": "YOUR_TOKEN",
      "baseUrl": "https://relay.example/v1",
      "model": "gpt-image-1",
      "generatePath": "/images/generations",
      "editPath": "/images/edits",
      "timeoutMs": 180000,
      "maxRetries": 3,
      "editImageField": "image[]",
      "outputFormat": "png",
      "headers": {},
      "downloadHeaders": {},
      "extraJson": {},
      "allowPrivateImageUrls": false,
      "allowedImageHosts": [],
      "capabilities": {
        "textToImage": true,
        "imageToImage": true,
        "multiReference": true,
        "maskEdit": true,
        "customSize": true,
        "transparentBackground": false,
        "batchN": false,
        "responseFormats": ["b64_json", "url"],
        "maxReferences": 10,
        "maxCandidates": 4
      },
      "costs": { "low": 0, "medium": 0, "high": 0, "auto": 0, "editMultiplier": 1 }
    }
  },
  "llm": {
    "architect": { "provider": "fallback" },
    "reviewer": { "provider": "fallback" }
  },
  "runtime": {
    "host": "127.0.0.1",
    "port": 43120,
    "concurrency": 1,
    "leaseSeconds": 30
  }
}
```

</details>

Environment variable overrides are documented in [`.env.example`](.env.example).

**Connectivity probe** (makes a real low-quality generation request, may incur cost):

```bash
vibecanvas doctor --probe-provider
```

## CLI

VibeCanvas ships a single unified entry point. Install globally (`npm install -g`) or use `node dist/node/cli.js` directly:

```text
vibecanvas serve [--project DIR] [--host H] [--port N]   Web process (canvas + REST API + WebSocket)
vibecanvas mcp                                            MCP stdio server (21 tools for external agents)
vibecanvas dev                                            Web + MCP + Vite watch in parallel (local dev)
vibecanvas doctor [--probe-provider]                      Environment health checks
vibecanvas install-skills [--target-agents AGENTS]        Install skills + generate per-agent MCP config
vibecanvas validate [--project DIR]                       Validate the current design graph
vibecanvas open                                           Open the running Web UI in the default browser
```

`npm start` / `npm run mcp` / `npm run cli` are aliased to the CLI for backward compatibility.

## LLM providers

The Prompt Architect and Vision Review nodes talk to a pluggable LLM layer — they are not bound to any specific vendor. Two independent profiles (`architect`, `reviewer`) live in the shared config:

```json
{
  "llm": {
    "architect": { "provider": "openai-chat", "baseUrl": "https://ark.cn-beijing.volces.com/api/v3", "apiKey": "...", "model": "doubao-pro-32k" },
    "reviewer":  { "provider": "openai-chat", "baseUrl": "https://api.openai.com/v1", "apiKey": "...", "model": "gpt-4o" }
  }
}
```

Supported providers:

- `openai-chat` — any OpenAI-compatible `/chat/completions` endpoint (OpenAI, Doubao/Ark, GLM, OpenRouter, ollama, vLLM).
- `opencode-session` — legacy `opencode serve` HTTP API (preserved for existing setups).
- `fallback` — deterministic local heuristic. The default; works offline with no API key.

See [`docs/LLM.md`](docs/LLM.md) for full configuration, request shape, and migration from the legacy OpenCode-only setup.

## Agent integration

VibeCanvas works with any MCP-capable agent (ZCode, OpenCode, Claude Code). To register the MCP server for one or more agents in a project:

```bash
vibecanvas install-skills \
  --project /absolute/path/to/project \
  --target-agents zcode,opencode
#   or: --all-agents  (covers zcode + opencode + claude-code)
```

This copies the five VibeCanvas skills into the project's `.agents/skills/` and writes the agent-specific MCP config:

| Agent | Config file |
|---|---|
| ZCode | `.zcode/config.json` |
| OpenCode | `opencode.json` |
| Claude Code | `.mcp.json` |

Restart the agent session after installing so it picks up the new MCP server and skills.

<details>
<summary>Recommended Agent prompt</summary>

> Read the current VibeCanvas selection. Build a three-candidate Image workflow with Prompt Architect, Agent Vision Review, human selection, and final canvas output. Use transactional graph patches. Start the run asynchronously and poll its status.

</details>

## MCP tools

The MCP server exposes 21 tools. Key flows:

```text
start_run / run_to_node  →  runId
get_run_status           →  queued / running / needs-input / completed
resolve_human_selection  →  requeue paused run
cancel_run               →  propagate cancellation (including subflow children)
```

Full tool reference: [`docs/MCP.md`](docs/MCP.md).

## Project structure

```text
vibecanvas/
├── src/
│   ├── core/              # Pure business logic (no framework deps)
│   │   ├── types.ts       # All domain models
│   │   ├── storage.ts     # SQLite persistence + immutable snapshots
│   │   ├── runner.ts      # Workflow execution engine
│   │   ├── run-queue.ts   # Async queue with lease + recovery
│   │   ├── graph.ts       # Graph validation + patch + topology
│   │   ├── image-provider.ts   # OpenAI-compatible adapter + SSRF guard
│   │   ├── llm-provider.ts     # Pluggable LLM layer (openai-chat / opencode-session / fallback)
│   │   └── node-registry.ts    # Node type definitions
│   ├── server/            # Express HTTP + WebSocket
│   ├── mcp/               # MCP stdio tools
│   └── web/               # React + React Flow SPA
│       ├── App.tsx
│       ├── components/
│       └── lib/api.ts
├── tests/                 # Vitest — 54 tests
├── docs/                  # Architecture, MCP, LLM, Security, etc.
├── skills/                # 5 agent skills (router, compose, generate, edit, review)
├── scripts/               # doctor, install-skills, probe-mcp, release
├── assets/                # Repo-owned images (hero, icons)
├── package.json
└── tsconfig.json
```

Each user project generates a `.vibecanvas/` data directory (gitignored):

```text
<project>/.vibecanvas/
├── vibecanvas.db          # SQLite (graphs, runs, artifacts, events, cache)
├── vibecanvas.db-wal
├── vibecanvas.db-shm
├── artifacts/             # Image files referenced by Artifact IDs
├── uploads/
├── runs/
├── cache/
└── exports/
```

## Development

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run
npm run build         # tsup (server/mcp/cli) + vite (web)
npm run probe:mcp     # MCP stdio tool probe
npm run quality       # typecheck + test + build + probe
npm audit --omit=dev
```

## Testing

The quality gate covers:

- Graph type checking, cycle prevention, revisions, invalid targets
- Same-process and multi-connection SQLite concurrency
- Immutable run snapshots and lease recovery
- OpenAI-compatible chat completions contract for Prompt Architect and Vision Review
- Fallback LLM provider and provider factory branches
- Image API Base64/URL responses, headers, retries, cancellation, SSRF, masks
- Candidate Selector pause/resume, final status, true replacement, subworkflows
- zod-validated server routes
- Production Node/Web build and MCP stdio probe

```bash
npm test    # 54 tests, ~5s
```

See [`REVIEW.md`](REVIEW.md) for detailed test boundaries.

## Security

VibeCanvas is **local-first** and binds to localhost by default. It is not a ready-made public multi-tenant service.

- API keys live in the shared config file or environment variables — **never** in graph JSON, prompts, run metadata, or browser storage
- Image download URLs pass through SSRF validation: protocol whitelist, private-IP rejection, DNS-rebinding-hardened IP pinning, 80 MB limit, 3-redirect cap
- Server routes zod-validate request bodies
- `.gitignore` excludes `.env`, `config.json`, `.vibecanvas/`, `.zcode/`, `.data/`, `.agents/`, IDE directories, and per-agent MCP config files

Review [`docs/SECURITY.md`](docs/SECURITY.md) before exposing VibeCanvas to a network.

## License

[MIT](LICENSE). Third-party dependencies retain their respective licenses.
