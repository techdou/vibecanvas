---
name: vibecanvas-workflow-compose
description: Design and modify revision-controlled typed VibeCanvas 2 workflows. Use when the user wants ComfyUI-like semantic image orchestration, branches, candidates, masks, annotations, subworkflows, templates, graph repair, layout organization, or Agent-generated pipelines on the infinite canvas.
license: MIT
compatibility: opencode, codex, claude-code, mcp
metadata:
  product: vibecanvas
  role: workflow-composer
  protocol: "2.0"
---

# VibeCanvas Workflow Compose

Create semantic creative workflows. Do not imitate low-level diffusion internals when the provider is a hosted Image API.

## Workflow

1. Read `get_selection_context`.
2. Read `get_node_registry` for needed categories.
3. Decompose the request into brief, references, Prompt Architect, generation/edit, review, human selection, and output.
4. Reuse selected nodes where correct.
5. Read the current graph revision.
6. Submit one coherent `apply_graph_patch` transaction with `baseRevision`.
7. Validate the graph.
8. Repair only reported errors with a second narrow patch.
9. Start a target run only when execution is part of the request.

## Patch rules

- Use unique node, edge, and transaction IDs.
- Use exact handle IDs from the registry.
- Do not move unrelated freeform content.
- Disconnect a single-cardinality input before replacing its edge.
- Keep the graph acyclic.
- Use `workflow.subflow` for reusable complex stages.
- Save reusable designs as templates through the Web UI or template tools.

## Recommended generation flow

```text
input.brief ───────────────┐
input.image references ────┼→ agent.prompt-architect
                           ↓
utility.aspect-ratio → image.generate
                           ↓
                    review.quality
                           ↓
                control.human-select
                           ↓
                    output.canvas
```

## Recommended annotation edit flow

```text
canvas.image ─────────────→ image.edit.source
canvas.annotation ────────→ image.edit.annotation
input.mask ───────────────→ image.edit.mask
references ───────────────→ image.edit.references
brief → prompt architect ─→ image.edit.prompt
image.edit → review → human select → output
```

## Execution scope

Prefer `run_to_node` on the review, selector, or output node. A full run executes output-root subgraphs, not every unconnected freeform canvas object.
