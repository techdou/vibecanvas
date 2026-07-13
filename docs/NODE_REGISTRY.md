# Node Registry

`src/core/node-registry.ts` is the shared source of truth for UI, graph validation, MCP, and Runner dispatch.

## Input and canvas

- `input.brief`: natural-language creative brief.
- `input.prompt`: direct prompt text.
- `input.image`: Artifact image with subject/style/composition/color/character role.
- `input.mask`: transparent PNG mask from Mask Editor.
- `input.annotation`: annotation image and structured note text.
- `utility.aspect-ratio`: target width and height.
- `canvas.note`: freeform text that can feed Prompt Architect.
- `canvas.annotation`: source-linked annotation Artifact.
- `canvas.image`: branchable image Artifact on the canvas.

## Agent

### `agent.prompt-architect`

Combines brief and references into a `PromptSpec`. `useOpenCode=true` calls OpenCode Structured Output and validates `info.structured`; local dynamic compilation is available as a deterministic fallback.

### `review.quality`

Runs the technical image gate, then optionally sends real candidate files to OpenCode Vision Review. Modes:

- technical;
- OpenCode;
- hybrid.

Outputs selected Image, complete ImageSet, and EvaluationReport.

## Generation

### `image.generate`

OpenAI-compatible `/images/generations`. Produces one or more candidate Artifacts.

### `image.edit`

Multipart `/images/edits` with source, PromptSpec, references, optional annotation, optional alpha mask, and size. Preserves lineage to all visual parents.

## Local processing

### `image.resize`

Sharp-based contain, cover, or fill resizing.

## Control and workflow

### `control.human-select`

Pauses the Run for visual candidate selection and resumes after resolution.

### `workflow.subflow`

Executes a saved template as an isolated child Run snapshot.

## Output

### `output.canvas`

Persists selected/final state and either:

- creates a branchable image to the right;
- creates it below;
- replaces an explicit target node in place, retaining its position and size.

Replacement requires `replaceNodeId`; it is not inferred from ambiguous nearby content.
