---
name: vibecanvas-image-edit
description: Edit an existing image on the VibeCanvas canvas using source image, references, annotations, and masks through the OpenAI-compatible Image 2 API. Use when the user asks to revise, retouch, restyle, inpaint, swap a subject, apply annotation feedback, or otherwise modify an existing image rather than create one from scratch.
license: MIT
compatibility: opencode, zcode, mcp
metadata:
  product: vibecanvas
  role: image-editing
  protocol: "2.0"
---

# VibeCanvas Image Edit

Use this skill when the user wants to **modify an existing image**: retouching, restyling, inpainting via mask, annotation-driven revision, multi-reference fusion, or any other source-image-based change. For text-to-image creation, route to `vibecanvas-image-generate`.

## Preconditions

1. **The VibeCanvas service is registered as MCP.** Verify with `get_workspace_context` `{}`. Errors here mean install-skills hasn't been run.
2. **An image provider is configured AND supports image-to-image.** `get_provider_capabilities` `{}` → check `capabilities.imageToImage === true`. If false, edits will fail at run time; tell the user to configure a provider that supports edits.
3. **Check the mask capability.** `capabilities.maskEdit` tells you whether masks are honored. Multi-reference is `capabilities.multiReference`.

## Workflow

1. **Identify the source image.**
   - `get_selection_context` `{}`.
   - The selected node should be (or contain) a `canvas.image` or `input.image`. Read its `config.artifactId`.
   - If the user referenced a file path instead, ask them to upload via the Web UI's Inspector → Upload, then re-read the selection.

2. **Resolve the source Artifact.**
   - `inspect_artifact` `{ artifactId }` → confirm `kind === 'image'`, check `width`, `height`, `filePath`.
   - Save the artifact ID; it will become `image.edit`'s `source` input.

3. **Pick the editing mode.**

   **Mode A: prompt-only edit.** Restyle, swap subject, adjust lighting. No mask, no annotation. The provider gets the source image + a new prompt.

   **Mode B: mask-based inpainting.** Localized change (remove object, change one region). The user paints a mask over the source. Connect an `input.mask` node whose `artifactId` is a mask Artifact (PNG with alpha channel).

   **Mode C: annotation-driven revision.** The user drew arrows/text on the source. Connect an `input.annotation` node and use `config.annotationInstruction` to tell the model how to interpret the annotations (default: "apply changes, strip annotation artifacts from the final image").

   **Mode D: multi-reference fusion.** Add `input.image` nodes for each reference and connect them to `image.edit.references` (port `multiple: true`). Use metadata role labels (`config.role` on each input.image: `style`, `subject`, `composition`, etc.) so the prompt architect knows what each reference is for.

4. **Author or expand the prompt.**
   - Add an `agent.prompt-architect` node. Connect `input.brief.text` → `agent.prompt-architect.brief` (the user's edit request in natural language).
   - Connect the source and references as `agent.prompt-architect.references` — the LLM (if `llmEnabled: true`) will look at them when composing the edit prompt.
   - If you don't want LLM expansion, set `llmEnabled: false` and feed a hand-written PromptSpec directly to `image.edit.prompt`.

5. **Add the edit node and wire inputs.**
   - `nodeType: "image.edit"`. Connect:
     - `source` (port type `Image`, required) ← the `canvas.image`/`input.image` of the source.
     - `prompt` (port type `PromptSpec`, required) ← `agent.prompt-architect.promptSpec`.
     - `references` (port `ImageArray`, `multiple: true`) ← optional `input.image` nodes.
     - `annotation` (port `Annotation`) ← optional `input.annotation`.
     - `mask` (port `Mask`) ← optional `input.mask`.
     - `size` (port `AspectRatio`) ← optional `utility.aspect-ratio` (defaults to source dimensions).
   - Set `config.quality` (`low`/`medium`/`high`).
   - Set `config.candidateCount` (1 for surgical edits; 2-3 when the user wants variants).
   - Set `config.annotationInstruction` if you connected an annotation. Default is fine for most cases.

6. **Add review + selector + output (same as image-generate).**
   - `review.quality` ← `image.edit.images`.
   - `control.human-select` ← `review.quality.images` (optional but recommended for edits where the user will compare before/after).
   - `output.canvas` ← `control.human-select.selected` or `review.quality.selected`. Use `config.placement: 'right'` so the result lands beside the source for visual comparison; **do not** use `replace` unless the user explicitly asked to overwrite the source.

7. **Apply, validate, run, poll, finalize.**
   - Same as `vibecanvas-image-generate` steps 8-12: single `apply_graph_patch`, `validate_graph`, `run_to_node` on the output node, poll `get_run_status`, handle `needs-input` via `resolve_human_selection`, finalize with `list_artifacts` + `inspect_artifact`.

## Mask rules (hard constraints)

- A mask **must** be a PNG with an alpha channel. JPEG won't work.
- Mask dimensions must match the source image exactly (same `width` and `height`). Mismatched masks are rejected at run time.
- Mask file size must be under 50MB.
- If `get_provider_capabilities.capabilities.maskEdit === false`, masks are silently ignored — the edit falls back to prompt-only. Warn the user if they expect localized inpainting.

## Annotation rules

- Annotations are images (PNG screenshots of the source with arrows, text, highlights drawn on top). They're attached as additional context, not as the output target.
- The model is instructed (via `config.annotationInstruction`) to apply the changes described by the annotations and **remove all annotation artifacts** from the final image — no arrows, no selection outlines, no toolbar UI.
- If the user supplied a screenshot that includes editor chrome, mention it; the model tries to ignore chrome but occasionally needs a cleaner input.

## Notes

- `image.edit`'s `editImageField` provider profile field controls how the source file is multipart-encoded. Most OpenAI-compatible providers use `image[]`; some use `image`. This is a provider-config concern, not a workflow concern — the Web UI's Provider panel exposes it.
- Reference images sent to `references` should be declared with a role via `config.role` on the upstream `input.image` node (`subject`, `style`, `composition`, `background`, etc.). The prompt architect uses these roles to weight influence.
- For inpainting where the user wants the unchanged regions pixel-identical to the source, request `quality: 'high'` and connect the source as both `source` and a `references` entry with role `subject`. Not all providers guarantee pixel-exact preservation; check the result with `inspect_artifact` and warn if the diff is larger than expected.
- `cancel_run` propagates an AbortController into the multipart upload and the provider HTTP call. Already-billed compute is not refunded.

See `vibecanvas-image-generate` for the run/poll/finalize loop details; the patterns are identical.
