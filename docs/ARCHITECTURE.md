# Architecture

## Components

```text
React Flow Web UI
  ├─ revisioned Graph Patch API
  ├─ run/event API and WebSocket
  ├─ Candidate/Annotation/Mask/Lineage UI
  └─ Provider settings
          │
Express application ───────────── MCP stdio server
          │                            │
          └──────── shared services ───┘
                 WorkspaceStorage
                 WorkflowRunner
                 RunQueue
                 OpenCodeBridge
                 Image2Provider
```

Web and MCP are separate processes when used with OpenCode. They share a SQLite WAL database and project-local Artifact files, not mutable JSON registries.

## Storage

`WorkspaceStorage` owns the project `.vibecanvas` directory. Tables:

- `graphs`: current design graph and revision;
- `graph_revisions`: immutable design history;
- `selection`: current UI selection;
- `artifacts`: indexed files, states, hashes, dimensions, parents, metadata;
- `runs`: queue index and complete immutable run JSON;
- `run_events`: ordered persistent event stream;
- `cache`: deterministic node output cache;
- `templates`: built-in and user templates.

SQLite settings:

```text
journal_mode = WAL
synchronous = NORMAL
foreign_keys = ON
busy_timeout = 10000
user_version = 2
```

Image bytes are not stored inside SQLite. Files are copied to `.vibecanvas/artifacts/<artifact-id>/` and referenced by ID.

## Design graph versus run snapshot

The current graph is editable. A run captures:

- graph ID and revision;
- a deep-cloned graph snapshot;
- target node;
- node run records;
- estimated and actual cost.

The Runner reads only the snapshot. It does not persist transient node status into the current design graph. An output operation that intentionally adds or replaces a canvas image uses a fresh revision-controlled patch.

This prevents a long-running workflow from overwriting user edits or Agent patches made after the run started.

## Graph transactions

Every patch contains:

```json
{
  "transactionId": "tx-unique",
  "baseRevision": 17,
  "operations": []
}
```

The complete operation list is validated for schema, node definitions, typed handles, cardinality, parent references, and cycles before the transaction commits. A stale revision returns a conflict and nothing is written.

## Execution

1. `RunQueue.enqueue` validates the target and inserts a queued immutable snapshot.
2. A worker claims one row atomically and receives a lease.
3. The Runner computes the target ancestor subgraph or output-root subgraph.
4. Nodes execute topologically and persist NodeRun records/events.
5. Heartbeats renew the lease.
6. A Candidate Selector may set `needs-input`; resolution stores the selected Artifact and requeues the same run.
7. Completion, failure, or cancellation is persisted.

Expired running leases are recovered on startup. Runs below `maxAttempts` return to queued; exhausted runs fail with recovery metadata.

## Cancellation

An active run has an AbortController. Cancellation:

- changes queued/running state to cancelled;
- aborts OpenCode requests and requests session abort;
- aborts Image API calls and image URL downloads;
- interrupts retry sleeps;
- prevents post-response Artifact registration, cache write, or canvas insertion.

An upstream provider may have already accepted a paid request before cancellation. The UI should therefore report cancellation as local workflow cancellation, not guaranteed provider billing reversal.

## Agent boundary

Agent work is semantic:

- Prompt Architect produces a validated `PromptSpec`;
- Vision Review compares actual candidate image files and returns a validated `EvaluationReport`;
- Workflow Skills use Graph Patch and asynchronous MCP tools.

The deterministic Runner remains responsible for topology, storage, API transport, cancellation, cache, and status.

## Image provider boundary

The graph does not contain credentials. The active profile is loaded from the unified user config. Provider capability fields decide whether nodes may use text-to-image, edit, multi-reference, masks, custom sizes, and candidate limits.

## Extensibility

A new executable node requires:

1. Node Registry definition and version;
2. typed input/output contract;
3. validation behavior;
4. Runner executor;
5. cache/cost policy;
6. regression tests;
7. Skill and documentation update.
