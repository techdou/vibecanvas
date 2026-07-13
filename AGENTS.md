# VibeCanvas Agent Guide

## Intent

VibeCanvas is a local-first visual creation canvas plus typed workflow executor. Keep Canvas UI, design graph, immutable run snapshots, Agent semantics, Image Provider transport, and Artifact files as separate concerns.

## Operational rules

- Read `get_workspace_context` and `get_selection_context` before modification.
- Every graph mutation uses `apply_graph_patch` with the current `baseRevision`.
- Never edit `.vibecanvas/vibecanvas.db`, legacy JSON files, or Artifact indexes by hand.
- Use asynchronous `start_run` or `run_to_node`; poll status/events.
- Use `cancel_run` for cancellation and `resolve_human_selection` for paused candidate nodes.
- Preserve source Artifacts and branches unless replacement is explicit.
- Do not put secrets into graph configuration, prompts, run metadata, browser storage, or examples.
- Inspect final Artifact status and lineage before claiming completion.

## Development rules

- Register node types and ports in `src/core/node-registry.ts` before exposing them.
- Every executable node needs validation, executor, cancellation behavior, cache/cost policy, tests, and documentation.
- Do not write runtime status back into the editable design graph.
- Canvas output changes must use a fresh revision-controlled patch.
- Keep workflows acyclic; retries are bounded executor behavior, not graph loops.
- Keep large payloads outside graph JSON and SQLite rows; use Artifact files.
- Provider-specific behavior belongs in profiles/adapters, not semantic graph nodes.

## Quality gate

```bash
npm run quality
npm audit --omit=dev
```

For UI work, verify with a desktop browser when localhost browser automation is available. Do not describe a sandbox-blocked browser run as a pass.
