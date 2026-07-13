---
name: vibecanvas-image-edit
description: Perform VibeCanvas 2 image-to-image, multi-reference, annotation-driven, and masked revisions through an OpenAI-compatible Image 2 edit endpoint. Use when the user wants controlled variants, local edits, preserved identity, masks, annotations, or a new version branch.
license: MIT
compatibility: opencode, codex, claude-code, mcp
metadata:
  product: vibecanvas
  role: image-editing
  protocol: "2.0"
---

# VibeCanvas Image Edit

Preserve the source branch by default. Use true replacement only when the user explicitly requests it and the output node has an exact `replaceNodeId`.

## Workflow

1. Read selection context and identify the clean source Artifact.
2. Classify references by role: subject, style, composition, color, or character.
3. Use the Annotation Editor for arrows/notes or the Mask Editor for a local editable region.
4. Connect source, PromptSpec, references, annotation, mask, and size to `image.edit`.
5. Connect edit output to Vision Review, Candidate Selector, and canvas output.
6. Validate and start an asynchronous target run.
7. Poll; resolve candidate selection when paused.
8. Inspect lineage to verify the new image points to source, references, and annotation parents.

## Mask rules

A mask must:

- match source dimensions exactly;
- contain alpha;
- remain under 50MB;
- be supported by the active provider profile.

## Edit prompt rules

- State the requested change precisely.
- State what remains unchanged.
- Include structured annotation notes.
- Remove arrows, labels, handles, toolbars, selection outlines, and annotation residue from the final bitmap.
- Report contradictory notes instead of silently inventing a compromise.

## Provider compatibility

If the relay rejects repeated `image[]`, change the provider profile `editImageField` to `image`. Restart Web and MCP after provider profile changes.
