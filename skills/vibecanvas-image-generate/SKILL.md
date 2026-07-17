---
name: vibecanvas-image-generate
description: Generate fresh images on the VibeCanvas canvas using the OpenAI-compatible Image 2 API. Use when the user asks to create, produce, draft, imagine, or render a brand-new image (not edit an existing one). Covers single-shot generation, multi-candidate generation, and Prompt Architect-driven brief expansion.
license: MIT
compatibility: opencode, zcode, mcp
metadata:
  product: vibecanvas
  role: image-generation
  protocol: "2.0"
---

# VibeCanvas Image Generate

Use this skill when the user wants to **create a new image from scratch** — text-to-image, multi-candidate generation, or expanding a short brief into a polished prompt. For modifying an existing image (source/reference/mask/annotation), route to `vibecanvas-image-edit`.

## Preconditions

1. **The VibeCanvas service is registered as MCP.** Verify with `get_workspace_context` `{}`. If it errors, ask the user to run install-skills and restart the session.
2. **An image provider is configured.** Call `get_provider_capabilities` `{}`. Read `configured` — if false, the provider token is missing and generation will fail at run time. Tell the user to set `IMAGE_API_KEY` (or edit the provider profile via the Web UI's Provider panel) before continuing.
3. **Read the candidate limits.** From the same capabilities response, note `maxCandidates` and the `capabilities` object (e.g. `batchN`, `customSize`). Don't request a `candidateCount` higher than `maxCandidates`.

## Workflow

1. **Inspect the current selection.**
   - `get_selection_context` `{}`.
   - If the user pointed at an existing `input.brief` node, read its `config.text` — that's the creative brief.
   - If the user pointed at an `agent.prompt-architect` node, they've already authored the prompt spec; skip to step 4.

2. **Ensure a brief exists.**
   - If no brief is selected and the user gave you text, create one with a patch:
     ```json
     { "op": "addNode", "node": { "id": "node-brief-01", "type": "workflow", "position": { "x": 80, "y": 200 }, "data": { "nodeType": "input.brief", "config": { "text": "<the brief>" }, "status": "idle" } } }
     ```

3. **Decide between LLM-assisted or local prompt design.**
   - Add an `agent.prompt-architect` node and connect `input.brief.text` → `agent.prompt-architect.brief`.
   - Set `config.llmEnabled`:
     - `true` — uses the configured LLM provider (set `VIBECANVAS_LLM_ARCHITECT_*`). Best for expanding terse briefs into rich, structured PromptSpec.
     - `false` — uses the deterministic local fallback. Faster, free, but the prompt is a templated expansion. Good default when the user's brief is already detailed.
   - Optional inputs: `references` (port type `ImageArray`, `multiple: true`) — feed `input.image` nodes here if the user supplied style references.

4. **Add the generation node.**
   - `nodeType: "image.generate"`.
   - Connect `agent.prompt-architect.promptSpec` → `image.generate.prompt`.
   - Optionally connect `utility.aspect-ratio.ratio` → `image.generate.size` if the user asked for a specific ratio.
   - Set `config.candidateCount` (1 to `maxCandidates`). Use 2-4 when the user wants to compare; 1 for quick drafts.
   - Set `config.quality` (`low` | `medium` | `high` | `auto`). Default `high` for final deliverables.

5. **Add a review stage if candidateCount > 1.**
   - `nodeType: "review.quality"`. Connect `image.generate.images` → `review.quality.images`.
   - Set `config.reviewMode`:
     - `technical` — image-statistics only (resolution, entropy, file size). Always available.
     - `agent` — LLM semantic review. Requires `VIBECANVAS_LLM_REVIEWER_*` configured with a vision model.
     - `hybrid` — both. Recommended when a vision-capable LLM is configured; falls back to technical-only with a warning if not.

6. **Add a human selector if you want the user to pick.**
   - `nodeType: "control.human-select"`. Connect `review.quality.images` → `control.human-select.images`.
   - At run time this node pauses the workflow with status `needs-input`. The user picks via the Web UI or you call `resolve_human_selection` after they tell you which one.

7. **Add the output node.**
   - `nodeType: "output.canvas"`. Connect `control.human-select.selected` (or `review.quality.selected` if no human-select) → `output.canvas.image`.
   - `config.placement`: `right` (default, branches a new node beside the source), `below`, or `replace` (in-place replacement — set `replaceNodeId` too).
   - `config.markFinal: true` marks the output Artifact as `final` and tags it as the deliverable.

8. **Apply the whole pipeline in one transaction, then validate.**
   - Single `apply_graph_patch` with all `addNode` + `connect` ops.
   - `validate_graph` `{}`. Fix any problems before running.

9. **Run asynchronously.**
   - `run_to_node` `{ nodeId: "<output node id>" }` — runs just this pipeline and stops at the output. Faster and safer than `start_run` for fresh pipelines that share the canvas with unrelated work.
   - Returns `{ runId, status, graphRevision }` immediately. **Do not block.**

10. **Poll.**
    - Loop `get_run_status` `{ runId }` every ~1s. Terminal states: `completed`, `failed`, `cancelled`, `needs-input`.
    - For richer progress (per-node start/complete events), use `get_run_events` `{ runId, afterSeq }`. Track `afterSeq` to avoid re-reading old events.

11. **Handle `needs-input`.**
    - The `control.human-select` node is waiting. Read the candidate list from the run payload or `list_artifacts` `{ runId, status: 'candidate' }`.
    - Present the candidates to the user. Once they choose, call `resolve_human_selection` `{ runId, nodeId: <select node id>, artifactId }`. The run resumes automatically.

12. **Finalize.**
    - After `completed`, `list_artifacts` `{ runId, status: 'selected' }` or `{ status: 'final' }` to find the deliverable.
    - `inspect_artifact` `{ artifactId }` to verify lineage and metadata.
    - If the user wants the image on the canvas as a standalone node (not just in the workflow output), call `place_artifact` `{ artifactId, baseRevision }`.

## Prompt design (when authoring PromptSpec directly)

If you're feeding `image.generate.prompt` without going through `agent.prompt-architect` (e.g. via `updateNode` with a hand-written spec), use this shape:

```json
{
  "subject": "Concise subject line (<= 160 chars)",
  "purpose": "What the image is for",
  "composition": "Framing, perspective, hierarchy",
  "lighting": "Direction, quality, color temperature",
  "materials": ["..."],
  "palette": ["..."],
  "style": " Photorealistic / editorial / illustration / ...",
  "avoid": ["watermarks", "editor chrome", "annotation arrows", "garbled text"],
  "finalPrompt": "The actual prompt sent to the image model — combine everything above into one coherent prompt."
}
```

Only `subject` and `finalPrompt` are required; other fields guide the LLM when `agent.prompt-architect` runs.

## Notes

- `image.generate` writes the generated images as `candidate` Artifacts under `.vibecanvas/artifacts/`. Their `parentArtifactIds` point at any reference images used.
- Provider billing accrues per request, even on cancellation. If the user cancels mid-generation, `cancel_run` `{ runId }` propagates an AbortController to the in-flight HTTP request, but the provider may still charge for compute already started.
- For aspect ratios, prefer the `utility.aspect-ratio` node over hard-coding `{ width, height }` in `image.generate.config` — the utility node emits a typed `AspectRatio` value that the runner normalizes to the provider's supported sizes.
- If the user wants the same prompt at multiple sizes, build parallel `image.generate` nodes fed by one `agent.prompt-architect`; don't try to fan out inside a single node.

See `references/provider-contract.md` for provider profile details.
