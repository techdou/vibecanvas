# Workflow Protocol 2.0

## WorkflowGraph

```json
{
  "schemaVersion": "2.0",
  "id": "main",
  "revision": 12,
  "name": "IP design workflow",
  "mode": "hybrid",
  "nodes": [],
  "edges": [],
  "viewport": { "x": 0, "y": 0, "zoom": 1 },
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

Modes change visual emphasis. Execution is based on target ancestry or output roots, not every unconnected freeform object.

## Strong port types

- `Text`
- `PromptSpec`
- `Image`
- `ImageSet`
- `ImageArray`
- `Mask`
- `Annotation`
- `AspectRatio`
- `EvaluationReport`
- `ArtifactRef`
- `Metadata`
- `Boolean`
- `Number`
- `Any`

Supported widening includes `Image -> ImageArray`, `ImageSet -> ImageArray`, and image-like values to Artifact references where registered. Arbitrary mismatches are rejected.

## Graph Patch

Operations:

- `addNode`
- `updateNode`
- `moveNode`
- `resizeNode`
- `removeNode`
- `connect`
- `disconnect`
- `setMode`
- `setViewport`
- `setGraphMetadata`

Patches require a `baseRevision`. The server increments revision exactly once after a successful transaction.

## Artifact

An Artifact is an indexed project-local file with:

- kind: image, mask, annotation, JSON, or text;
- status: draft, candidate, selected, final, or archived;
- file path and API URL;
- MIME, SHA-256, byte size, dimensions;
- parent Artifact IDs;
- Run and node IDs;
- provider, prompt, request, cost, or annotation metadata.

Lineage is derived through parent IDs and supports both ancestors and descendants.

## Run

```text
queued → running → completed
                 → needs-input → queued → running
                 → failed
                 → cancelled
```

A Run stores its complete graph snapshot. Node records contain status, timestamps, cache key, outputs, error, duration, attempt, and cost.

## Run events

Events are ordered by database sequence:

```text
run-queued
run-started
node-started
node-completed
node-needs-input
node-failed
run-completed
run-failed
run-cancelled
run-recovered
graph-updated
artifact-updated
```

MCP and HTTP clients may request events after a known sequence.

## Candidate selection

`control.human-select` receives an ImageSet. With multiple candidates and no stored selection, it persists `needs-input`. The UI or MCP calls selection resolution with `runId`, `nodeId`, and `artifactId`; the run is requeued and continues from cached/upstream outputs.

## Subworkflow

`workflow.subflow` references a saved template and optional input/output node IDs. It executes the template as a child immutable run snapshot. Parent and child Runs remain independently inspectable.
