# ZCode Integration

ZCode is an MCP-capable AI coding agent. VibeCanvas exposes 21 MCP tools that let ZCode design, run, and manage visual creation workflows directly from the agent conversation — no HTTP bridge needed.

## How it works

```text
ZCode (agent host)
  ├── reads skills from .agents/skills/vibecanvas*
  ├── connects to VibeCanvas MCP server (stdio)
  └── drives the workflow:
        get_workspace_context → apply_graph_patch → start_run → poll → resolve
```

Unlike the OpenCode integration (where VibeCanvas calls OpenCode's HTTP API for Prompt Architect / Vision Review), ZCode operates as the **driver**. ZCode uses its own model to do prompt architecture and creative review, then writes results back through MCP tools.

### What works differently

| Capability | OpenCode mode | ZCode mode |
|---|---|---|
| Workflow design | Via MCP tools | Via MCP tools (same) |
| Run execution | Via MCP tools | Via MCP tools (same) |
| Prompt Architect | Runner calls OpenCode HTTP API for structured output | ZCode generates prompt in conversation, writes via `apply_graph_patch` |
| Vision Review | Runner sends images to OpenCode for evaluation | ZCode reviews images via `inspect_artifact`, writes decision via MCP |
| Image generation | Runner calls Image API directly | Runner calls Image API directly (same) |

When no OpenCode session is configured, the `agent.prompt-architect` and `review.quality` nodes automatically use deterministic local fallbacks. ZCode can override these by editing node configs directly.

## Setup

### 1. Build VibeCanvas

```bash
npm install
npm run build
```

### 2. Install skills + write ZCode MCP config

```bash
npm run install:skills -- --project /absolute/path/to/your/project --write-zcode
```

This command:
- Copies 5 VibeCanvas skills into `<project>/.agents/skills/` (ZCode discovers these automatically)
- Writes `<project>/.zcode/config.json` with the MCP server entry

The generated MCP config looks like:

```json
{
  "mcp": {
    "servers": {
      "vibecanvas": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/vibecanvas/dist/node/mcp.js"],
        "env": {
          "VIBECANVAS_PROJECT_DIR": "/path/to/your/project",
          "VIBECANVAS_CONFIG_FILE": "/path/to/config.json"
        }
      }
    }
  }
}
```

### 3. Start the VibeCanvas web server (for the canvas UI)

```bash
npm start
```

The web UI is at `http://127.0.0.1:43120`. The MCP server runs as a separate stdio process spawned by ZCode — they share the same SQLite database via WAL.

### 4. Open ZCode in your project

ZCode auto-connects workspace-scoped MCP servers at session start. Open a new conversation in the project directory and the VibeCanvas tools are available.

## Usage

### Recommended conversation prompt

> Read the current VibeCanvas selection. Build a three-candidate image workflow with a prompt, image generation, quality review, human selection, and canvas output. Use transactional graph patches. Start the run asynchronously and poll its status.

### Key MCP tools for ZCode

| Tool | Purpose |
|---|---|
| `get_workspace_context` | Read project paths, graph revision, selection |
| `get_selection_context` | Read selected nodes + neighbors + definitions |
| `apply_graph_patch` | Atomically modify the graph (add/move/connect nodes, etc.) |
| `validate_graph` | Check schema, ports, cycles |
| `start_run` / `run_to_node` | Queue async workflow execution |
| `get_run_status` / `get_run_events` | Poll run progress |
| `cancel_run` | Cancel + propagate to subflow children |
| `resolve_human_selection` | Pick a candidate for a paused run |
| `inspect_artifact` | View artifact metadata + lineage |
| `place_artifact` | Put an artifact on the canvas |

### Revision discipline

Always read the current `baseRevision` before patching. On conflict (another process edited the graph), re-read and retry with a narrow patch — never overwrite the full graph from a stale snapshot.

### Run discipline

Use `start_run` (returns immediately with `runId`), then poll `get_run_status`. Do not block synchronously. For `needs-input` status, use `resolve_human_selection` after comparing candidates.

## Skills reference

ZCode discovers these skills from `.agents/skills/`:

| Skill | Role |
|---|---|
| `vibecanvas` | Router — coordinates the other four |
| `vibecanvas-workflow-compose` | Design and modify typed workflows |
| `vibecanvas-image-generate` | Text-to-image generation |
| `vibecanvas-image-edit` | Image-to-image editing (mask, annotation, references) |
| `vibecanvas-creative-review` | Candidate review and quality gate |

## Troubleshooting

### MCP server not connecting

Check **Settings → MCP** in ZCode. The `vibecanvas` server should show as connected. If not:
- Verify `dist/node/mcp.js` exists (`npm run build`)
- Verify the paths in `.zcode/config.json` are absolute
- Check that `VIBECANVAS_PROJECT_DIR` points to a valid project

### Skills not discovered

Skills are installed to `.agents/skills/`. ZCode scans this directory. If skills don't appear, use `/` menu in ZCode to verify, or check Settings → Skills.

### Image generation disabled

The Image API key must be set in the shared config (`config.json` → `providers.*.apiKey`) or via the `IMAGE_API_KEY` environment variable. Run `npm run doctor` to verify.
