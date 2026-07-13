# Revision-controlled patch example

First read `get_graph` and use its current revision.

```json
{
  "transactionId": "tx-add-review-selector-01",
  "baseRevision": 12,
  "operations": [
    {
      "op": "addNode",
      "node": {
        "id": "node-review-01",
        "type": "workflow",
        "position": { "x": 1100, "y": 100 },
        "data": {
          "nodeType": "review.quality",
          "config": { "minimumScore": 70, "reviewMode": "hybrid" },
          "status": "idle"
        }
      }
    },
    {
      "op": "connect",
      "edge": {
        "id": "edge-generate-review",
        "source": "node-generate-01",
        "target": "node-review-01",
        "sourceHandle": "images",
        "targetHandle": "images"
      }
    }
  ]
}
```

A revision conflict means another actor changed the graph. Reread and rebuild the patch; do not force-write the old graph.
