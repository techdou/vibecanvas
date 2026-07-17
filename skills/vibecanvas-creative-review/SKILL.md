---
name: vibecanvas-creative-review
description: Compare candidate images, run semantic quality review, pick the best candidate, repair issues, finalize or archive Artifacts on the VibeCanvas canvas. Use when the user asks to review, judge, score, choose between, finalize, archive, or inspect candidate images or Artifact lineage.
license: MIT
compatibility: opencode, zcode, mcp
metadata:
  product: vibecanvas
  role: creative-review
  protocol: "2.0"
---

# VibeCanvas Creative Review

Use this skill for the **judgment and finalization** stage of any image workflow: comparing candidates, scoring quality, picking a winner, repairing flaws, marking a final deliverable, or archiving alternatives. The image-generate and image-edit skills get you to candidates; this skill takes you from candidates to a single delivered Artifact.

## Preconditions

1. **The VibeCanvas service is registered as MCP.** `get_workspace_context` `{}`.
2. **At least one candidate exists.** Either the user has run a generation/edit and there are `candidate`-status Artifacts, or a `review.quality` / `control.human-select` node has paused a run with `needs-input`. If neither is true, route back to `vibecanvas-image-generate` or `vibecanvas-image-edit`.

## Workflow

1. **Gather the candidate set.**
   - If a run is paused (`get_run_status` returns `status: "needs-input"`), read the candidate Artifact IDs from the run payload (typically under `nodeRuns[<selector-id>].outputs.candidateArtifactIds` or by listing).
   - Otherwise: `list_artifacts` `{ status: "candidate", limit: 100 }`. Filter by `runId` if you're scoped to a specific run.

2. **Read each candidate's metadata.**
   - `inspect_artifact` `{ artifactId }` for each candidate. Note:
     - `width`, `height`, `sizeBytes`, `mimeType` — technical signal.
     - `parentArtifactIds` — lineage (what source/references produced it).
     - `metadata.role` — what role the candidate plays.
   - The Artifact file path is local to `.vibecanvas/artifacts/`. Do not embed base64 in MCP calls — the runner reads files directly.

3. **Choose a review path.**

   **Path A: Workflow review (recommended when you have a run).**
   - Add a `review.quality` node if the workflow doesn't have one. Connect `image.generate.images` (or `image.edit.images`) → `review.quality.images`.
   - Set `config.reviewMode`:
     - `technical` — local only (resolution, entropy, file size). Zero LLM cost. Fast.
     - `agent` — LLM semantic review. Requires `VIBECANVAS_LLM_REVIEWER_*` configured with a vision-capable model.
     - `hybrid` — both. Falls back to technical-only with a warning if the LLM provider is `fallback`.
   - Set `config.minimumScore` (0-100). Default 70.
   - `run_to_node` `{ nodeId: "<review node id>" }`. Poll to completion.

   **Path B: Ad-hoc comparison (when candidates exist outside a workflow).**
   - As the agent, you can directly compare the candidate files you have access to via your host environment's image-viewing capability, then use `set_artifact_status` to mark your choice (step 6). VibeCanvas does not expose a "compare these specific Artifacts" MCP tool — comparison happens either in the workflow (`review.quality`) or in your own multimodal judgment.

4. **Read the review report.**
   - After the review node completes, `get_run_status` `{ runId }` → read `nodeRuns[<review-id>].outputs.report`:
     ```json
     {
       "decision": "pass | retry | manual",
       "selectedIndex": 0,
       "score": 87,
       "technicalScore": 75,
       "semanticScore": 92,
       "reviewer": "hybrid | technical | agent",
       "issues": [{ "code": "...", "severity": "warning", "message": "..." }],
       "repairPrompt": "optional — what to change if retrying"
     }
     ```
   - `selectedIndex` is 0-based into the input candidate array. If you don't have the array handy, cross-reference with the candidate Artifact list from step 1.

5. **Handle `needs-input` (human-in-the-loop).**
   - If a `control.human-select` node downstream of `review.quality` has paused the run, the workflow wants the user to confirm the choice.
   - Surface the candidates (typically by listing them and their file paths so the user can open them) and let the user decide.
   - Call `resolve_human_selection` `{ runId, nodeId: <selector id>, artifactId: <user's choice> }`. The run resumes.

6. **Persist the verdict.**
   - Mark the winner: `set_artifact_status` `{ artifactId: <winner>, status: "selected" }`.
   - Mark the deliverable: `set_artifact_status` `{ artifactId: <winner>, status: "final" }` (usually after the user confirms).
   - Archive losers: `set_artifact_status` `{ artifactId: <loser>, status: "archived" }` for each non-selected candidate. Archiving keeps lineage intact and removes them from default list views.

7. **Place on canvas if requested.**
   - `place_artifact` `{ artifactId: <final>, baseRevision }` — creates a freeform `canvas.image` node on the canvas at a clear position. Returns the new `graphRevision`.

8. **Repair loop (if `decision === "retry"`).**
   - Read `repairPrompt` from the report. Feed it back into an `agent.prompt-architect` node (or directly into `image.generate.prompt` via `updateNode`) as additional constraints.
   - Re-run. Compare the new candidates against the original winner. Keep the better one.

## Criteria checklist (for ad-hoc or hybrid review)

When you're the reviewer (Path B) or interpreting a `hybrid` report, check each candidate against:

- **Subject correctness** — does it match the brief's stated subject?
- **Composition** — framing, focal hierarchy, negative space.
- **Anatomy and geometry** — for people/objects, no distortions, six fingers, warped architecture.
- **Visible text accuracy** — if text was requested, is it spelled correctly and well-rendered?
- **Material and lighting coherence** — do surfaces and light match the described environment?
- **Reference adherence** — does it preserve identity/style/composition from declared references without copying watermarks or chrome?
- **Artifacts** — no compression blocking, no neural noise, no partial duplicates.
- **Watermarks / annotation residue** — none should be visible in the final.
- **Suitability for the stated use** — does it fit the purpose (marketing, illustration, reference, etc.)?

For each issue, decide severity (`info` / `warning` / `error`) and write a one-line message into the report. Errors force `decision: retry` or `manual`; warnings inform but don't block.

## Decision schema

Use this shape when authoring or interpreting reports:

```json
{
  "decision": "pass | retry | manual",
  "selectedIndex": 0,
  "score": 0,
  "issues": [
    { "code": "anatomy", "severity": "error", "message": "Subject has six fingers on left hand." }
  ],
  "repairPrompt": "Reduce hand to five fingers; preserve overall pose."
}
```

- `pass` — deliverable ready. Go to step 6.
- `retry` — try again with `repairPrompt`. Go to step 8.
- `manual` — neither auto-pass nor auto-retry; ask the user to decide.

## Notes

- Artifact status transitions: `draft` → `candidate` → `selected` → `final`. `archived` is terminal. Status changes are append-only in the lineage log; you can always see the history via `inspect_artifact`.
- The `reviewer` field on reports is `'technical' | 'agent' | 'hybrid'`. Older runs may have the legacy value `'opencode'`; treat it as `'agent'`.
- When the LLM reviewer returns an out-of-range `selectedIndex`, the runner throws `"LLM selected candidate index N, but only M images exist"` and the run fails. Surface the error, drop the review node, switch to `reviewMode: 'technical'`, and re-run.
- For batch comparison across multiple runs (e.g. "compare today's three generation runs"), use `list_artifacts` with no `runId` filter and group client-side by `metadata.generatedByRunId`.
