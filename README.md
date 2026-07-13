# VibeCanvas 2.0

VibeCanvas is a local-first, Agent-native visual creation studio. It combines a freeform infinite canvas, a typed ComfyUI-style semantic workflow, OpenCode/MCP orchestration, and an OpenAI-compatible Image 2 provider.

The project is designed for agents that do not have a built-in image model. OpenCode, Codex, Claude Code, OpenClaw, or another MCP-capable host can design and execute workflows while the configured Image 2 relay produces the actual images.

## What changed in 2.0

V2 is a data and execution redesign rather than a UI-only update:

- SQLite database with WAL, indexes, transactions, and crash recovery;
- optimistic graph revisions and atomic Graph Patch transactions;
- immutable run snapshots separated from the editable design graph;
- lease-based asynchronous run queue with persisted events;
- cancellation propagated to Image API, downloads, retry sleeps, and OpenCode;
- current OpenCode `info.structured` contract and real image-file Vision Review;
- persistent Artifact states: draft, candidate, selected, final, archived;
- true in-place replacement and branch-preserving canvas output;
- Candidate Selector that pauses and resumes a run;
- annotation editor, Mask Editor, Artifact lineage tree, templates, and subworkflows;
- provider capabilities, custom request/download headers, cost table, and safety controls;
- one shared user configuration for Web, CLI, and MCP;
- 21 MCP tools and asynchronous run semantics.

## Product model

```text
Freeform canvas + typed workflow
            ↓
Agent Prompt Architect / Agent Vision Review
            ↓
Image 2 generate or edit provider
            ↓
Candidate Selector / technical gate
            ↓
Artifact lineage + final status
            ↓
Place beside, below, or replace in place
```

VibeCanvas uses semantic creative nodes rather than diffusion-internal Checkpoint/VAE/Sampler nodes. It is therefore suitable for hosted image APIs while remaining extensible to future providers.

## Main capabilities

### Unified infinite canvas

- free, workflow, and hybrid modes;
- images, notes, annotations, masks, nodes, connections, and previews in one coordinate system;
- strong port types and cycle prevention;
- revisions, restore history, templates, and subworkflows;
- partial execution to a selected node.

### Image creation

- `/images/generations` and multipart `/images/edits`;
- text-to-image, source image, multiple references, annotation image, and alpha mask;
- Base64 or URL responses;
- custom endpoint paths, model aliases, JSON fields, request headers, and download headers;
- output normalization to PNG/JPEG/WebP;
- timeout, retry, URL/SSRF guard, size validation, ratio validation, and SHA-256.

### Agent collaboration

- OpenCode Structured Output Prompt Architect;
- Agent Vision Review receives the actual candidate files, not filenames alone;
- deterministic local fallback for workflows that do not require an Agent;
- MCP graph patching, artifact inspection, run control, and candidate resolution;
- Skills for routing, composing, generating, editing, and reviewing.

### Reliability

- SQLite WAL allows Web and MCP processes to share the same project safely;
- all design changes require the current `baseRevision`;
- runners execute immutable graph snapshots and do not overwrite live canvas edits;
- queued and running work has leases and is recovered after restart;
- cancelled operations do not register or place new Artifacts;
- run events and cost estimates are persisted.

## Requirements

- Node.js 22.5 or later. VibeCanvas uses the built-in `node:sqlite` API.
- npm.
- An OpenAI-compatible image relay for generation.
- OpenCode server only when OpenCode Prompt Architect or Agent Vision Review is enabled.

`node:sqlite` may print an ExperimentalWarning on some Node 22 builds. VibeCanvas requires the API but does not treat that warning as a failure.

## Install

```bash
npm install
npm run build
npm run doctor
```

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

Default URLs:

```text
Development Web: http://127.0.0.1:5173
Production Web:  http://127.0.0.1:43120
```

Open a specific user project:

```bash
VIBECANVAS_PROJECT_DIR=/path/to/project npm start
```

PowerShell:

```powershell
$env:VIBECANVAS_PROJECT_DIR="D:\Projects\visual-project"
npm start
```

## Shared configuration

V2 does not require a separate `.env` in every user project. Web, CLI, and MCP read the same configuration file.

```text
Linux/macOS: ~/.config/vibecanvas/config.json
Windows:     %APPDATA%\VibeCanvas\config.json
```

The application creates it automatically. Provider Settings in the Web UI can update the active profile. Restart Web and MCP processes after changing a profile.

Minimal profile:

```json
{
  "version": 1,
  "activeProviderId": "my-relay",
  "providers": {
    "my-relay": {
      "id": "my-relay",
      "label": "My Image 2 Relay",
      "apiKey": "YOUR_TOKEN",
      "baseUrl": "https://relay.example/v1",
      "model": "gpt-image-2",
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
      "costs": {
        "low": 0,
        "medium": 0,
        "high": 0,
        "auto": 0,
        "editMultiplier": 1
      }
    }
  },
  "openCode": {
    "baseUrl": "http://127.0.0.1:4096",
    "username": "opencode"
  },
  "runtime": {
    "host": "127.0.0.1",
    "port": 43120,
    "concurrency": 1,
    "leaseSeconds": 30
  }
}
```

Environment overrides are documented in `.env.example`.

Connectivity probe, which makes a real low-quality generation request and may incur cost:

```bash
npm run doctor -- --probe-provider
```

## OpenCode integration

Start OpenCode Server:

```bash
opencode serve \
  --hostname 127.0.0.1 \
  --port 4096 \
  --cors http://127.0.0.1:5173 \
  --cors http://127.0.0.1:43120
```

Install project-local Skills and write MCP configuration:

```bash
npm run install:skills -- \
  --project /absolute/path/to/user/project \
  --write-opencode
```

The generated MCP entry passes both:

```text
VIBECANVAS_PROJECT_DIR
VIBECANVAS_CONFIG_FILE
```

Open a new OpenCode conversation after installation so the Skill and MCP schemas reload.

Recommended request:

```text
Read the current VibeCanvas selection. Build a three-candidate Image 2 workflow with Prompt Architect, Agent Vision Review, human selection, and final canvas output. Use transactional graph patches. Start the run asynchronously and poll its status.
```

## Asynchronous MCP run flow

Do not wait synchronously inside `run_graph` or `run_to_node`.

```text
start_run / run_to_node
    → runId
get_run_status / get_run_events
    → queued / running / needs-input / completed
resolve_human_selection
    → requeue paused run
cancel_run
    → propagate cancellation
```

The MCP server currently exposes 21 tools. See `docs/MCP.md`.

## Project data

Each user project receives:

```text
<project>/.vibecanvas/
├── vibecanvas.db
├── vibecanvas.db-wal
├── vibecanvas.db-shm
├── artifacts/
├── uploads/
├── runs/
├── cache/
└── exports/
```

SQLite stores graph revisions, selection, Artifact index, lineage, immutable runs, node outputs, events, cache metadata, and templates. Large image bytes remain project-local files referenced by Artifact IDs.

Legacy v1 JSON files are imported when present; v2 thereafter treats SQLite as the source of truth. See `docs/MIGRATION_V1_TO_V2.md` before upgrading an important project.

## Scripts

```bash
npm run typecheck
npm test
npm run build
npm run probe:mcp
npm run quality
npm audit --omit=dev
npm run package:release
```

`package:release` creates a cross-platform source-and-build ZIP without `.git`, `node_modules`, secrets, or user project data.

## Test status

The release quality gate covers:

- graph type checking, cycle prevention, revisions, and invalid targets;
- same-process and multi-connection SQLite concurrency;
- immutable run snapshots and lease recovery;
- OpenCode `info.structured` and real Vision Review file attachments;
- Image API Base64/URL responses, headers, retries, cancellation, SSRF, and masks;
- Candidate Selector pause/resume, final status, true replacement, and subworkflows;
- asynchronous HTTP and MCP interfaces;
- production Node/Web build and MCP stdio probe.

See `REVIEW.md` for exact results and remaining verification boundaries.

## Design inspiration and independence

VibeCanvas was inspired by Cowart's project-local canvas, selection-driven image creation, annotation revision, and Agent/MCP interaction model. It is not a Cowart fork and does not reuse Cowart's tldraw records, MCP Widget bridge, source names, or insertion implementation. VibeCanvas independently uses React Flow, SQLite, a typed DAG, asynchronous runners, and an external Image 2 provider. See `docs/DESIGN_INSPIRATION.md`.

## Security posture

VibeCanvas is local-first and binds to localhost by default. It is not a ready-made public multi-tenant service. Review `docs/SECURITY.md` before exposing it to a network.

## License

MIT. Third-party dependencies retain their respective licenses.
