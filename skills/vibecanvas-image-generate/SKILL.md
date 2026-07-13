---
name: vibecanvas-image-generate
description: Generate high-quality images through VibeCanvas 2 and an OpenAI-compatible Image 2 relay. Use for text-to-image, multi-candidate creation, Prompt Architect workflows, visual review, human selection, finalization, or placing a generated branch on the canvas.
license: MIT
compatibility: opencode, codex, claude-code, mcp
metadata:
  product: vibecanvas
  role: image-generation
  protocol: "2.0"
---

# VibeCanvas Image Generate

The Agent makes visual decisions. The provider handles API transport, cancellation, validation, normalization, local files, and Artifact indexing.

## Workflow

1. Read selection and provider capabilities.
2. Ensure the graph has brief, Prompt Architect, size, generation, review, selection, and output as needed.
3. Patch missing stages using the current revision.
4. Validate.
5. Call `run_to_node` on review, selector, or output.
6. Poll `get_run_status` or `get_run_events` using the returned `runId`.
7. When status is `needs-input`, inspect every candidate, choose one, and call `resolve_human_selection`.
8. Poll until completed.
9. Inspect the resulting Artifact and verify selected/final status and lineage.

## Prompt design

Create a task-specific PromptSpec. Include only relevant dimensions:

- subject, identity, and intended use;
- composition, negative space, viewpoint, and target ratio;
- lighting, materials, palette, and visual style;
- exact visible copy when required;
- reference roles and preservation constraints;
- forbidden watermarks, UI chrome, annotations, duplicated objects, malformed geometry, and pseudo-text.

Do not blindly pass the user's short sentence to the API.

## Candidate and cost policy

- Exploration: normally 2–3 candidates.
- Final output: high quality unless the user requests a draft.
- Respect `maxCandidates` and configured costs.
- Do not generate just to validate graph structure.

## Cancellation

Use `cancel_run`. VibeCanvas prevents late results from being registered or placed, but the relay may already have accepted the paid request.
