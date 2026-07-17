# MCP Contract

VibeCanvas 2.0 exposes 21 tools through stdio.

## Service startup

The MCP server is one of three process entry points. It reads the same `VIBECANVAS_PROJECT_DIR` / `VIBECANVAS_CONFIG_FILE` env vars as the Web process, so both can run side-by-side and share the SQLite WAL store.

```bash
# Start the Web process (canvas UI + REST API + WebSocket)
vibecanvas serve
#   or: npm start
#   or: node dist/node/cli.js serve

# Start the MCP stdio server (drives the canvas from an external agent)
vibecanvas mcp
#   or: npm run mcp
#   or: node dist/node/cli.js mcp
#   or: node dist/node/mcp.js
```

External agents (ZCode, OpenCode, Claude Code) connect by spawning `node dist/node/mcp.js` as a stdio child process. Run `vibecanvas install-skills --target-agents <agents>` to generate the per-agent config file that registers the MCP server:

- ZCode → `.zcode/config.json`
- OpenCode → `opencode.json`
- Claude Code → `.mcp.json`

Each config injects `VIBECANVAS_PROJECT_DIR` and `VIBECANVAS_CONFIG_FILE` into the spawned child's env. Restart the agent session after installing so it picks up the new MCP server.

## Context and graph

- `get_workspace_context`
- `get_selection_context`
- `get_graph`
- `get_node_registry`
- `apply_graph_patch`
- `add_node`
- `validate_graph`

Always read the current revision before mutation. `apply_graph_patch` is the canonical mutation path.

## Asynchronous execution

- `start_run`
- `run_graph` — compatibility alias for asynchronous full run
- `run_to_node`
- `get_run_status`
- `get_run_events`
- `cancel_run`
- `resolve_human_selection`

Recommended loop:

```text
run_to_node(nodeId)
  → { runId, status: queued }
get_run_status(runId)
  → running / needs-input / completed
get_run_events(runId, afterSeq)
  → incremental progress
resolve_human_selection(...)
  → resume when needed
```

Do not keep a tool call open while waiting for a high-quality image generation.

## Artifacts

- `inspect_artifact`
- `list_artifacts`
- `set_artifact_status`
- `place_artifact`

`place_artifact` requires `baseRevision` because it changes the design graph.

## Templates and provider

- `list_templates`
- `apply_template`
- `get_provider_capabilities`

## Agent operating rules

1. Read selection context first.
2. Read the graph only when the whole workflow matters.
3. Use exact registered port handles.
4. Patch a coherent transaction; do not rewrite a stale complete graph.
5. Validate before high-cost execution.
6. Prefer a target node or output root over an indiscriminate full graph run.
7. Poll asynchronous Runs.
8. Inspect Artifact lineage before reporting success.
9. Preserve original branches unless replacement is explicit.
