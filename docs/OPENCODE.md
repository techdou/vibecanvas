# OpenCode Integration

## Start the host

```bash
opencode serve \
  --hostname 127.0.0.1 \
  --port 4096 \
  --cors http://127.0.0.1:5173 \
  --cors http://127.0.0.1:43120
```

Optional Basic Auth is configured in the shared VibeCanvas config or environment.

## Install Skills and MCP

```bash
npm run build
npm run install:skills -- --project /path/to/user/project --write-opencode
```

The generated local MCP entry uses the built `dist/node/mcp.js`, the user project as `cwd`, and explicitly passes the project and shared config paths.

Restart the OpenCode conversation after installation.

## Structured Prompt Architect

VibeCanvas sends a JSON Schema `format` and reads the current OpenCode message response from:

```text
response.info.structured
```

A compatibility fallback accepts the older `structured_output` spelling. The result is validated before it becomes a PromptSpec.

Reference images are attached as file parts when available.

## Vision Review

Agent Vision Review attaches the actual candidate files and asks OpenCode to return:

```json
{
  "decision": "pass | retry | manual",
  "selectedIndex": 0,
  "score": 0,
  "issues": [],
  "repairPrompt": "optional"
}
```

Technical decoding and resolution checks run independently. Hybrid review combines both results.

## Cancellation

VibeCanvas aborts the active message request and calls the OpenCode session abort endpoint on run cancellation. OpenCode cancellation is best effort; a remote model request may already have consumed provider resources.

## Recommended Agent behavior

```text
Read selection_context.
Use get_node_registry for unknown nodes.
Apply one revisioned graph patch.
Validate.
Start an asynchronous target run.
Poll status/events.
Resolve human selection if needed.
Inspect the final Artifact and lineage.
```
