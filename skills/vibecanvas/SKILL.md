---
name: vibecanvas
description: Route and coordinate work in the VibeCanvas 2 visual creation canvas. Use when the user asks to inspect, organize, modify, run, cancel, review, or collaborate on a VibeCanvas infinite canvas; refers to selected nodes, candidates, masks, annotations, subworkflows, Artifacts, versions, or Image 2 workflows; or needs another VibeCanvas specialist skill.
license: MIT
compatibility: opencode, codex, claude-code, mcp
metadata:
  product: vibecanvas
  role: router
  protocol: "2.0"
---

# VibeCanvas

VibeCanvas combines a freeform canvas, typed executable image workflow, asynchronous Run queue, and indexed Artifact lineage. MCP tools are the operational interface.

## Route

- Build, connect, repair, template, or refactor workflows: `vibecanvas-workflow-compose`.
- Text-to-image and candidate generation: `vibecanvas-image-generate`.
- Source/reference/mask/annotation editing: `vibecanvas-image-edit`.
- Candidate comparison, semantic review, and repair direction: `vibecanvas-creative-review`.

## Default sequence

1. Call `get_workspace_context`.
2. Call `get_selection_context`.
3. Call `get_graph` only when the whole graph is required.
4. Read `get_node_registry` before adding unfamiliar node types.
5. Modify with `apply_graph_patch` using the current `baseRevision`.
6. Call `validate_graph`.
7. Use `run_to_node` or `start_run`; both return immediately with `runId`.
8. Poll `get_run_status` and optionally `get_run_events`.
9. For `needs-input`, call `resolve_human_selection` after visual comparison.
10. Inspect the final Artifact and lineage before reporting completion.

## Revision discipline

Never rewrite a complete graph from a stale snapshot. On revision conflict:

1. reread the graph;
2. preserve unrelated edits;
3. rebuild a narrow patch;
4. retry once with the new revision.

## Run discipline

- Do not synchronously wait in an MCP tool call for Image 2.
- Use `cancel_run` when the user cancels.
- A cancelled upstream request may already have incurred relay cost; never promise billing reversal.
- Preserve candidate and source Artifacts unless deletion was explicitly requested.

## Safety

- Never expose API keys, protected headers, or OpenCode passwords.
- Check provider capabilities before mask, multi-reference, or large candidate requests.
- Keep loops out of the graph and retries bounded.
