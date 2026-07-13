# Changelog

## 2.0.0 - 2026-07-13

### Reliability and storage

- Replaced shared JSON registries with SQLite, WAL, transactions, indexes, and a 10-second busy timeout.
- Added monotonic graph revisions, immutable revision history, atomic Graph Patch transactions, and restore support.
- Separated editable design graphs from immutable run snapshots and runtime state.
- Added asynchronous lease-based run queue, persisted events, heartbeat, retry, and expired-run recovery.
- Added safe same-instance initialization and concurrent multi-connection Artifact registration.

### Agent and execution

- Fixed OpenCode Structured Output parsing to read `info.structured` with compatibility fallback.
- Implemented real Agent Vision Review with actual local candidate files attached to OpenCode.
- Propagated AbortSignal through workflow, OpenCode, Image API, URL downloads, retry delays, and local processing.
- Added explicit OpenCode session abort on run cancellation.
- Rejected invalid target nodes before queueing.
- Changed MCP runs to asynchronous start/status/events/cancel semantics.
- Added subworkflow execution from saved templates.

### Images and Artifacts

- Added persistent Artifact states: draft, candidate, selected, final, archived.
- Added indexed lineage, ancestry/descendant view, and final-state persistence.
- Implemented true in-place canvas replacement with revision control.
- Added Candidate Selector pause/resume flow.
- Added annotation and Mask editors and typed Annotation/Mask nodes.
- Added mask dimension/alpha/50MB validation, output format normalization, custom API/download headers, and URL safety controls.
- Added Provider capability and cost profiles.

### User experience

- Added run/cost panel, Artifact lineage panel, graph revision history, Provider settings, templates, and subworkflow node.
- Added WebSocket reconnect behavior and revision-aware graph synchronization.
- Added built-in starter and annotation/mask edit templates.

### Quality

- Expanded regression coverage to 36 tests.
- Added concurrent initialization, invalid HTTP target, embedded URL credential, and oversized edit-input tests.
- Added cross-platform release packaging using Archiver.
- MCP probe now validates 21 tools.

## 1.0.0 - 2026-07-13

- Initial React Flow canvas, typed DAG, Image 2 provider, local Artifact files, HTTP/MCP interface, and five Agent Skills.
