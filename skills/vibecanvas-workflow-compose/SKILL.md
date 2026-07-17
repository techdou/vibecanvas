---
name: vibecanvas-workflow-compose
description: Build, connect, validate, repair, and template typed image workflows on the VibeCanvas canvas. Use when the user asks to design a new pipeline, add or remove nodes, wire inputs to outputs, fix validation errors, reuse a template, or refactor an existing graph.
license: MIT
compatibility: opencode, zcode, mcp
metadata:
  product: vibecanvas
  role: workflow-composer
  protocol: "2.0"
---

# VibeCanvas Workflow Compose

Use this skill whenever the user wants to assemble or restructure a typed workflow: adding nodes, wiring ports, replacing a section, applying a template, or repairing a broken graph. The MCP surface is the only way to mutate the graph — there is no direct file access.

## Preconditions

- The user has registered VibeCanvas as an MCP server. Verify with `get_workspace_context` `{}`. If it errors, ask them to run install-skills and restart the session.
- You already know the user's target outcome (text-to-image, edit, hybrid) so you can pick node types with intent. If not, route to `vibecanvas-image-generate` or `vibecanvas-image-edit` instead.

## Workflow

1. **Read the current graph and the registry.**
   - `get_graph` `{}` → save `revision` (this is your `baseRevision`), `nodes[]`, `edges[]`, `mode`.
   - `get_node_registry` `{}` → keep it open while you plan. Each entry has:
     - `inputs[]` / `outputs[]` with `id` (the port handle), `type` (Text/Image/PromptSpec/AspectRatio/...), `required`, `multiple`.
     - `configFields[]` with `key`, `type`, `default` — used when seeding node `config`.
   - You only need to call the registry once per turn; cache the result.

2. **Plan the patch as a list of operations, then send it in one transaction.**
   - Prefer a single `apply_graph_patch` call with multiple operations over several calls. Atomic transactions either fully apply or fully reject, so the user never sees a half-built graph.
   - Operation kinds (see `references/tool-cookbook.md` for full JSON):
     - `addNode` — new node; you provide `id`, `position`, `data.nodeType`, `data.config`.
     - `updateNode` — patch `data.config` or other fields of an existing node.
     - `removeNode` — also removes its connected edges.
     - `connect` — new edge; you provide `id`, `source`, `target`, `sourceHandle`, `targetHandle`. Handles must come from the registry.
     - `disconnect` — remove one edge by `edgeId`.
     - `moveNode` / `resizeNode` — geometry only.
     - `setMode` — `free` | `workflow` | `hybrid`. Affects whether nodes are required to be wired.
     - `setViewport` / `setGraphMetadata` — UI metadata.

3. **Generate node IDs deterministically.**
   - Use a stable prefix that reflects intent (e.g. `node-brief-01`, `node-architect-01`, `node-generate-01`, `node-review-01`, `node-select-01`, `node-output-01`).
   - Avoid pure nanoid-style IDs in patches you'll reference later in the same turn — you'll need to read them back from the response. Stable prefixes make follow-up patches easier to author.

4. **Validate immediately after structural changes.**
   - `validate_graph` `{}` → check `valid`, `problems[]`, `executionOrder`.
   - Common problems:
     - Missing required input (a node has an unconnected `required: true` port). Fix: connect an upstream node or seed the value via `updateNode`.
     - Type mismatch (e.g. connecting a `Text` output to an `Image` input). Fix: pick the right port handle.
     - Cycle detected. Fix: remove the offending edge with `disconnect`.
     - Single-input port already occupied. Fix: `disconnect` the old edge before connecting the new one.
   - After fixing, re-validate. Do not start a run on an invalid graph.

5. **Offer templates before hand-building.**
   - `list_templates` `{}` → if a template's `description` matches the user's goal, prefer it.
   - `apply_template` `{ templateId }` → warns the user, then replaces the graph in one transaction. Returns the new `revision`.
   - Custom graphs the user wants to reuse: tell them to save it via the Web UI (top bar → BookmarkPlus) so it becomes a `custom` template; you can't author templates from MCP today.

## Recommended generation flow

A minimal text-to-image pipeline:

```
input.brief → agent.prompt-architect → image.generate → review.quality → control.human-select → output.canvas
```

For edits, swap `image.generate` for `image.edit` and add an `input.image` upstream of `source`.

For reference-driven work, add `input.image` nodes feeding `references` on `image.edit`.

For subworkflows, drop a `workflow.subflow` node and point its `config.templateId` at a saved template.

## Patch rules

- `transactionId` must be unique per attempt. Use a label that describes the change (e.g. `tx-add-review-stage-01`) so the revision log stays readable.
- `baseRevision` is the revision you read from `get_graph`. Re-read on conflict; never reuse a stale revision.
- Node `data.config` for a fresh node should seed the registry defaults. The cookbook shows how.
- Keep the graph acyclic. Retries are executor behavior, not graph topology.
- When wiring a `multiple: false` input, disconnect the existing edge first; otherwise `validate_graph` will reject the second connection.

## Notes

- `add_node` (the convenience MCP tool) is shorthand for a single-node `apply_graph_patch` with auto-positioning. Prefer `apply_graph_patch` when you're adding multiple nodes — one transaction beats N.
- Mode `free` lets nodes exist without edges; `workflow` requires every node to participate; `hybrid` allows freeform canvas items alongside the workflow. Set the mode intentionally when the user is sketching vs. running.
- Node positions are in canvas units; a typical column spacing is `x + 420`, row spacing `y + 320`. The cookbook shows a layout helper.

See `references/tool-cookbook.md` for full JSON examples of every patch operation, multi-step transaction patterns, and validate-and-repair loops.
