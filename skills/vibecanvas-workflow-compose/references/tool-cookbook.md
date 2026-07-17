# Workflow Compose Tool Cookbook

Parameter-level reference for the workflow-compose skill. Every JSON block is a literal MCP tool input you can send as-is (after substituting IDs and the current `baseRevision`).

## 1. Read the starting state

```jsonc
// get_workspace_context {}
// Returns: { projectDir, databaseFile, graphRevision, selectionUpdatedAt }

// get_graph {}
// Returns the full graph. Save .revision as baseRevision.
```

## 2. addNode operation (inside apply_graph_patch)

```json
{
  "op": "addNode",
  "node": {
    "id": "node-brief-01",
    "type": "workflow",
    "position": { "x": 80, "y": 200 },
    "width": 280,
    "height": 180,
    "data": {
      "nodeType": "input.brief",
      "config": { "text": "A friendly robot barista in a warm cafe, morning light." },
      "status": "idle"
    }
  }
}
```

- `id`: your stable, intent-prefixed ID.
- `data.nodeType`: one of the types from `get_node_registry`.
- `data.config`: seed values. Use `get_node_registry[].configFields[].default` when unsure.
- `data.status`: always `"idle"` for a fresh node.

## 3. updateNode operation (patch an existing node's config)

```json
{
  "op": "updateNode",
  "nodeId": "node-generate-01",
  "patch": {
    "config": { "candidateCount": 2, "quality": "high" }
  }
}
```

`patch` is shallow-merged into `data`. Pass only the fields you want to change.

## 4. removeNode operation

```json
{ "op": "removeNode", "nodeId": "node-stale-01" }
```

Connected edges are removed automatically; you don't need to disconnect them first.

## 5. connect operation

```json
{
  "op": "connect",
  "edge": {
    "id": "edge-brief-architect-01",
    "source": "node-brief-01",
    "target": "node-architect-01",
    "sourceHandle": "text",
    "targetHandle": "brief"
  }
}
```

`sourceHandle` and `targetHandle` are port IDs from `get_node_registry`. Connecting wrong types (e.g. `Text` → `Image`) fails at `validate_graph`.

## 6. disconnect operation

```json
{ "op": "disconnect", "edgeId": "edge-brief-architect-01" }
```

Required before reconnecting a `multiple: false` input port.

## 7. moveNode / resizeNode operations

```json
{ "op": "moveNode", "nodeId": "node-generate-01", "position": { "x": 500, "y": 200 } }
{ "op": "resizeNode", "nodeId": "node-generate-01", "width": 360, "height": 320 }
```

## 8. setMode operation

```json
{ "op": "setMode", "mode": "workflow" }
```

Use `workflow` when the user is running pipelines end-to-end; `free` when sketching; `hybrid` for mixed canvas + workflow.

## 9. A complete multi-operation transaction

Adds an architect node, a generate node, wires them, and updates the generate node's config. All atomic.

```json
{
  "transactionId": "tx-build-architect-generate-01",
  "baseRevision": 12,
  "operations": [
    {
      "op": "addNode",
      "node": {
        "id": "node-architect-01",
        "type": "workflow",
        "position": { "x": 400, "y": 200 },
        "data": {
          "nodeType": "agent.prompt-architect",
          "config": { "strategy": "dynamic", "extraConstraints": "", "llmEnabled": false },
          "status": "idle"
        }
      }
    },
    {
      "op": "addNode",
      "node": {
        "id": "node-generate-01",
        "type": "workflow",
        "position": { "x": 760, "y": 200 },
        "data": {
          "nodeType": "image.generate",
          "config": { "quality": "high", "candidateCount": 2, "outputFormat": "png" },
          "status": "idle"
        }
      }
    },
    {
      "op": "connect",
      "edge": {
        "id": "edge-architect-generate-01",
        "source": "node-architect-01",
        "target": "node-generate-01",
        "sourceHandle": "promptSpec",
        "targetHandle": "prompt"
      }
    },
    {
      "op": "connect",
      "edge": {
        "id": "edge-brief-architect-01",
        "source": "node-brief-01",
        "target": "node-architect-01",
        "sourceHandle": "text",
        "targetHandle": "brief"
      }
    }
  ]
}
```

## 10. Layout helper

When placing a column of nodes left-to-right, add 420 to `x` for each step and keep `y` aligned. For a 2-row layout, use `y + 320` for the second row.

```text
input.brief      x=80,   y=200
architect        x=420,  y=200
generate         x=840,  y=200
review           x=1260, y=200
selector         x=1680, y=200
output           x=2100, y=200
```

## 11. Validate-and-repair loop

```jsonc
// 1. apply_graph_patch { ... }
// 2. validate_graph {}
//    Returns: { valid, problems: [...], executionOrder: [...] }
// 3. If !valid:
//      for each problem, build a fix operation (usually disconnect or addNode+connect)
//      apply_graph_patch with the new revision
//      validate_graph again
// 4. Stop when valid === true.
```

Never `start_run` while `validate_graph.valid === false`. The runner will refuse anyway, but you waste a round trip.

## 12. Template application

```jsonc
// list_templates {}
// Pick a template id, then:
// apply_template { "templateId": "starter-text-to-image" }
//   Returns the new graph with a fresh revision.
```

Warn the user before applying — `apply_template` replaces the entire graph in one transaction. Undo is via the Web UI's revision history, not from MCP.

## 13. add_node (convenience shortcut)

When you only need to add a single node and let VibeCanvas pick a position:

```json
{
  "nodeType": "input.brief",
  "x": 80,
  "y": 200,
  "config": { "text": "Hello" },
  "baseRevision": 12
}
```

Returns `{ node, graphRevision }`. Prefer the multi-op `apply_graph_patch` for anything beyond one node.
