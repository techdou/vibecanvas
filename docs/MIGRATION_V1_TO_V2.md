# Migrating VibeCanvas 1.x to 2.0

VibeCanvas 2.0 replaces the v1 JSON persistence and synchronous Runner model with SQLite/WAL, revision-controlled graph patches, immutable run snapshots, and asynchronous queue execution.

## Back up first

Copy the complete v1 project data before opening it with v2:

```text
<project>/.vibecanvas/
```

V2 imports legacy `graph.json`, `selection.json`, and `artifacts.json` only when the SQLite database has not yet been initialized. The legacy files are not deleted.

## Runtime requirements

- Upgrade Node.js to 22.5 or later.
- Run `npm install` again because v2 uses the built-in `node:sqlite` API and new dependencies.
- Rebuild with `npm run build`.

## Shared configuration

V1 commonly read `.env` from the process working directory. V2 uses one user-level configuration file for Web, CLI, and MCP:

```text
Linux/macOS: ~/.config/vibecanvas/config.json
Windows:     %APPDATA%\VibeCanvas\config.json
```

Environment variables remain supported as overrides. Configure the same explicit file in every Agent host with:

```text
VIBECANVAS_CONFIG_FILE=/absolute/path/to/config.json
```

Do not copy API tokens into each project repository.

## OpenCode MCP configuration

Re-run the installer so the MCP entry points to the v2 build and passes both the project and shared config paths:

```bash
npm run install:skills -- \
  --project /absolute/path/to/user/project \
  --write-opencode
```

Open a new OpenCode conversation after installation.

## MCP run semantics

V1 run tools could wait synchronously. V2 run tools are asynchronous:

```text
start_run / run_to_node
    → runId
get_run_status / get_run_events
    → observe progress
resolve_human_selection
    → resume a paused Candidate Selector
cancel_run
    → cancel queued/running work
```

Agent instructions that assume a synchronous image result must be updated.

## Graph changes

Every graph mutation requires the latest revision:

```json
{
  "transactionId": "agent-edit-001",
  "baseRevision": 12,
  "operations": []
}
```

On a revision conflict, reload the graph and recompute the patch. Never retry a stale patch blindly and never replace the complete graph from an old snapshot.

## Run and canvas separation

V2 does not store node execution status in the editable design graph. Runs use immutable snapshots and write status, outputs, costs, and events to the Run index. Generated images are placed on the current canvas only through a revisioned output patch.

## Artifact changes

Artifacts are indexed in SQLite and have persistent states:

```text
draft → candidate → selected → final → archived
```

Existing v1 Artifacts are imported when their legacy records contain usable paths. Missing source files remain unusable and should be re-uploaded.

## Image slots and replacement

`placement: "replace"` now performs a true in-place transactional update. Configure `replaceNodeId` whenever more than one upstream source image exists; ambiguous replacement is rejected instead of guessing.

## Provider profiles

Move relay configuration into a Provider Profile. Review:

- endpoint paths and image field name;
- custom request and download headers;
- declared capabilities;
- URL allowlist and private-address policy;
- output format;
- candidate/reference limits;
- quality cost table.

Run `npm run doctor -- --probe-provider` after configuration. This can incur a provider charge.

## Verification

```bash
npm run quality
npm audit --omit=dev
npm run doctor
```

Then start a disposable project and verify:

1. graph edit and revision history;
2. one generation run;
3. candidate pause and resume;
4. final Artifact persistence;
5. cancellation during a slow request;
6. Web and MCP access to the same project.
