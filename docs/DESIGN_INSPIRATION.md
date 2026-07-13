# Design inspiration and Cowart relationship

Cowart informed the original product discussion in four areas:

- project-local canvas and assets;
- selected image slots carrying position and aspect ratio;
- Agent/MCP generation followed by local image insertion;
- annotation-driven revision while preserving the source image.

VibeCanvas is not a Cowart fork. The implementation does not copy Cowart's tldraw snapshot schema, `cowart*` shape metadata, `insert_cowart_image`, native Codex MCP Apps Widget bridge, or source file structure.

VibeCanvas independently implements:

- React Flow unified canvas;
- semantic typed DAG and partial execution;
- SQLite/WAL project database;
- revision-controlled Graph Patch;
- asynchronous run queue and recovery;
- external Image 2 provider profiles;
- OpenCode and generic MCP host integration;
- Artifact state and lineage;
- Candidate Selector, masks, subworkflows, and cost tracking.

When behavior resembles Cowart, documentation should describe it as design inspiration rather than source reuse. Any future direct source reuse must first review Cowart's current license and preserve required notices.
